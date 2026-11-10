#include "server/Feeds.hpp"
#include "server/MessageHub.hpp"
#include "server/Protocol.hpp"
#include "server/Recorder.hpp"
#include "server/Server.hpp"

#include <doctest/doctest.h>
#include <zlib.h>

#include <algorithm>

#include <filesystem>
#include <fstream>
#include <thread>

using namespace radar;
namespace fs = std::filesystem;

namespace {
struct TempDir {
    fs::path path;
    TempDir() {
        path = fs::temp_directory_path() / ("radar-test-" + std::to_string(std::rand()) + std::to_string(
            std::chrono::steady_clock::now().time_since_epoch().count()));
        fs::create_directories(path);
    }
    ~TempDir() { fs::remove_all(path); }
    void write(const fs::path& rel, const std::string& text) const {
        fs::create_directories((path / rel).parent_path());
        std::ofstream(path / rel) << text;
    }
};

bool contains(const std::string& s, std::string_view part) { return s.find(part) != std::string::npos; }
}  // namespace

TEST_CASE("protocol encoding") {
    CHECK(server::messageType(server::encodeHello()) == "hello");
    CHECK(server::messageTime(server::encodeHello()).value_or(0) > 0);

    eft::Status status;
    status.state = eft::Status::State::InRaid;
    status.locationId = "bigmap";
    status.raidId = 3;
    const auto s = server::encodeStatus(status);
    CHECK(server::messageType(s) == "status");
    CHECK(contains(s, R"("state":"inRaid")"));
    CHECK(contains(s, R"("locationId":"bigmap")"));
    CHECK(contains(s, R"("raid":3)"));

    status.state = eft::Status::State::WaitingForRaid;
    CHECK(contains(server::encodeStatus(status), R"("locationId":null)"));

    eft::PlayersSnapshot snap;
    snap.raidId = 3;
    snap.revision = 9;
    snap.players.push_back({.id = 1, .local = true, .kind = eft::PlayerKind::Local, .side = eft::Side::Usec,
                            .voice = {}, .position = math::Vec3{1.234f, 2, -3.456f}, .yaw = 90.0f});
    snap.players.push_back({.id = 2, .kind = eft::PlayerKind::Observed, .ai = true, .side = eft::Side::Savage,
                            .dead = true, .voice = "BossKilla", .position = std::nullopt});
    snap.players.push_back({.id = 3, .kind = eft::PlayerKind::Client, .ai = true, .side = eft::Side::Savage, .role = 6,
                            .position = std::nullopt});
    const auto p = server::encodePlayers(snap);
    CHECK(contains(p, R"("pos":[1.23,2,-3.46])"));
    CHECK(contains(p, R"("pos":null)"));
    CHECK(contains(p, R"("side":"savage")"));
    CHECK(contains(p, R"("kind":"local")"));
    CHECK(contains(p, R"("kind":"observed")"));
    CHECK(contains(p, R"("voice":"BossKilla")"));
    CHECK(contains(p, R"("role":6)"));
    // Only the player that has a role gets the field.
    std::size_t roles = 0;
    for (auto at = p.find(R"("role":)"); at != std::string::npos; at = p.find(R"("role":)", at + 1)) ++roles;
    CHECK(roles == 1);
    CHECK(contains(p, R"("rev":9)"));

    eft::LootSnapshot loot;
    loot.loot.push_back({.id = 1, .kind = eft::LootEntry::Kind::Container, .templateId = "box", .objectName = "c",
                         .position = {1, 2, 3},
                         .contents = {{.tpl = "bag", .slot = "", .count = 1,
                                       .children = {{.tpl = "ammo", .slot = "", .count = 30, .children = {}}}}}});
    const auto l = server::encodeLoot(loot);
    CHECK(contains(l, R"("contents":[{)"));
    CHECK(contains(l, R"("tpl":"bag")"));
    CHECK((contains(l, R"({"tpl":"ammo","count":30})") || contains(l, R"({"count":30,"tpl":"ammo"})")));

    eft::EquipmentSnapshot eq;
    eq.players.push_back({.playerId = 4, .slots = {{.tpl = "ak", .slot = "FirstPrimaryWeapon", .count = 1, .children = {}}}});
    const auto e = server::encodeEquipment(eq);
    CHECK(contains(e, R"("id":4)"));
    CHECK((contains(e, R"({"tpl":"ak","slot":"FirstPrimaryWeapon"})") || contains(e, R"({"slot":"FirstPrimaryWeapon","tpl":"ak"})")));

    CHECK_FALSE(server::messageType("not json"));
    CHECK_FALSE(server::messageType(R"({"no":"type"})"));
}

TEST_CASE("MessageHub sends hello and the latest state on connect") {
    server::MessageHub hub;
    std::vector<std::string> tapped;
    hub.setTap([&](const std::string& m) { tapped.push_back(m); });
    hub.broadcast("status", "s1");
    hub.broadcast("players", "p1");
    hub.broadcast("players", "p2");

    std::vector<std::string> received;
    const auto id = hub.connect([&](const std::string& m) { received.push_back(m); }, "hello");
    CHECK(received == std::vector<std::string>{"hello", "p2", "s1"});  // latest per type
    hub.broadcast("players", "p3");
    CHECK(received.back() == "p3");
    hub.disconnect(id);
    hub.broadcast("players", "p4");
    CHECK(received.back() == "p3");
    CHECK(tapped.size() == 5);
}

TEST_CASE("resolveUnder keeps requests inside the root") {
    TempDir root, outside;
    root.write("index.html", "x");
    root.write("assets/app.js", "x");
    outside.write("secret.txt", "x");
    fs::create_directory_symlink(outside.path, root.path / "link");

    CHECK(server::resolveUnder(root.path, "index.html"));
    CHECK(server::resolveUnder(root.path, "assets/app.js"));
    CHECK(server::resolveUnder(root.path, "/assets/app.js"));  // absolute → relative to root
    CHECK(server::resolveUnder(root.path, "assets/../index.html"));
    CHECK_FALSE(server::resolveUnder(root.path, "assets"));  // directory
    CHECK_FALSE(server::resolveUnder(root.path, "missing.txt"));
    CHECK_FALSE(server::resolveUnder(root.path, "../" + outside.path.filename().string() + "/secret.txt"));
    CHECK_FALSE(server::resolveUnder(root.path, "link/secret.txt"));  // symlink escaping the root
    CHECK_FALSE(server::resolveUnder(root.path, std::string("index.html\0", 11)));
    CHECK_FALSE(server::resolveUnder(root.path / "nope", "index.html"));
}

TEST_CASE("originAllowed: only pages from the same host may connect") {
    CHECK(server::originAllowed("", "127.0.0.1:8080"));
    CHECK(server::originAllowed("http://127.0.0.1:8080", "127.0.0.1:8080"));
    CHECK(server::originAllowed("http://localhost:5173", "localhost:5173"));  // vite dev server proxy
    CHECK_FALSE(server::originAllowed("https://evil.example", "127.0.0.1:8080"));
    CHECK_FALSE(server::originAllowed("http://127.0.0.1:9999", "127.0.0.1:8080"));
    CHECK_FALSE(server::originAllowed("null", "127.0.0.1:8080"));
}

TEST_CASE("buildMapsIndex lists valid map folders") {
    TempDir maps;
    maps.write("woods/map.json", R"({"name":"Woods","ids":["woods"]})");
    maps.write("broken/map.json", "{ not json");
    maps.write("empty/readme.txt", "no config");
    maps.write("labs/map.json", R"({"name":"Labs","ids":["laboratory"]})");
    const auto index = server::buildMapsIndex(maps.path);
    CHECK(contains(index, R"("folder":"labs")"));
    CHECK(contains(index, R"("folder":"woods")"));
    CHECK_FALSE(contains(index, "broken"));
    CHECK_FALSE(contains(index, "empty"));
    CHECK(index.find("labs") < index.find("woods"));  // sorted
    CHECK(server::buildMapsIndex(maps.path / "missing") == "[]");
}

TEST_CASE("LiveFeed broadcasts only changes") {
    server::MessageHub hub;
    std::vector<std::string> types;
    hub.setTap([&](const std::string& m) { types.push_back(server::messageType(m).value_or("?")); });
    eft::WorldState world;
    auto status = std::make_shared<eft::Status>();
    server::LiveFeed feed({.status = [&] { return std::shared_ptr<const eft::Status>(status); }, .world = &world}, hub);

    CHECK(feed.poll() == 6);  // initial status + every (empty) world snapshot
    CHECK(feed.poll() == 0);
    world.players.publish(eft::PlayersSnapshot{.raidId = 1, .revision = 1, .players = {}});
    CHECK(feed.poll() == 1);
    auto changed = std::make_shared<eft::Status>(*status);
    changed->state = eft::Status::State::InRaid;
    status = changed;
    CHECK(feed.poll() == 1);
    CHECK(types == std::vector<std::string>{"status", "players", "exfils", "explosives", "loot", "equipment", "players", "status"});
}

namespace {
// Lines of a recording, plain or gzipped.
std::vector<std::string> readLines(const fs::path& file) {
    std::vector<std::string> lines;
    gzFile in = gzopen(file.c_str(), "rb");
    REQUIRE(in);
    std::string line;
    char buf[4096];
    int n;
    while ((n = gzread(in, buf, sizeof buf)) > 0)
        for (int i = 0; i < n; ++i) {
            if (buf[i] == '\n') lines.push_back(std::exchange(line, {}));
            else line += buf[i];
        }
    gzclose(in);
    return lines;
}

std::vector<std::string> types(const std::vector<std::string>& lines) {
    std::vector<std::string> out;
    for (const auto& l : lines) out.push_back(server::messageType(l).value_or("?"));
    return out;
}

std::vector<fs::path> filesIn(const fs::path& dir) {
    std::vector<fs::path> files;
    for (const auto& e : fs::directory_iterator(dir)) files.push_back(e.path());
    std::sort(files.begin(), files.end());
    return files;
}

eft::Status raidStatus(std::uint64_t raid, std::string location = "bigmap") {
    return {.state = eft::Status::State::InRaid, .locationId = std::move(location), .raidId = raid};
}

eft::PlayersSnapshot playersAt(std::uint64_t raid, std::uint64_t rev, float x, bool dead = false) {
    return {.raidId = raid, .revision = rev,
            .players = {{.id = 1, .local = true, .kind = eft::PlayerKind::Local, .dead = dead, .position = math::Vec3{x, 0, 0}}}};
}

eft::LootEntry lootItem(std::uint32_t id, std::string tpl) {
    return {.id = id, .kind = eft::LootEntry::Kind::Item, .templateId = std::move(tpl), .position = {1, 2, 3}};
}
}  // namespace

TEST_CASE("RaidRecorder writes one file per raid") {
    TempDir dir;
    std::int64_t now = 1'000'000;
    {
        server::RaidRecorder rec({.dir = dir.path, .playersInterval = std::chrono::milliseconds(100),
                                  .lootKeyframeInterval = std::chrono::milliseconds(60'000)},
                                 [&] { return now; });
        const auto send = [&](const eft::Status& st) { rec.onStatus(st, server::encodeStatus(st)); };
        const auto players = [&](const eft::PlayersSnapshot& p) { rec.onPlayers(p, server::encodePlayers(p)); };
        const auto loot = [&](const eft::LootSnapshot& l) { rec.onLoot(l, server::encodeLoot(l)); };

        send({.state = eft::Status::State::WaitingForRaid});
        CHECK_FALSE(rec.flushActive());
        // The raid's first snapshots can come before its status says "in raid".
        players(playersAt(1, 1, 0));
        loot({.raidId = 1, .revision = 1, .loot = {lootItem(1, "a"), lootItem(2, "b")}});
        send(raidStatus(1));
        REQUIRE(rec.flushActive());
        CHECK(rec.flushActive()->ends_with("_bigmap.jsonl"));

        now += 30;
        players(playersAt(1, 2, 1));  // throttled
        now += 30;
        players(playersAt(1, 3, 2, /*dead*/ true));  // a death is written at once
        now += 30;
        players(playersAt(1, 4, 2, true));  // throttled again
        now += 100;
        players(playersAt(1, 5, 2, true));  // due

        now += 1000;
        auto changed = lootItem(2, "b");
        changed.contents = {{.tpl = "c"}};
        loot({.raidId = 1, .revision = 2, .loot = {changed, lootItem(3, "d")}});  // 1 removed, 2 changed, 3 added
        loot({.raidId = 1, .revision = 3, .loot = {changed, lootItem(3, "d")}});  // nothing changed: no line
        now += 60'000;
        loot({.raidId = 1, .revision = 4, .loot = {changed}});  // keyframe due
        rec.onMessage("exfils", 1, server::encodeExfils({.raidId = 1, .revision = 1}));
        rec.onMessage("exfils", 2, server::encodeExfils({.raidId = 2, .revision = 1}));  // other raid: ignored
        players(playersAt(1, 6, 3, true));  // pending when the raid ends: written on finish

        send({.state = eft::Status::State::Cooldown});
        CHECK_FALSE(rec.flushActive());
        players(playersAt(0, 7, 0));  // after the raid: not recorded
    }  // waits for compression

    const auto files = filesIn(dir.path);
    REQUIRE(files.size() == 1);
    CHECK(files[0].string().ends_with("_bigmap.jsonl.gz"));
    const auto lines = readLines(files[0]);
    CHECK(types(lines) == std::vector<std::string>{"recording", "players", "loot", "status", "players", "players",
                                                   "lootDiff", "loot", "exfils", "players", "status"});
    CHECK(contains(lines[0], R"("locationId":"bigmap")"));
    CHECK(contains(lines[0], R"("format":1)"));
    CHECK(contains(lines[4], R"("rev":3)"));
    CHECK(contains(lines[5], R"("rev":5)"));
    CHECK(contains(lines[6], R"("removed":[1])"));
    CHECK(contains(lines[6], R"("tpl":"d")"));
    CHECK(contains(lines[6], R"("contents")"));
    CHECK(contains(lines[9], R"("rev":6)"));
    CHECK(contains(lines[10], R"("state":"cooldown")"));
}

TEST_CASE("RaidRecorder: a new raid id starts a new file; keep prunes old ones") {
    TempDir dir;
    std::int64_t now = 1'000'000;
    server::RaidRecorder rec({.dir = dir.path, .keep = 2, .compress = false}, [&] { return now; });
    for (std::uint64_t raid = 1; raid <= 3; ++raid) {
        const auto st = raidStatus(raid, "woods");
        rec.onStatus(st, server::encodeStatus(st));
        now += 5000;  // names carry the time to the second
    }
    rec.finish();
    const auto files = filesIn(dir.path);
    REQUIRE(files.size() == 2);
    // The newest two: raids 2 and 3.
    CHECK(contains(readLines(files[0])[0], R"("raid":2)"));
    CHECK(contains(readLines(files[1])[0], R"("raid":3)"));
}

TEST_CASE("RecordingIndex lists recordings") {
    TempDir dir;
    auto rec = std::make_unique<server::RaidRecorder>(server::RaidRecorder::Config{.dir = dir.path});
    const auto st = raidStatus(1, "factory4_day");
    rec->onStatus(st, server::encodeStatus(st));
    const auto active = rec->flushActive();
    REQUIRE(active);
    // A legacy stream (no header): location from the status line.
    dir.write("old.jsonl", R"({"type":"status","raid":1,"rev":1,"t":100,"data":{"state":"inRaid","locationId":"woods"}})"
                           "\n" R"({"type":"players","raid":1,"rev":1,"t":5100,"data":{"players":[]}})" "\n" "cut off li");
    dir.write("notes.txt", "x");

    server::RecordingIndex index(dir.path);
    auto list = index.list(active);
    REQUIRE(list.size() == 2);
    const auto& live = list[0];  // newest first
    CHECK(live.name == *active);
    CHECK(live.active);
    CHECK(live.locationId == "factory4_day");
    CHECK(live.start.has_value());
    CHECK_FALSE(live.end.has_value());
    CHECK(list[1].name == "old.jsonl");
    CHECK(list[1].locationId == "woods");
    CHECK(list[1].start == 100);
    CHECK(list[1].end == 5100);
    CHECK(contains(index.listJson(active), R"("name":"old.jsonl")"));

    rec.reset();  // finishes, waits for compression
    list = index.list(std::nullopt);
    REQUIRE(list.size() == 2);
    CHECK(list[0].name == *active + ".gz");
    CHECK(list[0].end.has_value());
}

TEST_CASE("isRecordingName") {
    CHECK(server::isRecordingName("2026-11-10_19-03-12_bigmap.jsonl"));
    CHECK(server::isRecordingName("a.jsonl.gz"));
    CHECK_FALSE(server::isRecordingName("a.jsonl.gz.tmp"));
    CHECK_FALSE(server::isRecordingName("../a.jsonl"));
    CHECK_FALSE(server::isRecordingName(".jsonl"));
    CHECK_FALSE(server::isRecordingName("x.json"));
}
