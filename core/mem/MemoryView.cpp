#include "core/mem/MemoryView.hpp"

#include "core/text/Utf16.hpp"

#include <algorithm>
#include <vector>

namespace radar::mem {

std::optional<std::uint64_t> MemoryView::readChain(Address base,
                                                   std::span<const std::uint32_t> offsets,
                                                   Freshness freshness) const {
    if (offsets.empty() || !isUserPointer(base)) return std::nullopt;
    std::uint64_t cur = base;
    for (std::size_t i = 0; i < offsets.size(); ++i) {
        const Address field = cur + offsets[i];
        if (!isUserPointer(field)) return std::nullopt;
        if (!tryRead(field, cur, freshness)) return std::nullopt;
        if (i + 1 < offsets.size() && !isUserPointer(cur)) return std::nullopt;
    }
    return cur;
}

std::string MemoryView::readCString(Address va, std::size_t maxBytes, Freshness freshness) const {
    constexpr std::size_t kCap = 4096;
    maxBytes = std::min(maxBytes, kCap);
    if (maxBytes == 0 || !isUserPointer(va)) return {};
    std::vector<char> buf(maxBytes);
    // A partial read still yields usable bytes before the failure point (the rest is zeros),
    // so the result is used regardless of the return value.
    readBytes(va, std::as_writable_bytes(std::span{buf}), freshness);
    const auto end = std::find(buf.begin(), buf.end(), '\0');
    return text::sanitizeUtf8(std::string_view(buf.data(), static_cast<std::size_t>(end - buf.begin())));
}

}  // namespace radar::mem
