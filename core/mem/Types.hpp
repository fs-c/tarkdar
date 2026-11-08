#pragma once

#include <cstddef>
#include <cstdint>

namespace radar::mem {

using Pid = std::uint32_t;
using Address = std::uint64_t;

struct ModuleInfo {
    Address base = 0;
    std::uint64_t size = 0;
};

// Hint only. Backends without a cache ignore it.
//  Cached: may be served from a backend cache (static data: templates, names, class metadata).
//  Fresh:  bypass caches (anything that changes in-game: positions, rosters, raid discovery).
enum class Freshness { Cached, Fresh };

// One element of a batched read. `bytesRead` is always written by the backend. Bytes that could
// not be read are zero-filled: most consumers follow pointers, where 0 already means "invalid".
// Caveat: bytesRead is only a weak failure signal. With VMM, an unmapped or paged-out page inside
// the guest's physical memory can come back zero-filled AND counted as read. So never treat a
// complete read as proof the data is real: validate pointers, counts and values (as the readers do).
struct ReadRequest {
    Address va = 0;
    void* dst = nullptr;
    std::uint32_t size = 0;
    std::uint32_t bytesRead = 0;

    [[nodiscard]] bool complete() const noexcept { return size != 0 && bytesRead == size; }
};

struct Limits {
    std::size_t maxRequestsPerBatch = 0;  // 0 = unlimited
    std::size_t maxBytesPerRequest = 0;   // 0 = unlimited
};

}  // namespace radar::mem
