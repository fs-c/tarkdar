#include "core/unity/Camera.hpp"

#include "core/mem/ReadBatch.hpp"

#include <algorithm>
#include <array>
#include <cmath>
#include <functional>

namespace radar::unity {

using math::Mat4;
using math::Vec3;
using mem::Freshness;
using mem::MemoryView;

namespace {

constexpr float kMaxElement = 1e5f;
constexpr float kNonZero = 1e-5f;

// Finite and not (nearly) zero length.
bool hasUsableLength(Vec3 v) {
    const float length = math::length(v);
    return std::isfinite(length) && length > kNonZero;
}

}  // namespace

bool matrixLooksValid(const Mat4& m) {
    std::array<bool, 4> rows{}, columns{};
    for (int c = 0; c < 4; ++c)
        for (int r = 0; r < 4; ++r) {
            const float v = m.at(r, c);
            if (!std::isfinite(v) || std::fabs(v) > kMaxElement) return false;
            if (std::fabs(v) > kNonZero) rows[static_cast<std::size_t>(r)] = columns[static_cast<std::size_t>(c)] = true;
        }
    return std::ranges::all_of(rows, std::identity{}) && std::ranges::all_of(columns, std::identity{});
}

bool viewProjectionLooksValid(const Mat4& vp) {
    if (!matrixLooksValid(vp)) return false;
    const Vec3 x = vp.row3(0), y = vp.row3(1), w = vp.row3(3);
    if (!hasUsableLength(x) || !hasUsableLength(y) || !hasUsableLength(w)) return false;
    const float volume = std::fabs(math::dot(math::cross(x, y), w)) / (math::length(x) * math::length(y) * math::length(w));
    return std::isfinite(volume) && volume > 1e-4f;
}

bool viewProjectionMatchesView(const Mat4& vp, const Mat4& view) {
    const Vec3 w = vp.row3(3), z = view.row3(2);
    if (!hasUsableLength(w) || !hasUsableLength(z)) return false;
    // Perspective projection puts camera-space Z into clip W; the sign depends on the convention.
    const float alignment = std::fabs(math::dot(w, z) / (math::length(w) * math::length(z)));
    return std::isfinite(alignment) && alignment >= 0.995f;
}

std::optional<Vec3> cameraPosition(const Mat4& view) {
    // view = [R t; 0 1] with R orthonormal: the camera is at -Rᵀt.
    const Vec3 t{view.at(0, 3), view.at(1, 3), view.at(2, 3)};
    const Vec3 p{-(view.at(0, 0) * t.x + view.at(1, 0) * t.y + view.at(2, 0) * t.z),
                 -(view.at(0, 1) * t.x + view.at(1, 1) * t.y + view.at(2, 1) * t.z),
                 -(view.at(0, 2) * t.x + view.at(1, 2) * t.y + view.at(2, 2) * t.z)};
    if (!math::isSane(p)) return std::nullopt;
    return p;
}

std::vector<Address> Cameras::list(Address listGlobal) const {
    Address container = 0;
    if (!mem_.tryRead(listGlobal, container) || !MemoryView::isUserPointer(container)) return {};
    Address items = 0;
    std::uint32_t count32 = 0;
    std::uint64_t count64 = 0;
    mem::ReadBatch batch(mem_);
    batch.add(container + layout_.listItems, items);
    batch.add(container + layout_.listCount, count32);
    batch.add(container + layout_.listCount64, count64);
    batch.execute(Freshness::Fresh);
    // The 64-bit count is the array's size where both exist (the 32-bit field may then be something
    // else, e.g. a memory label); the 32-bit one is for versions without it.
    std::size_t count = 0;
    if (count64 >= 1 && count64 <= kMaxCameras) count = static_cast<std::size_t>(count64);
    else if (count32 >= 1 && count32 <= kMaxCameras) count = count32;
    if (!count || !MemoryView::isUserPointer(items)) return {};

    std::vector<Address> cameras(count);
    if (!mem_.readBytes(items, std::as_writable_bytes(std::span{cameras}), Freshness::Fresh)) return {};
    std::erase_if(cameras, [](Address a) { return !MemoryView::isUserPointer(a); });
    return cameras;
}

std::optional<CameraSample> Cameras::sample(Address camera) const {
    if (!MemoryView::isUserPointer(camera)) return std::nullopt;
    CameraSample s;
    Mat4 view;
    mem::ReadBatch batch(mem_);
    const auto vp = batch.add(camera + layout_.viewProjection, s.viewProjection.m);
    const auto v = batch.add(camera + layout_.worldToCamera, view.m);
    const auto fov = batch.add(camera + layout_.fieldOfView, s.fieldOfView);
    const auto aspect = batch.add(camera + layout_.aspect, s.aspect);
    batch.execute(Freshness::Fresh);
    if (!batch.complete(vp) || !viewProjectionLooksValid(s.viewProjection)) return std::nullopt;
    if (batch.complete(v) && matrixLooksValid(view)) {
        if (!viewProjectionMatchesView(s.viewProjection, view)) return std::nullopt;  // torn or foreign read
        // Clip w must grow with distance in front of the camera (which looks down view -z): flip a
        // matrix stored with the other sign convention. The projected point (clip / w) is the same.
        if (math::dot(s.viewProjection.row3(3), view.row3(2)) > 0)
            for (float& e : s.viewProjection.m) e = -e;
        s.worldToCamera = view;
        s.position = cameraPosition(view);
    }
    if (!batch.complete(fov) || !std::isfinite(s.fieldOfView) || s.fieldOfView <= 1.0f || s.fieldOfView >= 180.0f)
        s.fieldOfView = 0;
    if (!batch.complete(aspect) || !std::isfinite(s.aspect) || s.aspect <= 0.1f || s.aspect >= 5.0f) s.aspect = 0;
    return s;
}

}  // namespace radar::unity
