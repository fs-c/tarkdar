#!/usr/bin/env python3
"""Writes a synthetic raid recording, for frontend work without a game.

Usage: make-demo-stream.py [output.jsonl] [--seconds N]

The default output is recordings/demo.jsonl. Open it in the frontend's raid list, with the backend
serving the recordings:  radar-backend --offline
The location id is "demo", which matches maps/2d/demo/. Format: docs/protocol.md, "Raid recordings".

Scenario: the local player walks a loop around the map centre, passing through a two-floor
"building" (y up to 6 m), while bots wander, one dies after 20 s (leaving a corpse) and one leaves
the list after 35 s. Also: three exfils (one opens after 10 s), scattered loot and containers, an
airdrop that lands over 15 s, a tripwire, and a grenade thrown at 12 s that explodes at 17 s. The
local player picks up a LEDX lying on its path at 10 s and takes a GPU out of a container at 20 s
(both show up in its equipment a few seconds later, as with the real backend's 5 s re-reads).
"""
import argparse
import json
import math
import os
import random
import time

RATE_HZ = 20
PROTOCOL = 1
RECORDING_FORMAT = 1


def envelope(kind, raid, rev, t_ms, data):
    return json.dumps({"type": kind, "raid": raid, "rev": rev, "t": t_ms, "data": data}, separators=(",", ":"))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("output", nargs="?", default=os.path.join("recordings", "demo.jsonl"))
    ap.add_argument("--seconds", type=float, default=60.0)
    args = ap.parse_args()

    rng = random.Random(42)
    t0 = int(time.time() * 1000)
    raid = 1
    lines = []

    def status(t, state, location=None, pending=False):
        lines.append(envelope("status", raid if state == "inRaid" else None, 1, t,
                              {"state": state, "raidPending": pending, "locationId": location,
                               "offsetsMismatch": False}))

    start = t0
    lines.append(envelope("recording", raid, 0, start, {"protocol": PROTOCOL, "format": RECORDING_FORMAT,
                                                        "locationId": "demo", "offsetsMismatch": False}))
    status(start, "inRaid", "demo")

    bots = []
    for i in range(8):
        bots.append({
            "id": i + 2,
            "side": rng.choice(["savage", "savage", "savage", "usec", "bear"]),
            "x": rng.uniform(-150, 150), "z": rng.uniform(-150, 150),
            "heading": rng.uniform(0, 360), "speed": rng.uniform(0.5, 3.0),
        })

    containers = ["578f8782245977354405a1e3", "578f87a3245977356274f2cb", "5909d89086f77472591234a0",
                  "5d6fd45b86f774317075ed43", "578f87b7245977356274f2cd"]
    loot = []
    for i in range(250):
        loot.append({"id": i + 1, "kind": "item", "tpl": "5449016a4bdc2d6f028b456f", "obj": f"item_{i}",
                     "pos": [round(rng.uniform(-220, 220), 2), 0.0, round(rng.uniform(-220, 220), 2)]})
    for i in range(30):
        loot.append({"id": 300 + i, "kind": "container", "tpl": rng.choice(containers), "obj": "container",
                     "pos": [round(rng.uniform(-220, 220), 2), 0.0, round(rng.uniform(-220, 220), 2)]})
    loot.append({"id": 400, "kind": "quest", "tpl": "questtpl", "obj": "quest_item", "pos": [-30.0, 0.0, 80.0]})
    # On the local player's loop: a LEDX it passes (and takes) at 10 s, a container it passes at 20 s.
    # Container contents aren't read (the backend sends none).
    LEDX, GPU = "5c0530ee86f774697952d952", "57347ca924597744596b4e71"
    loot.append({"id": 450, "kind": "item", "tpl": LEDX, "obj": "item_ledx", "pos": [0.5, 0.0, 60.0]})
    loot.append({"id": 460, "kind": "container", "tpl": "5909d89086f77472591234a0", "obj": "container_pc",
                 "pos": [-60.5, 0.0, 0.5]})
    exfils_closed = [{"id": 1, "kind": "regular", "name": "ZB-1011", "status": 1, "pos": [180.0, 0.0, 150.0]},
                     {"id": 2, "kind": "regular", "name": "Crossroads", "status": 4, "pos": [-200.0, 0.0, -120.0]},
                     {"id": 3, "kind": "secret", "name": "Smugglers' Basement", "status": 1, "pos": [90.0, 0.0, -190.0]}]
    def loadout(r):
        weapon = {"tpl": r.choice(["5447a9cd4bdc2dbd208b4567", "5bb2475ed4351e00853264e3", "5ac66d2e5acfc43b321d4b53"]),
                  "slot": "FirstPrimaryWeapon",
                  "items": [{"tpl": "55d4887d4bdc2d962f8b4570", "slot": "mod_magazine",
                             "items": [{"tpl": "54527a984bdc2d4e668b4567", "slot": "cartridges", "count": 30}]},
                            {"tpl": "57dc2fa62459775949412633", "slot": "mod_stock"}]}
        rig = {"tpl": "5d5d646386f7742797261fd9", "slot": "TacticalVest",
               "items": [{"tpl": "55d4887d4bdc2d962f8b4570", "count": 1}, {"tpl": "5710c24ad2720bc3458b45a3", "count": 2}]}
        slots = [weapon, rig, {"tpl": "5aa7d03ae5b5b00016327db5", "slot": "Headwear"}]
        if r.random() < 0.5:
            slots.append({"tpl": "5e4abc6786f77406812bd572", "slot": "Backpack",
                          "items": [{"tpl": "5449016a4bdc2d6f028b456f", "count": r.randint(1000, 50000)}]})
        return slots

    equipment = {"players": [{"id": 1, "slots": loadout(rng)}] + [{"id": b["id"], "slots": loadout(rng)} for b in bots]}
    tripwire = {"id": 1, "from": [-60.0, 0.2, -10.0], "to": [-52.0, 0.2, -4.0]}
    rev = {"exfils": 0, "explosives": 0, "loot": 0, "equipment": 0}

    def emit(kind, t, data):
        rev[kind] += 1
        lines.append(envelope(kind, raid, rev[kind], t, data))

    steps = int(args.seconds * RATE_HZ)
    for step in range(steps):
        t = start + int(step * 1000 / RATE_HZ)
        secs = step / RATE_HZ
        # Local: loop of radius 60 m around (0, 0), one lap per 40 s; climbs to the upper floor
        # while passing x > 40.
        angle = 2 * math.pi * secs / 40.0
        lx, lz = 60 * math.cos(angle), 60 * math.sin(angle)
        ly = 6.0 if lx > 40 else 0.0
        # Unity yaw: 0 = +z (north), 90 = +x (east). Moving counter-clockwise (seen from above),
        # the direction of travel is (-sin, cos).
        lyaw = math.degrees(math.atan2(-math.sin(angle), math.cos(angle))) % 360
        players = [{"id": 1, "local": True, "kind": "local", "ai": False, "side": "usec", "dead": False, "absent": False,
                    "pos": [round(lx, 2), round(ly, 2), round(lz, 2)], "yaw": round(lyaw, 2), "pitch": 0.0}]
        for b in bots:
            dead = b["id"] == 3 and secs > 20
            absent = b["id"] == 4 and secs > 35
            if not dead and not absent:
                b["heading"] = (b["heading"] + rng.uniform(-15, 15)) % 360
                h = math.radians(b["heading"])
                b["x"] = max(-200, min(200, b["x"] + math.sin(h) * b["speed"] / RATE_HZ))
                b["z"] = max(-200, min(200, b["z"] + math.cos(h) * b["speed"] / RATE_HZ))
            players.append({"id": b["id"], "local": False, "kind": "observed", "ai": True, "side": b["side"],
                            "voice": "BossKilla" if b["id"] == 2 else "Scav_1", "dead": dead,
                            "absent": absent, "pos": [round(b["x"], 2), 0.0, round(b["z"], 2)],
                            "yaw": round(b["heading"], 2), "pitch": 0.0})
        lines.append(envelope("players", raid, step + 1, t, {"players": players}))

        if step in (0, 15 * RATE_HZ, 24 * RATE_HZ):
            local_slots = equipment["players"][0]["slots"]
            rig = next(s for s in local_slots if s["slot"] == "TacticalVest")
            if secs >= 15 and not any(i["tpl"] == LEDX for i in rig["items"]):
                rig["items"].append({"tpl": LEDX})
            if secs >= 24 and not any(i["tpl"] == GPU for i in rig["items"]):
                rig["items"].append({"tpl": GPU})
            emit("equipment", t, json.loads(json.dumps(equipment)))
        if step == 0 or step == 10 * RATE_HZ:
            exfils = [dict(e) for e in exfils_closed]
            if secs >= 10:
                exfils[0]["status"] = 4
            emit("exfils", t, {"exfils": exfils})
        if step % (RATE_HZ // 2) == 0:  # explosives / airdrop updates at 2 Hz
            grenades = []
            if 12 <= secs < 17:
                k = (secs - 12) / 2.0
                grenades.append({"id": 2, "pos": [round(-20 + 15 * min(k, 1.0), 2), 0.5, round(30 - 10 * min(k, 1.0), 2)]})
            emit("explosives", t, {"grenades": grenades, "tripwires": [tripwire]})
        if step % (RATE_HZ * 3) == 0:  # loot scans every 3 s
            drop_y = max(0.0, 150.0 - 10.0 * secs)
            entries = [l for l in loot if not (l["id"] == 450 and secs > 10.5)]
            entries = entries + [{"id": 500, "kind": "airdrop", "tpl": "", "obj": "loot_collider", "pos": [20.0, round(drop_y, 2), -60.0]}]
            dead = next(b for b in bots if b["id"] == 3)
            if secs > 20:
                corpse_eq = next(p["slots"] for p in equipment["players"] if p["id"] == 3)
                if secs > 26:  # someone takes the weapon
                    corpse_eq = [s for s in corpse_eq if s["slot"] != "FirstPrimaryWeapon"]
                entries.append({"id": 501, "kind": "corpse", "tpl": "", "obj": "corpse",
                                "pos": [round(dead["x"], 2), 0.0, round(dead["z"], 2)], "contents": corpse_eq})
            emit("loot", t, {"loot": entries})

    status(t + 1000 // RATE_HZ, "cooldown")

    os.makedirs(os.path.dirname(args.output) or ".", exist_ok=True)
    with open(args.output, "w", encoding="utf-8") as f:
        f.write("\n".join(lines) + "\n")
    print(f"wrote {len(lines)} messages ({args.seconds:.0f} s) to {args.output}")


if __name__ == "__main__":
    main()
