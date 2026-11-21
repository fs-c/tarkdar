#pragma once

#include <algorithm>
#include <string>
#include <string_view>

// ASCII-only case folding (locale-independent; bytes >= 0x80 are left alone).
namespace radar::text {

[[nodiscard]] constexpr char lowerAscii(char c) noexcept { return c >= 'A' && c <= 'Z' ? static_cast<char>(c - 'A' + 'a') : c; }

[[nodiscard]] inline std::string lowerAscii(std::string_view s) {
    std::string out(s);
    std::ranges::transform(out, out.begin(), [](char c) { return lowerAscii(c); });
    return out;
}

[[nodiscard]] constexpr bool equalsIgnoreCase(std::string_view a, std::string_view b) noexcept {
    return a.size() == b.size() && std::ranges::equal(a, b, [](char x, char y) { return lowerAscii(x) == lowerAscii(y); });
}

[[nodiscard]] constexpr bool startsWithIgnoreCase(std::string_view s, std::string_view prefix) noexcept {
    return s.size() >= prefix.size() && equalsIgnoreCase(s.substr(0, prefix.size()), prefix);
}

[[nodiscard]] constexpr bool containsIgnoreCase(std::string_view haystack, std::string_view needle) noexcept {
    return !std::ranges::search(haystack, needle, [](char x, char y) { return lowerAscii(x) == lowerAscii(y); }).empty() ||
           needle.empty();
}

}  // namespace radar::text
