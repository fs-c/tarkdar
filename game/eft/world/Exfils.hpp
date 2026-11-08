#pragma once

#include "game/eft/model/WorldState.hpp"
#include "game/eft/raid/RaidSession.hpp"

#include <memory>
#include <optional>
#include <string>
#include <unordered_map>

namespace radar::eft {

// Exfiltration points for the local player. Publishes WorldState::exfils.
//
// Discovery (every kDiscoveryInterval, merging, entries are never removed during a raid):
//  - regular exfils from the PMC or scav list (by the local player's side), filtered by eligibility:
//    PMC: the exfil's EligibleEntryPoints contains Profile.Info.EntryPoint;
//    scav: the exfil's EligibleIds contains Profile.Id (both compared trimmed, case-insensitive).
//    With an empty eligibility id no regular exfils are shown;
//  - secret exfils, unfiltered.
// Positions are read once (exfils don't move), and retried with each status refresh until they
// succeed. Status is refreshed every kStatusInterval.
class Exfils final : public RaidSubsystem {
public:
    static constexpr auto kDiscoveryInterval = std::chrono::seconds(8);
    static constexpr auto kStatusInterval = std::chrono::seconds(1);
    static constexpr std::size_t kMaxExfils = 256;
    static constexpr std::size_t kMaxEligibility = 64;

    Exfils(std::shared_ptr<const RaidSession> session, WorldState& world);
    ~Exfils() override;

    void registerTasks(sched::TaskRunner& live, sched::TaskRunner& background) override;

    void discover();
    void refreshStatus();

private:
    struct Entry {
        Exfil exfil;
        Address instance = 0;
    };
    struct LocalIdentity {
        bool scav = false;
        std::string eligibilityId;  // entry point (PMC) or profile id (scav)
    };

    std::optional<LocalIdentity> localIdentity() const;
    bool eligible(Address exfil, const LocalIdentity& local) const;
    bool readStatus();  // true if any status changed
    void publish();

    std::shared_ptr<const RaidSession> session_;
    const Game& game_;
    WorldState& world_;
    std::unordered_map<Address, Entry> entries_;
    std::uint32_t nextId_ = 1;
    std::uint64_t revision_ = 0;
};

}  // namespace radar::eft
