#include "core/mem/Pe.hpp"

namespace radar::mem {

namespace {
// Standard PE/COFF layout constants.
constexpr std::uint16_t kDosMagic = 0x5A4D;          // "MZ"
constexpr std::uint32_t kNtSignature = 0x00004550;   // "PE\0\0"
constexpr std::uint16_t kPe32PlusMagic = 0x20B;
constexpr std::uint32_t kDosLfanewOffset = 0x3C;
constexpr std::uint32_t kFileHeaderOffset = 4;       // after the NT signature
constexpr std::uint32_t kTimeDateStampOffset = kFileHeaderOffset + 4;
constexpr std::uint32_t kOptionalHeaderOffset = kFileHeaderOffset + 20;
constexpr std::uint32_t kSizeOfImageOffset = kOptionalHeaderOffset + 56;
constexpr std::uint32_t kMaxLfanew = 0x1000;
}  // namespace

std::optional<PeFingerprint> readPeFingerprint(const MemoryView& mem, Address imageBase) {
    if (!MemoryView::isUserPointer(imageBase)) return std::nullopt;

    std::uint16_t dosMagic = 0;
    std::uint32_t lfanew = 0;
    if (!mem.tryRead(imageBase, dosMagic) || dosMagic != kDosMagic) return std::nullopt;
    if (!mem.tryRead(imageBase + kDosLfanewOffset, lfanew) || lfanew == 0 || lfanew > kMaxLfanew)
        return std::nullopt;

    const Address nt = imageBase + lfanew;
    std::uint32_t signature = 0;
    std::uint16_t optionalMagic = 0;
    PeFingerprint fp;
    if (!mem.tryRead(nt, signature) || signature != kNtSignature) return std::nullopt;
    if (!mem.tryRead(nt + kOptionalHeaderOffset, optionalMagic) || optionalMagic != kPe32PlusMagic)
        return std::nullopt;
    if (!mem.tryRead(nt + kTimeDateStampOffset, fp.timeDateStamp)) return std::nullopt;
    if (!mem.tryRead(nt + kSizeOfImageOffset, fp.sizeOfImage) || fp.sizeOfImage == 0)
        return std::nullopt;
    return fp;
}

}  // namespace radar::mem
