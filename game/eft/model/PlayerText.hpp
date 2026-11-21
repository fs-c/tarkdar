#pragma once

#include "game/eft/model/Players.hpp"

#include <format>
#include <string>

// How the radar-diagnose report and the backend's log describe a player in one line.
namespace radar::eft {

// "#3 observed ai side 2 voice Boss role 6 alive": who, side and state, without position.
[[nodiscard]] inline std::string describePlayer(const PlayerState& p) {
    return std::format("#{} {}{} side {}{}{} {}", p.id, kindName(p.kind), p.ai ? " ai" : "",
                       static_cast<int>(p.side), p.voice.empty() ? "" : " voice " + p.voice,
                       p.role ? std::format(" role {}", *p.role) : "", p.dead ? "dead" : "alive");
}

}  // namespace radar::eft
