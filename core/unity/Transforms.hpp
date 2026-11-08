#pragma once

#include "core/il2cpp/Managed.hpp"
#include "core/math/Math.hpp"
#include "core/mem/MemoryView.hpp"
#include "core/unity/Layout.hpp"

#include <optional>
#include <span>
#include <vector>

namespace radar::unity {

using mem::Address;

struct Pose {
    math::Vec3 position;
    math::Quat rotation;  // normalised
};

// Local transform of one hierarchy slot, as stored by Unity (48 bytes).
struct TrsX {
    math::Vec3 t;
    float pad0;
    math::Quat q;
    math::Vec3 s;
    float pad1;
};
static_assert(sizeof(TrsX) == 48);

// World poses of Unity transforms, computed from the transform hierarchy's local TRS array.
//
// A native Transform points at its TransformHierarchy and its slot index there. The hierarchy holds
// two parallel arrays: local TRS per slot, and the parent slot per slot (-1 for the root). Unity
// normally keeps parents at lower slot indices than their children, so slots [0, index] contain
// every ancestor of `index`: a whole hierarchy prefix can be read in two bulk reads and everything
// computed locally. When that doesn't hold (or the hierarchy is huge), the parent chain is walked
// with individual reads instead.
class Transforms {
public:
    static constexpr std::int32_t kMaxIndex = 1'000'000;
    static constexpr std::size_t kMaxDepth = 512;
    // Hierarchies up to this many slots are read in bulk; larger ones walk the parent chain.
    static constexpr std::size_t kBulkMaxSlots = 4096;

    Transforms(const mem::MemoryView& mem, const Layout& layout) : mem_(mem), layout_(layout) {}

    // Accepts a managed UnityEngine.Transform or a native Transform, returns the native one.
    // Structural check only (hierarchy pointer and index look plausible).
    [[nodiscard]] std::optional<Address> resolveNative(Address transform, const il2cpp::Managed& managed) const;

    // World poses for many native transforms at once. nullopt per entry when unreadable or
    // implausible (non-finite, outside ±1e6, or exactly at the origin, which in practice means
    // zero-filled memory).
    [[nodiscard]] std::vector<std::optional<Pose>> worldPoses(std::span<const Address> nativeTransforms,
                                                              mem::Freshness freshness = mem::Freshness::Fresh) const;

    [[nodiscard]] std::optional<Pose> worldPose(Address nativeTransform,
                                                mem::Freshness freshness = mem::Freshness::Fresh) const {
        return worldPoses(std::span{&nativeTransform, 1}, freshness).front();
    }

    // Composes the pose of slot `index` from local TRS values and parent indices. Exposed for tests.
    [[nodiscard]] static std::optional<Pose> compose(std::int32_t index, std::span<const TrsX> local,
                                                     std::span<const std::int32_t> parents);

private:
    [[nodiscard]] std::optional<Pose> composeByChain(std::int32_t index, Address localTransforms, Address parentIndices,
                                                     mem::Freshness freshness) const;

    mem::MemoryView mem_;
    Layout layout_;
};

}  // namespace radar::unity
