#pragma once

#include "game/eft/model/Camera.hpp"
#include "game/eft/model/Players.hpp"
#include "game/eft/model/World.hpp"
#include "overlay/Config.hpp"
#include "overlay/DrawList.hpp"

#include <optional>

// Building one overlay frame: world points through the camera onto the surface, plain functions so
// they can be tested without a window.
namespace radar::overlay {

using eft::CameraSnapshot;
using eft::CameraView;

// Points closer than this (m) in front of the camera aren't drawn (behind it can't be).
inline constexpr float kNear = 0.05f;

// A world point through a view-projection matrix: normalised device coordinates (−1…1, y up) and the
// distance along the view (clip w). nullopt if behind the camera.
struct Projected {
    float x = 0, y = 0, depth = 0;
};
[[nodiscard]] std::optional<Projected> project(const math::Mat4& viewProjection, math::Vec3 p);

// Where the game's picture is on the surface: the surface letterboxed to the camera's aspect, as
// Looking Glass shows a picture of a different aspect in fullscreen.
struct Viewport {
    float x = 0, y = 0, width = 0, height = 0;
};
[[nodiscard]] Viewport letterbox(float surfaceWidth, float surfaceHeight, float aspect);

// The scope's mapping while scoped: a world point → offset from the picture's centre, in units of the
// picture's height (y up). Through the optic camera when it's known: its NDC · tan(fpsFov / 2) (the
// reference's mapping); otherwise the first-person view magnified by the sight's zoom.
struct ScopeMapping {
    std::optional<CameraView> optic;  // if read
    CameraView fps;
    float magnification = 1;
    [[nodiscard]] std::optional<Projected> offset(math::Vec3 p) const;
};

// Everything one frame is built from.
struct SceneInput {
    const Config& config;
    const CameraSnapshot& camera;          // aiming, scope (the views come from below)
    std::optional<CameraView> fps;         // read for this frame
    std::optional<CameraView> optic;       // read for this frame, while scoped
    const eft::PlayersSnapshot& players;
    const eft::LootSnapshot& loot;
    const eft::ExfilsSnapshot& exfils;
    float surfaceWidth = 0, surfaceHeight = 0;
};

[[nodiscard]] DrawList buildScene(const SceneInput& in);

}  // namespace radar::overlay
