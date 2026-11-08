#pragma once

#include "core/mem/Target.hpp"

#include <cstdio>

namespace radar::app {

// One-shot check of the whole read chain against the running game (or a memory dump): attach,
// IL2CPP type table, GameObjectManager, both raid-finding strategies, and, if a raid is found, one
// pass of every subsystem (players, positions, equipment, exfils, explosives, loot) with a summary
// of what came out. Each step prints what it read and which offsets it depended on, so a failure
// points at what to check. Returns 0 if a raid was found and every step produced data, 1 otherwise.
int runDiagnose(mem::Target& target, int timeoutSeconds, std::FILE* out);

}  // namespace radar::app
