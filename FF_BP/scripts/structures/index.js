// ─── Challenge Structure Registry ───────────────────────────────────────────
// All challenge structures are defined here as inline data objects and collected
// into CHALLENGE_STRUCT_DEFS, which main.js imports and spawns.
//
// Structures are shipped .mcstructure files (blocks only); this file supplies the
// gameplay metadata — loot, mobs, phase gating — for each one. (Bedrock scripts
// can't auto-discover files, so the array below is the explicit registry.)
//
// ── To ADD a structure ──────────────────────────────────────────────────────
//   1. Export your build from a Bedrock world to <name>.mcstructure (NO spaces in
//      the filename — the name becomes part of the id).
//   2. Drop it at  FF_BP/structures/ff/<name>.mcstructure  → id "ff:<name>"
//      (the first subfolder, "ff", is the namespace).
//   3. Add a def object to the array below whose structureId is "ff:<name>".
//   build_template.bat copies FF_BP wholesale, so the file rides into the template.
//
// ── Field reference ─────────────────────────────────────────────────────────
//   type        string   unique id (used for persistence + the ff:structure command).
//   label       string   display name shown in the spawn announcement.
//   structureId string   id of the shipped .mcstructure ("ff:<name>"). The engine
//                        places it centered on the spawn point; height + footprint
//                        are read from the .mcstructure size automatically.
//   mobs        object   per-phase arrays of mob ids (early/mid/late/end). The
//                        spawner picks from the array matching the current phase and
//                        spawns them on solid footing inside the build.
//   lootTier    object   per-phase loot tier (common/uncommon/rare/mythic). FF finds
//                        an open surface, places the chest, and fills it to this tier.
//   minPhase    string?  optional — earliest phase it may spawn ("early"|"mid"|
//                        "late"|"end"). Omit for always-on.
//   fireproof   bool?    optional — grant spawned mobs fire resistance so undead
//                        survive daylight on open/exposed islands. Default off.
//   baseWeight  number?  optional — relative spawn frequency + pity recovery rate
//                        (default 10). Lower = rarer AND recovers slower after the
//                        anti-repeat system zeroes it. Raise commons, drop big/
//                        high-value builds. See pickWeightedStructure in main.js.
//   spawns      array?   optional — explicit mob spawn points as LOCAL offsets from
//                        the .mcstructure MIN corner: [{ x, y, z }, ...], where y is
//                        the feet position (footing must be the block below). When
//                        present the proximity spawner uses these instead of scanning;
//                        each is footing-validated, and it falls back to the scan if a
//                        point is bad or the list is omitted.
//   chests      array?   optional — explicit chests as LOCAL offsets from the MIN
//                        corner: [{ x, y, z, rarity?, slots? }, ...]. rarity overrides
//                        the structure's tier for that chest ("common"|"uncommon"|
//                        "rare"|"mythic"); slots forces the loot-roll count (a number,
//                        or [min,max] range). NO surface scan — the offset is authored,
//                        so a bad offset just buries a chest. Omit to keep the single
//                        auto-placed, surface-scanned chest at the structure tier.
//
// NOTE: the spawner still supports the legacy script-built contract (build/height/
// chestOffset) for backward compatibility, but all current structures are native
// .mcstructure placements defined as the data objects below.

export const CHALLENGE_STRUCT_DEFS = [
// ── Medieval castle — illager garrison, scales to a real threat late. ───────
  {
    type: "castillo_medieval", label: "Medieval Castle", structureId: "ff:castillo_medieval",
    fireproof: true, baseWeight: 8,
    spawns: [{x:14,y:1,z:13}, {x:3,y:1,z:24}, {x:24,y:1,z:24}, {x:14,y:7,z:15}, {x:3,y:8,z:3}, {x:24,y:8,z:3}, {x:14,y:15,z:15}, {x:13,y:15,z:9}],
    chests: [{x:14,y:7,z:18}, {x:14,y:8,z:9}],
    mobs: {
      early: ["minecraft:zombie", "minecraft:skeleton"],
      mid:   ["minecraft:pillager", "minecraft:vindicator", "minecraft:zombie"],
      late:  ["minecraft:vindicator", "minecraft:pillager", "minecraft:witch"],
      end:   ["minecraft:vindicator", "minecraft:evocation_illager", "minecraft:pillager"],
    },
    lootTier: { early: "uncommon", mid: "rare", late: "rare", end: "mythic" },
  },

// ── Arcane library/observatory — high-value, gated to mid+. ─────────────────
  {
    type: "large_library_observatory", label: "Library Observatory", structureId: "ff:large_library_observatory",
    fireproof: true, minPhase: "mid", baseWeight: 6,
    spawns: [{x:20,y:2,z:12}, {x:38,y:1,z:3}, {x:3,y:1,z:3}, {x:21,y:14,z:18}, {x:3,y:12,z:4}, {x:38,y:12,z:3}, {x:36,y:12,z:18}, {x:18,y:19,z:11}, {x:22,y:24,z:9}],
    chests: [{x:30,y:12,z:12}, {x:11,y:12,z:12}],
    mobs: {
      mid:   ["minecraft:witch", "minecraft:enderman"],
      late:  ["minecraft:evocation_illager", "minecraft:witch", "minecraft:vex"],
      end:   ["minecraft:evocation_illager", "minecraft:vindicator", "minecraft:vex"],
    },
    lootTier: { mid: "rare", late: "rare", end: "mythic" },
  },

// ── Huge derelict ship — drowned crew. (Very large: ~64×64 footprint.) ──────
  {
    type: "casco_marry", label: "Derelict Ship", structureId: "ff:casco_marry",
    fireproof: true, baseWeight: 3,
    spawns: [{x:32,y:1,z:32}, {x:3,y:1,z:3}, {x:3,y:1,z:60}, {x:31,y:7,z:19}, {x:58,y:7,z:24}, {x:20,y:10,z:12}, {x:24,y:14,z:20}, {x:60,y:15,z:15}, {x:13,y:22,z:20}, {x:20,y:26,z:20}, {x:9,y:42,z:19}, {x:35,y:48,z:20}],
    chests: [{x:16,y:7,z:26}, {x:34,y:48,z:19}, {x:45,y:1,z:30}],
    mobs: {
      early: ["minecraft:zombie", "minecraft:drowned"],
      mid:   ["minecraft:drowned", "minecraft:pillager"],
      late:  ["minecraft:drowned", "minecraft:vindicator"],
      end:   ["minecraft:drowned", "minecraft:vindicator", "minecraft:pillager"],
    },
    lootTier: { early: "uncommon", mid: "rare", late: "rare", end: "mythic" },
  },

// ── Witch's cottage — potion-flavored, mid-value. ───────────────────────────
  {
    type: "casinha_de_bruxa", label: "Witch's Cottage", structureId: "ff:casinha_de_bruxa",
    fireproof: true, baseWeight: 10,
    spawns: [{x:16,y:5,z:14}, {x:33,y:2,z:13}, {x:4,y:4,z:5}, {x:13,y:17,z:13}, {x:25,y:11,z:21}, {x:12,y:24,z:12}],
    chests: [{x:15,y:17,z:12}],
    mobs: {
      early: ["minecraft:witch", "minecraft:zombie"],
      mid:   ["minecraft:witch", "minecraft:slime"],
      late:  ["minecraft:witch", "minecraft:vex"],
      end:   ["minecraft:witch", "minecraft:evocation_illager"],
    },
    lootTier: { early: "uncommon", mid: "uncommon", late: "rare", end: "rare" },
  },

// ── Guard tower — common early-game stop, modest loot. ──────────────────────
  {
    type: "tower_1", label: "Watchtower", structureId: "ff:tower_1",
    fireproof: true, baseWeight: 12,
    spawns: [{x:12,y:1,z:17}, {x:3,y:1,z:3}, {x:24,y:1,z:26}, {x:10,y:10,z:11}, {x:8,y:10,z:4}, {x:11,y:17,z:11}, {x:10,y:38,z:11}],
    chests: [{x:10,y:10,z:14}, {x:10,y:30,z:14}],
    mobs: {
      early: ["minecraft:skeleton", "minecraft:zombie"],
      mid:   ["minecraft:pillager", "minecraft:skeleton"],
      late:  ["minecraft:pillager", "minecraft:vindicator"],
      end:   ["minecraft:pillager", "minecraft:vindicator"],
    },
    lootTier: { early: "common", mid: "uncommon", late: "uncommon", end: "rare" },
  },

// ── Village house A — low-stakes, common loot. ──────────────────────────────
  {
    type: "medieval_house_1", label: "Medieval House", structureId: "ff:medieval_house_1",
    fireproof: true, baseWeight: 12,
    spawns: [{x:11,y:1,z:11}, {x:10,y:7,z:8}, {x:10,y:13,z:7}, {x:11,y:17,z:9}, {x:7,y:23,z:6}, {x:7,y:27,z:10}],
    mobs: {
      early: ["minecraft:zombie"],
      mid:   ["minecraft:zombie", "minecraft:pillager"],
      late:  ["minecraft:vindicator", "minecraft:zombie"],
      end:   ["minecraft:vindicator", "minecraft:pillager"],
    },
    lootTier: { early: "common", mid: "uncommon", late: "uncommon", end: "rare" },
  },

// ── Village house B — variant, common loot. ─────────────────────────────────
  {
    type: "medieval_house_2", label: "Medieval Manor", structureId: "ff:medieval_house_2",
    fireproof: true, baseWeight: 12,
    spawns: [{x:15,y:1,z:18}, {x:10,y:7,z:33}, {x:10,y:7,z:3}, {x:14,y:13,z:18}, {x:9,y:13,z:33}, {x:9,y:13,z:3}, {x:18,y:17,z:10}],
    chests: [{x:14,y:7,z:10}, {x:14,y:7,z:26}],
    mobs: {
      early: ["minecraft:skeleton", "minecraft:zombie"],
      mid:   ["minecraft:pillager", "minecraft:zombie"],
      late:  ["minecraft:vindicator", "minecraft:pillager"],
      end:   ["minecraft:vindicator", "minecraft:evocation_illager"],
    },
    lootTier: { early: "common", mid: "uncommon", late: "uncommon", end: "rare" },
  },

// ── Evil tower — dangerous illager nest, gated to mid+, top loot. ───────────
  {
    type: "evil_tower_1", label: "Illager Spire", structureId: "ff:evil_tower_1",
    fireproof: true, minPhase: "mid", baseWeight: 6,
    spawns: [{x:8,y:14,z:12}, {x:8,y:26,z:9}, {x:8,y:30,z:9}, {x:9,y:30,z:3}],
    chests: [{x:8,y:30,z:8}, {x:8,y:18,z:9}],
    mobs: {
      mid:   ["minecraft:pillager", "minecraft:vindicator"],
      late:  ["minecraft:vindicator", "minecraft:evocation_illager", "minecraft:vex"],
      end:   ["minecraft:evocation_illager", "minecraft:vindicator", "minecraft:vex"],
    },
    lootTier: { mid: "rare", late: "rare", end: "mythic" },
  },

// ── Nether outpost — fire mobs (don't burn in daylight), gated to mid+. ─────
  {
    type: "nether_house_1", label: "Nether Outpost", structureId: "ff:nether_house_1",
    minPhase: "mid", baseWeight: 6,
    spawns: [{x:28,y:5,z:27}, {x:7,y:3,z:8}, {x:24,y:3,z:7}, {x:16,y:12,z:17}, {x:29,y:11,z:26}, {x:14,y:19,z:15}, {x:6,y:33,z:31}],
    chests: [{x:18,y:6,z:16}, {x:14,y:25,z:16}],
    mobs: {
      mid:   ["minecraft:blaze", "minecraft:zombie_pigman"],
      late:  ["minecraft:blaze", "minecraft:wither_skeleton"],
      end:   ["minecraft:blaze", "minecraft:wither_skeleton", "minecraft:piglin_brute"],
    },
    lootTier: { mid: "rare", late: "rare", end: "mythic" },
  },

// ── Treehouse cluster — forest critters, common-to-mid loot. ────────────────
  {
    type: "triple_treehouse", label: "Treehouse Cluster", structureId: "ff:triple_treehouse",
    fireproof: true, baseWeight: 10,
    spawns: [{x:20,y:2,z:21}, {x:31,y:31,z:24}, {x:10,y:18,z:3}, {x:36,y:9,z:39}, {x:8,y:21,z:32}, {x:36,y:3,z:3}, {x:5,y:2,z:39}, {x:3,y:2,z:13}, {x:17,y:2,z:3}],
    chests: [{x:21,y:2,z:10}, {x:29,y:12,z:28}, {x:11,y:2,z:27}],
    mobs: {
      early: ["minecraft:spider", "minecraft:zombie"],
      mid:   ["minecraft:spider", "minecraft:pillager"],
      late:  ["minecraft:pillager", "minecraft:vindicator"],
      end:   ["minecraft:vindicator", "minecraft:pillager"],
    },
    lootTier: { early: "common", mid: "uncommon", late: "uncommon", end: "rare" },
  },
];
