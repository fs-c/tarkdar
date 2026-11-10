#include "FakeWorld.hpp"

#include "app/Diagnose.hpp"

#include <doctest/doctest.h>

#include <cstdio>
#include <string>

using namespace radar;
using radar::test::FakeWorld;

namespace {
std::string runToString(mem::Target& target) {
    std::FILE* f = std::tmpfile();
    REQUIRE(f);
    app::runDiagnose(target, 1, f);
    std::rewind(f);
    std::string out;
    char buf[4096];
    while (std::size_t n = std::fread(buf, 1, sizeof buf, f)) out.append(buf, n);
    std::fclose(f);
    return out;
}
bool has(const std::string& s, std::string_view part) { return s.find(part) != std::string::npos; }
}  // namespace

TEST_CASE("diagnose reports each step, with hints for failures") {
    FakeWorld w;
    w.newWorld(u"Woods", 3);
    mem::Target target(w.fake, std::string(eft::kProcessName),
                       {std::string(eft::kGameAssembly), std::string(eft::kUnityPlayer)});
    const auto out = runToString(target);
    INFO(out);
    CHECK(has(out, "OK   attached to EscapeFromTarkov.exe"));
    CHECK(has(out, "OK   type index points at EFT.GamePlayerOwner"));
    CHECK(has(out, "OK   GameObjectManager at"));
    CHECK(has(out, "GamePlayerOwner static: world"));
    CHECK(has(out, "location 'Woods'"));
    CHECK(has(out, "OK   3 registered players"));
    CHECK(has(out, "OK   3 players built"));
    CHECK(has(out, "OK   3 of 3 players have a position"));
    // The fake has no exfils or loot: those fail, with hints.
    CHECK(has(out, "FAIL no exfils"));
    CHECK(has(out, "check: ClientLocalGameWorld.ExfiltrationController"));
    CHECK(has(out, "FAIL no loot resolved"));
}

TEST_CASE("diagnose lists player kinds and why entries didn't build") {
    FakeWorld w;
    w.newWorld(u"Woods", 2);
    const mem::Address observed = w.newObservedPlayer();
    const mem::Address broken = w.heap.object(w.observedClass);
    const auto roster = w.rosterPlayers();
    std::vector<mem::Address> list(roster.begin(), roster.end());
    list.push_back(observed);
    list.push_back(broken);
    w.setRosterList(list);
    mem::Target target(w.fake, std::string(eft::kProcessName),
                       {std::string(eft::kGameAssembly), std::string(eft::kUnityPlayer)});
    const auto out = runToString(target);
    INFO(out);
    CHECK(has(out, "FAIL only 3 of 4 players built (client ×1, local ×1, observed ×1)"));
    CHECK(has(out, "(ObservedPlayerView): ObservedPlayerView.ObservedPlayerController is null"));
    CHECK(has(out, "observed ai side 4 voice BossKilla alive"));
}

TEST_CASE("diagnose without a raid stops after discovery") {
    FakeWorld w;
    w.newWorld(u"hideout", 1);
    mem::Target target(w.fake, std::string(eft::kProcessName),
                       {std::string(eft::kGameAssembly), std::string(eft::kUnityPlayer)});
    const auto out = runToString(target);
    INFO(out);
    CHECK(has(out, "lobby location 'hideout'"));
    CHECK(has(out, "FAIL no raid found"));
    CHECK(has(out, "skipping players"));
}
