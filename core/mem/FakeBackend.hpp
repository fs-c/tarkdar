#pragma once

#include "core/mem/MemoryBackend.hpp"

#include <algorithm>
#include <cstring>
#include <map>
#include <mutex>
#include <string>
#include <vector>

namespace radar::mem {

// In-memory IMemoryBackend for unit tests. Holds sparse memory regions, processes
// and modules that tests set up explicitly. Thread-safe.
class FakeBackend final : public IMemoryBackend {
public:
    // ---- test setup ------------------------------------------------------------------------
    void addProcess(std::string name, Pid pid) {
        std::lock_guard lock(mutex_);
        processes_[std::move(name)] = pid;
        alive_[pid] = true;
    }
    void killProcess(Pid pid) {
        std::lock_guard lock(mutex_);
        alive_[pid] = false;
        std::erase_if(processes_, [&](const auto& kv) { return kv.second == pid; });
    }
    void addModule(Pid pid, std::string name, ModuleInfo info) {
        std::lock_guard lock(mutex_);
        modules_[{pid, std::move(name)}] = info;
    }
    // Writes bytes into a region (regions may be written piecewise; overlapping writes merge).
    void write(Pid pid, Address va, const void* data, std::size_t size) {
        std::lock_guard lock(mutex_);
        auto& mem = memory_[pid];
        const auto* bytes = static_cast<const std::byte*>(data);
        for (std::size_t i = 0; i < size; ++i) mem[va + i] = bytes[i];
    }
    template <class T>
    void writeValue(Pid pid, Address va, const T& value) {
        write(pid, va, &value, sizeof(T));
    }
    void setOpenResult(bool ok) { openOk_ = ok; }
    [[nodiscard]] std::size_t readCalls() const {
        std::lock_guard lock(mutex_);
        return readCalls_;
    }

    // ---- IMemoryBackend ----------------------------------------------------------------------
    std::expected<void, std::string> open() override {
        if (!openOk_) return std::unexpected("fake open failure");
        open_ = true;
        return {};
    }
    void close() override { open_ = false; }
    [[nodiscard]] bool isOpen() const override { return open_; }

    [[nodiscard]] std::optional<Pid> findProcess(std::string_view imageName) override {
        std::lock_guard lock(mutex_);
        if (auto it = processes_.find(std::string(imageName)); it != processes_.end())
            return it->second;
        return std::nullopt;
    }
    [[nodiscard]] std::optional<ModuleInfo> findModule(Pid pid, std::string_view name) override {
        std::lock_guard lock(mutex_);
        if (auto it = modules_.find({pid, std::string(name)}); it != modules_.end())
            return it->second;
        return std::nullopt;
    }
    [[nodiscard]] bool processAlive(Pid pid) override {
        std::lock_guard lock(mutex_);
        auto it = alive_.find(pid);
        return it != alive_.end() && it->second;
    }

    bool read(Pid pid, Address va, std::span<std::byte> dst, Freshness) override {
        std::lock_guard lock(mutex_);
        ++readCalls_;
        return readLocked(pid, va, dst.data(), dst.size()) == dst.size() && !dst.empty();
    }
    void readMany(Pid pid, std::span<ReadRequest> requests, Freshness) override {
        std::lock_guard lock(mutex_);
        ++readCalls_;
        for (auto& r : requests)
            r.bytesRead = static_cast<std::uint32_t>(readLocked(pid, r.va, r.dst, r.size));
    }
    [[nodiscard]] Limits limits() const override { return limits_; }
    void setLimits(Limits limits) { limits_ = limits; }

private:
    // Zero-fills dst, copies known bytes, returns the count of leading bytes that were present.
    std::size_t readLocked(Pid pid, Address va, void* dst, std::size_t size) const {
        if (!dst || size == 0) return 0;
        auto* out = static_cast<std::byte*>(dst);
        std::memset(out, 0, size);
        if (!open_ || va == 0) return 0;
        auto memIt = memory_.find(pid);
        if (memIt == memory_.end()) return 0;
        std::size_t leading = 0;
        bool contiguous = true;
        for (std::size_t i = 0; i < size; ++i) {
            auto it = memIt->second.find(va + i);
            if (it != memIt->second.end()) {
                out[i] = it->second;
                if (contiguous) ++leading;
            } else {
                contiguous = false;
            }
        }
        return leading;
    }

    mutable std::mutex mutex_;
    bool openOk_ = true;
    bool open_ = false;
    std::size_t readCalls_ = 0;
    Limits limits_{};
    std::map<std::string, Pid> processes_;
    std::map<Pid, bool> alive_;
    std::map<std::pair<Pid, std::string>, ModuleInfo> modules_;
    std::map<Pid, std::map<Address, std::byte>> memory_;
};

}  // namespace radar::mem
