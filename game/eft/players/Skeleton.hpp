#pragma once

#include "core/unity/Transforms.hpp"
#include "game/eft/Game.hpp"
#include "game/eft/model/Players.hpp"

#include <array>
#include <optional>
#include <span>
#include <string>
#include <string_view>
#include <vector>

// Player skeleton. Players have no usable position field; the radar position is derived from the
// skeleton's root ("Base", at floor level) and feet. The other joints give the body's pose.
namespace radar::eft {

// Where a joint comes from: its index in the skeleton's bone list, and the end of the bone's
// GameObject name (e.g. "Base HumanLCalf" ends in "LCalf"). Only --diagnose checks the names; the
// tracking reads by index alone. Verified with --diagnose (2026-11-12, local and observed players):
// bone 0 is the "Player" root object, at floor level.
struct JointSource {
    std::size_t bone;
    std::string_view nameSuffix;
};
inline constexpr std::array<JointSource, kJointCount> kJointSources{{
    {0, "Player"},
    {18, "LFoot"},
    {23, "RFoot"},
    {14, "Pelvis"},
    {37, "Spine3"},
    {132, "Neck"},
    {133, "Head"},
    {15, "LThigh1"},
    {17, "LCalf"},
    {20, "RThigh1"},
    {22, "RCalf"},
    {90, "LUpperarm"},
    {91, "LForearm1"},
    {94, "LPalm"},
    {111, "RUpperarm"},
    {112, "RForearm1"},
    {115, "RPalm"},
}};

// Native transforms of the skeleton's joints, in Joint order.
struct SkeletonBones {
    std::array<Address, kJointCount> transforms{};
    // Every joint resolved. Otherwise only the first kPositionJoints are set (the bone list was
    // too short or some joint bone unreadable), which is enough for the position.
    bool full = false;
    [[nodiscard]] std::size_t count() const { return full ? kJointCount : kPositionJoints; }
    [[nodiscard]] std::span<const Address> used() const { return std::span{transforms}.first(count()); }
};

// Follows the PlayerBody pointer stored at bodyField (Player._playerBody or ObservedPlayerView.PlayerBody)
// → skeleton root joint → bone list, then each joint bone's managed Transform to its native transform.
// nullopt if the bone list or any position bone is unreadable.
[[nodiscard]] std::optional<SkeletonBones> resolveSkeletonBones(const Game& game, Address bodyField);

// Picks the position from bone poses (Base, left foot, right foot):
//  1. Base, if usable;  2. midpoint of the feet, if both usable and 1 cm < separation ≤ 5.5 m;
//  3. left foot;  4. right foot.  "Usable" = present, finite, not at the world origin.
[[nodiscard]] std::optional<math::Vec3> pickPosition(const std::array<std::optional<unity::Pose>, 3>& poses);

// Whether the poses look like a real skeleton: all three present, none within 2 m of the origin on
// every axis, each foot within 5 m of Base and the feet within 5 m of each other. Failing this
// means the cached bone pointers are stale (e.g. the body was rebuilt) and need resolving again.
[[nodiscard]] bool plausibleSkeleton(const std::array<std::optional<unity::Pose>, 3>& poses);

// No joint is further than this from Base (metres): a standing player reaching up, or prone.
inline constexpr float kMaxJointReach = 3.0f;

// The joints relative to `position`, from all kJointCount poses (Joint order). nullopt unless every
// pose is present, sane and within kMaxJointReach of Base: a half-drawn body is worse than none.
[[nodiscard]] std::optional<Joints> relativeJoints(std::span<const std::optional<unity::Pose>> poses,
                                                   math::Vec3 position);

// Why relativeJoints rejects these poses (Joint order), e.g. "joint 6 (Head) is 3.4 m from Base"; empty if
// it doesn't. For --diagnose.
[[nodiscard]] std::string jointProblem(std::span<const std::optional<unity::Pose>> poses);

// One entry of a skeleton's bone list, for --diagnose.
struct BoneInfo {
    std::size_t index = 0;
    std::string name;                   // the bone's GameObject name; empty if unreadable
    std::optional<unity::Pose> pose{};  // world pose
};
// Every bone of the skeleton behind bodyField (up to kMaxBones), read one by one. Empty if the
// bone list is unreadable. Slow: for diagnostics only.
[[nodiscard]] std::vector<BoneInfo> readAllBones(const Game& game, Address bodyField);

}  // namespace radar::eft
