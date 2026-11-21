#pragma once

#include "game/eft/items/ItemTree.hpp"
#include "game/eft/model/WorldState.hpp"
#include "game/eft/raid/RaidSession.hpp"

#include <memory>
#include <optional>
#include <string>
#include <vector>

namespace radar::eft {

// The PMC's owned items (stash and equipment), for what quests (and later hideout upgrades) still
// need. Publishes WorldState::stash.
//
// In a raid the player's own profile (Player.Profile) has its stash stripped, so this reads the
// menu-side profile, which stays loaded for the whole session:
//   TarkovApplication (a MonoBehaviour on "Application (Main Client)"; no static path, found in the
//   scene) → ClientApplication<T>.ClientBackEnd → ClientBackend<T>.Session (ClientBackendSession)
//   → _profile → Inventory → Stash, SortingTable, QuestStashItems, HideoutAreaStashes; Equipment.
// The stash doesn't change during a raid, so it's read rarely: a full read is ~2k items, ~50 ms.
// Verified on SPT (2026-11-21, the radar-diagnose stash probe), in a raid and in the menu.
class Stash final : public RaidSubsystem {
public:
    static constexpr auto kInterval = std::chrono::seconds(30);
    static constexpr ItemTreeLimits kLimits{.maxDepth = 12, .maxNodes = 60000, .maxSlots = 64, .maxGridItems = 8192};

    Stash(std::shared_ptr<const RaidSession> session, WorldState& world);
    ~Stash() override;

    void registerTasks(sched::TaskRunner& live, sched::TaskRunner& background) override;

    void update();

    // The TarkovApplication object: scene objects named like "*application*" first, then the rest.
    // nullopt if not found. `checked`: how many objects were looked at.
    [[nodiscard]] static std::optional<Address> findApplication(const Game& game, std::size_t* checked = nullptr);
    // The session's (PMC) profile; 0 if the path doesn't read.
    [[nodiscard]] static Address sessionProfile(const Game& game, Address application);

    // Owned items, per template: the stash's (and its other containers') and the equipment's. nullopt
    // if the profile's inventory doesn't read.
    struct Contents {
        std::string profileId;
        std::vector<OwnedItem> stash, equipment;
        bool truncated = false;
        friend bool operator==(const Contents&, const Contents&) = default;
    };
    [[nodiscard]] static std::optional<Contents> readContents(const Game& game, Address profile);

    // Units per template of item trees (slot and grid contents included); ordered by tpl.
    [[nodiscard]] static std::vector<OwnedItem> tally(const std::vector<ItemNode>& nodes);

private:
    std::shared_ptr<const RaidSession> session_;
    const Game& game_;
    WorldState& world_;
    Address application_ = 0;
    std::optional<Contents> last_;
    std::uint64_t revision_ = 0;
    bool loggedFailure_ = false;
};

}  // namespace radar::eft
