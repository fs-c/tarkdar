#pragma once

#include "core/math/Math.hpp"
#include "core/mem/MemoryView.hpp"
#include "core/unity/Layout.hpp"

#include <cstdint>
#include <optional>
#include <vector>

// Unity cameras: the engine's list of all cameras, and per-camera matrices and projection settings.
namespace radar::unity {

using mem::Address;

// One read of a camera.
struct CameraSample {
    math::Mat4 viewProjection;
    std::optional<math::Mat4> worldToCamera;  // if readable and consistent with viewProjection
    std::optional<math::Vec3> position;       // world position, from worldToCamera
    float fieldOfView = 0;                    // 0 if unreadable or implausible
    float aspect = 0;                         // 0 if unreadable or implausible
};

// Finite, no element above 1e5, and no all-zero row or column (rejects zeroed or garbage memory).
[[nodiscard]] bool matrixLooksValid(const math::Mat4& m);
// matrixLooksValid, and clip X, Y and W come from three independent world directions, as in any
// perspective projection (rejects identity, affine and singular matrices; allows off-centre ones).
[[nodiscard]] bool viewProjectionLooksValid(const math::Mat4& viewProjection);
// Clip W follows camera-space Z (either sign): the view-projection belongs to this view matrix.
[[nodiscard]] bool viewProjectionMatchesView(const math::Mat4& viewProjection, const math::Mat4& worldToCamera);
// The camera's world position from its view matrix (a rigid transform, possibly mirrored).
[[nodiscard]] std::optional<math::Vec3> cameraPosition(const math::Mat4& worldToCamera);

class Cameras {
public:
    static constexpr std::size_t kMaxCameras = 1024;

    Cameras(const mem::MemoryView& mem, const CameraLayout& layout) : mem_(mem), layout_(layout) {}

    // The native Camera pointers in the list whose pointer is stored at `listGlobal`. Empty if the
    // list is unreadable.
    [[nodiscard]] std::vector<Address> list(Address listGlobal) const;

    // Reads a camera's matrices and projection settings in one batch (fresh). nullopt unless the
    // view-projection matrix looks valid (and matches the view matrix, when that one is readable).
    // With the view matrix, the view-projection is normalised so that clip w > 0 in front.
    [[nodiscard]] std::optional<CameraSample> sample(Address camera) const;

private:
    mem::MemoryView mem_;
    CameraLayout layout_;
};

}  // namespace radar::unity
