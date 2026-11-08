#pragma once

#include "core/mem/MemoryView.hpp"

#include <cstdint>
#include <optional>

namespace radar::mem {

// Identifies a specific build of a PE image loaded in memory.
struct PeFingerprint {
    std::uint32_t timeDateStamp = 0;  // IMAGE_FILE_HEADER.TimeDateStamp
    std::uint32_t sizeOfImage = 0;    // IMAGE_OPTIONAL_HEADER64.SizeOfImage

    friend bool operator==(const PeFingerprint&, const PeFingerprint&) = default;
};

// Reads the fingerprint from the PE headers of a loaded 64-bit image. nullopt if the headers
// don't look like a valid PE32+ image.
[[nodiscard]] std::optional<PeFingerprint> readPeFingerprint(const MemoryView& mem,
                                                             Address imageBase);

}  // namespace radar::mem
