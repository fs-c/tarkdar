#pragma once

#include "core/mem/Target.hpp"

#include <string>
#include <vector>

namespace radar::eft {

// Compares the loaded game modules against the build fingerprints recorded with the compiled-in
// offsets. A mismatch is only a warning: in the worst case results are wrong, and often the offsets
// still work because the update didn't touch the classes we read.
struct ModuleBuildCheck {
    enum class Result { Match, Mismatch, NotRecorded, Unreadable };
    std::string module;
    Result result = Result::Unreadable;
    std::uint32_t loadedTimestamp = 0, loadedSize = 0;
    std::uint32_t expectedTimestamp = 0, expectedSize = 0;
};

[[nodiscard]] std::vector<ModuleBuildCheck> checkBuild(const mem::Target& target);

// Logs one line per module; returns true if any module mismatched.
bool logBuildCheck(const std::vector<ModuleBuildCheck>& checks);

}  // namespace radar::eft
