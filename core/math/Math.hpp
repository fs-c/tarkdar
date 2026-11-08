#pragma once

#include <cmath>

// Minimal vector/quaternion types for transform math. Unity conventions: left-handed, Y up,
// quaternions stored (x, y, z, w).
namespace radar::math {

struct Vec3 {
    float x = 0, y = 0, z = 0;

    friend constexpr Vec3 operator+(Vec3 a, Vec3 b) { return {a.x + b.x, a.y + b.y, a.z + b.z}; }
    friend constexpr Vec3 operator-(Vec3 a, Vec3 b) { return {a.x - b.x, a.y - b.y, a.z - b.z}; }
    friend constexpr Vec3 operator*(Vec3 a, float s) { return {a.x * s, a.y * s, a.z * s}; }
    friend constexpr bool operator==(Vec3, Vec3) = default;
};

[[nodiscard]] constexpr Vec3 cross(Vec3 a, Vec3 b) {
    return {a.y * b.z - a.z * b.y, a.z * b.x - a.x * b.z, a.x * b.y - a.y * b.x};
}
[[nodiscard]] constexpr Vec3 hadamard(Vec3 a, Vec3 b) { return {a.x * b.x, a.y * b.y, a.z * b.z}; }
[[nodiscard]] inline float length(Vec3 v) { return std::sqrt(v.x * v.x + v.y * v.y + v.z * v.z); }

struct Quat {
    float x = 0, y = 0, z = 0, w = 1;
    friend constexpr bool operator==(Quat, Quat) = default;
};

// Hamilton product: applying the result rotates by b first, then by a.
[[nodiscard]] constexpr Quat operator*(Quat a, Quat b) {
    return {a.w * b.x + a.x * b.w + a.y * b.z - a.z * b.y,
            a.w * b.y - a.x * b.z + a.y * b.w + a.z * b.x,
            a.w * b.z + a.x * b.y - a.y * b.x + a.z * b.w,
            a.w * b.w - a.x * b.x - a.y * b.y - a.z * b.z};
}

// Rotates v by unit quaternion q (q v q*): v' = v + 2w(u×v) + 2u×(u×v), u = (x, y, z).
[[nodiscard]] constexpr Vec3 rotate(Quat q, Vec3 v) {
    const Vec3 u{q.x, q.y, q.z};
    const Vec3 t = cross(u, v) * 2.0f;
    return v + t * q.w + cross(u, t);
}

[[nodiscard]] inline Quat normalized(Quat q) {
    const float n = std::sqrt(q.x * q.x + q.y * q.y + q.z * q.z + q.w * q.w);
    if (!(n > 0.0f) || !std::isfinite(n)) return {};
    return {q.x / n, q.y / n, q.z / n, q.w / n};
}

// Finite and within ±limit on every axis.
[[nodiscard]] inline bool isSane(Vec3 v, float limit = 1e6f) {
    return std::isfinite(v.x) && std::isfinite(v.y) && std::isfinite(v.z) && std::fabs(v.x) <= limit &&
           std::fabs(v.y) <= limit && std::fabs(v.z) <= limit;
}

}  // namespace radar::math
