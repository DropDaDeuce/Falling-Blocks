// ─── CONFIG ───────────────────────────────────────────────────────────────────
// Pure constants only. No imports, no side effects.

export const CFG = {
  platformSize:   32,
  platformStride: 35,     // 32-block platform + 3-block gap; gaps filled with bedrock at y=-63
  platformY:      -64,
  platformBlock:  "minecraft:bedrock",
  spawnY:         -62,
  blockDropY:     200,
  tickInterval:   4,
  dropStepSize:   3,
  voteCooldown:   300,    // game ticks (5/sec) between successful votes = 60s
  chestInterval:  1000,   // game ticks between per-platform chest spawns (~3.3 min)
};

// ─── PLATFORM GRID ────────────────────────────────────────────────────────────
// Hardcoded 3x3 layout (top-down):
//   7  8  9
//   6  1  2
//   5  4  3
// Platform 1 = center (0,0). Stride = 35 (32-block platform + 3-block gap).
// Each platform spans cx-16..cx+15, cz-16..cz+15 at Y = platformY.
// Gap strips are filled with bedrock at Y = platformY+1 (one block higher).
export const PLATFORMS = [
  { id: 1, cx:   0, cz:   0 },
  { id: 2, cx:  35, cz:   0 },
  { id: 3, cx:  35, cz:  35 },
  { id: 4, cx:   0, cz:  35 },
  { id: 5, cx: -35, cz:  35 },
  { id: 6, cx: -35, cz:   0 },
  { id: 7, cx: -35, cz: -35 },
  { id: 8, cx:   0, cz: -35 },
  { id: 9, cx:  35, cz: -35 },
];

// ─── PORTAL PLATFORMS ────────────────────────────────────────────────────────
// Spawned at milestone days. Nether = north (cz=-150), End = south (cz=150).
// state.tick increments once per gameTick call (every CFG.tickInterval=4 MC ticks).
// 1 MC day = 24,000 MC ticks / 4 = 6,000 state.ticks.
export const TICKS_PER_DAY      = 6000;
export const NETHER_PORTAL_TICK = TICKS_PER_DAY * 20;   // day 20
export const END_PORTAL_TICK    = TICKS_PER_DAY * 30;   // day 30
export const PORTAL_NETHER = { cx: 0, cz: -150 };
export const PORTAL_END    = { cx: 0, cz:  150 };

// ─── NATURALLY FALLING BLOCKS ─────────────────────────────────────────────────
// All 16 concrete powder variants included — required for Gravity Surge event.
// Powder snow is intentionally excluded — it does NOT obey gravity in Bedrock.
export const GRAVITY_BLOCKS = new Set([
  "minecraft:sand", "minecraft:red_sand", "minecraft:gravel",
  "minecraft:white_concrete_powder",      "minecraft:orange_concrete_powder",
  "minecraft:magenta_concrete_powder",    "minecraft:light_blue_concrete_powder",
  "minecraft:yellow_concrete_powder",     "minecraft:lime_concrete_powder",
  "minecraft:pink_concrete_powder",       "minecraft:gray_concrete_powder",
  "minecraft:light_gray_concrete_powder", "minecraft:cyan_concrete_powder",
  "minecraft:purple_concrete_powder",     "minecraft:blue_concrete_powder",
  "minecraft:brown_concrete_powder",      "minecraft:green_concrete_powder",
  "minecraft:red_concrete_powder",        "minecraft:black_concrete_powder",
]);

// Above this Y, falling blocks descend WITHOUT collision scanning. getBlock()
// is unreliable in high, sparse subchunks (returns undefined indefinitely),
// which left blocks permanently stuck at ~197-200. No stack can realistically
// reach this height, so blind descent is safe.
export const BLIND_FALL_Y = 190;

// Block types the falling animation passes through. Source liquids
// (minecraft:water / minecraft:lava) are deliberately NOT listed — blocks land
// on top of source blocks but fall through flowing liquid.
export const PASS_THROUGH = new Set([
  "minecraft:air", "minecraft:flowing_water", "minecraft:flowing_lava",
]);

// Blocks that can convert to water (melt / break). Kept ≥3 blocks away from
// platform edges so the resulting water doesn't cascade off the sides.
export const EDGE_INSET_BLOCKS = new Set(["minecraft:ice"]);

// ─── CHALLENGE STRUCTURE TUNABLES ──────────────────────────────────────────────
// Spawn interval: 800-1600 game ticks (~2.7-5.3 min) between spawns.
export const STRUCT_SPAWN_MIN = 800;
export const STRUCT_SPAWN_MAX = 1600;

// id: used for persistence + reporting. minRadius/maxRadius: XZ distance from world
// center (0,0). Rings no longer carry a count capacity — placement is now SPATIAL
// (v1.8.1): a structure goes in the innermost ring it physically fits, overflowing
// outward when an inner band is packed. Bands widened in v1.8.1 because .mcstructure
// builds can be much larger than the old hand-built ±13 footprints.
export const STRUCT_RINGS = [
  { id: 1, minRadius:  95, maxRadius: 140 },
  { id: 2, minRadius: 150, maxRadius: 200 },
  { id: 3, minRadius: 210, maxRadius: 270 },
  { id: 4, minRadius: 280, maxRadius: 350 },
];

// Placement tunables (v1.8.1, footprint-aware):
//   STRUCT_PAD            walkable gap left between two structure footprints.
//   PLATFORM_CLEAR_RADIUS no structure footprint may come closer than this to world
//                         center. The 3×3 grid is 102×102 (platforms only), but
//                         buildGapBedrock() extends bedrock to the NW corner of
//                         platform 7 at (-54,-54) — ~76.4 from center. 85 leaves
//                         ~8.6 blocks of horizontal breathing room past that corner.
//   DEFAULT_FOOT_R        bounding radius assumed for legacy build() structures and
//                         for any persisted entry saved before footprints were stored.
export const STRUCT_PAD            = 5;
export const PLATFORM_CLEAR_RADIUS = 85;
export const DEFAULT_FOOT_R        = 22;

// Hard total cap. Geometry may prevent reaching it if the world is packed with very
// large structures — that's intentional; the spawner just defers when there's no room.
export const MAX_STRUCTURES = 32;

// Proximity mob spawning (v1.8.4). Structure guards spawn ONLY while a player is
// within STRUCT_MOB_RADIUS, refilling toward STRUCT_MOB_CAP at most once every
// STRUCT_MOB_COOLDOWN game-ticks. They are non-persistent, so they despawn naturally
// when the player leaves and idle structures cost nothing. (gameTick runs every
// CFG.tickInterval ticks, so one game-tick ≈ 0.2s.)
export const STRUCT_MOB_RADIUS   = 40;   // activation distance from structure center (blocks, 3D)
export const STRUCT_MOB_CAP      = 5;    // max concurrent guards per structure
export const STRUCT_MOB_COOLDOWN = 40;   // game-ticks between refills (~8s)
export const STRUCT_MOB_CHECK    = 10;   // run the proximity sweep this often (~2s)

// Anti-repeat / rarity dial default (v1.9.0). See pickWeightedStructure in structures.js.
export const DEFAULT_STRUCT_WEIGHT = 10;

// Columns tried (in order) when looking for a chest surface inside a structure:
// center first, then nearby rings — authors are asked to keep the center open,
// this just adds slack.
export const CHEST_PROBE_OFFSETS = [[0,0],[2,0],[-2,0],[0,2],[0,-2],[3,3],[-3,3],[3,-3],[-3,-3],[5,0],[-5,0],[0,5],[0,-5]];

// Drop rate sentinel for blackout — "never drops".
export const BLACKOUT_DROP_RATE = 999999;
