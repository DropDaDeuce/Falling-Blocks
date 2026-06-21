// ─── LOOT SYSTEM ─────────────────────────────────────────────────────────────
import { world, system, ItemStack, EnchantmentTypes } from "@minecraft/server";
import { store } from "./store.js";
import { CFG } from "./config.js";
import { currentDay, lootPhase } from "./phase.js";
import { rand, pick, getDim, findLandingY, adminMsg, logErr } from "./util.js";
import { savePlatformState } from "./persistence.js";
import { SPAWN_EGGS } from "./pools.js";

// ─── LOOT TABLES ─────────────────────────────────────────────────────────────
// Entry shape: { id, w, min, max, enchants? }
// enchants:    [{ name, minLvl, maxLvl }]

const LOOT_COMMON = [
  // Food
  { id: "minecraft:bread",           w: 20, min: 4,  max: 8  },
  { id: "minecraft:cooked_beef",     w: 15, min: 3,  max: 6  },
  { id: "minecraft:cooked_chicken",  w: 12, min: 3,  max: 6  },
  { id: "minecraft:apple",           w: 12, min: 4,  max: 8  },
  { id: "minecraft:baked_potato",    w: 12, min: 3,  max: 6  },
  { id: "minecraft:sweet_berries",   w: 10, min: 4,  max: 8  },
  { id: "minecraft:carrot",          w: 10, min: 3,  max: 6  },
  { id: "minecraft:torch",           w: 18, min: 12, max: 24 },
  // Tools — stone era retires at day 3 when iron unlocks
  { id: "minecraft:stone_pickaxe",   w:  8, min: 1,  max: 1, maxDay: 5 },
  { id: "minecraft:stone_axe",       w:  6, min: 1,  max: 1, maxDay: 5 },
  { id: "minecraft:stone_sword",     w:  6, min: 1,  max: 1, maxDay: 5 },
  { id: "minecraft:iron_pickaxe",    w:  6, min: 1,  max: 1, minDay: 5 },
  { id: "minecraft:iron_shovel",     w:  5, min: 1,  max: 1, minDay: 5 },
  { id: "minecraft:iron_sword",      w:  5, min: 1,  max: 1, minDay: 5 },
  { id: "minecraft:iron_axe",        w:  5, min: 1,  max: 1, minDay: 5 },
  { id: "minecraft:bow",             w:  8, min: 1,  max: 1, minDay: 5 },
  { id: "minecraft:arrow",           w: 12, min: 12, max: 24 },
  // Armor — leather is the early-game ceiling
  { id: "minecraft:leather_helmet",     w: 5, min: 1, max: 1 },
  { id: "minecraft:leather_chestplate", w: 4, min: 1, max: 1 },
  // Utility / materials
  { id: "minecraft:shears",          w:  6, min: 1,  max: 1  },
  { id: "minecraft:bucket",          w:  6, min: 1,  max: 1  },
  { id: "minecraft:flint",           w:  8, min: 2,  max: 4  },
  { id: "minecraft:ladder",          w: 10, min: 12, max: 16 },
  { id: "minecraft:string",          w: 10, min: 4,  max: 8  },
  { id: "minecraft:coal",            w: 20, min: 8,  max: 16 },
  { id: "minecraft:raw_iron",        w: 15, min: 3,  max: 6  },
  { id: "minecraft:bone",            w: 15, min: 4,  max: 8  },
  { id: "minecraft:feather",         w: 12, min: 4,  max: 8  },
  { id: "minecraft:gunpowder",       w: 10, min: 3,  max: 6  },
  { id: "minecraft:sugar",           w: 10, min: 4,  max: 8  },
  { id: "minecraft:paper",           w: 10, min: 4,  max: 8  },
  { id: "minecraft:spider_eye",      w:  8, min: 2,  max: 4  },
];

const LOOT_UNCOMMON = [
  // Iron armor + power items unlock at day 3
  { id: "minecraft:iron_helmet",     w:  5, min: 1,  max: 1, minDay: 5 },
  { id: "minecraft:iron_chestplate", w:  5, min: 1,  max: 1, minDay: 5 },
  { id: "minecraft:iron_leggings",   w:  5, min: 1,  max: 1, minDay: 5 },
  { id: "minecraft:iron_boots",      w:  5, min: 1,  max: 1, minDay: 5 },
  { id: "minecraft:golden_apple",    w:  5, min: 1,  max: 1, minDay: 5 },
  { id: "minecraft:ender_pearl",     w:  6, min: 2,  max: 4, minDay: 5 },
  { id: "minecraft:lava_bucket",     w:  5, min: 1,  max: 1, minDay: 5 },
  { id: "minecraft:blaze_rod",       w:  5, min: 1,  max: 3, minDay: 5 },
  { id: "minecraft:nether_wart",     w:  6, min: 4,  max: 8, minDay: 5 },
  { id: "minecraft:golden_carrot",   w:  6, min: 2,  max: 4, minDay: 5 },
  { id: "minecraft:enchanted_book",  w:  5, min: 1,  max: 1, minDay: 3,
    enchants: [{ name: "efficiency", minLvl: 1, maxLvl: 2 }] },
  // Ungated utility / materials
  { id: "minecraft:shield",          w:  8, min: 1,  max: 1  },
  { id: "minecraft:water_bucket",    w:  8, min: 1,  max: 1  },
  { id: "minecraft:scaffolding",     w:  8, min: 12, max: 16 },
  { id: "minecraft:flint_and_steel", w:  5, min: 1,  max: 1  },
  { id: "minecraft:firework_rocket", w:  5, min: 4,  max: 8  },
  { id: "minecraft:cooked_salmon",   w: 10, min: 4,  max: 8  },
  { id: "minecraft:raw_gold",        w:  8, min: 3,  max: 6  },
  { id: "minecraft:lapis_lazuli",    w: 10, min: 6,  max: 12 },
  { id: "minecraft:redstone",        w: 10, min: 6,  max: 12 },
  { id: "minecraft:copper_ingot",    w: 10, min: 6,  max: 12 },
  { id: "minecraft:leather",         w:  8, min: 4,  max: 8  },
  { id: "minecraft:saddle",          w:  5, min: 1,  max: 1  },
  { id: "minecraft:name_tag",        w:  4, min: 1,  max: 1  },
  { id: "minecraft:crossbow",        w:  5, min: 1,  max: 1  },
  { id: "minecraft:amethyst_shard",  w:  6, min: 2,  max: 4  },
  { id: "minecraft:honey_bottle",    w:  5, min: 1,  max: 2  },
  { id: "minecraft:bone_meal",       w:  8, min: 6,  max: 12 },
  { id: "minecraft:slime_ball",      w:  6, min: 4,  max: 8  },
  { id: "minecraft:fishing_rod",     w:  6, min: 1,  max: 1  },
  { id: "minecraft:book",            w:  8, min: 2,  max: 4  },
  { id: "minecraft:clock",           w:  5, min: 1,  max: 1  },
  { id: "minecraft:magma_cream",     w:  6, min: 2,  max: 4  },
  { id: "minecraft:rabbit_foot",     w:  5, min: 1,  max: 2  },
  { id: "minecraft:pufferfish",      w:  5, min: 1,  max: 2  },
  // All 16 dyes
  { id: "minecraft:white_dye",       w:  6, min: 4,  max: 8  },
  { id: "minecraft:orange_dye",      w:  6, min: 4,  max: 8  },
  { id: "minecraft:magenta_dye",     w:  6, min: 4,  max: 8  },
  { id: "minecraft:light_blue_dye",  w:  6, min: 4,  max: 8  },
  { id: "minecraft:yellow_dye",      w:  6, min: 4,  max: 8  },
  { id: "minecraft:lime_dye",        w:  6, min: 4,  max: 8  },
  { id: "minecraft:pink_dye",        w:  6, min: 4,  max: 8  },
  { id: "minecraft:gray_dye",        w:  6, min: 4,  max: 8  },
  { id: "minecraft:light_gray_dye",  w:  6, min: 4,  max: 8  },
  { id: "minecraft:cyan_dye",        w:  6, min: 4,  max: 8  },
  { id: "minecraft:purple_dye",      w:  6, min: 4,  max: 8  },
  { id: "minecraft:blue_dye",        w:  6, min: 4,  max: 8  },
  { id: "minecraft:brown_dye",       w:  6, min: 4,  max: 8  },
  { id: "minecraft:green_dye",       w:  6, min: 4,  max: 8  },
  { id: "minecraft:red_dye",         w:  6, min: 4,  max: 8  },
  { id: "minecraft:black_dye",       w:  6, min: 4,  max: 8  },
];

const LOOT_RARE = [
  { id: "minecraft:iron_pickaxe",    w: 10, min: 1, max: 1,
    enchants: [{ name: "efficiency",      minLvl: 2, maxLvl: 3 }] },
  { id: "minecraft:iron_pickaxe",    w:  6, min: 1, max: 1,
    enchants: [{ name: "fortune",         minLvl: 1, maxLvl: 2 }] },
  { id: "minecraft:iron_pickaxe",    w:  5, min: 1, max: 1,
    enchants: [{ name: "silk_touch",      minLvl: 1, maxLvl: 1 }] },
  { id: "minecraft:iron_sword",      w: 10, min: 1, max: 1,
    enchants: [{ name: "sharpness",       minLvl: 2, maxLvl: 3 }] },
  { id: "minecraft:iron_sword",      w:  6, min: 1, max: 1,
    enchants: [{ name: "looting",         minLvl: 1, maxLvl: 2 }] },
  { id: "minecraft:iron_chestplate", w:  8, min: 1, max: 1,
    enchants: [{ name: "protection",      minLvl: 2, maxLvl: 3 }] },
  { id: "minecraft:iron_boots",      w:  8, min: 1, max: 1,
    enchants: [{ name: "feather_falling", minLvl: 3, maxLvl: 4 }] },
  { id: "minecraft:bow",             w:  8, min: 1, max: 1,
    enchants: [{ name: "power",           minLvl: 2, maxLvl: 3 }] },
  { id: "minecraft:enchanted_book",  w:  8, min: 1, max: 1,
    enchants: [{ name: "unbreaking",      minLvl: 3, maxLvl: 3 }] },
  { id: "minecraft:enchanted_book",  w:  6, min: 1, max: 1,
    enchants: [{ name: "mending",         minLvl: 1, maxLvl: 1 }] },
  { id: "minecraft:enchanted_book",  w:  6, min: 1, max: 1,
    enchants: [{ name: "looting",         minLvl: 2, maxLvl: 3 }] },
  { id: "minecraft:enchanted_book",  w:  6, min: 1, max: 1,
    enchants: [{ name: "fortune",         minLvl: 2, maxLvl: 3 }] },
  { id: "minecraft:enchanted_book",  w:  5, min: 1, max: 1,
    enchants: [{ name: "silk_touch",      minLvl: 1, maxLvl: 1 }] },
  { id: "minecraft:enchanted_golden_apple", w: 5, min: 1, max: 1 },
  { id: "minecraft:totem_of_undying",       w: 5, min: 1, max: 1 },
  { id: "minecraft:tnt",                    w: 4, min: 2, max: 4 },
  { id: "minecraft:obsidian",               w: 6, min: 4, max: 8 },
  { id: "minecraft:diamond",                w: 8, min: 2, max: 4 },
  { id: "minecraft:emerald",                w: 8, min: 2, max: 4 },
  { id: "minecraft:trident",                w: 4, min: 1, max: 1 },
  { id: "minecraft:shulker_shell",          w: 5, min: 1, max: 2 },
  { id: "minecraft:ghast_tear",             w: 5, min: 1, max: 2 },
  { id: "minecraft:phantom_membrane",       w: 5, min: 1, max: 3 },
  { id: "minecraft:anvil",                  w: 5, min: 1, max: 1 },
  { id: "minecraft:experience_bottle",      w: 8, min: 8, max: 16 },
  { id: "minecraft:music_disc_cat",         w: 3, min: 1, max: 1 },
  { id: "minecraft:music_disc_pigstep",     w: 2, min: 1, max: 1 },
  { id: "minecraft:netherite_scrap",        w: 4, min: 1, max: 2, minDay: 20 }, // pre-farm during the late phase
  // end_portal_frame intentionally removed — obtained via the End Portal platform at day 20
];

const LOOT_MYTHIC = [
  // Day 30+ (End portal era) crown jewels — earlier mythics top out at enchanted diamond
  { id: "minecraft:elytra",              w:  8, min: 1, max: 1, minDay: 30 },
  { id: "minecraft:diamond_pickaxe",     w:  7, min: 1, max: 1,
    enchants: [{ name: "efficiency",     minLvl: 3, maxLvl: 5 }] },
  { id: "minecraft:diamond_pickaxe",     w:  5, min: 1, max: 1,
    enchants: [{ name: "fortune",        minLvl: 3, maxLvl: 3 }] },
  { id: "minecraft:diamond_pickaxe",     w:  3, min: 1, max: 1,
    enchants: [{ name: "silk_touch",     minLvl: 1, maxLvl: 1 }] },
  { id: "minecraft:diamond_sword",       w:  7, min: 1, max: 1,
    enchants: [{ name: "sharpness",      minLvl: 4, maxLvl: 5 }] },
  { id: "minecraft:diamond_sword",       w:  4, min: 1, max: 1,
    enchants: [{ name: "looting",        minLvl: 3, maxLvl: 3 }] },
  { id: "minecraft:diamond_chestplate",  w:  5, min: 1, max: 1,
    enchants: [{ name: "protection",     minLvl: 4, maxLvl: 4 }] },
  { id: "minecraft:diamond_chestplate",  w:  3, min: 1, max: 1,
    enchants: [{ name: "unbreaking",     minLvl: 3, maxLvl: 3 }] },
  { id: "minecraft:diamond_helmet",      w:  5, min: 1, max: 1 },
  { id: "minecraft:diamond_leggings",    w:  5, min: 1, max: 1 },
  { id: "minecraft:diamond_boots",       w:  5, min: 1, max: 1,
    enchants: [{ name: "feather_falling", minLvl: 4, maxLvl: 4 }] },
  { id: "minecraft:enchanted_book",      w:  6, min: 1, max: 1,
    enchants: [{ name: "mending",        minLvl: 1, maxLvl: 1 }] },
  { id: "minecraft:firework_rocket",     w: 10, min: 8, max: 8  },
  { id: "minecraft:totem_of_undying",    w:  8, min: 1, max: 1  },
  { id: "minecraft:netherite_ingot",     w:  5, min: 1, max: 1, minDay: 30 },
  { id: "minecraft:nether_star",         w:  4, min: 1, max: 1, minDay: 30 },
  // Wither path: 3 skulls + soul sand (POOL_HAZARD) → wither → star → beacon
  { id: "minecraft:wither_skeleton_skull",                 w: 5, min: 1, max: 1, minDay: 30 },
  { id: "minecraft:netherite_upgrade_smithing_template",   w: 5, min: 1, max: 1, minDay: 30 },
];

// weights = tier roll weight per phase; counts = [min, max] items per chest per phase
export const LOOT_TIERS = [
  { name: "common",   weights: { early: 100, mid: 100, late: 80, end: 70 }, counts: { early: [3, 5], mid: [4, 7], late: [4, 7], end: [4, 7] }, table: LOOT_COMMON   },
  { name: "uncommon", weights: { early:  25, mid:  45, late: 55, end: 60 }, counts: { early: [4, 6], mid: [5, 8], late: [5, 8], end: [5, 8] }, table: LOOT_UNCOMMON },
  { name: "rare",     weights: { early:   2, mid:   6, late:  9, end: 12 }, counts: { early: [5, 7], mid: [5, 7], late: [5, 7], end: [5, 7] }, table: LOOT_RARE     },
  { name: "mythic",   weights: { early:   0, mid:   1, late:  2, end:  3 }, counts: { early: [3, 5], mid: [3, 5], late: [3, 5], end: [3, 5] }, table: LOOT_MYTHIC   },
];

// Export the raw tables too (validateIds in main.js checks every item id).
export { LOOT_COMMON, LOOT_UNCOMMON, LOOT_RARE, LOOT_MYTHIC };

// ─── LOOT TIER ROLLING ───────────────────────────────────────────────────────
// rarePity / mythicPity are per-platform accumulators added to base weights.
// Positive = boosted odds (pity building up), negative = brief deficit after a hit.
// Weights are clamped at 0 so a deficit can never make a tier unrollable.
export function rollLootTier(rarePity = 0, mythicPity = 0, phase = "mid") {
  const adjusted = LOOT_TIERS.map(t => {
    const base = t.weights[phase];
    let w = base;
    if (t.name === "rare")   w = base + rarePity;
    if (t.name === "mythic") w = base + mythicPity;
    // base 0 = hard phase gate (e.g. no mythics in early) — pity can't open it
    return { ...t, weight: base === 0 ? 0 : Math.max(0, w) };
  });
  const total = adjusted.reduce((s, t) => s + t.weight, 0);
  let r = Math.random() * total;
  for (const t of adjusted) { r -= t.weight; if (r <= 0) return t; }
  return adjusted[0];
}

// Fill a chest block from a loot tier. No duplicate item types per roll.
// slotOverride (optional, v1.9.0): force the number of loot rolls instead of the
// tier's per-phase count. Accepts a scalar (exact) or a [min,max] range. Spawn-egg
// guarantees still append after these rolls. Container caps at 27 either way.
export function fillChest(block, tier, slotOverride) {
  try {
    const inv = block.getComponent("minecraft:inventory");
    if (!inv?.container) return;
    const container    = inv.container;
    const day          = currentDay();
    const phase        = lootPhase();
    const [cMin, cMax] = tier.counts[phase];
    let count          = rand(cMin, cMax);
    if (slotOverride !== undefined && slotOverride !== null) {
      count = Array.isArray(slotOverride)
        ? rand(slotOverride[0], slotOverride[1])
        : slotOverride;
    }
    // Day-gated entries: minDay = unlocks at that day, maxDay = retires after it
    const available = tier.table.filter(e =>
      day >= (e.minDay ?? 0) && day < (e.maxDay ?? Infinity)
    );
    const chosen    = [];

    for (let i = 0; i < count && available.length > 0; i++) {
      const total = available.reduce((s, e) => s + e.w, 0);
      let r   = Math.random() * total;
      let idx = available.length - 1;
      for (let j = 0; j < available.length; j++) {
        r -= available[j].w;
        if (r <= 0) { idx = j; break; }
      }
      chosen.push(available.splice(idx, 1)[0]);
    }

    for (let i = 0; i < chosen.length; i++) {
      const entry = chosen[i];
      try {
        const item = new ItemStack(entry.id, rand(entry.min, entry.max));
        if (entry.enchants) {
          const ec = item.getComponent("minecraft:enchantable");
          if (ec) {
            for (const e of entry.enchants) {
              try {
                ec.addEnchantment({
                  type:  EnchantmentTypes.get(e.name),
                  level: rand(e.minLvl, e.maxLvl),
                });
              } catch(_) {}
            }
          }
        }
        container.setItem(i, item);
      } catch(_) {}
    }

    // Guaranteed tier-matched spawn egg, then chance at extras
    const eggPool = SPAWN_EGGS[tier.name];
    let nextSlot = chosen.length;
    if (eggPool?.length > 0) {
      try { container.setItem(nextSlot++, new ItemStack(pick(eggPool), 1)); } catch(_) {}

      if (tier.name === "rare") {
        if (Math.random() < 0.4)
          try { container.setItem(nextSlot++, new ItemStack(pick(eggPool), 1)); } catch(_) {}
      }
      if (tier.name === "mythic") {
        for (let e = 0; e < 2; e++)
          if (Math.random() < 0.5)
            try { container.setItem(nextSlot++, new ItemStack(pick(eggPool), 1)); } catch(_) {}
      }
    }
    // End portal frames are no longer in loot — obtain via the End Portal platform (day 20)
  } catch(e) { logErr("fillChest", e); }
}

// Starter chest: wood tools + food + torches
export function fillStarterChest(block) {
  try {
    const inv = block.getComponent("minecraft:inventory");
    if (!inv?.container) return;
    const container = inv.container;
    const items = [
      { id: "minecraft:wooden_pickaxe", qty: 1 },
      { id: "minecraft:wooden_axe",     qty: 1 },
      { id: "minecraft:wooden_shovel",  qty: 1 },
      { id: "minecraft:wooden_sword",   qty: 1 },
      { id: "minecraft:bread",          qty: 5 },
      { id: "minecraft:torch",          qty: 8 },
      { id: "minecraft:bed",             qty: 1 },
      { id: "minecraft:cobblestone",     qty: 16 },
      { id: "minecraft:oak_planks",      qty: 16 },
    ];
    items.forEach((entry, i) => {
      try { container.setItem(i, new ItemStack(entry.id, entry.qty)); } catch(_) {}
    });
    // Two guaranteed common spawn eggs
    try { container.setItem(items.length,     new ItemStack(pick(SPAWN_EGGS.common), 1)); } catch(_) {}
    try { container.setItem(items.length + 1, new ItemStack(pick(SPAWN_EGGS.common), 1)); } catch(_) {}
  } catch(_) {}
}

// Place starter chest 2 blocks north of platform center, directly on the surface
export function spawnStarterChest(platform) {
  const dim = getDim();
  const x   = platform.cx;
  const y   = CFG.platformY + 1;
  const z   = platform.cz - 2;
  try {
    dim.runCommand(`setblock ${x} ${y} ${z} minecraft:chest`);
    system.runTimeout(() => {
      try {
        const block = dim.getBlock({ x, y, z });
        if (block?.typeId === "minecraft:chest") fillStarterChest(block);
      } catch(_) {}
    }, 2);
  } catch(_) {}
}

// Place a tiered loot chest at a random spot on the platform.
// Pass forcedTier to override the random roll (used by ff:spawnloot) — skips pity.
// Mythic tier spawns a purple shulker box instead of a chest.
export function spawnLootChest(platform, forcedTier = null) {
  const dim  = getDim();
  const half = Math.floor(CFG.platformSize / 2) - 2;
  const x    = platform.cx + rand(-half, half);
  const z    = platform.cz + rand(-half, half);
  const topY = findLandingY(dim, x, z);

  // Roll tier with per-platform pity; forced tier bypasses pity entirely.
  const pData      = store.platformState[platform.id];
  const rarePity   = pData?.rarePity   ?? 0;
  const mythicPity = pData?.mythicPity ?? 0;
  const tier       = forcedTier ?? rollLootTier(rarePity, mythicPity, lootPhase());

  // Update pity counters (natural rolls only).
  // Rare hit: rarePity deficit. Mythic hit: mythicPity deficit. Miss: both accrue.
  if (!forcedTier && pData) {
    // mythicPity only accrues once mythics are actually rollable (mid phase+),
    // otherwise 3 days of early-phase misses pile up into a day-3 mythic jackpot.
    const accrueMythic = lootPhase() !== "early";
    if (tier.name === "mythic") {
      pData.mythicPity = -2;
    } else if (tier.name === "rare") {
      pData.rarePity   = -4;
      if (accrueMythic) pData.mythicPity = (pData.mythicPity ?? 0) + 1;
    } else {
      pData.rarePity   = (pData.rarePity   ?? 0) + 1;
      if (accrueMythic) pData.mythicPity = (pData.mythicPity ?? 0) + 1;
    }
    savePlatformState();
  }

  const blockId = tier.name === "mythic" ? "minecraft:purple_shulker_box" : "minecraft:chest";
  try {
    dim.runCommand(`setblock ${x} ${topY} ${z} ${blockId}`);
    system.runTimeout(() => {
      try {
        const block = dim.getBlock({ x, y: topY, z });
        if (block?.typeId !== blockId) return;
        fillChest(block, tier);
        const label =
          tier.name === "mythic"   ? "§5✦ Mythic"   :
          tier.name === "rare"     ? "§6★ Rare"     :
          tier.name === "uncommon" ? "§bUncommon"   : "§7Common";
        const owner = pData ? world.getAllPlayers().find(p => p.id === pData.playerUUID) : null;
        if (owner) owner.sendMessage(`§6[FF] ${label} §6chest at (${x}, ${topY}, ${z})!`);
        adminMsg(`§8[FF-OP] Chest: ${label} §8on Platform ${platform.id} (${owner?.name ?? "offline"}) at (${x}, ${topY}, ${z})`);
      } catch(_) {}
    }, 2);
  } catch(_) {}
}
