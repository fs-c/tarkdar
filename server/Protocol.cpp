#include "server/Protocol.hpp"

#include <crow/json.h>

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

}  // namespace

std::string encodeHello() {
    crow::json::wvalue data;
    data["protocol"] = kProtocolVersion;
    return envelope("hello", 0, 0, std::move(data));
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
        v["ai"] = p.ai;
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

std::string encodeLoot(const eft::LootSnapshot& snap) {
    std::vector<crow::json::wvalue> list;
    list.reserve(snap.loot.size());
    for (const auto& l : snap.loot) {
        crow::json::wvalue v;
        v["id"] = l.id;
        v["kind"] = lootKind(l.kind);
        v["tpl"] = l.templateId;
        v["obj"] = l.objectName;
        v["pos"] = vec(l.position);
        if (!l.contents.empty()) v["contents"] = itemList(l.contents);
        list.push_back(std::move(v));
    }
    crow::json::wvalue data;
    data["loot"] = std::move(list);
    return envelope("loot", snap.raidId, snap.revision, std::move(data));
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

}  // namespace radar::server
