#pragma once

#include "core/mem/MemoryBackend.hpp"

#include <string>
#include <vector>

struct tdVMM_HANDLE;  // from vmmdll.h; kept out of this header so Windows-style macros don't leak

namespace radar::mem {

struct VmmConfig {
    // LeechCore device string, e.g. "qemu://hugepage-pid=1234" (QEMU guest) or a path to a raw
    // memory dump file.
    std::string device;
    // Extra VMM arguments, appended verbatim (e.g. "-v", "-vv").
    std::vector<std::string> extraArgs;
    // Print VMM's own messages to stdout.
    bool vmmPrintf = false;
};

// IMemoryBackend over MemProcFS's VMM library (vmm.so → leechcore.so → device plugin).
// VMM handles process lookup, module lookup and virtual-to-physical translation; LeechCore only
// provides physical memory.
class VmmBackend final : public IMemoryBackend {
public:
    // Pass as pid to read guest physical memory instead of a process's virtual memory.
    static constexpr Pid kPhysicalMemory = 0xFFFFFFFFu;

    struct PhysicalRange {
        Address base = 0;
        std::uint64_t size = 0;
    };

    struct ProcessEntry {
        Pid pid = 0;
        Pid parentPid = 0;
        std::string name;  // long image name (VMM truncates to 63 chars)
        bool running = false;  // EPROCESS state 0
        bool wow64 = false;
    };

    struct WindowsVersion {
        std::uint32_t major = 0, minor = 0, build = 0;
    };

    explicit VmmBackend(VmmConfig config);
    ~VmmBackend() override;

    VmmBackend(const VmmBackend&) = delete;
    VmmBackend& operator=(const VmmBackend&) = delete;

    std::expected<void, std::string> open() override;
    void close() override;
    [[nodiscard]] bool isOpen() const override { return handle_ != nullptr; }

    [[nodiscard]] std::optional<Pid> findProcess(std::string_view imageName) override;
    [[nodiscard]] std::optional<ModuleInfo> findModule(Pid pid, std::string_view name) override;
    [[nodiscard]] bool processAlive(Pid pid) override;

    bool read(Pid pid, Address va, std::span<std::byte> dst, Freshness freshness) override;
    void readMany(Pid pid, std::span<ReadRequest> requests, Freshness freshness) override;

    [[nodiscard]] Limits limits() const override;

    // The guest's physical memory map (RAM ranges, as the guest OS sees them). Empty on failure.
    [[nodiscard]] std::vector<PhysicalRange> physicalMemoryMap();
    // Every process VMM knows about, including terminated ones. Empty on failure.
    [[nodiscard]] std::vector<ProcessEntry> processes();
    // Guest Windows version as detected by VMM; nullopt if unknown.
    [[nodiscard]] std::optional<WindowsVersion> windowsVersion();

private:
    VmmConfig config_;
    tdVMM_HANDLE* handle_ = nullptr;
};

}  // namespace radar::mem
