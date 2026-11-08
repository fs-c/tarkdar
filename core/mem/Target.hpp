#pragma once

#include "core/mem/MemoryView.hpp"

#include <cstdint>
#include <map>
#include <optional>
#include <string>
#include <vector>

namespace radar::mem {

// Attach state machine for one target process:
//   WaitingForProcess → WaitingForModules → Attached
// Drops back to WaitingForProcess when the process exits. `generation` increments on every
// successful attach, so consumers can drop pointer caches derived from an earlier attach.
//
// Not thread-safe: poll() and the accessors are meant for the single thread that owns the
// lifecycle. Other threads get a MemoryView (or derived snapshots) from that owner.
class Target {
public:
    enum class State { WaitingForProcess, WaitingForModules, Attached };

    Target(IMemoryBackend& backend, std::string processName,
           std::vector<std::string> requiredModules);

    // Advances the state machine. Cheap enough to call about once per second.
    State poll();

    [[nodiscard]] State state() const noexcept { return state_; }
    [[nodiscard]] std::uint64_t generation() const noexcept { return generation_; }
    [[nodiscard]] const std::string& processName() const noexcept { return processName_; }
    [[nodiscard]] std::optional<Pid> pid() const noexcept { return pid_; }
    [[nodiscard]] std::optional<ModuleInfo> module(const std::string& name) const;
    [[nodiscard]] const std::map<std::string, ModuleInfo>& modules() const noexcept { return modules_; }

    // Only valid while Attached.
    [[nodiscard]] MemoryView view() const;

private:
    void reset();

    IMemoryBackend& backend_;
    std::string processName_;
    std::vector<std::string> requiredModules_;

    State state_ = State::WaitingForProcess;
    std::uint64_t generation_ = 0;
    std::optional<Pid> pid_;
    std::map<std::string, ModuleInfo> modules_;
};

[[nodiscard]] const char* stateName(Target::State state) noexcept;

}  // namespace radar::mem
