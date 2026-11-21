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
// Names: the game's own for the exit name (lookupTexts, Locale.hpp), looked up once per name. A name
// that wasn't found (typically the text table isn't readable yet early in the raid load) shows the
// exit name meanwhile, and is looked up again every kNameRetryInterval, up to kMaxNameRetries times.
// Positions are read once (exfils don't move), and retried with each status refresh until they
// succeed. Status is refreshed every kStatusInterval.
class Exfils final : public RaidSubsystem {
public:
    static constexpr auto kDiscoveryInterval = std::chrono::seconds(8);
    static constexpr auto kStatusInterval = std::chrono::seconds(1);
    static constexpr std::size_t kMaxExfils = 256;
    static constexpr std::size_t kMaxEligibility = 64;
    static constexpr auto kNameRetryInterval = std::chrono::seconds(4);
    static constexpr unsigned kMaxNameRetries = 15;

    Exfils(std::shared_ptr<const RaidSession> session, WorldState& world);
    ~Exfils() override;

    void registerTasks(sched::TaskRunner& live, sched::TaskRunner& background) override;

    void discover();
    void refreshStatus(sched::Clock::time_point now = sched::Clock::now());

private:
    struct Entry {
        Exfil exfil;
        Address instance = 0;
        unsigned nameRetries = 0;  // lookups after discovery while the name is still the exit name
    };
    struct LocalIdentity {
        bool scav = false;
        std::string eligibilityId;  // entry point (PMC) or profile id (scav)
    };

    std::optional<LocalIdentity> localIdentity() const;
    bool eligible(Address exfil, const LocalIdentity& local) const;
    bool retryNames();  // true if any name resolved
    bool readStatus();  // true if any status changed
    void publish();

    std::shared_ptr<const RaidSession> session_;
    const Game& game_;
    WorldState& world_;
    std::unordered_map<Address, Entry> entries_;
    std::unordered_map<std::string, std::string> names_;  // exit name → display name (found texts only)
    sched::Clock::time_point nextNameRetry_{};
    std::uint32_t nextId_ = 1;
    std::uint64_t revision_ = 0;
};

}  // namespace radar::eft
