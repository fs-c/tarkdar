#pragma once

#include "core/sched/Published.hpp"
#include "core/sched/TaskRunner.hpp"
#include "game/eft/model/WorldState.hpp"
#include "overlay/Config.hpp"
#include "overlay/DrawList.hpp"

#include <deque>
#include <span>
#include <string>

namespace radar::overlay {

using eft::CameraSnapshot;
using eft::CameraView;

// The cameras as read at one moment.
struct CameraReading {
    sched::Clock::time_point at{};
    std::optional<CameraView> fps{};
    std::optional<CameraView> optic{};
};

// Recent camera readings, to draw with the one from `delay` ago (Config::delay).
class CameraHistory {
public:
    static constexpr auto kKeep = std::chrono::seconds(1);

    void add(CameraReading r);
    void clear() { readings_.clear(); }
    // The newest reading taken at or before `at`; the oldest if all are newer; nullopt if none.
    [[nodiscard]] std::optional<CameraReading> at(sched::Clock::time_point at) const;

private:
    std::deque<CameraReading> readings_;
};

// Overlay frames: reads the cameras (CameraReader) when a frame is due and builds what to draw from
// them, the overlay's configuration and the world's latest snapshots. Used by the window's thread only.
class Frames {
public:
    // `stretch`: the game's picture fills the surface whatever its aspect (SceneInput::stretch).
    Frames(const eft::WorldState& world, const sched::Published<Config>& config, bool stretch = false)
        : world_(world), config_(config), stretch_(stretch) {}

    // Whether frames have anything to draw (configured on, in a raid, with a camera to read). While
    // not, the window can stop drawing.
    [[nodiscard]] bool active() const;

    // One frame for a surface of this size (logical pixels).
    [[nodiscard]] DrawList frame(float width, float height, sched::Clock::time_point now);

    // A test pattern for a surface of this size: its edges, its centre, and a status line saying why
    // `scene` (the frame just built) has what it has, e.g. the overlay off in the frontend, no camera;
    // then the `extra` lines (the window's timing).
    [[nodiscard]] DrawList testPattern(float width, float height, const DrawList& scene,
                                       std::span<const std::string> extra = {}) const;

private:
    const eft::WorldState& world_;
    const sched::Published<Config>& config_;
    bool stretch_ = false;
    CameraHistory history_;
    std::uint64_t historyRaid_ = 0;
    std::uint64_t fallbacks_ = 0;  // frames drawn with the tracker's camera: both reads failed
};

}  // namespace radar::overlay
