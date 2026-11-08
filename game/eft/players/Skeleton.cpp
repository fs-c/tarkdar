#include "game/eft/players/Skeleton.hpp"

#include "game/eft/Layouts.hpp"

#include "game/eft/Read.hpp"

#include <eft_offsets.hpp>

#include <cmath>

namespace radar::eft {

using mem::Freshness;
using mem::MemoryView;
using math::Vec3;

namespace {

bool usable(const std::optional<unity::Pose>& pose) {
    if (!pose) return false;
    const Vec3 p = pose->position;
    return math::isSane(p) && !(std::fabs(p.x) < 0.001f && std::fabs(p.y) < 0.001f && std::fabs(p.z) < 0.001f);
}

bool nearOrigin(Vec3 p, float range) {
    return std::fabs(p.x) < range && std::fabs(p.y) < range && std::fabs(p.z) < range;
}

}  // namespace

std::optional<PositionBones> resolvePositionBones(const Game& game, Address player) {
    const Address body = readPointer(game, player + off::Player::_playerBody, Freshness::Fresh);
    const Address root = body ? readPointer(game, body + off::PlayerBody::SkeletonRootJoint, Freshness::Fresh) : 0;
    const Address list = root ? readPointer(game, root + off::Skeleton::Values, Freshness::Fresh) : 0;
    if (!list) return std::nullopt;

    std::int32_t size = 0;
    const Address items = readPointer(game, list + kIl2CppLayout.listItems, Freshness::Fresh);
    constexpr std::int32_t kMaxBones = 1024;
    if (!items || !game.mem.tryRead(list + kIl2CppLayout.listSize, size, Freshness::Fresh) || size < 0 || size > kMaxBones)
        return std::nullopt;

    PositionBones bones;
    const Bone wanted[] = {Bone::Base, Bone::LeftFoot, Bone::RightFoot};
    for (std::size_t i = 0; i < 3; ++i) {
        const auto index = static_cast<std::size_t>(wanted[i]);
        if (static_cast<std::size_t>(size) <= index) return std::nullopt;
        const Address managedTransform = readPointer(game, items + kIl2CppLayout.arrayData + index * sizeof(Address), Freshness::Fresh);
        const auto native = managedTransform ? game.managed.nativePointer(managedTransform, Freshness::Fresh)
                                             : std::nullopt;
        if (!native) return std::nullopt;
        bones.transforms[i] = *native;
    }
    return bones;
}

std::optional<Vec3> pickPosition(const std::array<std::optional<unity::Pose>, 3>& poses) {
    const auto& [base, left, right] = poses;
    if (usable(base)) return base->position;
    if (usable(left) && usable(right)) {
        const float separation = math::length(left->position - right->position);
        if (separation > 0.01f && separation <= 5.5f) return (left->position + right->position) * 0.5f;
    }
    if (usable(left)) return left->position;
    if (usable(right)) return right->position;
    return std::nullopt;
}

bool plausibleSkeleton(const std::array<std::optional<unity::Pose>, 3>& poses) {
    for (const auto& p : poses)
        if (!p || !math::isSane(p->position) || nearOrigin(p->position, 2.0f)) return false;
    const Vec3 base = poses[0]->position, left = poses[1]->position, right = poses[2]->position;
    return math::length(left - base) <= 5.0f && math::length(right - base) <= 5.0f &&
           math::length(left - right) <= 5.0f;
}

}  // namespace radar::eft
