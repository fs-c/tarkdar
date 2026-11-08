#pragma once

#include <array>
#include <string_view>

// Game location ids (the GameWorld's LocationId string).
namespace radar::eft {

// Locations that are never a raid.
inline constexpr std::array kLobbyLocations = {std::string_view{"hideout"}, std::string_view{"default"}};

// Raid locations, including event variants. Compared case-insensitively. A location missing here
// is not treated as a raid; add new or modded locations to this list.
inline constexpr std::array kRaidLocations = {
    std::string_view{"bigmap"},          std::string_view{"factory4_day"},    std::string_view{"factory4_night"},
    std::string_view{"factory_event"},   std::string_view{"interchange"},     std::string_view{"laboratory"},
    std::string_view{"laboratory_dark"}, std::string_view{"laboratory_event"}, std::string_view{"labyrinth"},
    std::string_view{"lighthouse"},      std::string_view{"rezervbase"},      std::string_view{"sandbox"},
    std::string_view{"sandbox_high"},    std::string_view{"sandbox_start"},   std::string_view{"shoreline"},
    std::string_view{"tarkovstreets"},   std::string_view{"woods"},           std::string_view{"icebreaker"},
    std::string_view{"terminal"},
};

[[nodiscard]] bool isLobbyLocation(std::string_view id);   // also true for an empty id
[[nodiscard]] bool isRaidLocation(std::string_view id);

}  // namespace radar::eft
