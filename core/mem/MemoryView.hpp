#pragma once

#include "core/mem/MemoryBackend.hpp"

#include <array>
#include <cstring>
#include <optional>
#include <span>
#include <string>
#include <type_traits>

namespace radar::mem {

// Typed reads in one process's address space. Cheap to copy; doesn't own the
// backend. All reads zero-fill on failure.
class MemoryView {
public:
    MemoryView(IMemoryBackend& backend, Pid pid) : backend_(&backend), pid_(pid) {}

    [[nodiscard]] Pid pid() const noexcept { return pid_; }
    [[nodiscard]] IMemoryBackend& backend() const noexcept { return *backend_; }

    // The one pointer-validity rule: a canonical user-mode address, clear of the null page
    // region. Used for every pointer read from game memory.
    [[nodiscard]] static constexpr bool isUserPointer(Address p) noexcept {
        return p >= 0x10000 && p < 0x7FFF'FFFF'0000ull;
    }

    bool readBytes(Address va, std::span<std::byte> dst,
                   Freshness freshness = Freshness::Cached) const {
        return backend_->read(pid_, va, dst, freshness);
    }

    // True if all of T was read. `out` is zero on failure.
    template <class T>
    bool tryRead(Address va, T& out, Freshness freshness = Freshness::Cached) const {
        static_assert(std::is_trivially_copyable_v<T>);
        return readBytes(va, std::as_writable_bytes(std::span{&out, 1}), freshness);
    }

    // Value, or zero/default on failure.
    template <class T>
    [[nodiscard]] T read(Address va, Freshness freshness = Freshness::Cached) const {
        static_assert(std::is_trivially_copyable_v<T> && std::is_default_constructible_v<T>);
        T value{};
        tryRead(va, value, freshness);
        return value;
    }

    // Follows a pointer chain: cur = base; for each offset: cur = *(u64*)(cur + offset).
    // Every intermediate value must be a user pointer. The final value is returned without
    // validation (it may be a non-pointer field). Fails on an empty chain or a failed read.
    [[nodiscard]] std::optional<std::uint64_t> readChain(
        Address base, std::span<const std::uint32_t> offsets,
        Freshness freshness = Freshness::Cached) const;

    // NUL-terminated narrow string (native Unity names, IL2CPP class names). Reads up to
    // maxBytes and cuts at the first NUL; invalid UTF-8 is replaced with U+FFFD. Empty on failure.
    [[nodiscard]] std::string readCString(Address va, std::size_t maxBytes = 256,
                                          Freshness freshness = Freshness::Cached) const;

private:
    IMemoryBackend* backend_;
    Pid pid_;
};

}  // namespace radar::mem
