#pragma once

#include "core/mem/Types.hpp"

#include <expected>
#include <optional>
#include <span>
#include <string>
#include <string_view>

namespace radar::mem {

// Raw access to a target machine's processes. Implementations: VmmBackend (QEMU
// guest or dump file via VMM) and FakeBackend (tests). Planned: Recording/ReplayBackend, which
// log reads and replay them later for offline development with moving game state.
//
// Read semantics, common to all implementations:
//  - Bytes that could not be read are zero-filled. Callers that care check the return value or
//    ReadRequest::bytesRead; most consumers are pointer chains where 0 already means "invalid".
//  - Reads must be safe to issue concurrently from several threads.
class IMemoryBackend {
public:
    virtual ~IMemoryBackend() = default;

    // Configuration is passed at construction; open() connects.
    virtual std::expected<void, std::string> open() = 0;
    virtual void close() = 0;
    [[nodiscard]] virtual bool isOpen() const = 0;

    [[nodiscard]] virtual std::optional<Pid> findProcess(std::string_view imageName) = 0;
    [[nodiscard]] virtual std::optional<ModuleInfo> findModule(Pid pid, std::string_view name) = 0;
    [[nodiscard]] virtual bool processAlive(Pid pid) = 0;

    // Returns true only if every byte was read.
    virtual bool read(Pid pid, Address va, std::span<std::byte> dst, Freshness freshness) = 0;
    // Fills bytesRead for every request. Batches larger than limits() must be split by the caller
    // (MemoryView / ReadBatch do this).
    virtual void readMany(Pid pid, std::span<ReadRequest> requests, Freshness freshness) = 0;

    [[nodiscard]] virtual Limits limits() const = 0;
    // Optional periodic upkeep (e.g. cache refresh). Default: nothing to do.
    virtual void maintenance() {}
};

}  // namespace radar::mem
