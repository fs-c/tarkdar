#include "core/text/Utf16.hpp"

namespace radar::text {

namespace {
void appendUtf8(std::string& out, char32_t cp) {
    if (cp < 0x80) {
        out.push_back(static_cast<char>(cp));
    } else if (cp < 0x800) {
        out.push_back(static_cast<char>(0xC0 | (cp >> 6)));
        out.push_back(static_cast<char>(0x80 | (cp & 0x3F)));
    } else if (cp < 0x10000) {
        out.push_back(static_cast<char>(0xE0 | (cp >> 12)));
        out.push_back(static_cast<char>(0x80 | ((cp >> 6) & 0x3F)));
        out.push_back(static_cast<char>(0x80 | (cp & 0x3F)));
    } else {
        out.push_back(static_cast<char>(0xF0 | (cp >> 18)));
        out.push_back(static_cast<char>(0x80 | ((cp >> 12) & 0x3F)));
        out.push_back(static_cast<char>(0x80 | ((cp >> 6) & 0x3F)));
        out.push_back(static_cast<char>(0x80 | (cp & 0x3F)));
    }
}
constexpr char32_t kReplacement = 0xFFFD;
}  // namespace

std::string utf16ToUtf8(std::span<const char16_t> in) {
    std::string out;
    out.reserve(in.size());
    for (std::size_t i = 0; i < in.size(); ++i) {
        const char16_t u = in[i];
        if (u == 0) break;
        if (u >= 0xD800 && u <= 0xDBFF) {  // high surrogate
            if (i + 1 < in.size() && in[i + 1] >= 0xDC00 && in[i + 1] <= 0xDFFF) {
                const char32_t cp = 0x10000 + ((char32_t(u) - 0xD800) << 10) + (char32_t(in[i + 1]) - 0xDC00);
                appendUtf8(out, cp);
                ++i;
            } else {
                appendUtf8(out, kReplacement);
            }
        } else if (u >= 0xDC00 && u <= 0xDFFF) {  // lone low surrogate
            appendUtf8(out, kReplacement);
        } else {
            appendUtf8(out, u);
        }
    }
    return out;
}

std::string sanitizeUtf8(std::string_view in) {
    std::string out;
    out.reserve(in.size());
    std::size_t i = 0;
    const auto byte = [&](std::size_t k) { return static_cast<unsigned char>(in[k]); };
    while (i < in.size()) {
        const unsigned char c = byte(i);
        std::size_t len = 0;
        char32_t cp = 0;
        if (c < 0x80) {
            out.push_back(static_cast<char>(c));
            ++i;
            continue;
        }
        if (c >= 0xC2 && c <= 0xDF) { len = 2; cp = c & 0x1F; }
        else if (c >= 0xE0 && c <= 0xEF) { len = 3; cp = c & 0x0F; }
        else if (c >= 0xF0 && c <= 0xF4) { len = 4; cp = c & 0x07; }
        bool valid = len != 0 && i + len <= in.size();
        for (std::size_t k = 1; valid && k < len; ++k) {
            if ((byte(i + k) & 0xC0) != 0x80) valid = false;
            else cp = (cp << 6) | (byte(i + k) & 0x3F);
        }
        // Reject overlong encodings, surrogates and out-of-range code points.
        if (valid && ((len == 3 && cp < 0x800) || (len == 4 && (cp < 0x10000 || cp > 0x10FFFF)) ||
                      (cp >= 0xD800 && cp <= 0xDFFF)))
            valid = false;
        if (valid) {
            out.append(in.substr(i, len));
            i += len;
        } else {
            appendUtf8(out, kReplacement);
            ++i;
        }
    }
    return out;
}

}  // namespace radar::text
