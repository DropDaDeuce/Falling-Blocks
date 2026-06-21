// ─── WAVE CATEGORIES ──────────────────────────────────────────────────────────
// Two-tier system: roll a category by weight, then roll a wave within that category.
//
// Repeat bonus (+20) applies at the CATEGORY level — same category has a higher
// chance of continuing. A silent reset only fires when the exact same wave repeats.
//
// Announcement rules:
//   - Category changes  → title card + chat message
//   - Same cat, new wave → chat message only (no title)
//   - Same wave repeats  → silent (timer reset only)
//
// Drop-rate multipliers (all relative to CFG.tickInterval = 4 game ticks):
//   Standard  → 4 ticks between drops (calm, most events)
//   Fast      → 3 ticks (storms, Gold Rush, Gravity Surge)
//   Very fast → 2 ticks (Meteor Strike)
//   Blackout  → never
import { system } from "@minecraft/server";
import { state } from "./store.js";
import { CFG, BLACKOUT_DROP_RATE } from "./config.js";
import {
  POOL_TERRAIN, POOL_RESOURCE, POOL_HAZARD, POOL_RARE, POOL_CHAOS,
  POOL_NETHER, POOL_END, POOL_ICE, POOL_CAVE, POOL_GRAVITY,
} from "./pools.js";
import { rand, pick, weightedPick, broadcast, titleAll } from "./util.js";
import { spawnLootChest } from "./loot.js";
import { spawnMobsOnPlatform, getActivePlatforms } from "./platforms.js";
import { saveWaveState } from "./persistence.js";

export const CATEGORY_REPEAT_BONUS = 20;

export const WAVE_CATEGORIES = {
  calm: {
    weight:   70,
    title:    "§aCalmness",
    subtitle: "§7Blocks fall steadily...",
    waves: [
      {
        name:   "calm",
        minDur: 440, maxDur: 520,
        chat:   "§7[FF] §aCalmness §7— blocks fall at a steady pace.",
      },
    ],
  },

  events: {
    weight:   20,
    title:    "§6✦ Special Event",
    subtitle: "§eSomething unusual is happening...",
    waves: [
      {
        name:       "gold_rush",
        minDur:     240, maxDur: 320,
        chat:       "§7[FF] §6⬡ Gold Rush §7— resources and ores flooding in. Grab what you can!",
        bonusChest: true,
      },
      {
        name:       "ore_shower",
        minDur:     200, maxDur: 280,
        chat:       "§7[FF] §b◆ Ore Shower §7— rare ores only. Dig fast!",
        bonusChest: true,
      },
      {
        name:   "meteor_strike",
        minDur: 180, maxDur: 240,
        chat:   "§7[FF] §4✦ Meteor Strike §7— pure chaos at double speed. Take cover!",
      },
      {
        name:   "gravity_surge",
        minDur: 200, maxDur: 280,
        chat:   "§7[FF] §eGravity Surge §7— gravity blocks only. Watch your footing!",
      },
      {
        name:   "nether_flare",
        minDur: 240, maxDur: 320,
        chat:   "§7[FF] §cNether Flare §7— a burst of hellfire from below.",
      },
      {
        name:   "deep_freeze",
        minDur: 240, maxDur: 320,
        chat:   "§7[FF] §bDeep Freeze §7— ice and ocean blocks pour down. It's slippery.",
      },
      {
        name:   "monster_swarm",
        minDur: 300, maxDur: 400,
        chat:   "§7[FF] §cMonster Swarm §7— hostiles closing in on every platform. Watch your backs!",
        spawnMobs: {
          initial:  3,    // mobs per platform at wave start
          interval: 200,  // state.ticks between resupply waves
          count:    2,    // mobs per platform per resupply
          types: [
            "minecraft:zombie",       "minecraft:zombie",
            "minecraft:skeleton",     "minecraft:skeleton",
            "minecraft:spider",       "minecraft:cave_spider",
          ],
        },
      },
      {
        name:   "pillager_raid",
        minDur: 260, maxDur: 360,
        chat:   "§7[FF] §4Pillager Raid §7— raiders are storming every platform. Eliminate them!",
        spawnMobs: {
          initial:  3,
          interval: 220,
          count:    2,
          types: [
            "minecraft:pillager",   "minecraft:pillager",
            "minecraft:vindicator",
            "minecraft:creeper",
          ],
        },
      },
    ],
  },

  storms: {
    weight:   12,
    title:    "§4⚡ STORM",
    subtitle: "§cChaos incoming!",
    waves: [
      {
        name:   "chaos_storm",
        minDur: 440, maxDur: 520,
        chat:   "§7[FF] §4Chaos Storm §7— maximum chaos. Anything can fall.",
      },
      {
        name:   "nether_storm",
        minDur: 440, maxDur: 520,
        chat:   "§7[FF] §cNether Storm §7— sustained hellfire. Soul sand and magma everywhere.",
      },
      {
        name:   "end_storm",
        minDur: 440, maxDur: 520,
        chat:   "§7[FF] §5End Storm §7— the void bleeds obsidian and purpur.",
      },
      {
        name:   "frozen_storm",
        minDur: 440, maxDur: 520,
        chat:   "§7[FF] §bFrozen Storm §7— ice and ocean wreckage. Your platform is a rink.",
      },
      {
        name:   "cave_storm",
        minDur: 440, maxDur: 520,
        chat:   "§7[FF] §8Cave Storm §7— underground chaos. Dense and ore-rich.",
      },
    ],
  },

  blackout: {
    weight:   8,
    title:    "§8Blackout",
    subtitle: "§7The sky goes silent...",
    waves: [
      {
        name:   "blackout",
        minDur: 440, maxDur: 520,
        chat:   "§7[FF] §8Blackout §7— nothing falls. Enjoy the silence while it lasts.",
      },
    ],
  },
};

// Flat lookup: waveName → { ...waveDef, category: catName }
export const WAVE_BY_NAME = {};
for (const [catName, cat] of Object.entries(WAVE_CATEGORIES)) {
  for (const wave of cat.waves) {
    WAVE_BY_NAME[wave.name] = { ...wave, category: catName };
  }
}

// ─── WAVE ROLLING ──────────────────────────────────────────────────────────────

// Roll a new category. Current category gets +CATEGORY_REPEAT_BONUS to its weight.
export function rollCategory(currentCategory) {
  const opts = Object.entries(WAVE_CATEGORIES).map(([name, cat]) => ({
    name,
    w: cat.weight + (name === currentCategory ? CATEGORY_REPEAT_BONUS : 0),
  }));
  const total = opts.reduce((s, o) => s + o.w, 0);
  let r = Math.random() * total;
  for (const o of opts) { r -= o.w; if (r <= 0) return o.name; }
  return opts[opts.length - 1].name;
}

// Roll a random wave from a given category (flat, no repeat bonus within category).
export function rollWaveInCategory(categoryName) {
  const waves = WAVE_CATEGORIES[categoryName].waves;
  return waves[Math.floor(Math.random() * waves.length)].name;
}

// Single source of truth for drop pacing (game ticks between drops per platform).
// Used by both applyWave and restoreDropRate so the two can never drift apart.
// state.forceRate (the ff:rate override) is applied by the callers, not here.
//   blackout  → never                BLACKOUT_DROP_RATE
//   meteor    → very fast (2 ticks)
//   storms / gold_rush / gravity_surge → fast (3 ticks)
//   everything else → standard        CFG.tickInterval (4)
export function computeDropRate(category, wave) {
  if (category === "blackout") return BLACKOUT_DROP_RATE;
  if (wave === "meteor_strike") return Math.max(2, Math.floor(CFG.tickInterval / 2));
  if (category === "storms" || wave === "gold_rush" || wave === "gravity_surge")
    return Math.max(3, Math.floor(CFG.tickInterval / 1.5));
  return CFG.tickInterval;
}

// Apply a wave. opts = { announce, categoryChanged }
// announce defaults to true; pass { announce: false } to suppress all output.
// categoryChanged = true shows a title card in addition to the chat message.
export function applyWave(categoryName, waveName, opts = {}) {
  const catDef  = WAVE_CATEGORIES[categoryName];
  const waveDef = catDef?.waves.find(w => w.name === waveName);
  if (!catDef || !waveDef) return;

  state.category = categoryName;
  state.wave     = waveName;
  state.waveTick = 0;
  state.waveDur  = rand(waveDef.minDur, waveDef.maxDur);
  state.votes    = {};

  // Drop rate (game ticks between drops per platform). Blackout ignores the
  // ff:rate override (nothing falls regardless); every other wave honors it.
  state.dropRate = categoryName === "blackout"
    ? BLACKOUT_DROP_RATE
    : (state.forceRate ?? computeDropRate(categoryName, waveName));

  const doAnnounce = opts.announce !== false;
  if (doAnnounce) {
    if (opts.categoryChanged) titleAll(catDef.title, catDef.subtitle);
    broadcast(waveDef.chat);
  }

  // Bonus chest for resource events — spawn on all active platforms
  if (doAnnounce && waveDef.bonusChest) {
    system.runTimeout(() => {
      for (const platform of getActivePlatforms()) spawnLootChest(platform);
    }, 20);
  }

  // Initial mob burst for mob events
  if (doAnnounce && waveDef.spawnMobs) {
    system.runTimeout(() => {
      for (const platform of getActivePlatforms()) {
        spawnMobsOnPlatform(platform, waveDef.spawnMobs.types, waveDef.spawnMobs.initial);
      }
    }, 40);
  }

  saveWaveState();
}

export function restoreDropRate() {
  state.dropRate = state.category === "blackout"
    ? BLACKOUT_DROP_RATE
    : (state.forceRate ?? computeDropRate(state.category, state.wave));
}

// ─── BLOCK SELECTION ─────────────────────────────────────────────────────────
export function pickRare() {
  const total = POOL_RARE.reduce((s, e) => s + e.w, 0);
  let r = Math.random() * total;
  for (const e of POOL_RARE) { r -= e.w; if (r <= 0) return e.id; }
  return POOL_RARE[POOL_RARE.length - 1].id;
}
export function pickChaos() {
  const total = POOL_CHAOS.reduce((s, e) => s + e.w, 0);
  let r = Math.random() * total;
  for (const e of POOL_CHAOS) { r -= e.w; if (r <= 0) return e.id; }
  return POOL_CHAOS[POOL_CHAOS.length - 1].id;
}

// Balanced pool picker shared by calm wave and chaos storm.
// isStorm = true cranks CHAOS/HAZARD weights and pulls TERRAIN/RESOURCE down.
export function pickBlockBalanced(isStorm) {
  const weights = [
    { pool: POOL_TERRAIN,  w: isStorm ? 40 : 50 },
    { pool: POOL_RESOURCE, w: isStorm ? 15 : 30 },
    { pool: POOL_HAZARD,   w: isStorm ? 10 :  8 },
    { pool: null,          w: isStorm ? 5 : 3 }, // null sentinel → pickRare()
    { pool: "chaos",       w: isStorm ? 10 :  7 },
  ];
  const pool = weightedPick(weights);
  if (pool === null)    return pickRare();
  if (pool === "chaos") return pickChaos();
  return pick(pool);
}

export function pickBlock() {
  switch (state.wave) {
    // ── Calm ──────────────────────────────────────────────────────────────────
    case "calm":
      return pickBlockBalanced(false);

    // ── Events ────────────────────────────────────────────────────────────────
    case "gold_rush":
      // 65% resource, 35% rare ores
      return Math.random() < 0.65 ? pick(POOL_RESOURCE) : pickRare();

    case "ore_shower":
      return pickRare();

    case "meteor_strike":
      return pickChaos();

    case "gravity_surge":
      // All entries are in GRAVITY_BLOCKS — fall via MC physics
      return pick(POOL_GRAVITY);

    case "nether_flare":
      return pick(POOL_NETHER);

    case "deep_freeze":
      return pick(POOL_ICE);

    // ── Storms ────────────────────────────────────────────────────────────────
    case "chaos_storm":
      return pickBlockBalanced(true);

    case "nether_storm": {
      // Heavier on hazard than the flare event, plus a chance at ancient debris
      const r = Math.random();
      if (r < 0.65) return pick(POOL_NETHER);
      if (r < 0.90) return pick(POOL_HAZARD);
      return pickRare();
    }

    case "end_storm":
      // Mostly end blocks; small chance at chaos (obsidian/crying obsidian already in pool)
      return Math.random() < 0.08 ? pickChaos() : pick(POOL_END);

    case "frozen_storm":
      // Mostly ice/ocean; hazard mixed in (powder snow, cobweb, slime)
      return Math.random() < 0.15 ? pick(POOL_HAZARD) : pick(POOL_ICE);

    case "cave_storm":
      // Cave terrain with boosted rare ore chance
      return Math.random() < 0.20 ? pickRare() : pick(POOL_CAVE);

    // ── Blackout — should never reach here (dropBlock returns early) ──────────
    default:
      return pickBlockBalanced(false);
  }
}
