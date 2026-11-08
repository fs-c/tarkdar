#pragma once

#include <span>
#include <string>
#include <string_view>

namespace radar::text {

// UTF-16LE → UTF-8. Stops at the first NUL. Unpaired surrogates become U+FFFD.
// (Managed strings are UTF-16; never use wchar_t for them: it is 4 bytes on Linux.)
[[nodiscard]] std::string utf16ToUtf8(std::span<const char16_t> in);

// Returns `in` with every invalid UTF-8 sequence (stray bytes, truncated or overlong sequences,
// surrogates, code points above U+10FFFF) replaced by U+FFFD. Strings read from game memory go
// through this before reaching JSON, where invalid UTF-8 breaks WebSocket text frames.
[[nodiscard]] std::string sanitizeUtf8(std::string_view in);

}  // namespace radar::text
