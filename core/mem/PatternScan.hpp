#pragma once

#include "core/mem/MemoryView.hpp"

#include <cstdint>
#include <optional>
#include <span>
#include <string>
#include <string_view>
#include <vector>

// Byte-pattern scanning over a loaded module's code (for locating globals by the instructions that
// reference them).
namespace radar::mem {

// A byte pattern such as "48 8B 05 ? ? ? ? 48 85 C0". "?" (or "??") matches any byte.
struct Pattern {
    std::vector<std::int16_t> bytes;  // 0..255, or -1 for a wildcard

    // nullopt if the text isn't a valid pattern (or is empty / all wildcards).
    [[nodiscard]] static std::optional<Pattern> parse(std::string_view text);
    [[nodiscard]] std::size_t size() const noexcept { return bytes.size(); }
    [[nodiscard]] bool matchesAt(std::span<const std::uint8_t> data, std::size_t at) const;
};

struct Region {
    Address start = 0;
    std::size_t size = 0;
};

// Executable sections of a loaded PE image (IMAGE_SCN_CNT_CODE or IMAGE_SCN_MEM_EXECUTE), clamped to
// the image. Falls back to the whole image if the section table can't be read.
[[nodiscard]] std::vector<Region> codeRegions(const MemoryView& mem, Address imageBase, std::size_t imageSize);

// Scans the regions for every pattern in one pass, reading `chunkSize` bytes at a time with enough
// overlap that matches spanning chunk boundaries are found exactly once. Returns, per pattern, the
// addresses of up to `limit` matches in ascending order.
[[nodiscard]] std::vector<std::vector<Address>> scan(const MemoryView& mem, std::span<const Region> regions,
                                                     std::span<const Pattern> patterns, std::size_t limit,
                                                     std::size_t chunkSize = 1u << 20);

// Target of a RIP-relative operand: instruction at `insn`, int32 displacement at insn + dispOffset,
// next instruction at insn + insnLength. nullopt if the displacement can't be read.
[[nodiscard]] std::optional<Address> ripTarget(const MemoryView& mem, Address insn, std::uint32_t dispOffset,
                                               std::uint32_t insnLength);

}  // namespace radar::mem
