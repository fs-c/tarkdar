#include "game/eft/BuildCheck.hpp"

#include "core/log/Log.hpp"
#include "core/mem/Pe.hpp"

#include <eft_offsets.hpp>

namespace radar::eft {

std::vector<ModuleBuildCheck> checkBuild(const mem::Target& target) {
    std::vector<ModuleBuildCheck> out;
    const auto view = target.view();
    for (const auto& expected : off::build::kModules) {
        ModuleBuildCheck check;
        check.module = std::string(expected.module);
        check.expectedTimestamp = expected.peTimestamp;
        check.expectedSize = expected.imageSize;

        const auto module = target.module(check.module);
        const auto fp = module ? mem::readPeFingerprint(view, module->base) : std::nullopt;
        if (fp) {
            check.loadedTimestamp = fp->timeDateStamp;
            check.loadedSize = fp->sizeOfImage;
        }

        if (!fp) {
            check.result = ModuleBuildCheck::Result::Unreadable;
        } else if (!expected.known) {
            check.result = ModuleBuildCheck::Result::NotRecorded;
        } else if (fp->timeDateStamp == expected.peTimestamp && fp->sizeOfImage == expected.imageSize) {
            check.result = ModuleBuildCheck::Result::Match;
        } else {
            check.result = ModuleBuildCheck::Result::Mismatch;
        }
        out.push_back(std::move(check));
    }
    return out;
}

bool logBuildCheck(const std::vector<ModuleBuildCheck>& checks) {
    bool mismatch = false;
    for (const auto& c : checks) {
        using R = ModuleBuildCheck::Result;
        switch (c.result) {
        case R::Match:
            log::info("offsets: {} matches the recorded build (timestamp {:#x}, size {:#x})",
                      c.module, c.loadedTimestamp, c.loadedSize);
            break;
        case R::Mismatch:
            mismatch = true;
            log::warn("offsets: {} differs from the build the offsets were made for "
                      "(loaded: timestamp {:#x}, size {:#x}; expected: timestamp {:#x}, size {:#x}). "
                      "Continuing; results may be wrong.",
                      c.module, c.loadedTimestamp, c.loadedSize, c.expectedTimestamp,
                      c.expectedSize);
            break;
        case R::NotRecorded:
            log::info("offsets: no build fingerprint recorded for {} (loaded: timestamp {:#x}, "
                      "size {:#x}); record it in eft.offsets.json once the offsets are verified",
                      c.module, c.loadedTimestamp, c.loadedSize);
            break;
        case R::Unreadable:
            log::warn("offsets: could not read the PE header of {}", c.module);
            break;
        }
    }
    return mismatch;
}

}  // namespace radar::eft
