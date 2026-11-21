#pragma once

// Pure test maths, no process or memory backend involved: vector comparison and the camera
// matrices of the fakes (Unity's OpenGL-style worldToCamera and projection, column-major).

#include "core/math/Math.hpp"

#include <cmath>

namespace radar::test {

// Every axis within eps.
inline bool near(math::Vec3 a, math::Vec3 b, float eps = 1e-3f) {
    return std::fabs(a.x - b.x) < eps && std::fabs(a.y - b.y) < eps && std::fabs(a.z - b.z) < eps;
}

// A camera at `p` looking along +z (Unity's world forward).
inline math::Mat4 viewAt(math::Vec3 p) {
    // worldToCameraMatrix (OpenGL convention: the camera looks down its -z, so z is flipped).
    math::Mat4 v;
    auto set = [&](int r, int c, float x) { v.m[static_cast<std::size_t>(c * 4 + r)] = x; };
    set(0, 0, 1), set(1, 1, 1), set(2, 2, -1), set(3, 3, 1);
    set(0, 3, -p.x), set(1, 3, -p.y), set(2, 3, p.z);
    return v;
}
inline math::Mat4 perspective(float fovDegrees, float aspect, float zNear = 0.05f, float zFar = 1000.0f) {
    math::Mat4 m;
    auto set = [&](int r, int c, float x) { m.m[static_cast<std::size_t>(c * 4 + r)] = x; };
    const float f = 1.0f / std::tan(fovDegrees * 3.14159265f / 360.0f);
    set(0, 0, f / aspect), set(1, 1, f), set(2, 2, (zFar + zNear) / (zNear - zFar));
    set(2, 3, 2 * zFar * zNear / (zNear - zFar)), set(3, 2, -1);
    return m;
}
inline math::Mat4 multiply(const math::Mat4& a, const math::Mat4& b) {
    math::Mat4 out;
    for (int r = 0; r < 4; ++r)
        for (int c = 0; c < 4; ++c) {
            float sum = 0;
            for (int k = 0; k < 4; ++k) sum += a.at(r, k) * b.at(k, c);
            out.m[static_cast<std::size_t>(c * 4 + r)] = sum;
        }
    return out;
}

}  // namespace radar::test
