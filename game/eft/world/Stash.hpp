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
//   local player (ClientPlayer)._session (ClientBackendSession) → _profile → Inventory → Stash,
//   SortingTable, QuestStashItems, HideoutAreaStashes; Equipment.
// The same session is reachable from TarkovApplication (→ ClientApplication<T>.ClientBackEnd →
// ClientBackend<T>.Session), but that object has no static path and has to be found in the scene;
// radar-diagnose still does that, to probe the menu-side profile outside a raid.
// The stash doesn't change during a raid, so it's read rarely: a full read is ~2k items, ~50 ms.
class Stash final : public RaidSubsystem {
public:
    static constexpr auto kInterval = std::chrono::seconds(30);
    static constexpr ItemTreeLimits kLimits{.maxDepth = 12, .maxNodes = 60000, .maxSlots = 64, .maxGridItems = 8192};

    Stash(std::shared_ptr<const RaidSession> session, WorldState& world);
    ~Stash() override;

    void registerTasks(sched::TaskRunner& live, sched::TaskRunner& background) override;

    void update();

    // The TarkovApplication object (diagnostics): scene objects named like "*application*" first, then
    // the rest. nullopt if not found. `checked`: how many objects were looked at.
    [[nodiscard]] static std::optional<Address> findApplication(const Game& game, std::size_t* checked = nullptr);
    // The session's (PMC) profile, from the application; 0 if the path doesn't read.
    [[nodiscard]] static Address sessionProfile(const Game& game, Address application);
    // The profile of a ClientBackendSession; 0 if `session` isn't one or the profile doesn't read.
    [[nodiscard]] static Address profileOfSession(const Game& game, Address session);
    // The session's profile, from the local player (ClientPlayer._session); 0 if it doesn't read.
    [[nodiscard]] static Address playerSessionProfile(const Game& game, Address localPlayer);

    // Owned items, per template: the stash's (and its other containers') and the equipment's. nullopt
    // if the profile's inventory doesn't read.
    struct Contents {
        std::string profileId;
        std::vector<OwnedItem> stash, equipment;
        bool truncated = false;
        std::size_t unreadable = 0;  // failed reads: the trees may be incomplete (ItemTreeReader::failures)
        friend bool operator==(const Contents&, const Contents&) = default;
    };
    [[nodiscard]] static std::optional<Contents> readContents(const Game& game, Address profile);

    // Units per template of item trees (slot and grid contents included); ordered by tpl.
    [[nodiscard]] static std::vector<OwnedItem> tally(const std::vector<ItemNode>& nodes);

private:
    std::shared_ptr<const RaidSession> session_;
    const Game& game_;
    WorldState& world_;
    std::optional<Contents> last_;
    std::uint64_t revision_ = 0;
    bool loggedFailure_ = false;
};

}  // namespace radar::eft
