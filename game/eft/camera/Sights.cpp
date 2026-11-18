#include "game/eft/camera/Sights.hpp"

#include <algorithm>
#include <cmath>

namespace radar::eft {

namespace {
constexpr float kMaxZoom = 100.0f;
constexpr float kScopeBaseFov = 30.0f;
constexpr float kLiveZoomTolerance = 1.25f;

bool plausible(float zoom) { return std::isfinite(zoom) && zoom > 0.0f && zoom < kMaxZoom; }
}  // namespace

std::optional<SightState> resolveSight(const SightZoomData& data) {
    if (data.selectedScope < 0 || static_cast<std::size_t>(data.selectedScope) >= data.zooms.size()) return std::nullopt;
    const auto& modes = data.zooms[static_cast<std::size_t>(data.selectedScope)];
    if (modes.empty()) return std::nullopt;
    const int mode = data.selectedMode >= 0 && static_cast<std::size_t>(data.selectedMode) < modes.size() ? data.selectedMode : 0;
    const float selected = modes[static_cast<std::size_t>(mode)];
    if (!std::isfinite(selected) || selected < 0.0f || selected >= kMaxZoom) return std::nullopt;

    SightState s;
    s.scope = data.selectedScope;
    s.mode = mode;
    s.zoom = selected;
    float lo = kMaxZoom, hi = 0.0f;
    for (const auto& scope : data.zooms)
        for (const float z : scope)
            if (plausible(z)) lo = std::min(lo, z), hi = std::max(hi, z);
    if (hi > 0.0f) s.minZoom = lo, s.maxZoom = hi;

    if (hi > lo + 0.01f && std::isfinite(data.scopeZoomValue) && data.scopeZoomValue > 0.0f) {
        const float live = kScopeBaseFov / data.scopeZoomValue;
        if (std::isfinite(live) && live >= lo / kLiveZoomTolerance && live <= hi * kLiveZoomTolerance) {
            const bool atMinimum = selected <= lo + 0.05f && live <= lo * kLiveZoomTolerance;
            s.zoom = atMinimum ? lo : std::clamp(live, lo, hi);
        }
    }
    s.magnified = s.zoom > kMinimumMagnification;
    return s;
}

std::optional<std::size_t> activeSight(const std::vector<SightState>& sights) {
    for (std::size_t i = 0; i < sights.size(); ++i)
        if (sights[i].current) return i;
    if (!sights.empty()) return 0;
    return std::nullopt;
}

}  // namespace radar::eft
