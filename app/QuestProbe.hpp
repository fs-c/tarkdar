#pragma once

#include "game/eft/Game.hpp"

#include <string>

namespace radar::app {

// Exploratory dump of the local player's quests in progress, for building quest objectives from game
// memory instead of tarkov.dev (TODO.md, quest item kinks): per quest its template (QuestStatusData.
// Template, else Quest._template) with flags and every condition (class, id, count, item targets,
// child conditions), plus the profile's condition counters (progress). Offsets are the il2cpp dump's
// (dumps/il2cpp-dump.json) and live here, not in eft.offsets.json, until the probe confirms them.
struct QuestProbeResult {
    std::string json;     // the dump
    std::string summary;  // a few lines for the diagnose report
    bool ok = false;      // the quest list and at least one template were read
};

[[nodiscard]] QuestProbeResult probeQuests(const eft::Game& game, mem::Address localPlayer);

}  // namespace radar::app
