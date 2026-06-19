// ─── BLOCK POOLS ─────────────────────────────────────────────────────────────
// Pure data. No imports, no side effects.

export const POOL_TERRAIN = [
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
export const POOL_RESOURCE = [
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
export const POOL_HAZARD = [
  "minecraft:magma", "minecraft:soul_sand", "minecraft:soul_soil",
  "minecraft:powder_snow", "minecraft:web",
  "minecraft:slime", "minecraft:honey_block",
];
// Weighted entries { id, w } — lower w = rarer
export const POOL_RARE = [
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
export const POOL_CHAOS = [
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
export const POOL_NETHER = [
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
export const POOL_END = [
  "minecraft:end_stone", "minecraft:end_stone", "minecraft:end_stone",
  "minecraft:end_bricks",
  "minecraft:purpur_block", "minecraft:purpur_block",
  "minecraft:purpur_pillar",
];

// Ice / ocean — used by Deep Freeze event and Frozen Storm
export const POOL_ICE = [
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
export const POOL_CAVE = [
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
export const POOL_GRAVITY = [
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
export const SPAWN_EGGS = {
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
