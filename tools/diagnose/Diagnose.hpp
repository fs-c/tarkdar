#pragma once

#include "core/mem/Target.hpp"

#include <atomic>
#include <cstdio>

namespace radar::diagnose {

// One-shot check of the whole read chain against the running game (or a memory dump): attach,
// IL2CPP type table, GameObjectManager, both raid-finding strategies, and, if a raid is found, one
// pass of every raid subsystem (see runDiagnose in Diagnose.cpp for the list) with a summary of what
// came out. Each step prints what it read and which offsets it depended on, so a failure
// points at what to check. Returns 0 if a raid was found and every step produced data, 1 otherwise.
// Waiting for the attach ends early (returning 1) once `stop` is set.
int runDiagnose(mem::Target& target, int timeoutSeconds, std::FILE* out, const std::atomic<bool>* stop = nullptr);

}  // namespace radar::diagnose
