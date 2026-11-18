#include "server/Protocol.hpp"

#include <crow/json.h>

#include <algorithm>
#include <array>
#include <chrono>
#include <cmath>

namespace radar::server {

namespace {

std::int64_t nowMs() {
    return std::chrono::duration_cast<std::chrono::milliseconds>(std::chrono::system_clock::now().time_since_epoch())
        .count();
}

// Envelope shared by every message.
std::string envelope(std::string_view type, std::uint64_t raid, std::uint64_t rev, crow::json::wvalue data) {
    crow::json::wvalue msg;
    msg["type"] = std::string(type);
    if (raid) msg["raid"] = raid;
    else msg["raid"] = nullptr;
    msg["rev"] = rev;
    msg["t"] = nowMs();
    msg["data"] = std::move(data);
    return msg.dump();
}

// Positions are sent with centimetre precision: plenty for a radar, and keeps messages small.
double round2(float v) { return std::round(static_cast<double>(v) * 100.0) / 100.0; }

const char* stateId(eft::Status::State s) {
    switch (s) {
    case eft::Status::State::WaitingForProcess: return "waitingForProcess";
    case eft::Status::State::WaitingForModules: return "waitingForModules";
    case eft::Status::State::WaitingForRaid: return "waitingForRaid";
    case eft::Status::State::InRaid: return "inRaid";
    case eft::Status::State::Cooldown: return "cooldown";
    }
    return "unknown";
}

const char* sideId(eft::Side s) {
    switch (s) {
    case eft::Side::Usec: return "usec";
    case eft::Side::Bear: return "bear";
    case eft::Side::Savage: return "savage";
    case eft::Side::Unknown: break;
    }
    return "unknown";
}

crow::json::wvalue vec(const math::Vec3& v) {
    return std::vector<crow::json::wvalue>{round2(v.x), round2(v.y), round2(v.z)};
}

const char* lootKind(eft::LootEntry::Kind k) {
    switch (k) {
    case eft::LootEntry::Kind::Item: return "item";
    case eft::LootEntry::Kind::QuestItem: return "quest";
    case eft::LootEntry::Kind::Container: return "container";
    case eft::LootEntry::Kind::Airdrop: return "airdrop";
    case eft::LootEntry::Kind::Corpse: return "corpse";
    }
    return "item";
}

// {"tpl": ..., "slot": ... (if any), "count": ... (if > 1), "items": [...] (if any)}
crow::json::wvalue itemNode(const eft::ItemNode& n) {
    crow::json::wvalue v;
    v["tpl"] = n.tpl;
    if (!n.slot.empty()) v["slot"] = n.slot;
    if (n.count > 1) v["count"] = n.count;
    if (!n.children.empty()) {
        std::vector<crow::json::wvalue> children;
        for (const auto& c : n.children) children.push_back(itemNode(c));
        v["items"] = std::move(children);
    }
    return v;
}

crow::json::wvalue itemList(const std::vector<eft::ItemNode>& nodes) {
    std::vector<crow::json::wvalue> list;
    list.reserve(nodes.size());
    for (const auto& n : nodes) list.push_back(itemNode(n));
    return list;
}

crow::json::wvalue lootEntry(const eft::LootEntry& l) {
    crow::json::wvalue v;
    v["id"] = l.id;
    v["kind"] = lootKind(l.kind);
    v["tpl"] = l.templateId;
    v["obj"] = l.objectName;
    v["pos"] = vec(l.position);
    if (!l.contents.empty()) v["contents"] = itemList(l.contents);
    return v;
}

}  // namespace

std::string encodeHello(bool live, bool overlay) {
    crow::json::wvalue data;
    data["protocol"] = kProtocolVersion;
    data["live"] = live;
    data["overlay"] = overlay;
    return envelope("hello", 0, 0, std::move(data));
}

std::string encodeRecordingHeader(const eft::Status& s) {
    crow::json::wvalue data;
    data["protocol"] = kProtocolVersion;
    data["format"] = kRecordingFormat;
    data["locationId"] = s.locationId;
    data["offsetsMismatch"] = s.offsetsMismatch;
    return envelope("recording", s.raidId, 0, std::move(data));
}

std::string encodeStatus(const eft::Status& s) {
    crow::json::wvalue data;
    data["state"] = stateId(s.state);
    data["raidPending"] = s.raidPending;
    if (s.state == eft::Status::State::InRaid) data["locationId"] = s.locationId;
    else data["locationId"] = nullptr;
    data["offsetsMismatch"] = s.offsetsMismatch;
    return envelope("status", s.raidId, s.attachGeneration, std::move(data));
}

std::string encodePlayers(const eft::PlayersSnapshot& snap) {
    std::vector<crow::json::wvalue> list;
    list.reserve(snap.players.size());
    for (const auto& p : snap.players) {
        crow::json::wvalue v;
        v["id"] = p.id;
        v["local"] = p.local;
        v["kind"] = eft::kindName(p.kind);
        v["ai"] = p.ai;
        if (!p.voice.empty()) v["voice"] = p.voice;
        if (p.role) v["role"] = *p.role;
        if (!p.nickname.empty()) v["nickname"] = p.nickname;
        if (!p.groupId.empty()) v["groupId"] = p.groupId;
        v["side"] = sideId(p.side);
        v["dead"] = p.dead;
        v["absent"] = p.absent;
        if (p.position) v["pos"] = vec(*p.position);
        else v["pos"] = nullptr;
        v["yaw"] = round2(p.yaw);
        v["pitch"] = round2(p.pitch);
        list.push_back(std::move(v));
    }
    crow::json::wvalue data;
    data["players"] = std::move(list);
    return envelope("players", snap.raidId, snap.revision, std::move(data));
}

std::optional<std::string> encodeSkeletons(const eft::PlayersSnapshot& snap) {
    std::vector<crow::json::wvalue> list;
    for (const auto& p : snap.players) {
        if (!p.joints || p.dead || p.absent) continue;
        // Whole centimetres relative to the player's position: about 3 characters per number.
        std::vector<crow::json::wvalue> j;
        j.reserve(eft::kJointCount * 3);
        for (const auto& v : *p.joints)
            for (const float c : {v.x, v.y, v.z}) j.emplace_back(static_cast<std::int64_t>(std::lround(c * 100.0f)));
        crow::json::wvalue v;
        v["id"] = p.id;
        v["j"] = std::move(j);
        list.push_back(std::move(v));
    }
    if (list.empty()) return std::nullopt;
    crow::json::wvalue data;
    data["players"] = std::move(list);
    return envelope("skeletons", snap.raidId, snap.revision, std::move(data));
}

std::string encodeExfils(const eft::ExfilsSnapshot& snap) {
    std::vector<crow::json::wvalue> list;
    for (const auto& e : snap.exfils) {
        crow::json::wvalue v;
        v["id"] = e.id;
        v["kind"] = e.kind == eft::Exfil::Kind::Secret ? "secret" : "regular";
        v["name"] = e.name;
        v["status"] = e.status;
        if (e.position) v["pos"] = vec(*e.position);
        else v["pos"] = nullptr;
        list.push_back(std::move(v));
    }
    crow::json::wvalue data;
    data["exfils"] = std::move(list);
    return envelope("exfils", snap.raidId, snap.revision, std::move(data));
}

std::string encodeExplosives(const eft::ExplosivesSnapshot& snap) {
    std::vector<crow::json::wvalue> grenades, tripwires;
    for (const auto& g : snap.grenades) {
        crow::json::wvalue v;
        v["id"] = g.id;
        v["pos"] = vec(g.position);
        grenades.push_back(std::move(v));
    }
    for (const auto& t : snap.tripwires) {
        crow::json::wvalue v;
        v["id"] = t.id;
        v["from"] = vec(t.from);
        v["to"] = vec(t.to);
        tripwires.push_back(std::move(v));
    }
    crow::json::wvalue data;
    data["grenades"] = std::move(grenades);
    data["tripwires"] = std::move(tripwires);
    return envelope("explosives", snap.raidId, snap.revision, std::move(data));
}

std::string encodeVehicles(const eft::VehiclesSnapshot& snap) {
    std::vector<crow::json::wvalue> list;
    for (const auto& v : snap.vehicles) {
        crow::json::wvalue o;
        o["id"] = v.id;
        o["kind"] = "btr";
        o["state"] = v.state;
        o["pos"] = vec(v.position);
        o["yaw"] = std::round(static_cast<double>(v.yaw) * 10.0) / 10.0;
        std::vector<crow::json::wvalue> occupants;
        for (const auto& occ : v.occupants) {
            crow::json::wvalue x;
            x["player"] = occ.playerId;
            x["seat"] = occ.seat == eft::VehicleOccupant::Seat::Gunner ? "gunner" : "passenger";
            occupants.push_back(std::move(x));
        }
        o["occupants"] = std::move(occupants);
        list.push_back(std::move(o));
    }
    crow::json::wvalue data;
    data["vehicles"] = std::move(list);
    return envelope("vehicles", snap.raidId, snap.revision, std::move(data));
}

std::string encodeQuests(const eft::QuestsSnapshot& snap) {
    crow::json::wvalue data;
    if (!snap.known) {
        data["quests"] = nullptr;
        return envelope("quests", snap.raidId, snap.revision, std::move(data));
    }
    std::vector<crow::json::wvalue> list;
    for (const auto& q : snap.quests) {
        crow::json::wvalue o;
        o["id"] = q.id;
        o["status"] = q.status;
        if (q.completedConditions) {
            std::vector<crow::json::wvalue> done;
            for (const auto& c : *q.completedConditions) done.emplace_back(c);
            o["done"] = std::move(done);
        } else {
            o["done"] = nullptr;
        }
        list.push_back(std::move(o));
    }
    data["quests"] = std::move(list);
    return envelope("quests", snap.raidId, snap.revision, std::move(data));
}

namespace {
// Matrix elements: 6 decimals (they're mostly in -10..10; translations in metres).
double round6(float v) { return std::round(static_cast<double>(v) * 1e6) / 1e6; }

crow::json::wvalue cameraView(const eft::CameraView& v) {
    crow::json::wvalue o;
    std::vector<crow::json::wvalue> vp;
    for (const float e : v.viewProjection.m) vp.emplace_back(round6(e));
    o["vp"] = std::move(vp);
    if (v.position) o["pos"] = vec(*v.position);
    if (v.fieldOfView > 0) o["fov"] = round2(v.fieldOfView);
    if (v.aspect > 0) o["aspect"] = std::round(static_cast<double>(v.aspect) * 1e4) / 1e4;
    return o;
}
}  // namespace

std::string encodeCamera(const eft::CameraSnapshot& snap) {
    crow::json::wvalue data;
    if (snap.fps) data["fps"] = cameraView(*snap.fps);
    else data["fps"] = nullptr;
    data["aiming"] = snap.aiming;
    data["scoped"] = snap.scoped;
    data["magnification"] = round2(snap.magnification);
    std::vector<crow::json::wvalue> sights;
    for (const auto& s : snap.sights) {
        crow::json::wvalue o;
        o["scope"] = s.scope;
        o["mode"] = s.mode;
        o["zoom"] = round2(s.zoom);
        if (s.maxZoom > 0) {
            o["min"] = round2(s.minZoom);
            o["max"] = round2(s.maxZoom);
        }
        o["magnified"] = s.magnified;
        o["current"] = s.current;
        sights.push_back(std::move(o));
    }
    data["sights"] = std::move(sights);
    if (snap.activeSight) data["active"] = static_cast<std::uint64_t>(*snap.activeSight);
    else data["active"] = nullptr;
    if (snap.optic) data["optic"] = cameraView(*snap.optic);
    else data["optic"] = nullptr;
    return envelope("camera", snap.raidId, snap.revision, std::move(data));
}

std::string encodeLoot(const eft::LootSnapshot& snap) {
    std::vector<crow::json::wvalue> list;
    list.reserve(snap.loot.size());
    for (const auto& l : snap.loot) list.push_back(lootEntry(l));
    crow::json::wvalue data;
    data["loot"] = std::move(list);
    return envelope("loot", snap.raidId, snap.revision, std::move(data));
}

std::string encodeLootDiff(std::uint64_t raidId, std::uint64_t revision, const std::vector<const eft::LootEntry*>& added,
                           const std::vector<std::uint32_t>& removed, const std::vector<const eft::LootEntry*>& changed) {
    const auto entries = [](const std::vector<const eft::LootEntry*>& from) {
        std::vector<crow::json::wvalue> list;
        list.reserve(from.size());
        for (const auto* l : from) list.push_back(lootEntry(*l));
        return list;
    };
    std::vector<crow::json::wvalue> ids;
    ids.reserve(removed.size());
    for (auto id : removed) ids.emplace_back(id);
    crow::json::wvalue data;
    data["added"] = entries(added);
    data["removed"] = std::move(ids);
    data["changed"] = entries(changed);
    return envelope("lootDiff", raidId, revision, std::move(data));
}

std::string encodeEquipment(const eft::EquipmentSnapshot& snap) {
    std::vector<crow::json::wvalue> list;
    for (const auto& p : snap.players) {
        crow::json::wvalue v;
        v["id"] = p.playerId;
        v["slots"] = itemList(p.slots);
        list.push_back(std::move(v));
    }
    crow::json::wvalue data;
    data["players"] = std::move(list);
    return envelope("equipment", snap.raidId, snap.revision, std::move(data));
}

std::optional<std::string> messageType(std::string_view message) {
    const auto json = crow::json::load(message.data(), message.size());
    if (!json || json.t() != crow::json::type::Object || !json.has("type") ||
        json["type"].t() != crow::json::type::String)
        return std::nullopt;
    return std::string(json["type"].s());
}

std::optional<std::int64_t> messageTime(std::string_view message) {
    const auto json = crow::json::load(message.data(), message.size());
    if (!json || json.t() != crow::json::type::Object || !json.has("t") || json["t"].t() != crow::json::type::Number)
        return std::nullopt;
    return json["t"].i();
}

namespace {

std::optional<overlay::Color> parseColor(const crow::json::rvalue& v) {
    if (v.t() != crow::json::type::String) return std::nullopt;
    const std::string s = v.s();
    if (s.size() != 7 && s.size() != 9) return std::nullopt;
    if (s[0] != '#') return std::nullopt;
    std::array<std::uint8_t, 4> c{0, 0, 0, 255};
    for (std::size_t i = 0; i + 1 < s.size(); i += 2) {
        unsigned value = 0;
        for (const char ch : {s[i + 1], s[i + 2]}) {
            const int digit = ch >= '0' && ch <= '9'   ? ch - '0'
                              : ch >= 'a' && ch <= 'f' ? ch - 'a' + 10
                              : ch >= 'A' && ch <= 'F' ? ch - 'A' + 10
                                                       : -1;
            if (digit < 0) return std::nullopt;
            value = value * 16 + static_cast<unsigned>(digit);
        }
        c[i / 2] = static_cast<std::uint8_t>(value);
    }
    return overlay::Color{c[0], c[1], c[2], c[3]};
}

std::optional<double> number(const crow::json::rvalue& o, const char* key) {
    if (!o.has(key) || o[key].t() != crow::json::type::Number) return std::nullopt;
    const double v = o[key].d();
    return std::isfinite(v) ? std::optional(v) : std::nullopt;
}

std::optional<bool> boolean(const crow::json::rvalue& o, const char* key) {
    if (!o.has(key)) return std::nullopt;
    if (o[key].t() == crow::json::type::True) return true;
    if (o[key].t() == crow::json::type::False) return false;
    return std::nullopt;
}

}  // namespace

std::optional<overlay::Config> decodeOverlay(std::string_view text) {
    constexpr std::size_t kMaxMarks = 4096;
    constexpr std::size_t kMaxLabel = 80;
    const auto msg = crow::json::load(text.data(), text.size());
    if (!msg || msg.t() != crow::json::type::Object || !msg.has("type") || msg["type"].t() != crow::json::type::String ||
        msg["type"].s() != "overlay" || !msg.has("data") || msg["data"].t() != crow::json::type::Object)
        return std::nullopt;
    const auto& d = msg["data"];
    overlay::Config c;
    c.on = boolean(d, "on").value_or(false);
    if (const auto raid = number(d, "raid"); raid && *raid >= 0) c.raid = static_cast<std::uint64_t>(*raid);
    if (const auto delay = number(d, "delayMs")) c.delay = std::chrono::milliseconds(std::clamp(static_cast<int>(*delay), 0, 500));
    c.grid = boolean(d, "grid").value_or(false);
    if (const auto range = number(d, "lootRange")) c.lootRange = static_cast<float>(std::clamp(*range, 0.0, 1000.0));
    if (const auto radius = number(d, "scopeRadius")) c.scopeRadius = static_cast<float>(std::clamp(*radius, 0.0, 1.0));
    if (d.has("otherPlayers")) c.otherPlayers = parseColor(d["otherPlayers"]);
    if (d.has("marks") && d["marks"].t() == crow::json::type::List) {
        for (const auto& m : d["marks"]) {
            if (c.marks.size() >= kMaxMarks) break;
            if (m.t() != crow::json::type::Object || !m.has("kind") || m["kind"].t() != crow::json::type::String) continue;
            overlay::Mark mark;
            const std::string kind = m["kind"].s();
            if (kind == "player") mark.kind = overlay::MarkKind::Player;
            else if (kind == "loot") mark.kind = overlay::MarkKind::Loot;
            else if (kind == "exfil") mark.kind = overlay::MarkKind::Exfil;
            else continue;
            const auto id = number(m, "id");
            const auto color = m.has("color") ? parseColor(m["color"]) : std::nullopt;
            if (!id || *id < 0 || *id > 4294967295.0 || !color) continue;
            mark.id = static_cast<std::uint32_t>(*id);
            mark.color = *color;
            if (m.has("label") && m["label"].t() == crow::json::type::String) mark.label = std::string(m["label"].s()).substr(0, kMaxLabel);
            if (m.has("emphasis") && m["emphasis"].t() == crow::json::type::String) {
                const std::string e = m["emphasis"].s();
                mark.emphasis = e == "faint" ? overlay::Emphasis::Faint
                                : e == "strong" ? overlay::Emphasis::Strong
                                : e == "loud"   ? overlay::Emphasis::Loud
                                                : overlay::Emphasis::Normal;
            }
            c.marks.push_back(std::move(mark));
        }
    }
    return c;
}

}  // namespace radar::server
