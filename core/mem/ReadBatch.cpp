#include "core/mem/ReadBatch.hpp"

#include <algorithm>
#include <cstring>
#include <limits>

namespace radar::mem {

ReadBatch::Handle ReadBatch::addBytes(Address va, void* dst, std::size_t size) {
    entries_.push_back(Entry{va, static_cast<std::byte*>(dst), size});
    return entries_.size() - 1;
}

void ReadBatch::execute(Freshness freshness) {
    const Limits limits = mem_.backend().limits();
    const std::size_t maxChunk = std::min<std::size_t>(
        limits.maxBytesPerRequest ? limits.maxBytesPerRequest : std::numeric_limits<std::uint32_t>::max(),
        std::numeric_limits<std::uint32_t>::max());
    const std::size_t maxRequests =
        limits.maxRequestsPerBatch ? limits.maxRequestsPerBatch : std::numeric_limits<std::size_t>::max();

    // Split every entry into backend requests of at most maxChunk bytes.
    struct Piece {
        std::size_t entry;
        std::size_t offset;
    };
    std::vector<ReadRequest> requests;
    std::vector<Piece> pieces;
    for (std::size_t i = 0; i < entries_.size(); ++i) {
        Entry& e = entries_[i];
        e.bytesRead = 0;
        if (!e.dst || e.size == 0) continue;
        std::memset(e.dst, 0, e.size);
        if (e.va == 0) continue;
        for (std::size_t off = 0; off < e.size; off += maxChunk) {
            const std::size_t n = std::min(maxChunk, e.size - off);
            requests.push_back(ReadRequest{e.va + off, e.dst + off, static_cast<std::uint32_t>(n), 0});
            pieces.push_back(Piece{i, off});
        }
    }

    for (std::size_t start = 0; start < requests.size(); start += maxRequests) {
        const std::size_t n = std::min(maxRequests, requests.size() - start);
        mem_.backend().readMany(mem_.pid(), std::span(requests).subspan(start, n), freshness);
    }

    // bytesRead per entry = leading contiguous bytes read across its pieces (pieces are in order).
    std::vector<bool> broken(entries_.size(), false);
    for (std::size_t p = 0; p < pieces.size(); ++p) {
        Entry& e = entries_[pieces[p].entry];
        if (broken[pieces[p].entry]) continue;
        e.bytesRead += requests[p].bytesRead;
        if (requests[p].bytesRead != requests[p].size) broken[pieces[p].entry] = true;
    }
}

}  // namespace radar::mem
