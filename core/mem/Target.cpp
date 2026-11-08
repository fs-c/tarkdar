#include "core/mem/Target.hpp"

#include <cassert>

namespace radar::mem {

Target::Target(IMemoryBackend& backend, std::string processName,
               std::vector<std::string> requiredModules)
    : backend_(backend),
      processName_(std::move(processName)),
      requiredModules_(std::move(requiredModules)) {}

Target::State Target::poll() {
    switch (state_) {
    case State::Attached:
        if (pid_ && backend_.processAlive(*pid_)) return state_;
        reset();
        [[fallthrough]];

    case State::WaitingForProcess:
        pid_ = backend_.findProcess(processName_);
        if (!pid_) return state_;
        state_ = State::WaitingForModules;
        [[fallthrough]];

    case State::WaitingForModules:
        if (!backend_.processAlive(*pid_)) {
            reset();
            return state_;
        }
        // The game loads its modules some time after the process appears; retry until all
        // required ones are present.
        modules_.clear();
        for (const auto& name : requiredModules_) {
            auto info = backend_.findModule(*pid_, name);
            if (!info) {
                modules_.clear();
                return state_;
            }
            modules_.emplace(name, *info);
        }
        state_ = State::Attached;
        ++generation_;
        return state_;
    }
    return state_;
}

std::optional<ModuleInfo> Target::module(const std::string& name) const {
    if (auto it = modules_.find(name); it != modules_.end()) return it->second;
    return std::nullopt;
}

MemoryView Target::view() const {
    assert(state_ == State::Attached && pid_);
    return MemoryView(backend_, pid_.value_or(0));
}

void Target::reset() {
    state_ = State::WaitingForProcess;
    pid_.reset();
    modules_.clear();
}

const char* stateName(Target::State state) noexcept {
    switch (state) {
    case Target::State::WaitingForProcess: return "waiting for process";
    case Target::State::WaitingForModules: return "waiting for modules";
    case Target::State::Attached: return "attached";
    }
    return "?";
}

}  // namespace radar::mem
