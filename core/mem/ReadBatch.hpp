#pragma once

#include "core/mem/MemoryView.hpp"

#include <cstddef>
#include <cstdint>
#include <optional>
#include <span>
#include <type_traits>
#include <vector>

namespace radar::mem {

// Collects reads and executes them as batched backend reads. Requests are split to respect the
// backend's limits(); results are reassembled per request. Destination buffers must stay valid
// until execute() returns. Single-use: one execute() per batch.
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
    [[nodiscard]] bool complete(Handle h) const {
        const Entry& e = entries_.at(h);
        return e.size != 0 && e.bytesRead == e.size;
    }
    [[nodiscard]] std::size_t bytesRead(Handle h) const { return entries_.at(h).bytesRead; }

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

// One T from each address, in a single batch. Result[i] is empty if the read of addresses[i]
// failed (or was a null address); results line up with the input.
template <class T>
[[nodiscard]] std::vector<std::optional<T>> readEach(const MemoryView& mem, std::span<const Address> addresses,
                                                     Freshness freshness = Freshness::Cached) {
    std::vector<T> values(addresses.size());
    std::vector<ReadBatch::Handle> handles;
    handles.reserve(addresses.size());
    ReadBatch batch(mem);
    for (std::size_t i = 0; i < addresses.size(); ++i) handles.push_back(batch.add(addresses[i], values[i]));
    batch.execute(freshness);
    std::vector<std::optional<T>> out(addresses.size());
    for (std::size_t i = 0; i < addresses.size(); ++i)
        if (batch.complete(handles[i])) out[i] = values[i];
    return out;
}

// The same for a field at `offset` inside each object. A null object stays a null address
// (a failed read) instead of becoming a read at `offset`.
template <class T>
[[nodiscard]] std::vector<std::optional<T>> readEach(const MemoryView& mem, std::span<const Address> objects,
                                                     std::uint32_t offset, Freshness freshness = Freshness::Cached) {
    std::vector<Address> addresses(objects.size());
    for (std::size_t i = 0; i < objects.size(); ++i) addresses[i] = objects[i] ? objects[i] + offset : 0;
    return readEach<T>(mem, addresses, freshness);
}

}  // namespace radar::mem
