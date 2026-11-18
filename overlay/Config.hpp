#pragma once

#include <chrono>
#include <cstdint>
#include <optional>
#include <string>
#include <vector>

// The overlay: the local player's view drawn into a transparent window over the game's picture (on
// the machine showing the game). It's a display client that lives in the backend process only so it
// can read the camera right before each frame it draws; nothing that reads the game depends on it.
//
// What it draws, and how, is configured by a client (the web frontend, in its role of configuring
// the overlay): which things to mark, in what colour, with what label. The overlay adds what it knows
// best: where those things are on screen now. This configuration is for the overlay only; the
// backend doesn't use it for anything else.
namespace radar::overlay {

struct Color {
    std::uint8_t r = 255, g = 255, b = 255, a = 255;
    friend bool operator==(Color, Color) = default;
};

enum class MarkKind : std::uint8_t { Player, Loot, Exfil };

// How much a mark stands out: line widths and sizes.
enum class Emphasis : std::uint8_t { Faint, Normal, Strong, Loud };

// One thing to draw: what (kind and id, as in the backend's messages for the configured raid) and how.
struct Mark {
    MarkKind kind = MarkKind::Player;
    std::uint32_t id = 0;
    Color color{};
    std::string label{};  // drawn next to it (with the distance); empty: just the distance
    Emphasis emphasis = Emphasis::Normal;
    friend bool operator==(const Mark&, const Mark&) = default;
};

struct Config {
    bool on = false;
    std::uint64_t raid = 0;  // the raid the marks' ids belong to; marks for another raid aren't drawn
    std::vector<Mark> marks{};
    // Players not among the marks (e.g. spawned since the configuring client last sent): drawn in this
    // colour, so nobody is missing from the overlay; nullopt: not drawn.
    std::optional<Color> otherPlayers{};
    // The picture this late: Looking Glass and the compositor show the game a little after it rendered
    // it, while the camera is read as it is now.
    std::chrono::milliseconds delay{0};
    bool grid = false;         // dots on the ground around the player
    float lootRange = 150;     // m: loot and grid further away aren't drawn
    float scopeRadius = 0.36f; // the scope's picture while scoped: a circle this big (share of the height)
    friend bool operator==(const Config&, const Config&) = default;
};

}  // namespace radar::overlay
