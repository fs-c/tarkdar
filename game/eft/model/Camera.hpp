#pragma once

#include "core/math/Math.hpp"

#include <cstdint>
#include <memory>
#include <optional>
#include <vector>

namespace radar::eft {

// One of the local player's cameras as last read.
struct CameraView {
    // Projection × view (Unity Matrix4x4, column-major): world point (x, y, z, 1) → clip space. Its
    // projection is the camera's own, so the optic camera's covers only the scope's narrow view.
    math::Mat4 viewProjection;
    std::optional<math::Vec3> position{};  // world position, if the view matrix was readable
    float fieldOfView = 0;               // vertical, degrees; 0 if unknown
    float aspect = 0;                    // width / height; 0 if unknown
    friend bool operator==(const CameraView&, const CameraView&) = default;
};

// One sight on the local player's weapon (ProceduralWeaponAnimation's optics, in weapon order).
struct SightState {
    int scope = -1;      // selected scope of the sight (sights may have several, e.g. a scope with a reflex)
    int mode = -1;       // selected zoom mode of that scope
    float zoom = 1;      // magnification now (variable scopes: the live zoom)
    float minZoom = 0;   // the sight's zoom range over all scopes and modes; 0 if unknown
    float maxZoom = 0;
    bool magnified = false;  // zoom noticeably above 1× (the game then renders through the optic camera)
    bool current = false;    // the sight the game currently looks through (the optic camera's)
    friend bool operator==(const SightState&, const SightState&) = default;
};

struct CameraSnapshot {
    std::uint64_t raidId = 0;
    std::uint64_t revision = 0;
    std::optional<CameraView> fps{};  // the first-person camera; nullopt while not found or unreadable
    bool aiming = false;              // aiming down sights
    std::vector<SightState> sights{}; // read while aiming
    std::optional<std::size_t> activeSight{};  // index into sights: the one looked through
    float magnification = 1;          // the active sight's zoom; 1 without one
    bool scoped = false;              // aiming through a magnified sight
    std::optional<CameraView> optic{};  // the scope's camera, read while scoped
    // Equal state (ignoring raidId and revision).
    [[nodiscard]] bool sameState(const CameraSnapshot& o) const {
        return fps == o.fps && aiming == o.aiming && sights == o.sights && activeSight == o.activeSight &&
               magnification == o.magnification && scoped == o.scoped && optic == o.optic;
    }
};

// Reads the local player's cameras now, from any thread. For clients that must follow the camera as
// closely as possible (the overlay reads it right before drawing each frame); everything else uses
// CameraSnapshot. Keeps what it reads through (the raid's memory view) alive; it may outlive the
// raid, but then reads fail or return garbage (the matrices are validated, so: nullopt).
class CameraReader {
public:
    virtual ~CameraReader() = default;
    [[nodiscard]] virtual std::uint64_t raidId() const = 0;
    [[nodiscard]] virtual std::optional<CameraView> fps() const = 0;
    // The scope's camera; only meaningful while CameraSnapshot::scoped.
    [[nodiscard]] virtual std::optional<CameraView> optic() const = 0;
};

// The current reader; null outside a raid or before the first-person camera is found.
struct CameraReaderRef {
    std::shared_ptr<const CameraReader> reader;
};

}  // namespace radar::eft
