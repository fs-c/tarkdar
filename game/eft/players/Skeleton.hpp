#pragma once

#include "core/unity/Transforms.hpp"
#include "game/eft/Game.hpp"

#include <array>
#include <optional>

// Player position from skeleton bones. Players have no usable position field; the radar position
// is derived from the skeleton's root ("Base", at floor level) and feet.
namespace radar::eft {

// Unity bone indices in the player skeleton's bone list.
enum class Bone : std::size_t { Base = 0, LeftFoot = 18, RightFoot = 23 };

// Native transforms of the bones needed for the position: Base, left foot, right foot.
struct PositionBones {
    std::array<Address, 3> transforms{};
};

// Follows Player._playerBody → skeleton root joint → bone list, then each bone's managed Transform
// to its native transform. nullopt if any step fails.
[[nodiscard]] std::optional<PositionBones> resolvePositionBones(const Game& game, Address player);

// Picks the position from bone poses (Base, left foot, right foot):
//  1. Base, if usable;  2. midpoint of the feet, if both usable and 1 cm < separation ≤ 5.5 m;
//  3. left foot;  4. right foot.  "Usable" = present, finite, not at the world origin.
[[nodiscard]] std::optional<math::Vec3> pickPosition(const std::array<std::optional<unity::Pose>, 3>& poses);

// Whether the poses look like a real skeleton: all three present, none within 2 m of the origin on
// every axis, each foot within 5 m of Base and the feet within 5 m of each other. Failing this
// means the cached bone pointers are stale (e.g. the body was rebuilt) and need resolving again.
[[nodiscard]] bool plausibleSkeleton(const std::array<std::optional<unity::Pose>, 3>& poses);

}  // namespace radar::eft
