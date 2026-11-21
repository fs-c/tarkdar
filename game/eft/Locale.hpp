#pragma once

#include "game/eft/Game.hpp"

#include <span>
#include <string>
#include <unordered_map>

namespace radar::eft {

// The game's own texts (EFT.LocalizationManager._locales): the table of its current culture, else
// English. A Dictionary<string, string> subclass (EFT.Locale) keyed ignoring case, ~42k entries. Its
// hash isn't one we can compute, so a lookup goes through the keys: every key's length in one batch,
// then the characters of only those as long as a wanted key, then the texts found (a probe
// measured the whole scan at ~20 ms). Keys are matched ignoring ASCII case, as the game does.
//
// Returns wanted key (as given) → text, for the keys found; empty if the table can't be read.
[[nodiscard]] std::unordered_map<std::string, std::string> lookupTexts(const Game& game, std::span<const std::string> keys);

}  // namespace radar::eft
