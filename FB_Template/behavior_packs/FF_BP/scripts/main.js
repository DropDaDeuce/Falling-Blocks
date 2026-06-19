import { world, system, BlockPermutation, ItemStack, EnchantmentTypes, PlayerPermissionLevel } from "@minecraft/server";
// Challenge structure definitions live in their own files under ./structures/.
// To add a new structure, see the instructions in structures/index.js.
import { CHALLENGE_STRUCT_DEFS } from "./structures/index.js";

// ─── CONFIG ───────────────────────────────────────────────────────────────────
const CFG = {
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
const PLATFORMS = [
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
const TICKS_PER_DAY   = 6000;
const NETHER_PORTAL_TICK = TICKS_PER_DAY * 20;   // day 20
const END_PORTAL_TICK    = TICKS_PER_DAY * 30;   // day 30
const PORTAL_NETHER = { cx: 0, cz: -150 };
const PORTAL_END    = { cx: 0, cz:  150 };

// ─── NATURALLY FALLING BLOCKS ─────────────────────────────────────────────────
// All 16 concrete powder variants included — required for Gravity Surge event.
// Powder snow is intentionally excluded — it does NOT obey gravity in Bedrock.
const GRAVITY_BLOCKS = new Set([
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
const BLIND_FALL_Y = 190;

// Block types the falling animation passes through. Source liquids
// (minecraft:water / minecraft:lava) are deliberately NOT listed — blocks land
// on top of source blocks but fall through flowing liquid.
const PASS_THROUGH = new Set([
  "minecraft:air", "minecraft:flowing_water", "minecraft:flowing_lava",
]);

// Blocks that can convert to water (melt / break). Kept ≥3 blocks away from
// platform edges so the resulting water doesn't cascade off the sides.
const EDGE_INSET_BLOCKS = new Set(["minecraft:ice"]);

// ─── BLOCK POOLS ─────────────────────────────────────────────────────────────
const POOL_TERRAIN = [
  // Stone family
  "minecraft:stone", "minecraft:cobblestone", "minecraft:cobbled_deepslate",
  "minecraft:deepslate", "minecraft:calcite", "minecraft:tuff",
  "minecraft:granite", "minecraft:diorite", "minecraft:andesite",
  // Soil family
  "minecraft:dirt", "minecraft:coarse_dirt", "minecraft:dirt_with_roots",
  "minecraft:podzol", "minecraft:mycelium", "minecraft:clay", "minecraft:mud",
  // Sand / gravity (placed statically, fall via MC physics)
  "minecraft:sand", "minecraft:red_sand", "minecraft:gravel",
  "minecraft:white_concrete_powder",
  // Nether terrain
  "minecraft:netherrack", "minecraft:blackstone", "minecraft:basalt",
  "minecraft:smooth_basalt", "minecraft:nether_wart_block", "minecraft:warped_wart_block",
  // End / ocean / special
  "minecraft:end_stone", "minecraft:purpur_block", "minecraft:prismarine",
  "minecraft:hardened_clay", "minecraft:sandstone", "minecraft:red_sandstone",
  "minecraft:dripstone_block", "minecraft:packed_ice",
  // Mushroom blocks
  "minecraft:brown_mushroom_block", "minecraft:red_mushroom_block",
];
const POOL_RESOURCE = [
  // Wood — overworld
  "minecraft:oak_log", "minecraft:birch_log", "minecraft:spruce_log",
  "minecraft:jungle_log", "minecraft:acacia_log", "minecraft:dark_oak_log",
  "minecraft:mangrove_log", "minecraft:cherry_log", "minecraft:bamboo_block",
  // Wood — nether
  "minecraft:crimson_stem", "minecraft:warped_stem",
  // Overworld ores (surface variants only — deepslate versions in POOL_RARE/POOL_CAVE)
  "minecraft:coal_ore",
  "minecraft:iron_ore",
  "minecraft:copper_ore",
  // Nether ores / gold
  "minecraft:quartz_ore", "minecraft:nether_gold_ore",
  "minecraft:gilded_blackstone",
  // Building
  "minecraft:oak_planks", "minecraft:mossy_cobblestone",
  "minecraft:stone_bricks", "minecraft:bookshelf",
  // Nature / utility
  "minecraft:hay_block", "minecraft:melon_block", "minecraft:pumpkin",
  "minecraft:bone_block", "minecraft:pointed_dripstone",
  // Light sources
  "minecraft:glowstone", "minecraft:sea_lantern", "minecraft:shroomlight",
  // Misc
  "minecraft:white_wool", "minecraft:glass", "minecraft:sponge",
];
const POOL_HAZARD = [
  "minecraft:magma", "minecraft:soul_sand", "minecraft:soul_soil",
  "minecraft:powder_snow", "minecraft:web",
  "minecraft:slime", "minecraft:honey_block",
];
// Weighted entries { id, w } — lower w = rarer
const POOL_RARE = [
  { id: "minecraft:ancient_debris",         w:  1 },
  { id: "minecraft:deepslate_diamond_ore",  w:  2 },  // lowered from 4
  { id: "minecraft:diamond_ore",            w:  3 },  // lowered from 6
  { id: "minecraft:deepslate_emerald_ore",  w:  4 },
  { id: "minecraft:emerald_ore",            w:  6 },
  { id: "minecraft:deepslate_gold_ore",     w:  8 },
  { id: "minecraft:gold_ore",               w: 10 },
  { id: "minecraft:amethyst_block",         w: 12 },
  { id: "minecraft:deepslate_lapis_ore",    w: 10 },
  { id: "minecraft:lapis_ore",              w: 12 },
  { id: "minecraft:deepslate_redstone_ore", w: 10 },
  { id: "minecraft:redstone_ore",           w: 12 },
];
const POOL_CHAOS = [
  // lava and water intentionally removed — available as loot bucket drops instead
  // TNT and sculk_catalyst are low-weight intentionally — they're disruptive
  { id: "minecraft:tnt",                w: 0.5 },
  { id: "minecraft:sculk_catalyst",     w: 0.01 },
  { id: "minecraft:obsidian",           w: 2 },
  { id: "minecraft:crying_obsidian",    w: 2 },
  { id: "minecraft:moss_block",         w: 4 },
  { id: "minecraft:sculk",              w: 2 },
  { id: "minecraft:infested_stone",     w: 2 },
  { id: "minecraft:infested_deepslate", w: 2 },
];

// ─── THEMED BLOCK POOLS ───────────────────────────────────────────────────────
// Used by themed events and storms. Flat arrays — all entries equal weight.

// Nether biome — used by Nether Flare event and Nether Storm
const POOL_NETHER = [
  "minecraft:netherrack", "minecraft:netherrack", "minecraft:netherrack",
  "minecraft:soul_sand", "minecraft:soul_soil",
  "minecraft:magma",
  "minecraft:basalt", "minecraft:smooth_basalt",
  "minecraft:blackstone", "minecraft:polished_blackstone",
  "minecraft:nether_brick",
  "minecraft:crimson_nylium", "minecraft:warped_nylium",
  "minecraft:crimson_planks", "minecraft:warped_planks",
  "minecraft:crimson_stem", "minecraft:warped_stem",
  "minecraft:quartz_ore", "minecraft:nether_gold_ore",
  "minecraft:gilded_blackstone",
  "minecraft:glowstone", "minecraft:glowstone",
  "minecraft:shroomlight",
  "minecraft:nether_wart_block", "minecraft:warped_wart_block",
];

// End biome — used by End Storm
const POOL_END = [
  "minecraft:end_stone", "minecraft:end_stone", "minecraft:end_stone",
  "minecraft:end_bricks",
  "minecraft:purpur_block", "minecraft:purpur_block",
  "minecraft:purpur_pillar",
];

// Ice / ocean — used by Deep Freeze event and Frozen Storm
const POOL_ICE = [
  "minecraft:ice", "minecraft:ice", "minecraft:ice",
  "minecraft:packed_ice", "minecraft:packed_ice",
  "minecraft:blue_ice",
  "minecraft:packed_ice", "minecraft:blue_ice",
  "minecraft:powder_snow",          // animated (not a gravity block in Bedrock)
  "minecraft:prismarine", "minecraft:prismarine_bricks", "minecraft:dark_prismarine",
  "minecraft:sea_lantern",
  "minecraft:sponge",
];

// Underground / cave — used by Cave Storm
const POOL_CAVE = [
  "minecraft:deepslate", "minecraft:deepslate",
  "minecraft:cobbled_deepslate", "minecraft:cobbled_deepslate",
  "minecraft:tuff", "minecraft:tuff",
  "minecraft:calcite",
  "minecraft:dripstone_block",
  "minecraft:pointed_dripstone",
  "minecraft:amethyst_block",
  "minecraft:mud",
  "minecraft:dirt_with_roots",
  "minecraft:smooth_basalt",
];

// All gravity-obeying blocks — used exclusively by Gravity Surge event.
// Every entry here MUST also be in GRAVITY_BLOCKS (placed statically, fall via MC physics).
const POOL_GRAVITY = [
  "minecraft:sand", "minecraft:sand",
  "minecraft:red_sand",
  "minecraft:gravel", "minecraft:gravel",
  "minecraft:white_concrete_powder",      "minecraft:orange_concrete_powder",
  "minecraft:magenta_concrete_powder",    "minecraft:light_blue_concrete_powder",
  "minecraft:yellow_concrete_powder",     "minecraft:lime_concrete_powder",
  "minecraft:pink_concrete_powder",       "minecraft:gray_concrete_powder",
  "minecraft:light_gray_concrete_powder", "minecraft:cyan_concrete_powder",
  "minecraft:purple_concrete_powder",     "minecraft:blue_concrete_powder",
  "minecraft:brown_concrete_powder",      "minecraft:green_concrete_powder",
  "minecraft:red_concrete_powder",        "minecraft:black_concrete_powder",
];

// ─── SPAWN EGG POOLS ─────────────────────────────────────────────────────────
// One spawn egg guaranteed per chest, tier-matched. Flat equal-weight pick.
const SPAWN_EGGS = {
  common: [
    "minecraft:chicken_spawn_egg",  "minecraft:cow_spawn_egg",
    "minecraft:pig_spawn_egg",      "minecraft:sheep_spawn_egg",
    "minecraft:rabbit_spawn_egg",   "minecraft:squid_spawn_egg",
    "minecraft:cod_spawn_egg",      "minecraft:salmon_spawn_egg",
    "minecraft:bat_spawn_egg",      "minecraft:bee_spawn_egg",
  ],
  uncommon: [
    "minecraft:wolf_spawn_egg",      "minecraft:cat_spawn_egg",
    "minecraft:fox_spawn_egg",       "minecraft:horse_spawn_egg",
    "minecraft:donkey_spawn_egg",    "minecraft:panda_spawn_egg",
    "minecraft:llama_spawn_egg",     "minecraft:mooshroom_spawn_egg",
    "minecraft:turtle_spawn_egg",    "minecraft:axolotl_spawn_egg",
    "minecraft:goat_spawn_egg",      "minecraft:frog_spawn_egg",
    "minecraft:dolphin_spawn_egg",   "minecraft:tropical_fish_spawn_egg",
    "minecraft:parrot_spawn_egg",    "minecraft:ocelot_spawn_egg",
    "minecraft:camel_spawn_egg",     "minecraft:allay_spawn_egg",
    "minecraft:armadillo_spawn_egg", "minecraft:sniffer_spawn_egg",
    "minecraft:villager_spawn_egg",  "minecraft:mule_spawn_egg",
  ],
  rare: [
    "minecraft:zombie_spawn_egg",           "minecraft:skeleton_spawn_egg",
    "minecraft:spider_spawn_egg",           "minecraft:creeper_spawn_egg",
    "minecraft:enderman_spawn_egg",         "minecraft:blaze_spawn_egg",
    "minecraft:ghast_spawn_egg",            "minecraft:witch_spawn_egg",
    "minecraft:slime_spawn_egg",            "minecraft:cave_spider_spawn_egg",
    "minecraft:zombie_pigman_spawn_egg", "minecraft:drowned_spawn_egg",
    "minecraft:husk_spawn_egg",             "minecraft:stray_spawn_egg",
    "minecraft:phantom_spawn_egg",          "minecraft:pillager_spawn_egg",
    "minecraft:vindicator_spawn_egg",       "minecraft:hoglin_spawn_egg",
    "minecraft:piglin_spawn_egg",           "minecraft:strider_spawn_egg",
    "minecraft:guardian_spawn_egg",         "minecraft:magma_cube_spawn_egg",
    "minecraft:silverfish_spawn_egg",       "minecraft:bogged_spawn_egg",
    "minecraft:breeze_spawn_egg",           "minecraft:warden_spawn_egg",
  ],
  mythic: [
    "minecraft:elder_guardian_spawn_egg", "minecraft:wither_skeleton_spawn_egg",
    "minecraft:evoker_spawn_egg",         "minecraft:ravager_spawn_egg",
    "minecraft:shulker_spawn_egg",        "minecraft:zoglin_spawn_egg",
    "minecraft:iron_golem_spawn_egg",     "minecraft:piglin_brute_spawn_egg",
  ],
};

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

// ─── LOOT PROGRESSION PHASES ─────────────────────────────────────────────────
// Loot quality is tied to the world day counter (state.tick / TICKS_PER_DAY —
// the same clock that drives the portal milestones). Phases anchor to portals:
//   early: days 0-5   — stone/leather era, smaller chests, no mythics
//   mid:   days 5-20  — iron era, runs until the Nether portal spawns
//   late:  days 20-30 — Nether portal era; odds climb, netherite scrap drips
//   end:   day 30+    — End portal era; elytra / netherite / wither path open
// Loot entries may carry minDay / maxDay — filtered at roll time in fillChest.
// A phase weight of 0 is a HARD gate: pity cannot open it (see rollLootTier).
function currentDay() {
  return Math.floor(state.tick / TICKS_PER_DAY);
}
function lootPhase() {
  const d = currentDay();
  return d < 5 ? "early" : d < 20 ? "mid" : d < 30 ? "late" : "end";
}

// weights = tier roll weight per phase; counts = [min, max] items per chest per phase
const LOOT_TIERS = [
  { name: "common",   weights: { early: 100, mid: 100, late: 80, end: 70 }, counts: { early: [3, 5], mid: [4, 7], late: [4, 7], end: [4, 7] }, table: LOOT_COMMON   },
  { name: "uncommon", weights: { early:  25, mid:  45, late: 55, end: 60 }, counts: { early: [4, 6], mid: [5, 8], late: [5, 8], end: [5, 8] }, table: LOOT_UNCOMMON },
  { name: "rare",     weights: { early:   2, mid:   6, late:  9, end: 12 }, counts: { early: [5, 7], mid: [5, 7], late: [5, 7], end: [5, 7] }, table: LOOT_RARE     },
  { name: "mythic",   weights: { early:   0, mid:   1, late:  2, end:  3 }, counts: { early: [3, 5], mid: [3, 5], late: [3, 5], end: [3, 5] }, table: LOOT_MYTHIC   },
];

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
const CATEGORY_REPEAT_BONUS = 20;

const WAVE_CATEGORIES = {
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
const WAVE_BY_NAME = {};
for (const [catName, cat] of Object.entries(WAVE_CATEGORIES)) {
  for (const wave of cat.waves) {
    WAVE_BY_NAME[wave.name] = { ...wave, category: catName };
  }
}

// ─── STATE ────────────────────────────────────────────────────────────────────
const state = {
  running:      false,
  paused:       false,
  tick:         0,
  dropTick:     0,
  category:     "calm",  // active category name
  wave:         "calm",  // active wave name within the category
  waveTick:     0,
  waveDur:      0,
  dropRate:     CFG.tickInterval,
  voteLastTick:      -9999,
  votes:             {},
  forceRate:         null,
  nextStructureTick: 0,   // game tick when next challenge structure spawns
};

// activeDrops: { x, y, z, block }
let activeDrops = [];

// colHeightCache: { [platformId]: { "x,z": lastLandY } }
// Lazily populated as blocks land. Used by dropBlock() to bias toward shorter columns.
const colHeightCache = {};

// platformState: { [platformId]: { playerUUID, playerName, nextChestTick } }
// nextChestTick = -1 means "not yet initialized" (platform just assigned, game may not be running)
let platformState = {};

// portalState: { netherBuilt: bool, endBuilt: bool }
let portalState = { netherBuilt: false, endBuilt: false };

// structureState: [{ x, y, z, type, tick }] — persistent list of all placed challenge structures
let structureState = [];

// structWeights: { [type]: runningWeight } — weighted anti-repeat / rarity dial for
// structure selection (v1.9.0). Persisted so the pity memory survives reloads.
let structWeights = {};

// Max challenge structures that can exist at once. Spawning halts at this cap.
// Phase ordering for minPhase comparisons
const PHASE_ORDER = ["early", "mid", "late", "end"];

// ─── PERSISTENCE ─────────────────────────────────────────────────────────────
const PROP_DROPS      = "ff:activeDrops";
const PROP_WAVE       = "ff:wave";
const PROP_TICK       = "ff:tick";
const PROP_PLATFORMS  = "ff:platforms";
const PROP_ADMINS     = "ff:admins";
const PROP_MUTED      = "ff:msgsMuted";
const PROP_PORTALS    = "ff:portals";
const PROP_STRUCTURES = "ff:structures";
const PROP_STRUCT_WEIGHTS = "ff:structWeights";

function saveDrops() {
  try {
    const data = activeDrops.map(d => ({ x: d.x, y: d.y, z: d.z, block: d.block }));
    world.setDynamicProperty(PROP_DROPS, JSON.stringify(data));
  } catch(_) {}
}

function loadDrops() {
  try {
    const dim  = getDim();
    const half = Math.floor(CFG.platformSize / 2);

    // Sweep blockDropY across all assigned platforms. Blocks added to activeDrops
    // after the last periodic save won't be in saved data, but they're always
    // sitting at blockDropY in the world — clear them so they don't stick.
    for (const idStr of Object.keys(platformState)) {
      const p = getPlatformById(parseInt(idStr));
      if (!p) continue;
      try {
        dim.runCommand(
          `fill ${p.cx - half} ${CFG.blockDropY} ${p.cz - half} ${p.cx + half - 1} ${CFG.blockDropY} ${p.cz + half - 1} minecraft:air`
        );
      } catch(_) {}
    }

    const raw = world.getDynamicProperty(PROP_DROPS);
    if (!raw) return;
    const data = JSON.parse(raw);
    activeDrops = [];
    for (const d of data) {
      if (d.y <= CFG.platformY + 1 || d.y > CFG.blockDropY) continue;
      // The saved Y can be stale by up to 60 blocks (periodic save every 20 ticks
      // × 3 blocks/tick), so the ghost block sits somewhere in [y-60, y]. Clear
      // only blocks matching the drop's own type in that window — landed terrain
      // of other types is untouched (full-column wipes previously ate stacks).
      const lo = Math.max(CFG.platformY + 1, d.y - 60);
      try {
        dim.runCommand(`fill ${d.x} ${lo} ${d.z} ${d.x} ${d.y} ${d.z} minecraft:air replace ${d.block}`);
      } catch(_) {}
      try { dim.runCommand(`setblock ${d.x} ${d.y} ${d.z} ${d.block}`); } catch(_) {}
      activeDrops.push({ x: d.x, y: d.y, z: d.z, block: d.block });
    }
    if (activeDrops.length > 0)
      broadcast(`§e[FF] Resumed ${activeDrops.length} block(s) in flight.`);
  } catch(_) { activeDrops = []; }
}

function saveWaveState() {
  try {
    world.setDynamicProperty(PROP_WAVE, JSON.stringify({
      category:          state.category,
      wave:              state.wave,
      waveTick:          state.waveTick,
      waveDur:           state.waveDur,
      nextStructureTick: state.nextStructureTick,
    }));
    world.setDynamicProperty(PROP_TICK, state.tick);
  } catch(_) {}
}

function loadWaveState() {
  try {
    const raw = world.getDynamicProperty(PROP_WAVE);
    if (raw) {
      const d                    = JSON.parse(raw);
      state.category             = d.category          ?? "calm";
      state.wave                 = d.wave               ?? "calm";
      state.waveTick             = d.waveTick           ?? 0;
      state.waveDur              = d.waveDur             ?? 0;
      state.nextStructureTick    = d.nextStructureTick  ?? 0;
    }
    state.tick = world.getDynamicProperty(PROP_TICK) ?? 0;
  } catch(_) {}
}

function savePlatformState() {
  try {
    world.setDynamicProperty(PROP_PLATFORMS, JSON.stringify(platformState));
  } catch(_) {}
}

function loadPlatformState() {
  try {
    const raw = world.getDynamicProperty(PROP_PLATFORMS);
    platformState = raw ? JSON.parse(raw) : {};
  } catch(_) { platformState = {}; }
}

function savePortalState() {
  try { world.setDynamicProperty(PROP_PORTALS, JSON.stringify(portalState)); } catch(_) {}
}
function loadPortalState() {
  try {
    const raw = world.getDynamicProperty(PROP_PORTALS);
    portalState = raw ? JSON.parse(raw) : { netherBuilt: false, endBuilt: false };
  } catch(_) { portalState = { netherBuilt: false, endBuilt: false }; }
}

function saveStructureState() {
  try { world.setDynamicProperty(PROP_STRUCTURES, JSON.stringify(structureState)); } catch(_) {}
}
function loadStructureState() {
  try {
    const raw = world.getDynamicProperty(PROP_STRUCTURES);
    structureState = raw ? JSON.parse(raw) : [];
  } catch(_) { structureState = []; }
}

function saveStructWeights() {
  try { world.setDynamicProperty(PROP_STRUCT_WEIGHTS, JSON.stringify(structWeights)); } catch(_) {}
}
function loadStructWeights() {
  try {
    const raw = world.getDynamicProperty(PROP_STRUCT_WEIGHTS);
    structWeights = raw ? JSON.parse(raw) : {};
  } catch(_) { structWeights = {}; }
}

// ─── UTILITIES ────────────────────────────────────────────────────────────────
function rand(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}
function pick(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}
function weightedPick(weights) {
  const total = weights.reduce((s, e) => s + e.w, 0);
  let r = Math.random() * total;
  for (const e of weights) { r -= e.w; if (r <= 0) return e.pool; }
  return weights[weights.length - 1].pool;
}
function broadcast(msg) {
  try { world.sendMessage(msg); } catch(_) {}
}
// Persisted set of admin player UUIDs. permissionLevel is undefined in this API
// version, so we maintain our own list via ff:admin add/remove.
let adminUUIDs = new Set();
function loadAdmins() {
  try {
    const raw = world.getDynamicProperty(PROP_ADMINS);
    adminUUIDs = new Set(raw ? JSON.parse(raw) : []);
  } catch(_) { adminUUIDs = new Set(); }
}
function saveAdmins() {
  try { world.setDynamicProperty(PROP_ADMINS, JSON.stringify([...adminUUIDs])); } catch(_) {}
}

let mutedAdminUUIDs = new Set();
function loadMutedAdmins() {
  try {
    const raw = world.getDynamicProperty(PROP_MUTED);
    mutedAdminUUIDs = new Set(raw ? JSON.parse(raw) : []);
  } catch(_) { mutedAdminUUIDs = new Set(); }
}
function saveMutedAdmins() {
  try { world.setDynamicProperty(PROP_MUTED, JSON.stringify([...mutedAdminUUIDs])); } catch(_) {}
}
function isAdmin(player) {
  return adminUUIDs.has(player.id);
}
// Sends a message only to online OPs — debug/status info.
// Uses PlayerPermissionLevel enum; falls back to manual UUID list if API returns undefined.
function adminMsg(msg) {
  for (const p of world.getAllPlayers()) {
    try {
      if (mutedAdminUUIDs.has(p.id)) continue;
      const lvl = p.playerPermissionLevel;
      const opByLevel = lvl !== undefined
        ? (lvl === PlayerPermissionLevel.Operator || lvl === PlayerPermissionLevel.Custom)
        : isAdmin(p);
      if (opByLevel) p.sendMessage(msg);
    } catch(_) {}
  }
}
function titleAll(title, subtitle) {
  for (const p of world.getAllPlayers()) {
    try {
      p.onScreenDisplay.setTitle(title, {
        subtitle: subtitle ?? "",
        fadeInDuration: 5, stayDuration: 60, fadeOutDuration: 20,
      });
    } catch(_) {}
  }
}
function isOp(player) {
  try {
    const lvl = player.playerPermissionLevel;
    if (lvl === undefined) {
      // API didn't expose the level — fall back to the persisted admin list.
      // Fail open ONLY while no admins are registered (bootstrap escape hatch),
      // otherwise every player would silently become an op.
      return isAdmin(player) || adminUUIDs.size === 0;
    }
    return lvl === PlayerPermissionLevel.Operator || lvl === PlayerPermissionLevel.Custom;
  } catch(_) { return isAdmin(player) || adminUUIDs.size === 0; }
}
function getDim() {
  return world.getDimension("overworld");
}
function findLandingY(dim, x, z) {
  for (let y = CFG.platformY + 1; y <= CFG.blockDropY; y++) {
    try {
      const b = dim.getBlock({ x, y, z });
      if (b && b.typeId === "minecraft:air") return y;
    } catch(_) { return CFG.platformY + 1; }
  }
  return CFG.platformY + 1;
}
// A block counts as footing if it exists, isn't air, and isn't liquid.
function isFooting(b) { return !!b && !b.isAir && !b.isLiquid; }

// Find a standing/chest spot inside a FLOATING structure: scan a column from the
// structure base upward for the first Y with solid footing below and air at the spot
// plus headroom above. Returns the Y, or null if the column has no such surface.
// (findLandingY can't be used here — it finds the first AIR from platformY up, which
// for a floating island is the void *below* the structure.)
function findStructSurface(dim, x, z, baseY, maxY) {
  for (let y = baseY; y <= maxY; y++) {
    try {
      const below = dim.getBlock({ x, y: y - 1, z });
      const at    = dim.getBlock({ x, y,         z });
      const above = dim.getBlock({ x, y: y + 1, z });
      if (!below || !at || !above) continue;           // unloaded slice — skip
      if (isFooting(below) && at.isAir && above.isAir) return y;
    } catch(_) { /* keep scanning */ }
  }
  return null;
}

// Fallback when a structure has no open interior surface (e.g. a solid build):
// return one block above the highest solid in the column, so the chest sits on top.
function findStructRoof(dim, x, z, baseY, maxY) {
  for (let y = maxY; y >= baseY; y--) {
    try {
      const b = dim.getBlock({ x, y, z });
      if (isFooting(b)) return y + 1;
    } catch(_) {}
  }
  return baseY;
}

// Columns tried (in order) when looking for a chest surface: center first, then
// nearby rings — authors are asked to keep the center open, this just adds slack.
const CHEST_PROBE_OFFSETS = [[0,0],[2,0],[-2,0],[0,2],[0,-2],[3,3],[-3,3],[3,-3],[-3,-3],[5,0],[-5,0],[0,5],[0,-5]];

function getPlatformById(id) {
  return PLATFORMS.find(p => p.id === id) ?? null;
}
function getPlayerByName(name) {
  for (const p of world.getAllPlayers()) {
    if (p.name.toLowerCase() === name.toLowerCase()) return p;
  }
  return null;
}

// ─── PLATFORM FUNCTIONS ───────────────────────────────────────────────────────

// Wipe the vanilla void-world spawn stone across the entire 9-platform footprint.
// Called once, just before platform 1 is built for the first time.
function clearVoidSpawnPlatform() {
  const dim  = getDim();
  const half = Math.floor(CFG.platformSize / 2);
  let minX = Infinity, maxX = -Infinity, minZ = Infinity, maxZ = -Infinity;
  for (const p of PLATFORMS) {
    minX = Math.min(minX, p.cx - half);
    maxX = Math.max(maxX, p.cx + half - 1);
    minZ = Math.min(minZ, p.cz - half);
    maxZ = Math.max(maxZ, p.cz + half - 1);
  }
  // 102x102x1 = 10,404 blocks — under the 32,768 fill limit, single command.
  try {
    dim.runCommand(`fill ${minX} ${CFG.platformY} ${minZ} ${maxX} ${CFG.platformY} ${maxZ} minecraft:air`);
  } catch(_) {}
}
function buildPlatformById(platform) {
  const dim  = getDim();
  const half = Math.floor(CFG.platformSize / 2);
  const x1 = platform.cx - half, x2 = platform.cx + half - 1;
  const z1 = platform.cz - half, z2 = platform.cz + half - 1;
  const run = (cmd) => { try { dim.runCommand(cmd); } catch(_) {} };
  // Clear 4 blocks BELOW the platform only — never above (would wipe landed blocks)
  run(`fill ${x1} ${CFG.platformY - 4} ${z1} ${x2} ${CFG.platformY - 1} ${z2} minecraft:air`);
  run(`fill ${x1} ${CFG.platformY} ${z1} ${x2} ${CFG.platformY} ${z2} ${CFG.platformBlock}`);
}

function clearAbovePlatformById(platform) {
  const dim  = getDim();
  const half = Math.floor(CFG.platformSize / 2);
  const x1 = platform.cx - half, x2 = platform.cx + half - 1;
  const z1 = platform.cz - half, z2 = platform.cz + half - 1;
  // 32x32x32 = 32,768 blocks = exactly the max fill volume per command.
  // 264 layers → 9 fills instead of ~270,000 setblocks.
  for (let y = CFG.platformY + 1; y <= CFG.blockDropY; y += 32) {
    const yTop = Math.min(y + 31, CFG.blockDropY);
    try { dim.runCommand(`fill ${x1} ${y} ${z1} ${x2} ${yTop} ${z2} minecraft:air`); } catch(_) {}
  }
}

// Rebuild any assigned platform whose center bedrock is confirmed missing.
// IMPORTANT: only rebuild when getBlock() returns a defined block with the wrong type.
// If the chunk is unloaded, getBlock() returns undefined — do NOT rebuild in that case,
// as it would clear Y=-63 and Y=-62 across the entire platform, wiping all landed blocks.
function ensurePlatforms() {
  for (const idStr of Object.keys(platformState)) {
    const platform = getPlatformById(parseInt(idStr));
    if (!platform) continue;
    try {
      const center = getDim().getBlock({ x: platform.cx, y: CFG.platformY, z: platform.cz });
      if (center !== undefined && center.typeId !== CFG.platformBlock) {
        adminMsg(`§8[FF-OP] Platform ${platform.id} bedrock missing — rebuilding`);
        buildPlatformById(platform);
      }
    } catch(_) {}
  }
}

// ─── GAP FILL ────────────────────────────────────────────────────────────────
// Fills the 3-block gap segments directly adjacent to each ASSIGNED platform.
// Only fills around existing platforms — no dangling arms into void.
// Safe to call repeatedly (idempotent bedrock placement).
function buildGapBedrock() {
  const dim = getDim();
  const gy  = CFG.platformY + 1;              // y=-63
  const h   = Math.floor(CFG.platformSize / 2); // 16
  // h     = 16 → platform spans cx-h..cx+h-1
  // gap   = 3 blocks wide
  // east edge at cx+h (16), east gap x=[cx+h, cx+h+2]
  // west edge at cx-h (-16), west gap x=[cx-h-3, cx-h-1] = [cx-19, cx-17]
  // south edge at cz+h (16), south gap z=[cz+h, cz+h+2]
  // north edge at cz-h (-16), north gap z=[cz-h-3, cz-h-1] = [cz-19, cz-17]
  for (const idStr of Object.keys(platformState)) {
    const p = getPlatformById(parseInt(idStr));
    if (!p) continue;
    const { cx, cz } = p;
    const run = (cmd) => { try { dim.runCommand(cmd); } catch(_) {} };
    const gy_ = gy; // alias so template literals stay readable
    // Four edge segments (3 wide × 32 deep)
    run(`fill ${cx+h}   ${gy_} ${cz-h}   ${cx+h+2} ${gy_} ${cz+h-1} minecraft:bedrock`); // east
    run(`fill ${cx-h-3} ${gy_} ${cz-h}   ${cx-h-1} ${gy_} ${cz+h-1} minecraft:bedrock`); // west
    run(`fill ${cx-h}   ${gy_} ${cz+h}   ${cx+h-1} ${gy_} ${cz+h+2} minecraft:bedrock`); // south
    run(`fill ${cx-h}   ${gy_} ${cz-h-3} ${cx+h-1} ${gy_} ${cz-h-1} minecraft:bedrock`); // north
    // Four corner pieces (3×3) — covered by any adjacent platform that shares the corner
    run(`fill ${cx+h}   ${gy_} ${cz+h}   ${cx+h+2} ${gy_} ${cz+h+2} minecraft:bedrock`); // SE
    run(`fill ${cx+h}   ${gy_} ${cz-h-3} ${cx+h+2} ${gy_} ${cz-h-1} minecraft:bedrock`); // NE
    run(`fill ${cx-h-3} ${gy_} ${cz+h}   ${cx-h-1} ${gy_} ${cz+h+2} minecraft:bedrock`); // SW
    run(`fill ${cx-h-3} ${gy_} ${cz-h-3} ${cx-h-1} ${gy_} ${cz-h-1} minecraft:bedrock`); // NW
  }
}

// ─── PORTAL PLATFORMS ────────────────────────────────────────────────────────

// Uses /tickingarea to force-load the chunk regardless of player position,
// then defers block placement 5 ticks so the area is ready to accept writes.
// Works identically for ff:portal and the automatic day-10 trigger.
function buildNetherPortalPlatform() {
  const dim = getDim();
  const cx  = PORTAL_NETHER.cx;
  const cz  = PORTAL_NETHER.cz;
  const py  = CFG.platformY;
  const sy  = py + 1;  // surface level (one above bedrock floor)

  // Force-load chunk; kept permanently so portal area stays ticking
  try { dim.runCommand(`tickingarea add ${cx-14} ${py} ${cz-14} ${cx+13} ${py+20} ${cz+13} ff_nether`); } catch(_) {}

  // Phase 1 \u2014 floor and base terrain (5-tick delay for chunk load)
  system.runTimeout(() => {
    const run = (cmd) => { try { dim.runCommand(cmd); } catch(_) {} };

    // \u2500\u2500 Base floor (28\u00d728) \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
    // Outer ring: nether brick (2 thick)
    run(`fill ${cx-14} ${py} ${cz-14} ${cx+13} ${py} ${cz+13} minecraft:nether_brick`);
    // Second ring: cracked nether brick
    run(`fill ${cx-12} ${py} ${cz-12} ${cx+11} ${py} ${cz+11} minecraft:cracked_nether_bricks`);
    // Inner border: blackstone
    run(`fill ${cx-10} ${py} ${cz-10} ${cx+9}  ${py} ${cz+9}  minecraft:blackstone`);
    // Inner fill: netherrack
    run(`fill ${cx-8}  ${py} ${cz-8}  ${cx+7}  ${py} ${cz+7}  minecraft:netherrack`);
    // Center magma cross (altar feel)
    run(`fill ${cx-4}  ${py} ${cz-1}  ${cx+5}  ${py} ${cz+2}  minecraft:magma`);
    run(`fill ${cx-1}  ${py} ${cz-4}  ${cx+2}  ${py} ${cz+5}  minecraft:magma`);
    // Lava pools (2\u00d72) in four quadrants, inset from edge
    run(`fill ${cx-12} ${py} ${cz-12} ${cx-11} ${py} ${cz-11} minecraft:lava`);
    run(`fill ${cx+10} ${py} ${cz-12} ${cx+11} ${py} ${cz-11} minecraft:lava`);
    run(`fill ${cx-12} ${py} ${cz+10} ${cx-11} ${py} ${cz+11} minecraft:lava`);
    run(`fill ${cx+10} ${py} ${cz+10} ${cx+11} ${py} ${cz+11} minecraft:lava`);
    // Soul sand gardens (4\u00d74 in each quadrant)
    run(`fill ${cx-8} ${py} ${cz-8} ${cx-5} ${py} ${cz-5} minecraft:soul_sand`);
    run(`fill ${cx+4} ${py} ${cz-8} ${cx+7} ${py} ${cz-5} minecraft:soul_sand`);
    run(`fill ${cx-8} ${py} ${cz+4} ${cx-5} ${py} ${cz+7} minecraft:soul_sand`);
    run(`fill ${cx+4} ${py} ${cz+4} ${cx+7} ${py} ${cz+7} minecraft:soul_sand`);
    // Soul soil accent corners of soul sand patches
    run(`setblock ${cx-8} ${py} ${cz-8} minecraft:soul_soil`);
    run(`setblock ${cx+7} ${py} ${cz-8} minecraft:soul_soil`);
    run(`setblock ${cx-8} ${py} ${cz+7} minecraft:soul_soil`);
    run(`setblock ${cx+7} ${py} ${cz+7} minecraft:soul_soil`);
  }, 5);

  // Phase 2 \u2014 vegetation, lighting, wall bases (10-tick delay)
  system.runTimeout(() => {
    const run = (cmd) => { try { dim.runCommand(cmd); } catch(_) {} };

    // Nether wart on soul sand gardens
    run(`setblock ${cx-7} ${sy} ${cz-7} minecraft:nether_wart`);
    run(`setblock ${cx-6} ${sy} ${cz-6} minecraft:nether_wart`);
    run(`setblock ${cx+6} ${sy} ${cz-7} minecraft:nether_wart`);
    run(`setblock ${cx+5} ${sy} ${cz-6} minecraft:nether_wart`);
    run(`setblock ${cx-7} ${sy} ${cz+6} minecraft:nether_wart`);
    run(`setblock ${cx-6} ${sy} ${cz+5} minecraft:nether_wart`);
    run(`setblock ${cx+6} ${sy} ${cz+6} minecraft:nether_wart`);
    run(`setblock ${cx+5} ${sy} ${cz+5} minecraft:nether_wart`);
    // Wither roses scattered on soul sand
    run(`setblock ${cx-8} ${sy} ${cz-6} minecraft:wither_rose`);
    run(`setblock ${cx+7} ${sy} ${cz-6} minecraft:wither_rose`);
    run(`setblock ${cx-8} ${sy} ${cz+5} minecraft:wither_rose`);
    run(`setblock ${cx+7} ${sy} ${cz+5} minecraft:wither_rose`);
    // Shroomlight accent lights around magma cross
    run(`setblock ${cx-5} ${sy} ${cz}   minecraft:shroomlight`);
    run(`setblock ${cx+6} ${sy} ${cz}   minecraft:shroomlight`);
    run(`setblock ${cx}   ${sy} ${cz-5} minecraft:shroomlight`);
    run(`setblock ${cx}   ${sy} ${cz+6} minecraft:shroomlight`);
    // Crying obsidian border accents on blackstone ring
    run(`setblock ${cx-10} ${py} ${cz}   minecraft:crying_obsidian`);
    run(`setblock ${cx+9}  ${py} ${cz}   minecraft:crying_obsidian`);
    run(`setblock ${cx}    ${py} ${cz-10} minecraft:crying_obsidian`);
    run(`setblock ${cx}    ${py} ${cz+9}  minecraft:crying_obsidian`);
  }, 10);

  // Phase 3 \u2014 corner fortress towers (15-tick delay)
  system.runTimeout(() => {
    const run = (cmd) => { try { dim.runCommand(cmd); } catch(_) {} };

    // Four corner towers at approximately \u00b111 from center \u2014 nether brick walls 7 high
    for (const [ox, oz] of [[-11,-11],[10,-11],[-11,10],[10,10]]) {
      const tx = cx + ox;
      const tz = cz + oz;
      // Tower base footprint 4\u00d74
      run(`fill ${tx} ${py} ${tz} ${tx+3} ${py} ${tz+3} minecraft:nether_brick`);
      // Tower walls (hollow box, 7 high)
      run(`fill ${tx}   ${sy}   ${tz}   ${tx+3} ${sy+6} ${tz}   minecraft:nether_brick`);
      run(`fill ${tx}   ${sy}   ${tz+3} ${tx+3} ${sy+6} ${tz+3} minecraft:nether_brick`);
      run(`fill ${tx}   ${sy}   ${tz}   ${tx}   ${sy+6} ${tz+3} minecraft:nether_brick`);
      run(`fill ${tx+3} ${sy}   ${tz}   ${tx+3} ${sy+6} ${tz+3} minecraft:nether_brick`);
      // Cracked nether brick at base of walls for ruined look
      run(`fill ${tx}   ${sy}   ${tz}   ${tx+3} ${sy+1} ${tz+3} minecraft:cracked_nether_bricks`);
      // Nether brick fence crenellation on top
      run(`setblock ${tx}   ${sy+7} ${tz}   minecraft:nether_brick_fence`);
      run(`setblock ${tx+2} ${sy+7} ${tz}   minecraft:nether_brick_fence`);
      run(`setblock ${tx}   ${sy+7} ${tz+2} minecraft:nether_brick_fence`);
      run(`setblock ${tx+2} ${sy+7} ${tz+2} minecraft:nether_brick_fence`);
      // Glowstone on top of each tower
      run(`fill ${tx}   ${sy+7} ${tz}   ${tx+3} ${sy+7} ${tz+3} minecraft:glowstone`);
      run(`setblock ${tx+1} ${sy+8} ${tz+1} minecraft:glowstone`);
      run(`setblock ${tx+2} ${sy+8} ${tz+1} minecraft:glowstone`);
      // Chain hanging from underside of glowstone (decor)
      run(`setblock ${tx+1} ${sy+6} ${tz+1} minecraft:chain`);
    }
  }, 15);

  // Phase 4 \u2014 wall ruins connecting the towers (20-tick delay)
  system.runTimeout(() => {
    const run = (cmd) => { try { dim.runCommand(cmd); } catch(_) {} };

    // Ruined walls between towers \u2014 2 wide, 4 high, broken gaps left intentionally
    // North wall (between NW and NE towers)
    run(`fill ${cx-7} ${sy} ${cz-11} ${cx-2} ${sy+3} ${cz-11} minecraft:nether_brick`);
    run(`fill ${cx+1} ${sy} ${cz-11} ${cx+6} ${sy+3} ${cz-11} minecraft:nether_brick`);
    // South wall
    run(`fill ${cx-7} ${sy} ${cz+10} ${cx-2} ${sy+3} ${cz+10} minecraft:nether_brick`);
    run(`fill ${cx+1} ${sy} ${cz+10} ${cx+6} ${sy+3} ${cz+10} minecraft:nether_brick`);
    // West wall
    run(`fill ${cx-11} ${sy} ${cz-7} ${cx-11} ${sy+3} ${cz-2} minecraft:nether_brick`);
    run(`fill ${cx-11} ${sy} ${cz+1} ${cx-11} ${sy+3} ${cz+6} minecraft:nether_brick`);
    // East wall
    run(`fill ${cx+10} ${sy} ${cz-7} ${cx+10} ${sy+3} ${cz-2} minecraft:nether_brick`);
    run(`fill ${cx+10} ${sy} ${cz+1} ${cx+10} ${sy+3} ${cz+6} minecraft:nether_brick`);
    // Wall tops with fence crenellations
    run(`fill ${cx-7} ${sy+4} ${cz-11} ${cx-2} ${sy+4} ${cz-11} minecraft:nether_brick_fence`);
    run(`fill ${cx+1} ${sy+4} ${cz-11} ${cx+6} ${sy+4} ${cz-11} minecraft:nether_brick_fence`);
    run(`fill ${cx-7} ${sy+4} ${cz+10} ${cx-2} ${sy+4} ${cz+10} minecraft:nether_brick_fence`);
    run(`fill ${cx+1} ${sy+4} ${cz+10} ${cx+6} ${sy+4} ${cz+10} minecraft:nether_brick_fence`);
    // Chains hanging from wall gaps (atmospheric)
    run(`setblock ${cx-1} ${sy+2} ${cz-11} minecraft:chain`);
    run(`setblock ${cx}   ${sy+1} ${cz-11} minecraft:chain`);
    run(`setblock ${cx-1} ${sy+2} ${cz+10} minecraft:chain`);
    run(`setblock ${cx}   ${sy+1} ${cz+10} minecraft:chain`);
  }, 20);

  // Phase 5 \u2014 portal altar and obsidian gate (25-tick delay)
  system.runTimeout(() => {
    const run = (cmd) => { try { dim.runCommand(cmd); } catch(_) {} };

    // Raised obsidian altar platform under the portal (3\u00d76 raised 1 block)
    run(`fill ${cx-2} ${sy}   ${cz-1} ${cx+3} ${sy}   ${cz+1} minecraft:obsidian`);
    // Portal frame: 6 wide \u00d7 5 tall obsidian (inner 4\u00d73 portal space)
    run(`fill ${cx-2} ${sy+1} ${cz}   ${cx+3} ${sy+1} ${cz}   minecraft:obsidian`);
    run(`fill ${cx-2} ${sy+5} ${cz}   ${cx+3} ${sy+5} ${cz}   minecraft:obsidian`);
    run(`fill ${cx-2} ${sy+1} ${cz}   ${cx-2} ${sy+5} ${cz}   minecraft:obsidian`);
    run(`fill ${cx+3} ${sy+1} ${cz}   ${cx+3} ${sy+5} ${cz}   minecraft:obsidian`);
    // Crying obsidian accent blocks on frame corners
    run(`setblock ${cx-2} ${sy+1} ${cz} minecraft:crying_obsidian`);
    run(`setblock ${cx+3} ${sy+1} ${cz} minecraft:crying_obsidian`);
    run(`setblock ${cx-2} ${sy+5} ${cz} minecraft:crying_obsidian`);
    run(`setblock ${cx+3} ${sy+5} ${cz} minecraft:crying_obsidian`);
    // Portal fill (4 wide \u00d7 3 tall inner space)
    run(`fill ${cx-1} ${sy+2} ${cz} ${cx+2} ${sy+4} ${cz} minecraft:portal ["portal_axis"="z"]`);
    // Shroomlight pillars flanking the portal
    run(`fill ${cx-3} ${sy}   ${cz}   ${cx-3} ${sy+3} ${cz}   minecraft:shroomlight`);
    run(`fill ${cx+4} ${sy}   ${cz}   ${cx+4} ${sy+3} ${cz}   minecraft:shroomlight`);
    // Nether brick stair-style decor around altar base
    run(`setblock ${cx-2} ${sy} ${cz-1} minecraft:nether_brick_stairs ["weirdo_direction"=3]`);
    run(`setblock ${cx-2} ${sy} ${cz+1} minecraft:nether_brick_stairs ["weirdo_direction"=2]`);
    run(`setblock ${cx+3} ${sy} ${cz-1} minecraft:nether_brick_stairs ["weirdo_direction"=1]`);
    run(`setblock ${cx+3} ${sy} ${cz+1} minecraft:nether_brick_stairs ["weirdo_direction"=0]`);
    // Chains above portal frame
    run(`setblock ${cx}   ${sy+6} ${cz} minecraft:chain`);
    run(`setblock ${cx+1} ${sy+6} ${cz} minecraft:chain`);

    portalState.netherBuilt = true;
    savePortalState();
    broadcast("\u00a7c[FF] \u00a7l\u2605\u00a7r \u00a7cA Nether Fortress has risen to the North! Day 20 reached.");
    adminMsg(`\u00a78[FF-OP] Nether portal platform built at (${cx}, ${py}, ${cz})`);
  }, 25);
}

function buildEndPortalPlatform() {
  const dim = getDim();
  const cx  = PORTAL_END.cx;
  const cz  = PORTAL_END.cz;
  const py  = CFG.platformY;
  const sy  = py + 1;  // surface level

  try { dim.runCommand(`tickingarea add ${cx-14} ${py} ${cz-14} ${cx+13} ${py+25} ${cz+13} ff_end`); } catch(_) {}

  // Phase 1 \u2014 floor layout (5-tick delay)
  system.runTimeout(() => {
    const run = (cmd) => { try { dim.runCommand(cmd); } catch(_) {} };

    // \u2500\u2500 Base floor (28\u00d728) \u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500\u2500
    // Outer ring: end stone bricks (2 thick)
    run(`fill ${cx-14} ${py} ${cz-14} ${cx+13} ${py} ${cz+13} minecraft:end_bricks`);
    // Second ring: polished blackstone (contrast trim)
    run(`fill ${cx-12} ${py} ${cz-12} ${cx+11} ${py} ${cz+11} minecraft:polished_blackstone`);
    // Third ring: purpur block
    run(`fill ${cx-10} ${py} ${cz-10} ${cx+9}  ${py} ${cz+9}  minecraft:purpur_block`);
    // Inner fill: end stone
    run(`fill ${cx-8}  ${py} ${cz-8}  ${cx+7}  ${py} ${cz+7}  minecraft:end_stone`);
    // Central raised altar (4\u00d74, one block higher) for the portal room
    run(`fill ${cx-3}  ${sy}  ${cz-3}  ${cx+4}  ${sy}  ${cz+4}  minecraft:purpur_pillar`);
    // End rod lighting scattered on inner floor
    run(`setblock ${cx-7} ${sy} ${cz-7} minecraft:end_rod`);
    run(`setblock ${cx+6} ${sy} ${cz-7} minecraft:end_rod`);
    run(`setblock ${cx-7} ${sy} ${cz+6} minecraft:end_rod`);
    run(`setblock ${cx+6} ${sy} ${cz+6} minecraft:end_rod`);
    run(`setblock ${cx-5} ${sy} ${cz}   minecraft:end_rod`);
    run(`setblock ${cx+5} ${sy} ${cz}   minecraft:end_rod`);
    run(`setblock ${cx}   ${sy} ${cz-5} minecraft:end_rod`);
    run(`setblock ${cx}   ${sy} ${cz+5} minecraft:end_rod`);
    // Obsidian corner blocks on purpur ring for dramatic contrast
    for (const [ox, oz] of [[-10,-10],[9,-10],[-10,9],[9,9]]) {
      run(`setblock ${cx+ox} ${py} ${cz+oz} minecraft:obsidian`);
    }
  }, 5);

  // Phase 2 \u2014 corner obsidian spires (10-tick delay)
  system.runTimeout(() => {
    const run = (cmd) => { try { dim.runCommand(cmd); } catch(_) {} };

    // Four massive obsidian spires at corners (2\u00d72 base, 10 blocks tall)
    for (const [ox, oz] of [[-12,-12],[10,-12],[-12,10],[10,10]]) {
      const tx = cx + ox;
      const tz = cz + oz;
      // Spire shaft
      run(`fill ${tx} ${py} ${tz} ${tx+1} ${sy+9} ${tz+1} minecraft:obsidian`);
      // Crying obsidian accent halfway up
      run(`fill ${tx} ${sy+3} ${tz} ${tx+1} ${sy+4} ${tz+1} minecraft:crying_obsidian`);
      // Purpur cap at top
      run(`fill ${tx} ${sy+10} ${tz} ${tx+1} ${sy+10} ${tz+1} minecraft:purpur_pillar`);
      // End rods on top
      run(`setblock ${tx}   ${sy+11} ${tz}   minecraft:end_rod`);
      run(`setblock ${tx+1} ${sy+11} ${tz}   minecraft:end_rod`);
      run(`setblock ${tx}   ${sy+11} ${tz+1} minecraft:end_rod`);
      run(`setblock ${tx+1} ${sy+11} ${tz+1} minecraft:end_rod`);
    }
    // Midpoint purpur pillars between spires (smaller, varied heights)
    for (const [ox, oz, h] of [[-1,-13,5],[1,-13,7],[-1,12,5],[1,12,7],[-13,-1,6],[-13,1,4],[12,-1,6],[12,1,4]]) {
      run(`fill ${cx+ox} ${py} ${cz+oz} ${cx+ox} ${sy+h} ${cz+oz} minecraft:purpur_pillar`);
      run(`setblock ${cx+ox} ${sy+h+1} ${cz+oz} minecraft:end_rod`);
    }
  }, 10);

  // Phase 3 \u2014 chorus-like formations and inner structures (15-tick delay)
  system.runTimeout(() => {
    const run = (cmd) => { try { dim.runCommand(cmd); } catch(_) {} };

    // Chorus-style purpur column clusters (scattered, varied heights)
    const clusters = [
      [-6,-6,4], [5,-6,6], [-6,5,5], [5,5,3],
      [-8,-2,3], [7,-2,5], [-8,1,4], [7,1,3],
      [-2,-8,5], [1,-8,3], [-2,7,4], [1,7,6],
    ];
    for (const [ox, oz, h] of clusters) {
      run(`fill ${cx+ox} ${sy} ${cz+oz} ${cx+ox} ${sy+h} ${cz+oz} minecraft:purpur_pillar`);
      run(`setblock ${cx+ox} ${sy+h+1} ${cz+oz} minecraft:end_rod`);
      // Side branches for chorus-plant silhouette (1 block off main column)
      if (h >= 3) {
        run(`setblock ${cx+ox+1} ${sy+h-1} ${cz+oz} minecraft:purpur_pillar`);
        run(`setblock ${cx+ox-1} ${sy+h-2} ${cz+oz} minecraft:purpur_pillar`);
      }
    }
    // Ender chests as decorative elements (4 placed around inner area)
    run(`setblock ${cx-6} ${sy} ${cz-4} minecraft:ender_chest`);
    run(`setblock ${cx+5} ${sy} ${cz-4} minecraft:ender_chest`);
    run(`setblock ${cx-6} ${sy} ${cz+3} minecraft:ender_chest`);
    run(`setblock ${cx+5} ${sy} ${cz+3} minecraft:ender_chest`);
  }, 15);

  // Phase 4 \u2014 portal room on raised altar (20-tick delay)
  system.runTimeout(() => {
    const run = (cmd) => { try { dim.runCommand(cmd); } catch(_) {} };

    const ry = sy + 1;  // raised altar surface (py + 2)

    // Portal room walls on altar: 8\u00d78 outer, purpur pillar
    run(`fill ${cx-3} ${ry} ${cz-3} ${cx+4} ${ry} ${cz-3} minecraft:purpur_pillar`);
    run(`fill ${cx-3} ${ry} ${cz+4} ${cx+4} ${ry} ${cz+4} minecraft:purpur_pillar`);
    run(`fill ${cx-3} ${ry} ${cz-3} ${cx-3} ${ry} ${cz+4} minecraft:purpur_pillar`);
    run(`fill ${cx+4} ${ry} ${cz-3} ${cx+4} ${ry} ${cz+4} minecraft:purpur_pillar`);
    // Portal room corner pillars: 5 high obsidian
    for (const [ox, oz] of [[-3,-3],[4,-3],[-3,4],[4,4]]) {
      run(`fill ${cx+ox} ${ry} ${cz+oz} ${cx+ox} ${ry+5} ${cz+oz} minecraft:obsidian`);
    }
    // 12 end portal frames \u2014 3 per side, arranged around 3\u00d73 interior
    for (let x = cx-1; x <= cx+1; x++)
      run(`setblock ${x} ${ry} ${cz-2} minecraft:end_portal_frame ["end_portal_eye_bit"=true,"minecraft:cardinal_direction"="south"]`);
    for (let x = cx-1; x <= cx+1; x++)
      run(`setblock ${x} ${ry} ${cz+2} minecraft:end_portal_frame ["end_portal_eye_bit"=true,"minecraft:cardinal_direction"="north"]`);
    for (let z = cz-1; z <= cz+1; z++)
      run(`setblock ${cx-2} ${ry} ${z} minecraft:end_portal_frame ["end_portal_eye_bit"=true,"minecraft:cardinal_direction"="east"]`);
    for (let z = cz-1; z <= cz+1; z++)
      run(`setblock ${cx+2} ${ry} ${z} minecraft:end_portal_frame ["end_portal_eye_bit"=true,"minecraft:cardinal_direction"="west"]`);
    // End portal fill (3\u00d73 interior)
    run(`fill ${cx-1} ${ry} ${cz-1} ${cx+1} ${ry} ${cz+1} minecraft:end_portal`);
    // End rods as pillars inside room at corners
    run(`setblock ${cx-3} ${ry+1} ${cz-3} minecraft:end_rod`);
    run(`setblock ${cx+4} ${ry+1} ${cz-3} minecraft:end_rod`);
    run(`setblock ${cx-3} ${ry+1} ${cz+4} minecraft:end_rod`);
    run(`setblock ${cx+4} ${ry+1} ${cz+4} minecraft:end_rod`);
    // Ceiling of portal room: purpur slab canopy + end rods pointing down
    run(`fill ${cx-3} ${ry+5} ${cz-3} ${cx+4} ${ry+5} ${cz+4} minecraft:purpur_block`);
    run(`setblock ${cx}   ${ry+4} ${cz}   minecraft:end_rod`);
    run(`setblock ${cx+1} ${ry+4} ${cz}   minecraft:end_rod`);
    run(`setblock ${cx}   ${ry+4} ${cz+1} minecraft:end_rod`);
    run(`setblock ${cx+1} ${ry+4} ${cz+1} minecraft:end_rod`);

    portalState.endBuilt = true;
    savePortalState();
    broadcast("\u00a75[FF] \u00a7l\u2605\u00a7r \u00a75An End City Ruin has materialized to the South! Day 30 reached.");
    adminMsg(`\u00a78[FF-OP] End portal platform built at (${cx}, ${py}, ${cz})`);
  }, 25);
}

// ─── CHALLENGE STRUCTURES ─────────────────────────────────────────────────────
// Floating island structures that spawn at random intervals in concentric rings
// around the platform grid (radius 65-300 from center, random Y). Each has a
// themed build, mobs to fight, and a loot chest scaled to lootPhase().
//
// Spawn interval: 800-1600 game ticks (~2.7-5.3 min) between spawns.
// Placement ring: cos/sin from center, per-ring radius band, Y = platformY + 15-75.
// Persistence: ff:structures dynamic property; structures never despawn.
// Rings expand outward as each one fills. New structures always spawn in the
// innermost ring that still has capacity. Capacity per ring × 4 rings = 32 total.

const STRUCT_SPAWN_MIN = 800;
const STRUCT_SPAWN_MAX = 1600;

// id: used for persistence + reporting. minRadius/maxRadius: XZ distance from world
// center (0,0). Rings no longer carry a count capacity — placement is now SPATIAL
// (v1.8.1): a structure goes in the innermost ring it physically fits, overflowing
// outward when an inner band is packed. Bands widened in v1.8.1 because .mcstructure
// builds can be much larger than the old hand-built ±13 footprints.
const STRUCT_RINGS = [
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
const STRUCT_PAD            = 5;
const PLATFORM_CLEAR_RADIUS = 85;
const DEFAULT_FOOT_R        = 22;

// Hard total cap. Geometry may prevent reaching it if the world is packed with very
// large structures — that's intentional; the spawner just defers when there's no room.
const MAX_STRUCTURES = 32;

// Proximity mob spawning (v1.8.4). Structure guards spawn ONLY while a player is
// within STRUCT_MOB_RADIUS, refilling toward STRUCT_MOB_CAP at most once every
// STRUCT_MOB_COOLDOWN game-ticks. They are non-persistent, so they despawn naturally
// when the player leaves and idle structures cost nothing. (gameTick runs every
// CFG.tickInterval ticks, so one game-tick ≈ 0.2s.)
const STRUCT_MOB_RADIUS   = 40;   // activation distance from structure center (blocks, 3D)
const STRUCT_MOB_CAP      = 5;    // max concurrent guards per structure
const STRUCT_MOB_COOLDOWN = 40;   // game-ticks between refills (~8s)
const STRUCT_MOB_CHECK    = 10;   // run the proximity sweep this often (~2s)

// CHALLENGE_STRUCT_DEFS is imported at the top of this file from ./structures/index.js.
// Each structure (its data + build function OR structureId) lives in its own file in
// that folder; add new ones by following the instructions in structures/index.js.

// Bounding radius (half-diagonal) of a structure's XZ footprint. Native structures
// read their .mcstructure size; legacy build() structures use DEFAULT_FOOT_R.
function structFootprint(nativeStruct) {
  if (!nativeStruct) return DEFAULT_FOOT_R;
  const sz = nativeStruct.size;
  return Math.ceil(Math.max(sz.x, sz.z) * 0.71);
}

// ─── STRUCTURE WEIGHTED PITY (v1.9.0) ──────────────────────────────────────────
// Anti-repeat + rarity dial. Each def carries an optional baseWeight (default
// DEFAULT_STRUCT_WEIGHT) setting its relative frequency. A running weight per type
// lives in structWeights: on each spawn the chosen type drops to 0 and every other
// AVAILABLE type gains its own baseWeight, so commons recover fast and rares stay
// rare. The selection is weighted by the current running weights, so a type just
// picked can't be chosen again until it accrues weight back. Persisted across reloads.
const DEFAULT_STRUCT_WEIGHT = 10;

function baseWeightOf(def) {
  const w = def.baseWeight;
  return (typeof w === "number" && w > 0) ? w : DEFAULT_STRUCT_WEIGHT;
}

// Weighted selection over `avail` (already phase-filtered). Seeds any not-yet-tracked
// type (e.g. one that just unlocked via minPhase) to the current average so it's
// neither starved nor instantly favored. Does NOT mutate pity — commit that only after
// a placement actually succeeds (see commitStructurePity). Falls back to uniform when
// every weight is 0. Returns the chosen def (or null on empty input).
function pickWeightedStructure(avail) {
  if (avail.length === 0) return null;
  if (avail.length === 1) return avail[0];

  const tracked = avail.filter(d => structWeights[d.type] !== undefined);
  const avg = tracked.length
    ? tracked.reduce((s, d) => s + structWeights[d.type], 0) / tracked.length
    : 0;
  for (const d of avail) {
    if (structWeights[d.type] === undefined)
      structWeights[d.type] = avg > 0 ? Math.round(avg) : baseWeightOf(d);
  }

  const total = avail.reduce((s, d) => s + Math.max(0, structWeights[d.type]), 0);
  if (total <= 0) return pick(avail);

  let r = Math.random() * total;
  for (const d of avail) {
    r -= Math.max(0, structWeights[d.type]);
    if (r <= 0) return d;
  }
  return avail[avail.length - 1];
}

// Apply the pity update once a structure is confirmed placed: chosen type -> 0, every
// other available type climbs by its baseWeight. Safe whether or not `chosen` is in
// `avail` (a forced admin spawn of a gated type still zeroes its own weight).
function commitStructurePity(chosen, avail) {
  for (const d of avail) {
    if (d.type !== chosen.type)
      structWeights[d.type] = (structWeights[d.type] ?? baseWeightOf(d)) + baseWeightOf(d);
  }
  structWeights[chosen.type] = 0;
  saveStructWeights();
}

// Cached .mcstructure size lookup (no chunk load) — used to map authored local offsets
// to world coords for mob spawn points. Cleared implicitly per session.
const structSizeCache = {};
function getStructSize(def) {
  if (!def.structureId) return null;
  if (structSizeCache[def.structureId] !== undefined) return structSizeCache[def.structureId];
  let sz = null;
  try { const ns = world.structureManager.get(def.structureId); sz = ns ? ns.size : null; } catch(_) { sz = null; }
  structSizeCache[def.structureId] = sz;
  return sz;
}

// ─── Main structure spawner ───────────────────────────────────────────────────
function buildChallengeStructure(forcedType) {
  if (structureState.length >= MAX_STRUCTURES) return;

  const phase  = lootPhase();
  const avail  = CHALLENGE_STRUCT_DEFS.filter(s =>
    !s.minPhase || PHASE_ORDER.indexOf(phase) >= PHASE_ORDER.indexOf(s.minPhase)
  );
  if (avail.length === 0) return;

  const def = forcedType
    ? (CHALLENGE_STRUCT_DEFS.find(s => s.type === forcedType) ?? pickWeightedStructure(avail))
    : pickWeightedStructure(avail);

  // Resolve the structure's footprint UP FRONT so placement can be size-aware.
  // Native defs read .size from the shipped .mcstructure (available without loading
  // chunks); a missing file means we can't place it, so bail before recording.
  let nativeStruct = null;
  if (def.structureId) {
    try { nativeStruct = world.structureManager.get(def.structureId) ?? null; } catch(_) { nativeStruct = null; }
    if (!nativeStruct) return;
  }
  const footR     = structFootprint(nativeStruct);
  const structH   = nativeStruct ? nativeStruct.size.y : (def.height ?? DEFAULT_FOOT_R);

  // Spatial placement search. Walk rings inner→outer; in each, try several random
  // angle/radius candidates. Reject any candidate that (a) would bring the footprint
  // closer than PLATFORM_CLEAR_RADIUS to world center, or (b) comes within
  // footR + other.r + STRUCT_PAD of an existing structure. The first ring with room
  // wins; a packed inner ring naturally overflows outward. If EVERY ring is full we
  // defer (no slot consumed) — that's the "no space but cap not reached" case.
  let scx, scz, sy, ringId;
  let placed = false;
  for (const ring of STRUCT_RINGS) {
    for (let attempt = 0; attempt < 16; attempt++) {
      const angle  = Math.random() * Math.PI * 2;
      const radius = rand(ring.minRadius, ring.maxRadius);
      if (radius - footR < PLATFORM_CLEAR_RADIUS) continue; // would clip the platform grid
      const cx_ = Math.round(Math.cos(angle) * radius);
      const cz_ = Math.round(Math.sin(angle) * radius);
      const tooClose = structureState.some(s => {
        const dx = cx_ - s.x, dz = cz_ - s.z;
        const minD = footR + (s.r ?? DEFAULT_FOOT_R) + STRUCT_PAD;
        return (dx * dx + dz * dz) < minD * minD;
      });
      if (!tooClose) {
        scx = cx_; scz = cz_; sy = CFG.platformY + rand(15, 75); ringId = ring.id;
        placed = true; break;
      }
    }
    if (placed) break;
  }
  if (!placed) {
    adminMsg(`§8[FF-OP] Structure spawn deferred — no free space (${structureState.length}/${MAX_STRUCTURES} placed)`);
    return; // every ring spatially packed; retry next scheduled spawn
  }

  // Placement found — commit the pity update now (chosen -> 0, others climb). The only
  // later failure is the rare async chunk-probe bail, which self-corrects over time.
  commitStructurePity(def, avail);

  const tierName = def.lootTier[phase] ?? def.lootTier[PHASE_ORDER.find(p => def.lootTier[p])];
  const tier     = LOOT_TIERS.find(t => t.name === tierName);

  const dim = getDim();
  // Temporary ticking area to force-load the chunk so we can write immediately.
  // Sized to the footprint (+margin) rather than a fixed box. Capture the tick NOW —
  // state.tick advances during the 5-tick wait, so building the remove name from
  // state.tick later would target the wrong area. The area is REMOVED once the build
  // + loot fill finish (cleanup()): structures never despawn, so they don't need to
  // stay loaded, and leaking one permanent area each blows past Bedrock's ~10-area
  // cap, after which `tickingarea add` fails silently and far structures never load.
  const apad     = footR + 4;
  const areaName = `ff_s${state.tick}`;
  try { dim.runCommand(`tickingarea add ${scx-apad} ${sy-5} ${scz-apad} ${scx+apad} ${sy+structH+8} ${scz+apad} ${areaName} true`); } catch(_) {}

  system.runTimeout(() => {
    const run     = (cmd) => { try { dim.runCommand(cmd); } catch(_) {} };
    const cleanup = ()    => { try { dim.runCommand(`tickingarea remove ${areaName}`); } catch(_) {} };

    // Verify the chunk actually force-loaded. In an unloaded chunk getBlock()
    // returns undefined; a loaded void column returns minecraft:air. If it's
    // still unloaded (e.g. the area cap was hit), bail WITHOUT recording the
    // structure so the slot isn't consumed — it retries on a later tick.
    let probe;
    try { probe = dim.getBlock({ x: scx, y: sy, z: scz }); } catch(_) { probe = undefined; }
    if (!probe) { cleanup(); return; }

    // Build the structure. Native: let the engine stamp the .mcstructure (it anchors
    // at the MIN corner, so offset by half the footprint to center it on (scx,scz);
    // no pre-clear needed — it spawns in void and place() overwrites its own volume).
    // Legacy: pre-clear the ±15 box build() relies on, then run its commands.
    if (nativeStruct) {
      const ox = scx - Math.floor(nativeStruct.size.x / 2);
      const oz = scz - Math.floor(nativeStruct.size.z / 2);
      try {
        world.structureManager.place(def.structureId, dim, { x: ox, y: sy, z: oz }, { includeEntities: false });
      } catch(_) {}
    } else {
      const h = def.height + 6;
      run(`fill ${scx-15} ${sy-3} ${scz-15} ${scx+15} ${sy+h} ${scz+15} minecraft:air`);
      def.build(run, scx, sy, scz);
    }

    // Persist immediately — the structure is placed; chest/mobs settle just after.
    structureState.push({ x: scx, y: sy, z: scz, type: def.type, tick: state.tick, ring: ringId, r: footR, h: structH });
    saveStructureState();

    // Announce spawn
    const tierLabel =
      tierName === "mythic"   ? "§5✦ Mythic"   :
      tierName === "rare"     ? "§6★ Rare"     :
      tierName === "uncommon" ? "§bUncommon"   : "§7Common";
    broadcast(`§e[FF] §l⚔ ${def.label}§r §e(Ring ${ringId}) at §f(${scx}, ${sy}, ${scz})§e — ${tierLabel} §eloot inside!`);
    adminMsg(`§8[FF-OP] Structure: ${def.type} ring=${ringId} r=${footR} at (${scx}, ${sy}, ${scz}) tier=${tierName} total=${structureState.length}/${MAX_STRUCTURES}`);
    if (structureState.length >= MAX_STRUCTURES) {
      broadcast(`§6[FF] §lAll ${MAX_STRUCTURES} challenge structures have been discovered!`);
    }

    // Let the build settle one beat, then place the chest on a real surface, fill it,
    // and drop the ticking area. Mobs are NOT spawned here — they're spawned lazily by
    // spawnStructureMobs() only while a player is near, so they don't get culled at
    // range (Bedrock despawns hostiles >128 blocks from any player) and idle structures
    // stay cheap.
    const topY = sy + structH + 2;
    system.runTimeout(() => {
      // ── Chests. Three modes:
      //  (a) Authored (native def.chests): explicit local offsets from the .mcstructure
      //      MIN corner, each with an optional per-chest rarity override and optional
      //      slot count (scalar or [min,max]). No surface scan — the author owns the
      //      spot (a bad offset just buries a chest; fix the offset). Multiple chests of
      //      varying rarity are supported.
      //  (b) Native auto: scan for an open surface (center column, nearby columns, then
      //      the roof as a guaranteed fallback) and drop one chest at the structure tier.
      //  (c) Legacy build(): keep the authored chestOffset spot so the tested 15 behave
      //      exactly as before.
      const planned = [];   // { x, y, z, tier, slots }
      if (nativeStruct && Array.isArray(def.chests) && def.chests.length) {
        const cox = scx - Math.floor(nativeStruct.size.x / 2);
        const coz = scz - Math.floor(nativeStruct.size.z / 2);
        for (const c of def.chests) {
          const cx = cox + c.x, cy = sy + c.y, cz = coz + c.z;
          const ct = (c.rarity && LOOT_TIERS.find(t => t.name === c.rarity)) || tier;
          run(`setblock ${cx} ${cy} ${cz} minecraft:chest`);
          planned.push({ x: cx, y: cy, z: cz, tier: ct, slots: c.slots });
        }
      } else {
        let chestX = scx, chestZ = scz, chestY;
        if (nativeStruct) {
          chestY = null;
          for (const [dx, dz] of CHEST_PROBE_OFFSETS) {
            const y = findStructSurface(dim, scx + dx, scz + dz, sy, topY);
            if (y !== null) { chestX = scx + dx; chestZ = scz + dz; chestY = y; break; }
          }
          if (chestY === null) chestY = findStructRoof(dim, scx, scz, sy, topY);
        } else {
          chestY = sy + def.chestOffset;
        }
        run(`setblock ${chestX} ${chestY} ${chestZ} minecraft:chest`);
        planned.push({ x: chestX, y: chestY, z: chestZ, tier, slots: undefined });
      }

      // ── Loot + cleanup. Fill once chests are settled, then drop the ticking area.
      system.runTimeout(() => {
        for (const pc of planned) {
          try {
            const blk = dim.getBlock({ x: pc.x, y: pc.y, z: pc.z });
            if (blk?.typeId === "minecraft:chest") fillChest(blk, pc.tier, pc.slots);
          } catch(_) {}
        }
        cleanup();
      }, 2);
    }, 2);
  }, 5);
}

// ─── STRUCTURE MOB SPAWNING (proximity-based) ──────────────────────────────────
// Structures sit far from the platforms (rings 95–350). Spawning their guards at
// build time fails: Bedrock instantly despawns hostiles more than 128 blocks from any
// player, so they vanish before anyone arrives. Instead we spawn lazily — only while a
// player is within STRUCT_MOB_RADIUS — and top up toward STRUCT_MOB_CAP once per
// STRUCT_MOB_COOLDOWN. No persistence: when the player leaves they despawn on their own.
const structMobTimers = {};   // key "x,y,z" -> last spawn game-tick (in-memory only)
function spawnStructureMobs() {
  if (structureState.length === 0) return;
  const players = world.getAllPlayers();
  if (players.length === 0) return;
  const dim   = getDim();
  const phase = lootPhase();
  const R2    = STRUCT_MOB_RADIUS * STRUCT_MOB_RADIUS;

  for (const s of structureState) {
    const cy = s.y + 6;                          // rough island mid for distance + scan
    // Nearest player (3D). Skip the whole structure if no one is close.
    let near = Infinity;
    for (const p of players) {
      const l = p.location;
      const dx = l.x - s.x, dy = l.y - cy, dz = l.z - s.z;
      const d2 = dx * dx + dy * dy + dz * dz;
      if (d2 < near) near = d2;
    }
    if (near > R2) continue;

    // Per-structure refill cooldown.
    const key = `${s.x},${s.y},${s.z}`;
    if (state.tick - (structMobTimers[key] ?? -99999) < STRUCT_MOB_COOLDOWN) continue;
    structMobTimers[key] = state.tick;

    const def = CHALLENGE_STRUCT_DEFS.find(d => d.type === s.type);
    if (!def || !def.mobs) continue;

    // Cap: count hostiles already around this structure before adding more.
    let live = 0;
    try {
      live = dim.getEntities({
        location: { x: s.x, y: cy, z: s.z }, maxDistance: STRUCT_MOB_RADIUS, families: ["monster"],
      }).length;
    } catch(_) { live = 0; }
    if (live >= STRUCT_MOB_CAP) continue;

    const mobPool = def.mobs[phase] ?? def.mobs[PHASE_ORDER.find(p => def.mobs[p])];
    if (!mobPool) continue;
    const topY = s.y + (s.h ?? 48) + 2;
    const want = Math.min(STRUCT_MOB_CAP - live, rand(1, 3));

    // Authored spawn points (v1.9.0): if the def lists local feet-offsets and we can
    // resolve the .mcstructure origin (MIN corner = center minus half the footprint),
    // spawn at those; otherwise fall back to the surface scan. Per-point footing is
    // still validated so a stale/bad offset never drops a mob into void.
    let spawnOrigin = null;
    if (Array.isArray(def.spawns) && def.spawns.length) {
      const sz = getStructSize(def);
      if (sz) spawnOrigin = { x: s.x - Math.floor(sz.x / 2), z: s.z - Math.floor(sz.z / 2) };
    }

    for (let i = 0; i < want; i++) {
      const mob = Array.isArray(mobPool) ? pick(mobPool) : mobPool;
      // Require real footing within the footprint — never spawn over open void.
      let my = null, mx = s.x, mz = s.z;
      if (spawnOrigin) {
        for (let t = 0; t < 4; t++) {
          const p  = pick(def.spawns);
          const wx = spawnOrigin.x + p.x, wy = s.y + p.y, wz = spawnOrigin.z + p.z;
          try {
            const below = dim.getBlock({ x: wx, y: wy - 1, z: wz });
            const at    = dim.getBlock({ x: wx, y: wy,     z: wz });
            if (isFooting(below) && at && at.isAir) { mx = wx; my = wy; mz = wz; break; }
          } catch(_) {}
        }
      }
      if (my === null) {
        for (let t = 0; t < 6; t++) {
          const ddx = rand(-5, 5), ddz = rand(-5, 5);
          const sfc = findStructSurface(dim, s.x + ddx, s.z + ddz, s.y, topY);
          if (sfc !== null) { mx = s.x + ddx; mz = s.z + ddz; my = sfc; break; }
        }
      }
      if (my === null) continue;
      try {
        const e = dim.spawnEntity(mob, { x: mx + 0.5, y: my, z: mz + 0.5 });
        if (def.fireproof && e) {
          try { e.addEffect("fire_resistance", 2000000, { showParticles: false }); } catch(_) {}
        }
      } catch(_) {}
    }
  }
}

// ─── MOB SPAWNING ─────────────────────────────────────────────────────────────
// Spawns mobs in the outer ring of a platform (3-6 blocks inside the edge).
// At half=16 and edgeDist=3-6, spawn x/z land 10-13 blocks from center —
// close enough to be a threat, far enough not to land on the player.
function spawnMobsOnPlatform(platform, types, count) {
  const dim  = getDim();
  const half = Math.floor(CFG.platformSize / 2);        // 16
  for (let i = 0; i < count; i++) {
    try {
      const mob      = types[Math.floor(Math.random() * types.length)];
      const side     = Math.floor(Math.random() * 4);
      const edgeDist = rand(3, 6);                       // blocks inside the edge
      const along    = rand(-(half - edgeDist - 1), half - edgeDist - 1);
      let x, z;
      if      (side === 0) { x = platform.cx + (half - edgeDist); z = platform.cz + along; }
      else if (side === 1) { x = platform.cx - (half - edgeDist); z = platform.cz + along; }
      else if (side === 2) { x = platform.cx + along; z = platform.cz + (half - edgeDist); }
      else                 { x = platform.cx + along; z = platform.cz - (half - edgeDist); }
      const y = findLandingY(dim, x, z);
      dim.spawnEntity(mob, { x, y, z });
    } catch(_) {}
  }
}

// ─── PLATFORM ASSIGNMENT ─────────────────────────────────────────────────────
function getPlatformForPlayer(uuid) {
  for (const [idStr, data] of Object.entries(platformState)) {
    if (data.playerUUID === uuid) return getPlatformById(parseInt(idStr));
  }
  return null;
}

function assignNextPlatform(player) {
  for (const p of PLATFORMS) {
    if (!platformState[p.id]) {
      platformState[p.id] = {
        playerUUID:    player.id,
        playerName:    player.name,
        nextChestTick: -1,
        rarePity:      0,
        mythicPity:    0,
      };
      savePlatformState();
      return p;
    }
  }
  return null; // all 9 slots full
}

// Returns platforms whose assigned player is currently online
function getActivePlatforms() {
  const online = new Set(world.getAllPlayers().map(p => p.id));
  return Object.entries(platformState)
    .filter(([, d]) => online.has(d.playerUUID))
    .map(([idStr]) => getPlatformById(parseInt(idStr)))
    .filter(Boolean);
}

// ─── PLAYER SPAWN HANDLING ────────────────────────────────────────────────────
function handlePlayerJoin(player) {
  // Re-read platform state here — the top-level eager load fires before dynamic
  // properties are accessible in Bedrock, so it may return {}. By the time
  // playerSpawn fires, the world is fully initialised and the data is readable.
  loadPlatformState();
  const existing = getPlatformForPlayer(player.id);
  if (existing) {
    // Returning player — let Bedrock restore their saved position naturally.
    // Re-affirm spawnpoint so death without a bed sends them back to their platform.
    system.runTimeout(() => {
      try { player.runCommand(`spawnpoint @s ${existing.cx} ${CFG.spawnY} ${existing.cz}`); } catch(_) {}
    }, 5);
    return;
  }

  // New player — assign next free platform
  const platform = assignNextPlatform(player);
  if (!platform) {
    player.sendMessage("§c[FF] All 9 platforms are taken. Talk to an admin.");
    return;
  }

  broadcast(`§e[FF] §f${player.name}§e joined — Platform ${platform.id} activated!`);
  adminMsg(`§8[FF-OP] ${player.name} assigned to Platform ${platform.id} (UUID: ${player.id})`);
  if (platform.id === 1) clearVoidSpawnPlatform();
  buildPlatformById(platform);

  system.runTimeout(() => {
    spawnStarterChest(platform);
    buildGapBedrock(); // fill gaps around the newly built platform
    try { player.teleport({ x: platform.cx, y: CFG.spawnY, z: platform.cz }); } catch(_) {}
    try { player.runCommand(`spawnpoint @s ${platform.cx} ${CFG.spawnY} ${platform.cz}`); } catch(_) {}
    player.sendMessage(`§a[FF] Welcome! Platform ${platform.id} is yours.`);
  }, 20);
}

world.afterEvents.playerSpawn.subscribe((ev) => {
  if (!ev.initialSpawn) return;
  system.run(() => handlePlayerJoin(ev.player));
});

// ─── PLAYER TP ────────────────────────────────────────────────────────────────
function spawnAllPlayersToTheirPlatforms() {
  for (const p of world.getAllPlayers()) {
    const platform = getPlatformForPlayer(p.id);
    if (platform) {
      try { p.teleport({ x: platform.cx, y: CFG.spawnY, z: platform.cz }); } catch(_) {}
    }
  }
}

// ─── WAVES ────────────────────────────────────────────────────────────────────

// Roll a new category. Current category gets +CATEGORY_REPEAT_BONUS to its weight.
function rollCategory(currentCategory) {
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
function rollWaveInCategory(categoryName) {
  const waves = WAVE_CATEGORIES[categoryName].waves;
  return waves[Math.floor(Math.random() * waves.length)].name;
}

// Apply a wave. opts = { announce, categoryChanged }
// announce defaults to true; pass { announce: false } to suppress all output.
// categoryChanged = true shows a title card in addition to the chat message.
function applyWave(categoryName, waveName, opts = {}) {
  const catDef  = WAVE_CATEGORIES[categoryName];
  const waveDef = catDef?.waves.find(w => w.name === waveName);
  if (!catDef || !waveDef) return;

  state.category = categoryName;
  state.wave     = waveName;
  state.waveTick = 0;
  state.waveDur  = rand(waveDef.minDur, waveDef.maxDur);
  state.votes    = {};

  // Drop rate (game ticks between drops per platform)
  if (categoryName === "blackout") {
    state.dropRate = 999999;
  } else if (waveName === "meteor_strike") {
    // Very fast — 2 ticks (2× calm rate)
    state.dropRate = state.forceRate ?? Math.max(2, Math.floor(CFG.tickInterval / 2));
  } else if (categoryName === "storms" || waveName === "gold_rush" || waveName === "gravity_surge") {
    // Fast — 3 ticks
    state.dropRate = state.forceRate ?? Math.max(3, Math.floor(CFG.tickInterval / 1.5));
  } else {
    // Standard — 4 ticks (CFG.tickInterval)
    state.dropRate = state.forceRate ?? CFG.tickInterval;
  }

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

function restoreDropRate() {
  const c = state.category;
  const w = state.wave;
  if (c === "blackout") {
    state.dropRate = 999999;
  } else if (w === "meteor_strike") {
    state.dropRate = state.forceRate ?? Math.max(2, Math.floor(CFG.tickInterval / 2));
  } else if (c === "storms" || w === "gold_rush" || w === "gravity_surge") {
    state.dropRate = state.forceRate ?? Math.max(3, Math.floor(CFG.tickInterval / 1.5));
  } else {
    state.dropRate = state.forceRate ?? CFG.tickInterval;
  }
}

// ─── BLOCK SELECTION ─────────────────────────────────────────────────────────
function pickRare() {
  const total = POOL_RARE.reduce((s, e) => s + e.w, 0);
  let r = Math.random() * total;
  for (const e of POOL_RARE) { r -= e.w; if (r <= 0) return e.id; }
  return POOL_RARE[POOL_RARE.length - 1].id;
}
function pickChaos() {
  const total = POOL_CHAOS.reduce((s, e) => s + e.w, 0);
  let r = Math.random() * total;
  for (const e of POOL_CHAOS) { r -= e.w; if (r <= 0) return e.id; }
  return POOL_CHAOS[POOL_CHAOS.length - 1].id;
}

// Balanced pool picker shared by calm wave and chaos storm.
// isStorm = true cranks CHAOS/HAZARD weights and pulls TERRAIN/RESOURCE down.
function pickBlockBalanced(isStorm) {
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

function pickBlock() {
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

// ─── DROP SYSTEM ─────────────────────────────────────────────────────────────
function dropBlock(platform) {
  if (state.wave === "blackout") return;

  const half    = Math.floor(CFG.platformSize / 2);
  const cache   = colHeightCache[platform.id] ?? {};
  const base    = CFG.platformY + 1; // empty-column reference height

  // Pick the block FIRST so water-risk blocks (ice) can be inset from the edge.
  const block = pickBlock();
  const inset = EDGE_INSET_BLOCKS.has(block) ? 3 : 0;

  // Sample random candidates and pick one weighted by inverse sqrt of stack height.
  // Shorter columns get higher weight — bias without eliminating variability.
  const CANDIDATES = 8;
  const cands = [];
  for (let i = 0; i < CANDIDATES; i++) {
    const cx = platform.cx + rand(-half + inset, half - 1 - inset);
    const cz = platform.cz + rand(-half + inset, half - 1 - inset);
    const landY  = cache[`${cx},${cz}`] ?? base;
    const height = landY - base;                    // 0 = empty, higher = taller stack
    cands.push({ cx, cz, weight: 1 / Math.sqrt(height + 1) });
  }
  let totalW = 0;
  for (const c of cands) totalW += c.weight;
  let r = Math.random() * totalW;
  let chosen = cands[cands.length - 1];
  for (const c of cands) { r -= c.weight; if (r <= 0) { chosen = c; break; } }

  const x = chosen.cx;
  const z = chosen.cz;

  if (GRAVITY_BLOCKS.has(block)) {
    try {
      getDim().runCommand(`setblock ${x} ${CFG.blockDropY - 1} ${z} minecraft:air`);
      getDim().runCommand(`setblock ${x} ${CFG.blockDropY} ${z} ${block}`);
    } catch(_) {}
  } else {
    activeDrops.push({ x, y: CFG.blockDropY, z, block, platformId: platform.id });
  }
}

// Runs every real tick — animates falling blocks independently of gameTick
function stepDrops() {
  if (!state.running || state.paused) return;
  state.dropTick++;
  if (activeDrops.length === 0) return;

  const dim      = getDim();
  const toRemove = [];

  for (let i = 0; i < activeDrops.length; i++) {
    const d     = activeDrops[i];
    const curY  = d.y;
    const nextY = curY - CFG.dropStepSize;

    try { dim.runCommand(`setblock ${d.x} ${curY} ${d.z} minecraft:air`); } catch(_) {}

    let landed   = false;
    let skipTick = false;
    // Default hitY to the bedrock surface. If no stack is found, landY = platformY+1.
    let hitY     = CFG.platformY;

    // Always scan the full travel path, clamping the scan floor to platformY+1.
    // Previously this scan was skipped when nextY hit the floor, which caused blocks
    // to blindly place at nextY+1 and overwrite whatever was already stacked there.
    const scanBottom = Math.max(nextY, CFG.platformY + 1);
    for (let checkY = curY - 1; checkY >= scanBottom; checkY--) {
      if (checkY > BLIND_FALL_Y) continue; // treat as air — see BLIND_FALL_Y
      try {
        const b = dim.getBlock({ x: d.x, y: checkY, z: d.z });
        if (b === undefined || b === null) {
          skipTick = true;
          break;
        } else if (!PASS_THROUGH.has(b.typeId)) {
          landed = true;
          hitY = checkY;
          break;
        }
      } catch(_) { skipTick = true; break; }
    }
    // If the scan reached the platform floor without finding an obstacle, force land.
    // hitY stays at CFG.platformY so landY = platformY+1 (directly on the bedrock).
    if (!skipTick && !landed && nextY <= CFG.platformY + 1) {
      landed = true;
    }

    if (skipTick) {
      try { dim.runCommand(`setblock ${d.x} ${curY} ${d.z} ${d.block}`); } catch(_) {}
      continue;
    }

    if (landed) {
      const landY = hitY + 1;
      try { dim.runCommand(`setblock ${d.x} ${landY} ${d.z} ${d.block}`); } catch(_) {}
      // Update column-height cache for drop-targeting bias
      if (d.platformId !== undefined) {
        if (!colHeightCache[d.platformId]) colHeightCache[d.platformId] = {};
        colHeightCache[d.platformId][`${d.x},${d.z}`] = landY + 1; // next available slot above placed block
      }
      toRemove.push(i);
    } else {
      d.y = nextY;
      try { dim.runCommand(`setblock ${d.x} ${nextY} ${d.z} ${d.block}`); } catch(_) {}
    }
  }

  if (toRemove.length > 0) {
    for (let i = toRemove.length - 1; i >= 0; i--) activeDrops.splice(toRemove[i], 1);
    saveDrops();
  }
  if (state.dropTick % 20 === 0) saveDrops();
}

// ─── LOOT SYSTEM ─────────────────────────────────────────────────────────────
// rarePity / mythicPity are per-platform accumulators added to base weights.
// Positive = boosted odds (pity building up), negative = brief deficit after a hit.
// Weights are clamped at 0 so a deficit can never make a tier unrollable.
function rollLootTier(rarePity = 0, mythicPity = 0, phase = "mid") {
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
function fillChest(block, tier, slotOverride) {
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
  } catch(_) {}
}

// Starter chest: wood tools + food + torches
function fillStarterChest(block) {
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
function spawnStarterChest(platform) {
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
function spawnLootChest(platform, forcedTier = null) {
  const dim  = getDim();
  const half = Math.floor(CFG.platformSize / 2) - 2;
  const x    = platform.cx + rand(-half, half);
  const z    = platform.cz + rand(-half, half);
  const topY = findLandingY(dim, x, z);

  // Roll tier with per-platform pity; forced tier bypasses pity entirely.
  const pData      = platformState[platform.id];
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

// ─── KIT ─────────────────────────────────────────────────────────────────────
function giveKit(target, sender) {
  const targets = target ? [target] : [...world.getAllPlayers()];
  const items   = [
    "minecraft:stone_sword 1",  "minecraft:stone_pickaxe 1",
    "minecraft:stone_axe 1",    "minecraft:stone_shovel 1",
    "minecraft:bread 16",       "minecraft:torch 32",
  ];
  for (const p of targets) {
    for (const i of items) { try { p.runCommand(`give @s ${i}`); } catch(_) {} }
    p.sendMessage("§aKit received!");
  }
  if (sender) sender.sendMessage(
    `§aKit given to ${target ? target.name : "everyone"}.`
  );
}

// ─── VOTE ─────────────────────────────────────────────────────────────────────
// Players vote for a category; a random wave within that category is applied if
// the vote passes.
function handleVote(player, catName) {
  const valid = Object.keys(WAVE_CATEGORIES);
  if (!valid.includes(catName)) {
    player.sendMessage("§cUsage: /scriptevent ff:vote <calm|events|storms|blackout>");
    return;
  }
  const remain = CFG.voteCooldown - (state.tick - state.voteLastTick);
  if (remain > 0) {
    player.sendMessage(`§cVote cooldown: ${Math.ceil(remain / 5)}s left.`); // 5 game ticks = 1s
    return;
  }
  state.votes[player.name] = catName;
  const needed = Math.ceil(world.getAllPlayers().length / 2);
  const counts = {};
  for (const v of Object.values(state.votes)) counts[v] = (counts[v] ?? 0) + 1;
  broadcast(
    `§7[Vote] ${player.name} -> §e${catName}§7 ` +
    `(${Object.keys(state.votes).length}/${needed})`
  );
  for (const [cat, count] of Object.entries(counts)) {
    if (count >= needed) {
      state.votes = {}; state.voteLastTick = state.tick;
      const newWave = rollWaveInCategory(cat);
      applyWave(cat, newWave, { announce: true, categoryChanged: cat !== state.category });
      return;
    }
  }
}

// ─── ADMIN COMMANDS ───────────────────────────────────────────────────────────
function handleCommand(player, cmd, arg, fullMsg) {
  if (!isOp(player)) { player.sendMessage("§cOp required."); return; }

  if (cmd === "wave") {
    const catNames  = Object.keys(WAVE_CATEGORIES);
    const waveNames = Object.keys(WAVE_BY_NAME);
    if (arg === "random") {
      const newCat  = rollCategory(state.category);
      const newWave = rollWaveInCategory(newCat);
      applyWave(newCat, newWave, { announce: true, categoryChanged: newCat !== state.category });
    } else if (waveNames.includes(arg)) {
      const wd = WAVE_BY_NAME[arg];
      applyWave(wd.category, arg, { announce: true, categoryChanged: wd.category !== state.category });
    } else if (catNames.includes(arg)) {
      const newWave = rollWaveInCategory(arg);
      applyWave(arg, newWave, { announce: true, categoryChanged: arg !== state.category });
    } else {
      player.sendMessage("§c/scriptevent ff:wave <wave|category|random>");
      player.sendMessage(`§7Categories: ${catNames.join(", ")}`);
      player.sendMessage(`§7Waves: ${waveNames.join(", ")}`);
    }

  } else if (cmd === "rate") {
    if (arg === "reset") {
      state.forceRate = null; restoreDropRate();
      player.sendMessage("§aDrop rate reset."); return;
    }
    const n = parseInt(arg);
    if (isNaN(n) || n < 1 || n > 200) {
      player.sendMessage("§c/scriptevent ff:rate <1-200>"); return;
    }
    state.forceRate = n;
    if (state.category !== "blackout") state.dropRate = n;
    player.sendMessage(`§aDrop rate: ${n} ticks.`);

  } else if (cmd === "loot") {
    if (arg) {
      const num      = parseInt(arg);
      const platform = getPlatformById(num);
      if (!platform || !platformState[num]) {
        player.sendMessage(`§cPlatform ${num} not active.`); return;
      }
      spawnLootChest(platform);
    } else {
      for (const idStr of Object.keys(platformState)) {
        const p = getPlatformById(parseInt(idStr));
        if (p) spawnLootChest(p);
      }
    }

  } else if (cmd === "spawnloot") {
    const parts     = fullMsg.trim().split(/\s+/);
    const platArg   = parts[0]?.toLowerCase() ?? "";
    const tierArg   = parts[1]?.toLowerCase() ?? "";
    const validTiers = ["common", "uncommon", "rare", "mythic"];
    let forcedTier  = null;
    if (tierArg) {
      if (!validTiers.includes(tierArg)) {
        player.sendMessage(`§cInvalid rarity. Use: common, uncommon, rare, mythic`); return;
      }
      forcedTier = LOOT_TIERS.find(t => t.name === tierArg) ?? null;
    }
    if (platArg === "all") {
      for (const idStr of Object.keys(platformState)) {
        const p = getPlatformById(parseInt(idStr));
        if (p) spawnLootChest(p, forcedTier);
      }
    } else {
      const num      = parseInt(platArg);
      const platform = getPlatformById(num);
      if (!platform || !platformState[num]) {
        player.sendMessage(`§cPlatform ${num} not active.`); return;
      }
      spawnLootChest(platform, forcedTier);
    }

  } else if (cmd === "chaos") {
    // Route through applyWave so drop rate / wave timer / persistence all update.
    // Overriding waveDur lets the normal rotation take over when chaos expires —
    // no restore-timeout race with naturally rolled waves.
    const dur = parseInt(arg) || 400; // game ticks
    applyWave("storms", "chaos_storm", { announce: true, categoryChanged: state.category !== "storms" });
    state.waveDur = dur;
    saveWaveState();
    player.sendMessage(`§aChaos for ${dur} game ticks.`);

  } else if (cmd === "reset") {
    if (!arg || arg === "all") {
      activeDrops = []; saveDrops();
      broadcast("§e[FF] Resetting all platforms...");
      for (const idStr of Object.keys(platformState)) {
        const p = getPlatformById(parseInt(idStr));
        if (p) { clearAbovePlatformById(p); buildPlatformById(p); }
      }
      spawnAllPlayersToTheirPlatforms();
      state.tick = 0; // must reset BEFORE applyWave — applyWave persists state.tick
      applyWave("calm", "calm", { announce: false });
      broadcast("§a[FF] Reset done.");
    } else {
      const num      = parseInt(arg);
      const platform = getPlatformById(num);
      if (!platform || !platformState[num]) {
        player.sendMessage(`§cPlatform ${num} not active.`); return;
      }
      const half = Math.floor(CFG.platformSize / 2);
      activeDrops = activeDrops.filter(d =>
        !(d.x >= platform.cx - half && d.x < platform.cx + half &&
          d.z >= platform.cz - half && d.z < platform.cz + half)
      );
      saveDrops();
      clearAbovePlatformById(platform);
      buildPlatformById(platform);
      const data  = platformState[num];
      const owner = world.getAllPlayers().find(p => p.id === data.playerUUID);
      if (owner) {
        try { owner.teleport({ x: platform.cx, y: CFG.spawnY, z: platform.cz }); } catch(_) {}
      }
      broadcast(`§e[FF] Platform ${num} reset.`);
    }

  } else if (cmd === "pause") {
    state.paused = !state.paused;
    broadcast(state.paused ? "§e[FF] Paused." : "§a[FF] Resumed.");

  } else if (cmd === "tp") {
    spawnAllPlayersToTheirPlatforms();
    player.sendMessage("§aTPd everyone to their platforms.");

  } else if (cmd === "kit") {
    if (arg) {
      const target = getPlayerByName(arg);
      // Bail on a bad name — null target means "everyone" in giveKit.
      if (!target) { player.sendMessage(`§c[FF] Player '${arg}' not found.`); return; }
      giveKit(target, player);
    } else {
      giveKit(null, player);
    }

  } else if (cmd === "admin") {
    const subCmd = arg;
    const targetName = fullMsg?.split(/\s+/)[1] ?? null;
    const target = targetName ? getPlayerByName(targetName) : player;
    if (!target) { player.sendMessage(`§c[FF] Player not found.`); return; }
    if (subCmd === "add") {
      adminUUIDs.add(target.id);
      saveAdmins();
      player.sendMessage(`§a[FF] ${target.name} added to admin notifications.`);
    } else if (subCmd === "remove") {
      adminUUIDs.delete(target.id);
      saveAdmins();
      player.sendMessage(`§e[FF] ${target.name} removed from admin notifications.`);
    } else if (subCmd === "list") {
      const names = world.getAllPlayers().filter(p => adminUUIDs.has(p.id)).map(p => p.name);
      player.sendMessage(`§e[FF] Online admins: ${names.join(", ") || "none"}`);
      player.sendMessage(`§e[FF] Total registered: ${adminUUIDs.size}`);
    } else {
      player.sendMessage("§cUsage: /scriptevent ff:admin <add|remove|list> [playerName]");
    }

  } else if (cmd === "portal") {
    if (arg === "nether") {
      portalState.netherBuilt = false;  // allow rebuild if previous attempt failed
      buildNetherPortalPlatform();
      player.sendMessage("§e[FF] Building nether portal platform...");
    } else if (arg === "end") {
      portalState.endBuilt = false;
      buildEndPortalPlatform();
      player.sendMessage("§e[FF] Building end portal platform...");
    } else {
      const nd = Math.max(0, NETHER_PORTAL_TICK - state.tick);
      const ed = Math.max(0, END_PORTAL_TICK - state.tick);
      player.sendMessage(`§e[FF] Portals — Nether: ${portalState.netherBuilt ? "§abuilt" : `§cpending (~${Math.ceil(nd/TICKS_PER_DAY)} days)`}§e  End: ${portalState.endBuilt ? "§abuilt" : `§cpending (~${Math.ceil(ed/TICKS_PER_DAY)} days)`}`);
      player.sendMessage("§7Usage: /scriptevent ff:portal <nether|end>");
    }

  } else if (cmd === "structure") {
    if (!isOp(player)) { player.sendMessage("§cNo permission."); return; }
    const sub = arg.toLowerCase();
    if (sub === "spawn") {
      const typeArg = fullMsg.trim().split(/\s+/)[1]?.toLowerCase() ?? null;
      if (structureState.length >= MAX_STRUCTURES) {
        player.sendMessage(`§e[FF] Structure cap (${MAX_STRUCTURES}) reached — no more can spawn.`);
      } else {
        buildChallengeStructure(typeArg || undefined);
        player.sendMessage(`§e[FF] Spawning challenge structure${typeArg ? ` (${typeArg})` : ""}...`);
      }
    } else {
      // List status
      player.sendMessage(`§e[FF] Challenge Structures: ${structureState.length}/${MAX_STRUCTURES}`);
      player.sendMessage(`§e[FF] Next spawn at tick ${state.nextStructureTick} (current: ${state.tick})`);
      for (const r of STRUCT_RINGS) {
        const filled = structureState.filter(s => s.ring === r.id).length;
        player.sendMessage(`§7  Ring ${r.id} (r${r.minRadius}-${r.maxRadius}): ${filled} placed§7`);
      }
      const types = CHALLENGE_STRUCT_DEFS.map(s => s.type);
      player.sendMessage(`§7Types: ${types.join(", ")}`);
      player.sendMessage(`§7Usage: /scriptevent ff:structure spawn [type]`);
    }

  } else if (cmd === "msgs") {
    if (arg === "off") {
      mutedAdminUUIDs.add(player.id);
      saveMutedAdmins();
      player.sendMessage("§7[FF] OP messages muted. Use /scriptevent ff:msgs on to restore.");
    } else if (arg === "on") {
      mutedAdminUUIDs.delete(player.id);
      saveMutedAdmins();
      player.sendMessage("§a[FF] OP messages enabled.");
    } else {
      const muted = mutedAdminUUIDs.has(player.id);
      player.sendMessage(`§e[FF] OP messages: ${muted ? "§coff" : "§aon"}§e. Usage: /scriptevent ff:msgs <on|off>`);
    }

  } else if (cmd === "debug") {
    player.sendMessage(`§e[FF-DEBUG] permissionLevel = ${JSON.stringify(player.playerPermissionLevel)}`);
    player.sendMessage(`§e[FF-DEBUG] isOp = ${isOp(player)}, isAdmin = ${isAdmin(player)}`);
    player.sendMessage(`§e[FF-DEBUG] PlayerPermissionLevel.Operator = ${PlayerPermissionLevel.Operator}`);
    player.sendMessage(`§e[FF-DEBUG] tick = ${state.tick}, category = ${state.category}, wave = ${state.wave}, drops = ${activeDrops.length}`);

  } else if (cmd === "help") {
    [
      "§e--- FallingFalling v1.9.0 Commands ---",
      "§f/scriptevent ff:wave <wave|category|random>",
      "§7  Categories: calm, events, storms, blackout",
      "§7  Waves: calm, gold_rush, ore_shower, meteor_strike, gravity_surge,",
      "§7         nether_flare, deep_freeze, monster_swarm, pillager_raid,",
      "§7         chaos_storm, nether_storm, end_storm, frozen_storm,",
      "§7         cave_storm, blackout",
      "§f/scriptevent ff:rate <1-200> | reset",
      "§f/scriptevent ff:loot [1-9]",
      "§f/scriptevent ff:spawnloot <1-9|all> [common|uncommon|rare|mythic]",
      "§f/scriptevent ff:chaos [ticks]",
      "§f/scriptevent ff:reset <1-9|all>",
      "§f/scriptevent ff:portal <nether|end>",
      "§f/scriptevent ff:structure [spawn [type]]",
      `§7  Types: ${CHALLENGE_STRUCT_DEFS.map(s => s.type).join(", ")}`,
      "§f/scriptevent ff:pause",
      "§f/scriptevent ff:tp",
      "§f/scriptevent ff:kit [player]",
      "§f/scriptevent ff:admin <add|remove|list> [player]",
      "§f/scriptevent ff:msgs <on|off>",
      "§f/scriptevent ff:debug",
      "§7/scriptevent ff:vote <calm|events|storms|blackout>",
    ].forEach(l => player.sendMessage(l));

  } else {
    player.sendMessage("§cUnknown command. Try /scriptevent ff:help");
  }
}

// ─── GAME TICK (logic + spawning, every CFG.tickInterval real ticks) ─────────
function gameTick() {
  if (!state.running || state.paused) return;
  state.tick++;
  state.waveTick++;

  if (state.waveTick >= state.waveDur) {
    const newCat     = rollCategory(state.category);
    const newWave    = rollWaveInCategory(newCat);
    const isRepeat   = (newCat === state.category && newWave === state.wave);
    const catChanged = newCat !== state.category;

    const catLabel  = { calm: "§aCalmness§8", events: "§6Events§8", storms: "§cStorms§8", blackout: "§7Blackout§8" };
    const prevLabel = `${catLabel[state.category] ?? state.category}/${state.wave}`;
    const nextLabel = `${catLabel[newCat] ?? newCat}/${newWave}`;

    if (isRepeat) {
      const waveDef  = WAVE_BY_NAME[newWave];
      state.waveTick = 0;
      state.waveDur  = rand(waveDef.minDur, waveDef.maxDur);
      adminMsg(`§8[FF-OP] Wave repeating: ${nextLabel}`);
    } else {
      adminMsg(`§8[FF-OP] Wave: ${prevLabel} → ${nextLabel}`);
      applyWave(newCat, newWave, { announce: true, categoryChanged: catChanged });
    }
  }

  // Per-platform chest timers — only tick for platforms whose player is online
  const onlineUUIDs = new Set(world.getAllPlayers().map(p => p.id));
  let chestTimerDirty = false;
  for (const [idStr, data] of Object.entries(platformState)) {
    if (data.nextChestTick === -1) {
      data.nextChestTick = state.tick + CFG.chestInterval;
      chestTimerDirty = true;
      continue;
    }
    if (!onlineUUIDs.has(data.playerUUID)) continue;
    if (state.tick >= data.nextChestTick) {
      const p = getPlatformById(parseInt(idStr));
      if (p) spawnLootChest(p);
      data.nextChestTick = state.tick + CFG.chestInterval;
      chestTimerDirty = true;
    }
  }

  if (state.tick % state.dropRate === 0) {
    const active = getActivePlatforms();
    for (const platform of active) dropBlock(platform);
  }

  // Mob resupply for mob-wave events
  const _mobWaveDef = WAVE_BY_NAME[state.wave];
  if (_mobWaveDef?.spawnMobs && state.waveTick > 0 &&
      state.waveTick % _mobWaveDef.spawnMobs.interval === 0) {
    for (const platform of getActivePlatforms()) {
      spawnMobsOnPlatform(platform, _mobWaveDef.spawnMobs.types, _mobWaveDef.spawnMobs.count);
    }
  }

  if (state.tick % 200 === 0) {
    adminMsg(`§8[FF-OP] ${activeDrops.length} block(s) in flight | ${getActivePlatforms().length} platform(s) active | tick ${state.tick} | ${state.category}/${state.wave}`);
  }

  if (state.tick % 100 === 0) saveWaveState();
  if (chestTimerDirty || state.tick % 100 === 0) savePlatformState();

  // Portal platform milestones — checked every 100 ticks (low overhead after built)
  if (state.tick % 100 === 0) {
    if (!portalState.netherBuilt && state.tick >= NETHER_PORTAL_TICK) {
      buildNetherPortalPlatform();
    }
    if (!portalState.endBuilt && state.tick >= END_PORTAL_TICK) {
      buildEndPortalPlatform();
    }
  }

  // Challenge structure spawning — checked every 100 ticks
  if (state.tick % 100 === 0 && structureState.length < MAX_STRUCTURES) {
    if (state.nextStructureTick === 0) {
      // First run: schedule the initial spawn (stagger by half a cycle so it doesn't
      // fire the instant the game starts)
      state.nextStructureTick = state.tick + rand(STRUCT_SPAWN_MIN, STRUCT_SPAWN_MAX);
    } else if (state.tick >= state.nextStructureTick) {
      buildChallengeStructure();
      state.nextStructureTick = state.tick + rand(STRUCT_SPAWN_MIN, STRUCT_SPAWN_MAX);
      saveWaveState();
    }
  }

  // Structure guards — spawn/refill only while a player is near each structure.
  if (state.tick % STRUCT_MOB_CHECK === 0) spawnStructureMobs();
}

// ─── SCRIPT EVENT HANDLER ────────────────────────────────────────────
system.afterEvents.scriptEventReceive.subscribe((ev) => {
  const player = ev.sourceEntity;
  if (!player) return;
  const cmd = ev.id.replace("ff:", "").toLowerCase().trim();
  const arg = ev.message.trim().split(/\s+/)[0]?.toLowerCase() ?? "";
  if (cmd === "vote") {
    system.run(() => handleVote(player, arg));
  } else {
    system.run(() => handleCommand(player, cmd, arg, ev.message.trim()));
  }
}, { namespaces: ["ff"] });

// ─── STARTUP ID VALIDATION ───────────────────────────────────────────────────
// The blanket try/catch around world writes silently swallows typos in block
// and item IDs (e.g. a misnamed pool entry just never spawns). Validate every
// pool and loot table once at startup and report failures to console + ops.
function validateIds() {
  const bad = [];
  const checkBlock = (id) => {
    try { BlockPermutation.resolve(id); } catch(_) { bad.push(`block:${id}`); }
  };
  const checkItem = (id) => {
    try { new ItemStack(id, 1); } catch(_) { bad.push(`item:${id}`); }
  };
  for (const id of [
    ...POOL_TERRAIN, ...POOL_RESOURCE, ...POOL_HAZARD,
    ...POOL_NETHER, ...POOL_END, ...POOL_ICE, ...POOL_CAVE, ...POOL_GRAVITY,
    ...GRAVITY_BLOCKS,
  ]) checkBlock(id);
  for (const e of [...POOL_RARE, ...POOL_CHAOS]) checkBlock(e.id);
  for (const e of [...LOOT_COMMON, ...LOOT_UNCOMMON, ...LOOT_RARE, ...LOOT_MYTHIC]) checkItem(e.id);
  for (const pool of Object.values(SPAWN_EGGS)) for (const id of pool) checkItem(id);

  const unique = [...new Set(bad)];
  if (unique.length > 0) {
    console.warn(`[FF] ${unique.length} invalid ID(s): ${unique.join(", ")}`);
    adminMsg(`§c[FF-OP] ${unique.length} invalid ID(s) in pools/loot (see content log): ${unique.slice(0, 5).join(", ")}${unique.length > 5 ? " …" : ""}`);
  }
}

// ─── INIT ─────────────────────────────────────────────────────────────────────────────

loadPlatformState();
loadAdmins();
loadMutedAdmins();

function startGame() {
  state.running = true;
  state.paused  = false;

  loadPlatformState();
  loadWaveState();
  loadPortalState();
  loadStructureState();
  loadStructWeights();
  loadDrops();
  validateIds();

  if (!state.waveDur || state.waveDur === 0) {
    applyWave("calm", "calm", { announce: false });
    broadcast("§a[FF] Started on calm wave.");
  } else {
    restoreDropRate();
    broadcast(`§a[FF] Resumed. Wave: §e${state.wave}`);
  }

  ensurePlatforms();
  buildGapBedrock();   // fill 3-block gaps between platforms with bedrock at y=-63

  // Force-load the entire platform grid (covers all 9 drop columns up past blockDropY).
  // Without this, far platforms unload: setblock silently no-ops and getBlock returns
  // undefined, so falling blocks freeze at the BLIND_FALL_Y (190) scan seam and dump
  // all at once when a player returns. One area for the whole grid keeps drops animating
  // regardless of player position, and keeps us well under Bedrock's ~10-area cap
  // (ff_grid + ff_nether + ff_end = 3). Remove-then-add self-heals if bounds change.
  try { getDim().runCommand("tickingarea remove ff_grid"); } catch(_) {}
  try { getDim().runCommand("tickingarea add -56 -64 -56 52 256 52 ff_grid"); } catch(_) {}

  system.runInterval(gameTick, CFG.tickInterval);
  system.runInterval(stepDrops, 1);
}

function waitForPlayers() {
  if (world.getAllPlayers().length > 0) {
    broadcast("§e[FF] Loading...");
    system.runTimeout(startGame, 40);
  } else {
    system.runTimeout(waitForPlayers, 20);
  }
}
system.run(waitForPlayers);
