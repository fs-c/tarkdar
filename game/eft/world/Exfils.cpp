#include "game/eft/world/Exfils.hpp"

#include "core/log/Log.hpp"
#include "core/mem/ReadBatch.hpp"
#include "game/eft/Read.hpp"
#include "game/eft/model/Players.hpp"

#include <eft_offsets.hpp>

#include <algorithm>
#include <cctype>

namespace radar::eft {

using mem::Freshness;

namespace {
std::string normalized(std::string s) {
    const auto first = s.find_first_not_of(" \t\r\n");
    const auto last = s.find_last_not_of(" \t\r\n");
    s = first == std::string::npos ? std::string{} : s.substr(first, last - first + 1);
    std::transform(s.begin(), s.end(), s.begin(), [](unsigned char c) { return static_cast<char>(std::tolower(c)); });
    return s;
}
}  // namespace

Exfils::Exfils(std::shared_ptr<const RaidSession> session, WorldState& world)
    : session_(std::move(session)), game_(session_->game), world_(world) {}

Exfils::~Exfils() { world_.exfils.publish(ExfilsSnapshot{}); }

void Exfils::registerTasks(sched::TaskRunner&, sched::TaskRunner& background) {
    background.add("exfils.discover", {.interval = kDiscoveryInterval, .runOnStart = true}, [this] { discover(); });
    background.add("exfils.status", {.interval = kStatusInterval, .phase = std::chrono::milliseconds(250)},
                   [this] { refreshStatus(); });
}

std::optional<Exfils::LocalIdentity> Exfils::localIdentity() const {
    const Address player = session_->start.localPlayer;
    const Address profile = readPointer(game_, player + off::Player::Profile);
    const Address info = profile ? readPointer(game_, profile + off::Profile::Info) : 0;
    std::int32_t side = 0;
    if (!info || !game_.mem.tryRead(info + off::PlayerInfo::Side, side)) return std::nullopt;
    LocalIdentity local;
    local.scav = (side & static_cast<std::int32_t>(Side::Savage)) != 0;
    const auto id = local.scav ? game_.managed.readStringField(profile + off::Profile::Id, 64)
                               : game_.managed.readStringField(info + off::PlayerInfo::EntryPoint, 128);
    local.eligibilityId = normalized(id.value_or(""));
    return local;
}

bool Exfils::eligible(Address exfil, const LocalIdentity& local) const {
    if (local.eligibilityId.empty()) return false;
    std::optional<std::vector<Address>> ids;
    if (local.scav) {
        ids = game_.managed.readList<Address>(readPointer(game_, exfil + off::ScavExfiltrationPoint::EligibleIds),
                                              kMaxEligibility);
    } else {
        ids = game_.managed.readArray<Address>(readPointer(game_, exfil + off::ExfiltrationPoint::EligibleEntryPoints),
                                               kMaxEligibility);
    }
    if (!ids) return false;
    return std::any_of(ids->begin(), ids->end(), [&](Address s) {
        return normalized(game_.managed.readString(s, 128).value_or("")) == local.eligibilityId;
    });
}

void Exfils::discover() {
    const Address controller =
        readPointer(game_, session_->start.localGameWorld + off::ClientLocalGameWorld::ExfiltrationController);
    const auto local = localIdentity();
    if (!controller || !local) return;

    struct Candidate {
        Address instance;
        Exfil::Kind kind;
    };
    std::vector<Candidate> candidates;
    const auto addList = [&](std::uint32_t field, Exfil::Kind kind) {
        const auto list = game_.managed.readArray<Address>(readPointer(game_, controller + field), kMaxExfils);
        if (list)
            for (Address p : *list)
                if (mem::MemoryView::isUserPointer(p) && !entries_.contains(p)) candidates.push_back({p, kind});
    };
    addList(local->scav ? off::ExfiltrationController::ScavExfiltrationPoints
                        : off::ExfiltrationController::ExfiltrationPoints,
            Exfil::Kind::Regular);
    addList(off::ExfiltrationController::MSecretExfiltrationPoints, Exfil::Kind::Secret);

    std::vector<Entry> found;
    std::vector<Address> transforms;
    for (const auto& c : candidates) {
        if (c.kind == Exfil::Kind::Regular && !eligible(c.instance, *local)) continue;
        const Address settings = readPointer(game_, c.instance + off::ExfiltrationPoint::Settings);
        auto name = settings ? game_.managed.readStringField(settings + off::ExitSettings::Name, 256) : std::nullopt;
        if (!name || name->empty()) continue;
        Entry e;
        e.instance = c.instance;
        e.exfil.kind = c.kind;
        e.exfil.name = std::move(*name);
        found.push_back(std::move(e));
        transforms.push_back(transformOfComponent(game_, c.instance).value_or(0));
    }
    if (found.empty()) return;

    const auto poses = game_.transforms.worldPoses(transforms, Freshness::Cached);
    for (std::size_t i = 0; i < found.size(); ++i) {
        Entry& e = found[i];
        if (poses[i]) e.exfil.position = poses[i]->position;
        e.exfil.id = nextId_++;
        log::debug("exfils: +{} '{}'{}", e.exfil.kind == Exfil::Kind::Secret ? "secret" : "regular", e.exfil.name,
                   e.exfil.position ? "" : " (no position)");
        entries_.emplace(e.instance, std::move(e));
    }
    readStatus();
    publish();
}

void Exfils::refreshStatus() {
    bool changed = readStatus();
    // Retry positions that couldn't be read at discovery.
    std::vector<Entry*> missing;
    std::vector<Address> transforms;
    for (auto& [instance, e] : entries_) {
        if (e.exfil.position) continue;
        if (const auto t = transformOfComponent(game_, instance)) {
            missing.push_back(&e);
            transforms.push_back(*t);
        }
    }
    const auto poses = game_.transforms.worldPoses(transforms, Freshness::Cached);
    for (std::size_t i = 0; i < missing.size(); ++i) {
        if (poses[i]) {
            missing[i]->exfil.position = poses[i]->position;
            changed = true;
        }
    }
    if (changed) publish();
}

bool Exfils::readStatus() {
    if (entries_.empty()) return false;
    std::vector<std::pair<Entry*, std::int32_t>> reads;
    reads.reserve(entries_.size());
    for (auto& [instance, e] : entries_) reads.emplace_back(&e, 0);
    mem::ReadBatch batch(game_.mem);
    for (auto& [e, status] : reads) batch.add(e->instance + off::ExfiltrationPoint::Status, status);
    batch.execute(Freshness::Fresh);
    bool changed = false;
    for (std::size_t i = 0; i < reads.size(); ++i) {
        auto& [e, status] = reads[i];
        if (batch.complete(i) && status != e->exfil.status) {
            e->exfil.status = status;
            changed = true;
        }
    }
    return changed;
}

void Exfils::publish() {
    ExfilsSnapshot snap;
    snap.raidId = session_->id;
    snap.revision = ++revision_;
    for (const auto& [instance, e] : entries_) snap.exfils.push_back(e.exfil);
    std::sort(snap.exfils.begin(), snap.exfils.end(), [](const auto& a, const auto& b) { return a.id < b.id; });
    world_.exfils.publish(std::move(snap));
}

}  // namespace radar::eft
