#pragma once

#include "overlay/Frames.hpp"

#include <expected>
#include <stop_token>
#include <string>

namespace radar::overlay {

struct WindowOptions {
    std::string output;    // the monitor to cover (Wayland output name, e.g. "DP-1"); empty: the compositor's choice
    std::string font;      // TrueType font file for labels; empty: a common system font, or the built-in one
    float fontSize = 15;   // px
    // Draw a test pattern over every frame (Frames::testPattern), and keep drawing even while the
    // frames are inactive: to see that the window shows at all, and why it has nothing else to draw.
    bool test = false;
};

// Runs the overlay window until `stop` is requested: a transparent, click-through layer over the whole
// monitor, above fullscreen windows, drawing `frames` whenever the compositor is ready for a frame
// (and nothing while they're inactive). Returns an error if the window can't be opened (no Wayland
// session, a compositor without the layer-shell protocol, no OpenGL ES 3).
[[nodiscard]] std::expected<void, std::string> runOverlayWindow(std::stop_token stop, const WindowOptions& options,
                                                                Frames& frames);

}  // namespace radar::overlay
