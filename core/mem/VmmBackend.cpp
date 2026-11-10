#include "core/mem/VmmBackend.hpp"

#include <vmmdll.h>

#include <cstring>
#include <limits>

namespace radar::mem {

namespace {

ULONG64 vmmFlags(Freshness freshness) {
    // ZEROPAD_ON_FAIL: unreadable pages within physical memory come back as zeros. We zero-fill
    // destination buffers ourselves as well, so the "failed bytes are zero" contract holds
    // regardless of how VMM fails.
    ULONG64 flags = VMMDLL_FLAG_ZEROPAD_ON_FAIL;
    if (freshness == Freshness::Fresh) flags |= VMMDLL_FLAG_NOCACHE;
    return flags;
}

constexpr std::size_t kMaxReadSize = std::numeric_limits<DWORD>::max();

}  // namespace

VmmBackend::VmmBackend(VmmConfig config) : config_(std::move(config)) {}

VmmBackend::~VmmBackend() { close(); }

std::expected<void, std::string> VmmBackend::open() {
    if (handle_) return {};
    if (config_.device.empty()) return std::unexpected("no device configured");

    std::vector<std::string> args;
    if (config_.vmmPrintf) args.emplace_back("-printf");
    args.insert(args.end(), {"-device", config_.device,
                             // Python plugins and YARA are MemProcFS forensic features we don't use.
                             "-disable-python", "-disable-yara",
                             // Return from Initialize only once the process list etc. are ready.
                             "-waitinitialize"});
    args.insert(args.end(), config_.extraArgs.begin(), config_.extraArgs.end());

    std::vector<LPCSTR> argv;
    argv.reserve(args.size());
    for (const auto& a : args) argv.push_back(a.c_str());

    PLC_CONFIG_ERRORINFO errorInfo = nullptr;
    handle_ = VMMDLL_InitializeEx(static_cast<DWORD>(argv.size()), argv.data(), &errorInfo);
    std::string detail;
    if (errorInfo) {
        if (errorInfo->cwszUserText > 0) {
            // wszUserText is a wide string (wchar_t on Linux is 4 bytes); keep only ASCII.
            for (DWORD i = 0; i < errorInfo->cwszUserText && errorInfo->wszUserText[i]; ++i) {
                const auto c = errorInfo->wszUserText[i];
                detail.push_back(c < 0x80 ? static_cast<char>(c) : '?');
            }
        }
        VMMDLL_MemFree(errorInfo);
    }
    if (!handle_) {
        std::string msg = "VMMDLL_InitializeEx failed for device '" + config_.device + "'";
        if (!detail.empty()) msg += ": " + detail;
        return std::unexpected(msg);
    }
    return {};
}

void VmmBackend::close() {
    if (handle_) {
        VMMDLL_Close(handle_);
        handle_ = nullptr;
    }
}

std::optional<Pid> VmmBackend::findProcess(std::string_view imageName) {
    if (!handle_) return std::nullopt;
    const std::string name(imageName);
    DWORD pid = 0;
    if (!VMMDLL_PidGetFromName(handle_, name.c_str(), &pid) || pid == 0) return std::nullopt;
    return pid;
}

std::optional<ModuleInfo> VmmBackend::findModule(Pid pid, std::string_view name) {
    if (!handle_) return std::nullopt;
    const std::string moduleName(name);
    PVMMDLL_MAP_MODULEENTRY entry = nullptr;
    if (!VMMDLL_Map_GetModuleFromNameU(handle_, pid, moduleName.c_str(), &entry,
                                       VMMDLL_MODULE_FLAG_NORMAL) ||
        !entry) {
        return std::nullopt;
    }
    ModuleInfo info{entry->vaBase, entry->cbImageSize};
    VMMDLL_MemFree(entry);
    if (info.base == 0 || info.size == 0) return std::nullopt;
    return info;
}

bool VmmBackend::processAlive(Pid pid) {
    if (!handle_) return false;
    VMMDLL_PROCESS_INFORMATION info{};
    info.magic = VMMDLL_PROCESS_INFORMATION_MAGIC;
    info.wVersion = VMMDLL_PROCESS_INFORMATION_VERSION;
    SIZE_T size = sizeof(info);
    if (!VMMDLL_ProcessGetInformation(handle_, pid, &info, &size)) return false;
    // dwState is the EPROCESS state: 0 while the process is running.
    return info.dwState == 0;
}

bool VmmBackend::read(Pid pid, Address va, std::span<std::byte> dst, Freshness freshness) {
    if (dst.empty()) return false;
    std::memset(dst.data(), 0, dst.size());
    if (!handle_ || (va == 0 && pid != kPhysicalMemory) || dst.size() > kMaxReadSize) return false;
    DWORD bytesRead = 0;
    const BOOL ok = VMMDLL_MemReadEx(handle_, pid, va, reinterpret_cast<PBYTE>(dst.data()),
                                     static_cast<DWORD>(dst.size()), &bytesRead,
                                     vmmFlags(freshness));
    return ok && bytesRead == dst.size();
}

void VmmBackend::readMany(Pid pid, std::span<ReadRequest> requests, Freshness freshness) {
    for (auto& r : requests) {
        r.bytesRead = 0;
        if (r.dst && r.size) std::memset(r.dst, 0, r.size);
    }
    if (!handle_ || requests.empty()) return;

    VMMDLL_SCATTER_HANDLE scatter =
        VMMDLL_Scatter_Initialize(handle_, pid, static_cast<DWORD>(vmmFlags(freshness)));
    if (!scatter) return;

    bool anyPrepared = false;
    for (auto& r : requests) {
        if (r.va == 0 || !r.dst || r.size == 0) continue;
        // pcbRead is filled by VMMDLL_Scatter_Execute. The buffers must outlive the handle.
        if (VMMDLL_Scatter_PrepareEx(scatter, r.va, r.size, static_cast<PBYTE>(r.dst),
                                     reinterpret_cast<PDWORD>(&r.bytesRead))) {
            anyPrepared = true;
        }
    }
    if (anyPrepared && !VMMDLL_Scatter_Execute(scatter)) {
        // Transport-level failure: report nothing as read and keep the zero-fill guarantee.
        for (auto& r : requests) {
            r.bytesRead = 0;
            if (r.dst && r.size) std::memset(r.dst, 0, r.size);
        }
    }
    VMMDLL_Scatter_CloseHandle(scatter);
}

std::vector<VmmBackend::PhysicalRange> VmmBackend::physicalMemoryMap() {
    std::vector<PhysicalRange> out;
    if (!handle_) return out;
    PVMMDLL_MAP_PHYSMEM map = nullptr;
    if (!VMMDLL_Map_GetPhysMem(handle_, &map) || !map) return out;
    if (map->dwVersion == VMMDLL_MAP_PHYSMEM_VERSION)
        for (DWORD i = 0; i < map->cMap; ++i) out.push_back({map->pMap[i].pa, map->pMap[i].cb});
    VMMDLL_MemFree(map);
    return out;
}

std::vector<VmmBackend::ProcessEntry> VmmBackend::processes() {
    std::vector<ProcessEntry> out;
    if (!handle_) return out;
    PVMMDLL_PROCESS_INFORMATION all = nullptr;
    DWORD count = 0;
    if (!VMMDLL_ProcessGetInformationAll(handle_, &all, &count) || !all) return out;
    out.reserve(count);
    for (DWORD i = 0; i < count; ++i) {
        const auto& p = all[i];
        const char* name = p.szNameLong[0] ? p.szNameLong : p.szName;
        out.push_back({.pid = p.dwPID,
                       .parentPid = p.dwPPID,
                       .name = std::string(name, ::strnlen(name, p.szNameLong[0] ? sizeof(p.szNameLong)
                                                                                 : sizeof(p.szName))),
                       .running = p.dwState == 0,
                       .wow64 = p.win.fWow64 != 0});
    }
    VMMDLL_MemFree(all);
    return out;
}

std::optional<VmmBackend::WindowsVersion> VmmBackend::windowsVersion() {
    if (!handle_) return std::nullopt;
    ULONG64 major = 0, minor = 0, build = 0;
    if (!VMMDLL_ConfigGet(handle_, VMMDLL_OPT_WIN_VERSION_MAJOR, &major) ||
        !VMMDLL_ConfigGet(handle_, VMMDLL_OPT_WIN_VERSION_MINOR, &minor) ||
        !VMMDLL_ConfigGet(handle_, VMMDLL_OPT_WIN_VERSION_BUILD, &build) || major == 0) {
        return std::nullopt;
    }
    return WindowsVersion{static_cast<std::uint32_t>(major), static_cast<std::uint32_t>(minor),
                          static_cast<std::uint32_t>(build)};
}

Limits VmmBackend::limits() const {
    // VMM itself has no small per-batch limit (reads up to 1 GiB are accepted). Keep batches to a
    // sane size so a single failure doesn't stall a huge batch; tune with measurements.
    return Limits{.maxRequestsPerBatch = 4096, .maxBytesPerRequest = 16u * 1024 * 1024};
}

}  // namespace radar::mem
