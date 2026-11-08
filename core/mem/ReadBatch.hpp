#pragma once

#include "core/mem/MemoryView.hpp"

#include <cstddef>
#include <type_traits>
#include <vector>

namespace radar::mem {

// Collects reads and executes them as batched backend reads. Requests are split to respect the
// backend's limits(); results are reassembled per request. Destination buffers must stay valid
// until execute() returns. Single-use per execute(); call clear() to reuse.
//
//   ReadBatch batch(mem);
//   auto a = batch.add(addrA, valueA);
//   auto b = batch.addBytes(addrB, buffer, size);
//   batch.execute(Freshness::Fresh);
//   if (batch.complete(a)) ...
class ReadBatch {
public:
    using Handle = std::size_t;

    explicit ReadBatch(const MemoryView& mem) : mem_(mem) {}

    Handle addBytes(Address va, void* dst, std::size_t size);

    template <class T>
    Handle add(Address va, T& out) {
        static_assert(std::is_trivially_copyable_v<T>);
        return addBytes(va, &out, sizeof(T));
    }

    void execute(Freshness freshness = Freshness::Cached);

    // True if every byte of the request was read. Failed bytes are zero.
    [[nodiscard]] bool complete(Handle h) const { return entries_.at(h).bytesRead == entries_.at(h).size; }
    [[nodiscard]] std::size_t bytesRead(Handle h) const { return entries_.at(h).bytesRead; }
    [[nodiscard]] std::size_t size() const noexcept { return entries_.size(); }
    [[nodiscard]] bool empty() const noexcept { return entries_.empty(); }
    void clear() { entries_.clear(); }

private:
    struct Entry {
        Address va;
        std::byte* dst;
        std::size_t size;
        std::size_t bytesRead = 0;
    };

    MemoryView mem_;
    std::vector<Entry> entries_;
};

}  // namespace radar::mem
