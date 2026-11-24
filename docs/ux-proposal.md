# UX reorganization proposal

Status: superseded by the prototype (`prototype/index.html`, with `prototype/PORTING.md`): this is the original analysis; where they differ, the prototype wins.

Original status: proposal, not decided. Scope: UX (concepts, flows, where things live), not visual polish.
Source: the "UX inconsistencies/deficits" notes in `TODO.md`, and a read of `web/src` as of `04c56c9`.

## 1. What the radar offers today

Grouped by the job each part does for the user (not by where it lives):

| Job | What exists | Where |
|---|---|---|
| **See who's around** | Player markers coloured by 12 types, sized by emphasis, figures up close, facing, trails; type classification | Map; Players tab; Filters → Players (12 rules) |
| **See what's lootable** | Loose items by value per slot (3 value-tier rules, zoom thresholds), quest items, containers, airdrops, corpses (gear value) | Map; Items tab, Containers tab; Filters → Loot/Containers (off by default) |
| **Find something specific** | Global search `/` with suggestions (items, categories, presets, value, query syntax) → session-only pill with colour ring, match count, step to nearest | Map (top-left pills) |
| **Keep looking for something** | Pin a pill → "pinned rule" (this raid) → keep → stored rule (forever); or "+" on a category → blank 9-field rule form | Pills → Filters → Pinned → Filters → category |
| **Quest needs** | Started quests read from memory; which count (opt-out switch per quest); owned items cover needs; import from tarkov.dev; needed items get `is:needed`/`is:fir`; quest items nobody needs are dropped | Quests tab (feeds) → Filters rules "Needed for quests (FIR)", "Carrying needed items (FIR)", and the "Quest items: Needed/All" switch in Filters → Loot |
| **Inspect one thing** | Details: identity internals (side, role, voice, group, kind, position, template, object), needed-carried items, full equipment tree with prices, "look" (which rules styled it), history events | Floating panel on selection |
| **Get out** | Exfils with status colour and distance | Map; Exfils tab |
| **Stay safe** | Grenades (danger radius), tripwires | Map only |
| **Narrow the view** | Per-tab list filters (text, alive/humans/special, min value), which also filter the map ("● map filtered") | List tabs |
| **Review a raid** | Recordings, event log with group filters, playback bar, scrubbing, per-thing history | Raids tab, playback bar, details |
| **Tune the map** | Style, palette, colour grading, projection, controls, trails | Map tab |
| **Misc / dev** | Theme, overlay, map debug, quest debug report | Settings |

Two things stand out in that table:

- The middle rows ("find", "keep looking", "quest needs") are **one job done three ways**, spread over four
  places (pills, Filters → Pinned, Filters → categories, Quests).
- "What's shown and how" is decided by **six interacting mechanisms**: display rules (cascade, 6 style
  properties, order matters), category on/off switches, highlights, pinned rules, list filters (which also
  hide things on the map), and the quest-items Needed/All switch. Plus the quest counting switches and the
  owned-items switch upstream of them.

## 2. User stories

The main one, from `TODO.md`, split into its parts, plus the ones the codebase clearly serves:

| # | Story | How well it works today |
|---|---|---|
| S1 | *Keep track of all players around me, in order of importance: PMCs, specials (bosses, guards, BD, cultists, raiders, rogues), player scavs, scavs, infected.* | Players always show, but 12 colours, coloured names, "faint" scavs dimmed in the list (and only there); list order is type order, which isn't this order (p-scav before specials, infected before scavs). |
| S2 | *Passively watch for a category of item (e.g. battlepass documents), every raid.* | Possible only as a stored rule: search → pill → pin → keep (3 steps), or the 9-field form. Without a ring it disappears at zoom-out or when Loot is off; with a ring it looks like everything else. |
| S3 | *Actively hunt specific items I name.* | Search → pill works well (count, step to nearest), but it's lost on reload, and it rings players carrying the item exactly like the item itself. |
| S4 | *Find the items I still need for a specific quest.* | No way to say "this quest". All 100+ started quests count unless switched off one by one. And with the defaults, needed loose items are **not shown at all**: the "Needed for quests (FIR)" rule sits in Loot, which is off out of the box, and only ringed things beat a hidden category. |
| S5 | *See when a player (or corpse) carries something I'm after.* | The "Carrying needed items (FIR)" rule covers only quest needs, and uses the same ring as everything else. A highlight's ring on carriers looks identical to the ring on the item. |
| S6 | *What's valuable near me?* | Works (value tiers by zoom), but only after finding the Loot switch in Filters. The Items list's min-value dropdown repeats what sorting already does. |
| S7 | *Which exfils are open and how far away are they?* | Works. |
| S8 | *Who is this / what are they carrying?* | Details answer it, but read like a debug dump: classification internals come before what matters (distance, gear value, what they carry that I want). |
| S9 | *What happened in this raid?* | Works (Raids, timeline, playback). Not in scope here. |
| S10 | *Make the map look right for me.* | Works; done once, but has a top-level icon. |

## 3. Diagnosis: the causes behind the symptoms

1. **Lifetime is modelled as places.** Session (pill), raid (pinned), forever (rule) are three separate
   objects in three places, and moving between them is the 3-click pin dance. Users think in *intent*
   ("I'm after this", "I always want this"), and stop when they're done. Lifetime should be "until I remove
   it", not a property of where a thing lives.
2. **Presentation is exposed as its implementation.** Ring, emphasis, shown-from-zoom, label mode, label
   zoom and order in a cascade are the renderer's knobs. The user has one question, "how much should this
   stand out?", and has to translate it into five settings and a position in a list. The only setting that
   reliably answers "show this at every zoom" is the ring, so everything gets one and everything looks the
   same.
3. **There is no visual grammar for kinds × importance × relations.** The ring means "highlighted" on
   loot, players, exfils and vehicles alike, and "carries something" on players and corpses. A player
   carrying a LEDX and the LEDX itself end up drawn alike. Kind (player vs item) should be shape,
   importance should be size, label and zoom, and "carries something I want" should be its own mark.
4. **Category switches conflate "kind" with "interest".** Switching Loot off hides needed items too. You
   can't say "no loot except what I'm after". In practice that is the default state, and it is broken (S4).
5. **Quests are configuration for another tab.** The Quests tab doesn't let you *do* anything with a quest.
   Its switches change what `is:needed` means, which a rule in Filters then styles, and the map shows it,
   if Loot is on. Three hops, none of which shows the user the connection. With opt-out counting and 100+
   quests, the default is "everything is needed", which is the same as nothing.
6. **Three filters that hide.** List filters hide things on the map (a mode that's easy to forget, signalled
   only in the status bar), category switches hide, and the rules' "Hidden" hides. Highlights are the only
   non-destructive tool, and they're the session-only one.

## 4. Proposal

### 4.1 Core concepts (what the user has to learn)

Three concepts replace rules, categories, highlights, pins and quest counting:

- **Layers: what the map shows on its own.** Players (always), Loot (Off / Valuable / All), Quest items,
  Containers, Corpses, Exfils, Explosives, BTR. On/off switches with one or two options. Their look is
  tuned once in Settings.
- **Watchlist: what I'm after.** Entries made from a search, an item, or a quest. Each has a name, a
  colour and an **importance**. An entry lasts until you remove it, with no session, raid or forever
  variants. It switches on and off. Matches show **even when their layer is off**: that's the point of
  watching.
- **Importance: one axis, four steps.** It replaces ring/emphasis/shown/label/order:

  | Level | Loot, corpses, containers | Players (via tiers) |
  |---|---|---|
  | **Low** | small, only zoomed in, no label | small marker, id only (scavs, infected): *not* dimmed in the list |
  | **Normal** | from mid zoom, labelled where there's room | normal marker and label |
  | **High** | at every zoom, labelled where there's room, larger | halo, type name in the label |
  | **Top** | at every zoom, always labelled, ring; counted and steppable (nearest first) | larger, bold label |

  When several things apply, the **highest level wins** and its colour is used. There's no ordering to
  manage, and the up/down arrows, categories and "General wins over the others" go. The cascade engine
  (`rules/rules.ts`) can stay underneath: each level compiles to a `Style` preset.

### 4.2 Visual grammar

| Channel | Means | Notes |
|---|---|---|
| **Shape** | kind | circle + facing / figure = player; square = item; diamond = quest item; outlined square = container; X = corpse/dead (as today) |
| **Colour** | identity: player tier, or the watch entry | not importance |
| **Size, label, zoom** | importance | the level table above |
| **Ring** | Top-level *destination*: loot, corpses, containers | never on players |
| **Badge** | "carries something I'm after" | a small pip in the entry's colour beside a player marker, plus the item in its label ("BEAR 12 · LEDX"); players keep their tier colour |

This gives the TODO's "player", "item" and "player with a highlighted item" three distinct looks. A corpse
carrying a watched item is a destination, so it takes the item's level, colour and ring, as loot does.

**Player tiers** (the order of S1) replace 12 type colours with 6 hues. The subtype stays in the label
("Killa", "Reshala guard"):

| Tier | Members | Default level |
|---|---|---|
| PMC | USEC and BEAR, one colour (both are hostile in SPT; two shades stay an option) | High |
| Bosses & guards | bosses (bold, larger) and their guards | Top (bosses), High (guards) |
| Other specials | raiders, rogues, cultists, BD | High |
| Player scav | | Normal |
| Scav | AI scavs | Low |
| Infected | | Low |

How a tier looks is changeable, two ways:
- **For good:** each group header in Players shows its tier's level ("PMCs 3 · High ▾"). Clicking it opens
  the level (bosses and guards separately) and colour, the same settings as Settings → Markers.
- **For now (hunting):** every tier is a search preset (`/ scav ⏎`), so it becomes a watch entry like any
  other. Its players rise to the entry's level and get a halo in the entry's colour, so the pill and the
  markers match, and the pill's count steps through them. Typing a player kind ("scav", "boss") puts that
  preset before items named like it ("Scav BP").

### 4.3 Navigation

```
today:  Players · Items · Containers · Exfils · Quests · Filters · Map · Raids ··· Settings   (8 + 1)
new:    Players · Loot · Exfils · Watch · Quests · Raids ·················· Settings          (6 + 1)
```

- **Players**: grouped by tier in S1's order, with collapsible group headers and counts ("PMCs 3 · Bosses &
  guards 5 · Other specials 6 · …"), sorted by distance within each group (bosses first in theirs). The dead and those who left go in a collapsed group at the
  bottom; a dead player's row is their body (it shows what's on it, and the corpse on the map selects it),
  so corpses need no list of their own. Names in neutral text with a tier dot, no dimming. The `alive/humans/special` chips become
  unnecessary (collapse a group instead). No "carrying" column: only the gear on players is readable (not
  their pockets or containers), so carrying something you're after is rare. A small pip after the name, in
  the entry's colour, says so when it happens.
- **Loot**: Items and Containers (with airdrops) behind one segmented switch (corpses: Players → Dead). Items sorted by
  value by default. The min-value dropdown goes.
- **Exfils**: unchanged.
- **Watch**: the watchlist (§4.4), with a line about tracked and new quests that links to Quests.
- **Quests**: the quest tracker (§4.5). Its own view, not a drill-down inside Watch, where it was easy to
  miss.
- **Raids**: unchanged.
- **Settings**: Appearance; **Map** (today's Map tab: style, palette, grading, trails); **Markers**
  (layer and tier tuning: colours, default levels, the "valuable" threshold; what the default rules were);
  Overlay; Debug, including a switch that shows the debug sections in the details panel.

On the map itself, a **Layers** button (next to the style switch) holds the quick switches from §4.1:
the things you change per raid ("loot on for this map") belong on the map, not three clicks into a panel.

### 4.4 The watchlist and adding to it

**One way in, one step:** `/` (or the Watch view's "+", which just focuses it) → type → pick a
suggestion → **Enter adds a watch entry**. The entry gets its name from the suggestion ("LEDX", "Info
items", "Items ≥ 50k"), the next free colour, and the level High. Nothing else is asked, and the
category is gone. Nothing is created until a suggestion is picked, so there are no blank rules.

**The pills are the watchlist** as it shows on the map (one pill per entry; off ones greyed; beyond ~5,
a "+3" overflow):

```
 [● LEDX  2 ▾]  [● Info items  7 ▾]  [● Shooter Born in Heaven  1 ▾]
   │      │  └─ menu: level (Low/Normal/High/Top), colour, edit query, remove
   │      └──── count: click steps to the nearest match, then the next
   └─────────── click: on/off
```

The pin icon goes, and so do the pinned section and "keep". The Watch view lists the same entries with the
same controls. It also lets you edit the query (the query language stays as it is, for power users) and
holds "Query syntax".

**Other ways in**, all ending in the same entry:
- the details panel: "Watch" on an item, or on any item in someone's equipment;
- the quest tracker: "Track" on a quest (§4.5);
- the Loot list: "Watch these" next to the filter box (the filter text becomes the entry's query).

### 4.5 Quests become a source of watch entries

The Quests tab stops being configuration for another tab. It becomes the place where you pick which quests
you're working on:

- **Track** (opt-in, a star) a quest → a watch entry named after the quest, whose query matches what that
  quest still needs (a new query term, e.g. `for:<quest id>`). Its items show at High with their own
  colour and get their own pill. Carriers get the badge, so S4 and S5 fall out of the general mechanism.
- **Everything else** that started quests need is the "Quest items" layer: **Tracked** (default: only
  tracked quests' items show) or **All started** (every started quest's needs at Normal, in yellow). The
  tracker has the same switch. Hidden by default because some quests want lots of a common item, which
  is noise unless you're doing that quest.
- **New quests are nudged, not auto-tracked.** Quests started since the last raid that need items get a
  "New" tab in the tracker, a badge on the Quests icon and a line in Watch, each with Track or Dismiss. That
  keeps the feature discoverable without lighting up the map.
- **The link to the watchlist is visible.** A tracked quest's pill and Watch entry carry a quest icon; its
  row in Quests says "watching · High"; tracking one flashes its new pill, with a short notice saying where
  it went.
- **Ignore** (today's per-quest switch) becomes a secondary action on a quest's row, for quests left in
  progress for good. "Owned items count" stays as the tracker's one setting at the top.

Making 100+ quests navigable:
- **By default, show only quests with open item objectives.** Kill, visit and survive quests have
  nothing to find, and they're most of the 112. A "show all" switch brings them back.
- **Trader tabs** (Prapor, Therapist, …), with Story, Repeatables and Imported as their own tabs, a search
  box over all of them, and tracked quests pinned to the top across tabs.
- **One line per quest** ("☆ Shooter Born in Heaven · 3 items · FIR"), expanding to its objectives.
  Explanatory prose moves into tooltips or the Watch view's help.

### 4.6 Details panel

Ordered by what you want to know, with the internals behind Debug (Settings):

- **Player**: tier dot + "BEAR #12" · alive · 34 m ↑2 m · gear 1.2M ₽ · **Carrying** (watched and needed
  items, with what for) · **Kit** (weapon, armour class, helmet, backpack: one line each) · full equipment
  (collapsed) · history (compact) · actions: centre, trail.
  *Debug:* side, role, voice, group, kind, classification reason, position.
- **Item**: name · price per slot · "Needed for: …" · "Watched by: LEDX (Top)" · distance · action:
  Watch. *Debug:* template, object, position.
- **Dead player** (their body): gear value · Carrying · what's on the body.
- **Exfil**: status, distance.
- "Look" (the rule cascade) becomes one line, "Shown because: Watch 'LEDX' (Top)", with the full
  explanation under Debug.

### 4.7 List filters no longer filter the map

A tab's filter narrows the **list** only. While you type, the matches are marked on the map (as the search
previews, and as hovering a rule does today), and "Watch these" makes it stick. The status bar's "● map
filtered" and the hidden mode it signals go away. Hiding is then done only by layers, and finding only by
the watchlist.

## 5. Old → new

| Today | Becomes |
|---|---|
| Highlight pill (session) | Watch entry (until removed) |
| Pinned rule (raid), "keep" | Watch entry |
| Stored rule you made | Watch entry (on migration: level from its style, ring → Top, shown always → High, …) |
| Default rules (players, loot tiers, containers, exfils, explosives, BTR) | Layers + Settings → Markers |
| Category switches | Layers (map popover) |
| Ring / Emphasis / Shown / Label / order | Importance level |
| "Needed for quests (FIR)" | Quest items layer (Normal) + tracked quests (High) |
| "Carrying needed items (FIR)" | The carrying badge, for any watched or tracked item |
| Quests tab: count switch per quest | Track (opt-in) + Ignore (secondary); new quests nudged |
| Corpses in the Containers list | Players → Dead (the row is the body) |
| Filters → Loot → "Quest items: Needed/All" | Quest items layer: Tracked / All started |
| Items list min-value dropdown | Removed (sort by value) |
| Players list chips, dimmed scavs, coloured names | Tier groups (with their level and colour), neutral names, tier dot |
| Map tab | Settings → Map |
| List filters hiding things on the map | List only; map preview; "Watch these" |

What stays as it is: the query language (plus `for:`), the rules engine as the implementation underneath,
Raids and the timeline, the playback bar, the map's own controls.

## 6. Order of work

Each step can ship on its own and is useful without the next:

1. **Quick wins, no model change.** Drop the Items min-value dropdown. Players list: neutral names, tier
   order, no dimming. Search Enter → stored rule directly (skip pill → pinned → kept), with the "+" opening
   the search instead of a blank form. Debug lines in the details behind a disclosure. Make needed quest
   items show while Loot is off.
2. **Importance levels.** Replace the four style fields and ordering with a level; migrate stored rules.
3. **Visual grammar.** Carrying badge on players. Ring only on Top loot. Drop "Carrying needed items".
   Player tiers.
4. **Watch view + Layers.** Merge Filters into Watch, Layers and Settings → Markers; Map tab → Settings;
   list filters stop filtering the map.
5. **Quest tracker.** Track (opt-in), the `for:` term, trader tabs, only quests with item objectives,
   one-line rows.

## 7. Decisions

Decided (from the prototype review): layout A, with Quests as its own view; one PMC colour; untracked
quests' items hidden by default (a setting), new quests nudged; Items + Containers as Loot, corpses under
Players → Dead.

Still open:

1. **Lifetimes.** Drop session-only and this-raid-only entirely, so everything lasts until removed?
   (Recommended. "Off" and × cover the temporary case.)
2. **List filters and the map.** Stop list filters from hiding things on the map? (Recommended.)
3. **Level names.** Low / Normal / High / Top, or something more descriptive?
