#include "core/mem/PatternScan.hpp"

#include <algorithm>
#include <cstring>

namespace radar::mem {

namespace {
constexpr std::uint32_t kScnCntCode = 0x00000020;
constexpr std::uint32_t kScnMemExecute = 0x20000000;
constexpr std::uint32_t kMaxSections = 96;
constexpr std::uint32_t kSectionHeaderSize = 40;

int hexValue(char c) {
    if (c >= '0' && c <= '9') return c - '0';
    if (c >= 'a' && c <= 'f') return c - 'a' + 10;
    if (c >= 'A' && c <= 'F') return c - 'A' + 10;
    return -1;
}
}  // namespace

std::optional<Pattern> Pattern::parse(std::string_view text) {
    Pattern p;
    bool anyFixed = false;
    std::size_t i = 0;
    while (i < text.size()) {
        if (text[i] == ' ') {
            ++i;
            continue;
        }
        std::size_t j = i;
        while (j < text.size() && text[j] != ' ') ++j;
        const std::string_view token = text.substr(i, j - i);
        if (token == "?" || token == "??") {
            p.bytes.push_back(-1);
        } else if (token.size() == 2 && hexValue(token[0]) >= 0 && hexValue(token[1]) >= 0) {
            p.bytes.push_back(static_cast<std::int16_t>(hexValue(token[0]) * 16 + hexValue(token[1])));
            anyFixed = true;
        } else {
            return std::nullopt;
        }
        i = j;
    }
    if (!anyFixed) return std::nullopt;
    return p;
}

bool Pattern::matchesAt(std::span<const std::uint8_t> data, std::size_t at) const {
    if (at + bytes.size() > data.size()) return false;
    for (std::size_t k = 0; k < bytes.size(); ++k)
        if (bytes[k] >= 0 && data[at + k] != static_cast<std::uint8_t>(bytes[k])) return false;
    return true;
}

std::vector<Region> codeRegions(const MemoryView& mem, Address base, std::size_t imageSize) {
    const std::vector<Region> whole{{base, imageSize}};
    std::uint16_t dosMagic = 0;
    std::uint32_t lfanew = 0;
    if (!mem.tryRead(base, dosMagic) || dosMagic != 0x5A4D || !mem.tryRead(base + 0x3C, lfanew) || lfanew == 0 ||
        lfanew > 0x1000)
        return whole;
    const Address nt = base + lfanew;
    std::uint32_t signature = 0;
    std::uint16_t sectionCount = 0, optionalSize = 0;
    if (!mem.tryRead(nt, signature) || signature != 0x00004550 || !mem.tryRead(nt + 4 + 2, sectionCount) ||
        !mem.tryRead(nt + 4 + 16, optionalSize))
        return whole;
    sectionCount = std::min<std::uint16_t>(sectionCount, kMaxSections);
    const Address table = nt + 4 + 20 + optionalSize;

    std::vector<Region> regions;
    for (std::uint16_t i = 0; i < sectionCount; ++i) {
        std::uint8_t header[kSectionHeaderSize]{};
        if (!mem.readBytes(table + i * kSectionHeaderSize, std::as_writable_bytes(std::span{header}))) return whole;
        std::uint32_t virtualSize, virtualAddress, rawSize, characteristics;
        std::memcpy(&virtualSize, header + 8, 4);
        std::memcpy(&virtualAddress, header + 12, 4);
        std::memcpy(&rawSize, header + 16, 4);
        std::memcpy(&characteristics, header + 36, 4);
        if (!(characteristics & (kScnCntCode | kScnMemExecute))) continue;
        if (virtualAddress >= imageSize) continue;
        const std::size_t size = std::min<std::size_t>(std::max(virtualSize, rawSize), imageSize - virtualAddress);
        if (size) regions.push_back({base + virtualAddress, size});
    }
    return regions.empty() ? whole : regions;
}

std::vector<std::vector<Address>> scan(const MemoryView& mem, std::span<const Region> regions,
                                       std::span<const Pattern> patterns, std::size_t limit, std::size_t chunkSize) {
    std::vector<std::vector<Address>> out(patterns.size());
    std::size_t longest = 0;
    for (const auto& p : patterns) longest = std::max(longest, p.size());
    if (longest == 0 || limit == 0) return out;
    chunkSize = std::max(chunkSize, longest * 2);
    const std::size_t overlap = longest - 1;

    std::vector<std::uint8_t> buf;
    for (const Region& region : regions) {
        for (std::size_t offset = 0; offset < region.size; offset += chunkSize) {
            // Read [offset, offset + chunkSize + overlap); a match must *start* before offset + chunkSize,
            // so a match spanning the boundary is seen in this chunk and not again in the next.
            const std::size_t readSize = std::min(chunkSize + overlap, region.size - offset);
            buf.assign(readSize, 0);
            mem.readBytes(region.start + offset, std::as_writable_bytes(std::span{buf}));  // gaps read as zeros
            const std::size_t starts = std::min(chunkSize, readSize);
            for (std::size_t pi = 0; pi < patterns.size(); ++pi) {
                const Pattern& p = patterns[pi];
                if (out[pi].size() >= limit) continue;
                // Anchor on the first fixed byte to skip quickly.
                std::size_t anchor = 0;
                while (p.bytes[anchor] < 0) ++anchor;
                const auto anchorByte = static_cast<std::uint8_t>(p.bytes[anchor]);
                std::size_t s = 0;
                while (s < starts && out[pi].size() < limit) {
                    const std::size_t from = s + anchor;
                    const std::size_t to = std::min(starts + anchor, readSize);  // exclusive
                    if (from >= to) break;
                    const void* hit = std::memchr(buf.data() + from, anchorByte, to - from);
                    if (!hit) break;
                    s = static_cast<std::size_t>(static_cast<const std::uint8_t*>(hit) - buf.data()) - anchor;
                    if (p.matchesAt(buf, s)) out[pi].push_back(region.start + offset + s);
                    ++s;
                }
            }
        }
    }
    return out;
}

std::optional<Address> ripTarget(const MemoryView& mem, Address insn, std::uint32_t dispOffset,
                                 std::uint32_t insnLength) {
    std::int32_t disp = 0;
    if (!mem.tryRead(insn + dispOffset, disp)) return std::nullopt;
    return static_cast<Address>(static_cast<std::int64_t>(insn + insnLength) + disp);
}

}  // namespace radar::mem
