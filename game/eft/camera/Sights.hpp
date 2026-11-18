#pragma once

#include "game/eft/model/Camera.hpp"

#include <optional>
#include <vector>

// How a sight's magnification is worked out from what the game stores.
namespace radar::eft {

// What a sight stores about its zoom.
struct SightZoomData {
    int selectedScope = -1;
    int selectedMode = 0;  // of the selected scope; 0 if unreadable
    // SightModTemplate.Zooms: per scope, the zoom of each mode (e.g. {{1, 4}} for a 1×/4× scope).
    std::vector<std::vector<float>> zooms;
    // SightComponent.ScopeZoomValue: for variable scopes, the optic's live field of view.
    float scopeZoomValue = 0;
};

// Zoom at or below this counts as unmagnified: a variable optic's live zoom drifts a little around 1×.
inline constexpr float kMinimumMagnification = 1.05f;

// The sight's state from its zoom data; nullopt if the selected scope's zoom is unknown or implausible.
//  - zoom: the selected mode's template zoom; for variable scopes (a zoom range), the live zoom
//    30° / ScopeZoomValue instead, clamped to the range. The 30° base differs a little between optic
//    families, so the live value is accepted within 25 % outside the range, and taken as the minimum
//    zoom when the selected mode is the minimum and the live value is within 25 % of it (some 1–8×
//    scopes read about 1.22× at their 1× setting).
//  - minZoom / maxZoom: over every scope and mode of the sight.
// `current` is left false; whether the game looks through this sight is told elsewhere.
[[nodiscard]] std::optional<SightState> resolveSight(const SightZoomData& data);

// The sight looked through: the current one if any, otherwise the first.
[[nodiscard]] std::optional<std::size_t> activeSight(const std::vector<SightState>& sights);

}  // namespace radar::eft
