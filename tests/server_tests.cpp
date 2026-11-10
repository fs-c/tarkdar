#include "server/Feeds.hpp"
#include "server/MessageHub.hpp"
#include "server/Protocol.hpp"
#include "server/Server.hpp"

#include <doctest/doctest.h>

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
    const auto p = server::encodePlayers(snap);
    CHECK(contains(p, R"("pos":[1.23,2,-3.46])"));
    CHECK(contains(p, R"("pos":null)"));
    CHECK(contains(p, R"("side":"savage")"));
    CHECK(contains(p, R"("kind":"local")"));
    CHECK(contains(p, R"("kind":"observed")"));
    CHECK(contains(p, R"("voice":"BossKilla")"));
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

TEST_CASE("StreamRecorder and StreamReplay round-trip") {
    TempDir dir;
    const auto file = dir.path / "stream.jsonl";
    {
        server::StreamRecorder rec(file);
        REQUIRE(rec.ok());
        rec.write(server::encodeHello());  // hello lines are skipped on replay
        eft::Status st;
        rec.write(server::encodeStatus(st));
        rec.write("garbage line");
        rec.write(server::encodePlayers(eft::PlayersSnapshot{.raidId = 1, .revision = 1, .players = {}}));
    }
    server::MessageHub hub;
    std::vector<std::string> types;
    hub.setTap([&](const std::string& m) { types.push_back(server::messageType(m).value_or("?")); });
    server::StreamReplay replay(file, hub, /*speed*/ 1000.0, /*loop*/ false);
    std::stop_source stop;
    CHECK(replay.run(stop.get_token()));
    CHECK(types == std::vector<std::string>{"status", "players"});

    server::StreamReplay missing(dir.path / "nope.jsonl", hub);
    CHECK_FALSE(missing.run(stop.get_token()));
}
