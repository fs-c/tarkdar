import { describe, expect, it } from "vitest";
import type { Player } from "./protocol";
import { bossGroups, identityText, playerType } from "./roles";

const ai = (extra: Partial<Player> = {}): Player =>
  ({ id: 1, local: false, kind: "observed", ai: true, side: "savage", dead: false, absent: false, pos: null, yaw: 0, pitch: 0, ...extra });
const human = (side: Player["side"], extra: Partial<Player> = {}) => ai({ ai: false, side, ...extra });
const type = (p: Player, groups?: Map<string, string>) => playerType(p, groups).type;

describe("playerType", () => {
  it("classifies us and humans by side, ignoring their role", () => {
    expect(playerType(human("usec", { local: true, kind: "local", role: 1 }))).toMatchObject({ type: "self", label: "You" });
    expect(type(human("usec", { voice: "Usec_10_Garrett" }))).toBe("usec");
    expect(type(human("bear", { voice: "Bear_1_Eng", role: 1 }))).toBe("bear");
    expect(playerType(human("savage", { voice: "Scav_6" }))).toMatchObject({ type: "p-scav", label: "Player scav" });
    expect(type(human("unknown"))).toBe("other");
  });

  it("uses the role for AI", () => {
    expect(playerType(ai({ role: 6 }))).toEqual({ type: "boss", label: "Killa", reason: "role 6 (bossKilla)" });
    expect(playerType(ai({ role: 5, voice: "Scav_3" }))).toMatchObject({ type: "follower", label: "Reshala guard" });
    expect(type(ai({ role: 9, voice: "Scav_1" }))).toBe("raider");
    expect(type(ai({ role: 24 }))).toBe("rogue");
    expect(type(ai({ role: 57 }))).toBe("cultist");
    expect(type(ai({ role: 60 }))).toBe("zombie");
    expect(type(ai({ role: 1 }))).toBe("ai-scav");
    expect(playerType(ai({ role: 52, side: "usec" }))).toMatchObject({ type: "usec", label: "USEC bot" });
    expect(type(ai({ role: 27 }))).toBe("boss"); // Big Pipe: a follower in the enum
    expect(playerType(ai({ role: 999 }))).toMatchObject({ type: "other", label: "role 999" });
  });

  it("prefers a clear voice over an observed player's role that looks like a default", () => {
    const t = playerType(ai({ role: 0, voice: "BossKnight" }));
    expect(t).toMatchObject({ type: "boss", label: "Knight" });
    expect(t.reason).toContain("ignored role 0");
    // Full players' roles come from their profile: trusted.
    expect(type(ai({ kind: "client", role: 0, voice: "BossKnight" }))).toBe("ai-scav");
  });

  it("falls back to the voice without a role (voices seen in recordings and SPT's bot database)", () => {
    expect(playerType(ai({ voice: "BossBigPipe" }))).toMatchObject({ type: "boss", label: "Big Pipe" });
    expect(playerType(ai({ voice: "Boss_Partizan" }))).toMatchObject({ type: "boss", label: "Partisan" });
    expect(playerType(ai({ voice: "Boss_Sturman" }))).toMatchObject({ type: "boss", label: "Shturman" });
    expect(playerType(ai({ voice: "BossZombieTagilla" }))).toMatchObject({ type: "boss", label: "Tagilla (infected)" });
    expect(playerType(ai({ voice: "BossSomethingNew" }))).toMatchObject({ type: "boss", label: "SomethingNew" });
    expect(type(ai({ voice: "SectantWarrior" }))).toBe("cultist");
    expect(type(ai({ voice: "Zombie_Fast" }))).toBe("zombie");
    expect(type(ai({ voice: "Scav_4" }))).toBe("ai-scav");
    expect(type(ai())).toBe("ai-scav");
    expect(type(ai({ voice: "Usec_2" }))).toBe("rogue");
    expect(type(ai({ voice: "Bear_3" }))).toBe("raider");
    expect(playerType(ai({ voice: "Usec_2", side: "usec" }))).toMatchObject({ type: "usec", label: "USEC bot" });
    expect(playerType(ai({ voice: "Arena_Guard_1" }))).toMatchObject({ type: "other", label: "Arena_Guard_1", reason: "no rule matched" });
  });

  it("makes AI in a boss's group its guards", () => {
    const players = [
      ai({ id: 1, voice: "BossBully", groupId: "g1" }),
      ai({ id: 2, voice: "Scav_3", groupId: "g1" }),
      ai({ id: 3, voice: "Scav_3", groupId: "g2" }),
    ];
    const groups = bossGroups(players);
    expect(groups).toEqual(new Map([["g1", "Reshala"]]));
    expect(playerType(players[1]!, groups)).toMatchObject({ type: "follower", label: "Reshala guard" });
    expect(type(players[2]!, groups)).toBe("ai-scav");
    expect(type(players[0]!, groups)).toBe("boss");
    expect(type(players[1]!)).toBe("ai-scav"); // without the groups
  });
});

describe("identityText", () => {
  it("lists the raw inputs", () => {
    expect(identityText(ai({ role: 5, voice: "Scav_3", nickname: "Torpeda", groupId: "g1" }))).toBe(
      "AI · observed · side savage · role 5 (followerBully) · voice Scav_3 · nick Torpeda · group g1",
    );
  });
});
