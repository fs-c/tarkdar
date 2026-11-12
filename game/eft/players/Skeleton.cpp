#include "game/eft/players/Skeleton.hpp"

#include "game/eft/Layouts.hpp"

#include "game/eft/Read.hpp"

#include "core/mem/ReadBatch.hpp"

#include <eft_offsets.hpp>

#include <algorithm>
#include <cmath>
#include <format>

namespace radar::eft {

using mem::Freshness;
using mem::MemoryView;
using math::Vec3;

namespace {

constexpr std::int32_t kMaxBones = 1024;

constexpr std::size_t kMaxJointBone = [] {
    std::size_t m = 0;
    for (const auto& j : kJointSources) m = std::max(m, j.bone);
    return m;
}();

bool usable(const std::optional<unity::Pose>& pose) {
    if (!pose) return false;
    const Vec3 p = pose->position;
    return math::isSane(p) && !(std::fabs(p.x) < 0.001f && std::fabs(p.y) < 0.001f && std::fabs(p.z) < 0.001f);
}

bool nearOrigin(Vec3 p, float range) {
    return std::fabs(p.x) < range && std::fabs(p.y) < range && std::fabs(p.z) < range;
}

// The skeleton's bone list behind bodyField: its items array and size. nullopt if unreadable.
struct BoneList {
    Address items = 0;
    std::size_t size = 0;
};
std::optional<BoneList> boneList(const Game& game, Address bodyField) {
    const Address body = readPointer(game, bodyField, Freshness::Fresh);
    const Address root = body ? readPointer(game, body + off::PlayerBody::SkeletonRootJoint, Freshness::Fresh) : 0;
    const Address list = root ? readPointer(game, root + off::Skeleton::Values, Freshness::Fresh) : 0;
    if (!list) return std::nullopt;
    std::int32_t size = 0;
    const Address items = readPointer(game, list + kIl2CppLayout.listItems, Freshness::Fresh);
    if (!items || !game.mem.tryRead(list + kIl2CppLayout.listSize, size, Freshness::Fresh) || size < 0 || size > kMaxBones)
        return std::nullopt;
    return BoneList{items, static_cast<std::size_t>(size)};
}

}  // namespace

std::optional<SkeletonBones> resolveSkeletonBones(const Game& game, Address bodyField) {
    const auto list = boneList(game, bodyField);
    if (!list) return std::nullopt;

    // The managed Transforms of bones [0, last joint bone] in one read, then every joint's native
    // transform in one batch.
    std::vector<Address> managed(std::min(list->size, kMaxJointBone + 1), 0);
    if (managed.empty() ||
        !game.mem.readBytes(list->items + kIl2CppLayout.arrayData, std::as_writable_bytes(std::span{managed}),
                            Freshness::Fresh))
        return std::nullopt;

    SkeletonBones bones;
    mem::ReadBatch batch(game.mem);
    for (std::size_t j = 0; j < kJointCount; ++j) {
        const std::size_t index = kJointSources[j].bone;
        if (index < managed.size() && MemoryView::isUserPointer(managed[index]))
            batch.add(managed[index] + kIl2CppLayout.unityObjectCachedPtr, bones.transforms[j]);
    }
    batch.execute(Freshness::Fresh);

    auto valid = [&](std::size_t j) { return MemoryView::isUserPointer(bones.transforms[j]); };
    for (std::size_t j = 0; j < kPositionJoints; ++j)
        if (!valid(j)) return std::nullopt;
    bones.full = true;
    for (std::size_t j = kPositionJoints; j < kJointCount; ++j) bones.full = bones.full && valid(j);
    if (!bones.full) std::fill(bones.transforms.begin() + kPositionJoints, bones.transforms.end(), Address{0});
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

std::optional<Joints> relativeJoints(std::span<const std::optional<unity::Pose>> poses, Vec3 position) {
    if (poses.size() != kJointCount || !usable(poses[0])) return std::nullopt;
    const Vec3 base = poses[0]->position;
    Joints joints;
    for (std::size_t j = 0; j < kJointCount; ++j) {
        if (!usable(poses[j]) || math::length(poses[j]->position - base) > kMaxJointReach) return std::nullopt;
        joints[j] = poses[j]->position - position;
    }
    return joints;
}

std::string jointProblem(std::span<const std::optional<unity::Pose>> poses) {
    if (poses.size() != kJointCount) return std::format("{} of {} joints resolved", poses.size(), kJointCount);
    if (!usable(poses[0])) return "Base unusable";
    for (std::size_t j = 1; j < kJointCount; ++j) {
        if (!usable(poses[j])) return std::format("joint {} ({}) unusable", j, kJointSources[j].nameSuffix);
        if (const float d = math::length(poses[j]->position - poses[0]->position); d > kMaxJointReach)
            return std::format("joint {} ({}) is {:.1f} m from Base", j, kJointSources[j].nameSuffix, d);
    }
    return {};
}

std::vector<BoneInfo> readAllBones(const Game& game, Address bodyField) {
    const auto list = boneList(game, bodyField);
    if (!list) return {};
    std::vector<BoneInfo> bones;
    bones.reserve(list->size);
    for (std::size_t i = 0; i < list->size; ++i) {
        BoneInfo b;
        b.index = i;
        const Address managed = readPointer(game, list->items + kIl2CppLayout.arrayData + i * sizeof(Address), Freshness::Fresh);
        if (const auto native = managed ? game.managed.nativePointer(managed, Freshness::Fresh) : std::nullopt) {
            const Address object = readPointer(game, *native + kUnityLayout.componentGameObject, Freshness::Fresh);
            if (object)
                b.name = game.mem.readCString(readPointer(game, object + kUnityLayout.gameObjectName, Freshness::Fresh),
                                              128, Freshness::Fresh);
            b.pose = game.transforms.worldPose(*native, Freshness::Fresh);
        }
        bones.push_back(std::move(b));
    }
    return bones;
}

}  // namespace radar::eft
