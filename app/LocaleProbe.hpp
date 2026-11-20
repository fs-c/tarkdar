#pragma once

#include "game/eft/Game.hpp"

#include <string>
#include <vector>

namespace radar::app {

// Exploratory read of the game's text table (EFT.LocalizationManager), for showing exfils by their
// in-game names instead of their internal ones ("ex_customs_pmc_auto"; TODO.md, better exfil names).
// The table's hash isn't one we can compute (see QuestProbe.cpp), so this reads every key once, in a
// batch, and times it: the cost of doing that at raid start. Dumps, as JSON: the table (culture,
// size, scan time), each exfil name's entry (matched ignoring case, like the table) and the keys that
// contain it, keys that look like exits, and a sample of keys with their stored hash codes (for
// trying more hashes offline). Offsets are the il2cpp dump's, as in the quest probe.
struct LocaleProbeResult {
    std::string json;     // the dump
    std::string summary;  // a few lines for the diagnose report
    bool ok = false;      // the table was read and at least one exfil name found in it
};

[[nodiscard]] LocaleProbeResult probeLocale(const eft::Game& game, const std::vector<std::string>& exfilNames);

}  // namespace radar::app
