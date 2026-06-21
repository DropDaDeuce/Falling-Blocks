# FallingFalling — Project Notes for Claude

_Last updated: v1.10.0_

## Instructions

Whenever changes are made to any file in FF_BP or FB_Template, the version must be bumped:
1. Propose the new version number and confirm with Mathew before making any version changes.
2. Update `FF_BP/manifest.json` in two places: `header.version` and `modules.version`.
3. Update the version string in `FF_BP/scripts/commands.js` (in the ff:help command output).
4. Add an entry to `CHANGELOG.md` summarizing the change.

## What This Is

A Minecraft Bedrock Edition behavior pack that recreates the old Java mod "FallingFalling." Up to 9 players each get their own 32x32 bedrock platform floating in a void world. Random blocks fall from the sky onto each player's platform, land, and stack over time creating emergent terrain. No win condition — pure sandbox chaos.

## Current Status

Core falling logic, per-player platform system, block pools, wave system, and persistence all functional and sorta tested. Challenge structures are now native `.mcstructure` placements (see Challenge Structures).

---

## File Structure

```
Falling Blocks/        -- repo root (git)
  CLAUDE.md            -- this file: project notes for Claude
  CHANGELOG.md         -- full version history
  build_template.bat   -- packages FF_BP + FB_Template into FB_v<version>.mctemplate
  FF_BP/               -- SOURCE of truth; behavior pack only (@minecraft/server 2.7.0)
    manifest.json
    scripts/           -- modular ES modules (v1.10.0+); import with the .js extension
      main.js          -- entry point: validateIds, gameTick, init/wiring, event subs
      config.js        -- pure constants (CFG, PLATFORMS, portal/struct tunables, sets)
      store.js         -- shared mutable runtime state (state + store objects)
      pools.js         -- block pools + SPAWN_EGGS (pure data)
      phase.js         -- currentDay, lootPhase, PHASE_ORDER
      util.js          -- rand/pick/weightedPick, broadcast, setBlockFast, op/admin
                          helpers, getDim, findLandingY, struct-surface scanners, lookups
      persistence.js   -- PROP_* keys + all save*/load* dynamic-property functions
      loot.js          -- LOOT_* tables, LOOT_TIERS, rollLootTier, fillChest, chests
      platforms.js     -- platform build/gap/ensure/assign/join/tp + spawnMobsOnPlatform
      portals.js       -- buildNetherPortalPlatform / buildEndPortalPlatform
      structures.js    -- footprint/pity helpers, buildChallengeStructure, mob spawner
      waves.js         -- WAVE_CATEGORIES, rollers, computeDropRate, applyWave, pickBlock
      drops.js         -- dropBlock + stepDrops (fall animation)
      commands.js      -- handleCommand, handleVote, giveKit
      structures/
        index.js       -- challenge-structure registry (inline data defs)
    structures/
      ff/              -- shipped .mcstructure files (namespace "ff:")
  FB_Template/         -- world-template staging; behavior_packs/FF_BP is the post-build pristine copy
  Templates/           -- archive of built FB_v<version>.mctemplate files
  tools/               -- helper scripts (e.g. mcstructure_viewer.py)
```

**Working folder for script changes is `FF_BP/scripts/`.** As of v1.10.0 the logic is split across the modules above (smaller files also reduce the truncation/desync pain); `main.js` stays the manifest entry point and only holds init/wiring.

The pack is a **behavior pack only** (no resource pack). No custom entities, no custom blocks. Everything is done via Script API, `runCommand`, and `world.structureManager` for structure placement.

> **Tooling note (learned the hard way):** editing any `FF_BP/scripts/*.js` file with the editor file-tools and the shell in quick succession can desync and TRUNCATE the file in the shell's view. Treat the editor as the source of truth, pick ONE tool per file per burst, and verify with `node --check` afterward. Seen repeatedly: a file's *first* write reads back fine in the shell, but after an overwrite/edit the shell can serve a stale/truncated snapshot — and `node --check` then reports a bogus pass on it. When in doubt, verify by editor read-back and run `node --check` on the Windows side. A pristine pre-session copy lives in `FB_Template/behavior_packs/FF_BP/` after any build, and `git` is the real backstop.

---

## Technical Architecture

### API Version

- Minecraft Bedrock v26.x
- `@minecraft/server` version `2.7.0`
- Requires **Beta APIs** experiment enabled in world settings
- World type: **Flat with void preset** (important — see Platform section)
- Imports are per-module — each file imports only the `@minecraft/server` symbols it uses (across the pack: `world, system, BlockPermutation, ItemStack, EnchantmentTypes, EntityTypes, PlayerPermissionLevel`); structure defs come from `./structures/index.js`. Relative imports MUST include the `.js` extension.

### Key Design Decisions

**Falling blocks are animated via script**, not Minecraft physics. The script erases a block at its current Y and redraws it 3 blocks lower every tick via `dimension.runCommand("setblock ...")`. This runs on its own `system.runInterval(..., 1)` independent of the game logic loop.

**Gravity blocks** (sand, gravel, red sand, all 16 concrete powder variants) are placed statically at `blockDropY` with air below them, letting Minecraft's own physics handle the fall. Powder snow was moved to the animated pool because it does NOT obey gravity in Bedrock despite appearances. `GRAVITY_BLOCKS` is a `Set` checked in `dropBlock()` — any block in it skips animation and uses MC physics instead.

**Bedrock has no `falling_block` entity** (unlike Java). You cannot summon one. The animation approach is the only viable option.

**Commands use `/scriptevent`** (prefixed `ff:`) — `world.beforeEvents.chatSend` was removed in 2.x.

**Op check:** `player.playerPermissionLevel === PlayerPermissionLevel.Operator` — `player.isOp()` doesn't exist; `PlayerPermissionLevel` must be imported.

**Init uses a polling loop** waiting for `world.getAllPlayers().length > 0` — `world.afterEvents.worldLoad` doesn't exist in 2.7.0.

**`world.afterEvents.playerSpawn`** is used for player join handling (has `player` object + `initialSpawn` bool). `playerJoin` was not used because it only provides `playerName`, not the player entity.

**Loot chests are filled via `ItemStack` + `ItemEnchantableComponent`.** Items are created programmatically and placed in the chest's `BlockInventoryComponent` container. Enchantments use `EnchantmentTypes.get(name)` and `ec.addEnchantment({ type, level })`.

### Game Loop

Two separate intervals:

- `gameTick` fires every `CFG.tickInterval` (4) ticks -- handles wave rotation, block spawning per platform, per-platform chest timers, state persistence
- `stepDrops` fires every 1 tick -- handles block animation, landing detection, position saves

**Drop rate is per-platform.** Each active platform receives its own drop every `dropRate` ticks — more players does not dilute the drop rate per platform.

### Persistence

All state survives world reload via `world.setDynamicProperty()`:

- `ff:activeDrops` -- JSON array of `{ x, y, z, block }` for every block currently in flight.
- `ff:wave` -- JSON of `{ category, wave, waveTick, waveDur, nextStructureTick }`.
- `ff:tick` -- current game tick count.
- `ff:platforms` -- JSON object of `{ [platformId]: { playerUUID, playerName, nextChestTick, rarePity, mythicPity } }`.
- `ff:portals` -- JSON `{ netherBuilt: bool, endBuilt: bool }`.
- `ff:structures` -- JSON array of `{ x, y, z, type, tick, ring, r, h }` for every placed challenge structure (never despawn). `r` = footprint radius (size-aware spacing); `h` = height from `.mcstructure .size.y` (used by the proximity mob spawner's surface scan; old records lacking `h` default to 48).
- `ff:admins` / `ff:msgsMuted` -- admin UUID lists.
- `ff:structWeights` -- JSON `{ [type]: runningWeight }` for the weighted structure pity system (v1.9.0). Chosen structure → 0; every other available structure climbs by its `baseWeight` each spawn. Persisted so anti-repeat memory survives reloads.

See the Platform and Loot sections for the other persistence nuances (eager vs re-read loads, `loadDrops` sweep, `colHeightCache`, etc.) — unchanged from prior versions.

### Platform System

- **9 platforms** in a hardcoded 3x3 grid, each 32x32 bedrock at Y=-64. Layout 7-8-9 / 6-1-2 / 5-4-3, platform 1 = center (0,0), stride 35.
- Each platform spans `cx-16..cx+15`. The platform-only grid is **102×102**; `buildGapBedrock()` extends bedrock to the NW corner of platform 7 at (-54,-54), ~76.4 from center. Structures must clear this (see Challenge Structures → PLATFORM_CLEAR_RADIUS).
- Platforms only exist when assigned. `ensurePlatforms()` only rebuilds when center bedrock is confirmed missing (getBlock returns a defined non-bedrock block) — do NOT rebuild on `undefined` (unloaded chunk), it wipes player blocks.

(Full platform/assignment/portal details unchanged from v1.7.x — see git history / prior notes.)

### Portal Platforms

Two milestone platforms (Nether day 20, End day 30) build automatically at day thresholds, force-loaded via permanent `ff_nether` / `ff_end` ticking areas. `/scriptevent ff:portal <nether|end>` force-builds. Unchanged.

### Challenge Structures

Floating islands that spawn every 800–1600 game ticks in concentric rings around the platform grid, each with mobs and a phase-scaled loot chest. Persisted in `ff:structures` (never despawn). `/scriptevent ff:structure [spawn [type]]` spawns/reports.

**As of v1.8.x, structures are native `.mcstructure` files, not script-built.** The old per-file `build()` structures were removed.

- **Defs live inline in `FF_BP/scripts/structures/index.js`** — an array of data objects, each `{ type, label, structureId, mobs, lootTier, minPhase?, fireproof?, baseWeight?, spawns?, chests? }`, collected as `CHALLENGE_STRUCT_DEFS` (imported by `structures.js`; also by `commands.js`/`main.js` for the command lists + ID validation). The three v1.9.0 optionals: `baseWeight` (relative spawn frequency + pity recovery rate, default 10 — `casco_marry` is dropped to 3 so the 64×64 hulk stops dominating); `spawns` (array of `{x,y,z}` LOCAL offsets from the `.mcstructure` MIN corner giving explicit mob footing — the proximity spawner uses them with footing validation, else falls back to the surface scan); `chests` (array of `{x,y,z, rarity?, slots?}` LOCAL offsets — multiple chests of per-chest rarity/slot-count, no surface scan; omit to keep the single auto-scanned chest). The legacy `build()/height/chestOffset` contract is still supported by the spawner for backward compatibility, but no current structure uses it.
- **.mcstructure files live in `FF_BP/structures/ff/<name>.mcstructure`** → id `ff:<name>` (first subfolder = namespace). NO spaces in filenames. Placed at runtime via `world.structureManager.place(id, dim, originCorner, { includeEntities: false })`. `place()` anchors at the MIN corner, so the spawner offsets by half the footprint to center it. Height + footprint are read from `.size` automatically.
- **Footprint-aware placement (v1.8.1):** each structure's bounding radius `r = ceil(max(sizeX,sizeZ) * 0.71)` is computed up front (from `.size`; legacy = `DEFAULT_FOOT_R` 22) and persisted. Spacing requires `dist ≥ r_a + r_b + STRUCT_PAD (5)`. `PLATFORM_CLEAR_RADIUS = 85` keeps footprints off the platform grid (whose gap bedrock reaches ~76.4). Ring selection is SPATIAL: walk rings inner→outer (bands 95–140 / 150–200 / 210–270 / 280–350), 16 attempts each; a packed ring overflows outward. If every ring is full it defers (no slot consumed) — the "no space but cap not reached" case. `MAX_STRUCTURES = 32` (a soft ceiling geometry may prevent reaching). No pre-clear for native placements (void + place() overwrites its own volume), so big builds don't hit the 32,768 fill cap.
- **Chest & mobs (FF-controlled):** structures are authored BLOCKS-ONLY. After placement the spawner scans for an open surface (`findStructSurface`: solid footing below + air at spot + headroom) at the center column, then 12 nearby columns, then the roof (`findStructRoof`) as a guaranteed fallback, and places the loot chest there. **Mobs are NOT spawned at creation** (v1.8.4) — structures are far from players and Bedrock culls hostiles >128 blocks away, so build-time guards despawned instantly. Instead `spawnStructureMobs()` (proximity sweep from `gameTick`) spawns/refills guards only while a player is within `STRUCT_MOB_RADIUS`, capped at `STRUCT_MOB_CAP`, on found footing only (never over void), and non-persistent (they despawn when the player leaves). `fireproof: true` grants fire resistance so undead survive daylight while engaged. Note: script `spawnEntity` ignores light level — lit interiors do NOT block spawns.
- **Authoring checklist:** export blocks-only (no command/barrier/bedrock/beacon/spawner/light blocks, no workstations, no pre-filled containers — the FF loot system owns loot). Remove the structure_block export anchor. Leave the center column open at the floor for the cleanest chest spot. A scan/fix helper for palettes + container contents was used in v1.8.2 (little-endian NBT round-trip in Python).
- **Current set (10):** castillo_medieval, large_library_observatory (mid+), casco_marry (huge, ~64×64×100), casinha_de_bruxa, tower_1, medieval_house_1, medieval_house_2, evil_tower_1 (mid+), nether_house_1 (mid+), triple_treehouse.

---

## Config (CFG object in config.js)

| Key | Value | Notes |
|---|---|---|
| `platformSize` | 32 | Platform width/depth |
| `platformStride` | 35 | Distance between platform centers |
| `platformY` | -64 | Platform Y level |
| `platformBlock` | `minecraft:bedrock` | Platform material |
| `spawnY` | -62 | Player spawn height |
| `blockDropY` | 200 | Y blocks spawn at -- do not lower without asking |
| `tickInterval` | 4 | Game logic tick rate |
| `dropStepSize` | 3 | Blocks moved per animation tick |
| `chestInterval` | 1000 | Game ticks between chest spawns per platform |
| `voteCooldown` | 300 | Game ticks between successful votes |

Wave durations and weights live in `WAVE_CATEGORIES`. Block pools (5 core + 5 themed), the wave system (Calm/Events/Storms/Blackout), and the loot system (phase-scaled tiers, pity, spawn eggs) are unchanged from v1.6/1.7 — see prior notes.

---

## Commands

All admin commands require op (`permissionLevel >= 2`). Player `ff:vote` is open to all.

| Command | Description |
|---|---|
| `ff:wave <wave\|category\|random>` | Force a wave / random wave from a category / fully random |
| `ff:rate <1-200\|reset>` | Override / reset drop rate |
| `ff:loot [1-9]` | Spawn a loot chest on a platform (or all active) |
| `ff:spawnloot <1-9\|all> [rarity]` | Spawn a chest with optional forced rarity |
| `ff:chaos [ticks]` | Force chaos_storm temporarily |
| `ff:reset <1-9\|all>` | Clear/rebuild platform(s), restart calm (all resets tick to 0) |
| `ff:unassign <player\|1-9>` | Free a platform slot (by player name or number) so a new player can claim it; clears the platform. Manual only — no auto-free on disconnect |
| `ff:portal <nether\|end>` | Force-build / status a portal platform |
| `ff:structure [spawn [type]]` | Spawn a challenge structure (optional type), or report counts/rings |
| `ff:pause` / `ff:tp` / `ff:kit [name]` | Toggle pause / TP all to platforms / give starter kit |
| `ff:admin <add\|remove\|list> [name]` | Manage persisted admin-UUID fallback list |
| `ff:debug [on\|off]` / `ff:help` / `ff:msgs <on\|off>` | Debug info (no arg) or toggle verbose error logging to the content log (on/off) / command list / toggle OP messages |
| `ff:vote <calm\|events\|storms\|blackout>` | Player category vote |

**Valid wave names for `ff:wave`:** calm, gold_rush, ore_shower, meteor_strike, gravity_surge, nether_flare, deep_freeze, monster_swarm, pillager_raid, chaos_storm, nether_storm, end_storm, frozen_storm, cave_storm, blackout

**Valid category names for `ff:wave`:** calm, events, storms, blackout

**Valid structure types for `ff:structure spawn`:** castillo_medieval, large_library_observatory, casco_marry, casinha_de_bruxa, tower_1, medieval_house_1, medieval_house_2, evil_tower_1, nether_house_1, triple_treehouse (the `ff:structure`/`ff:help` lists are generated from `CHALLENGE_STRUCT_DEFS`, so this stays in sync automatically)

---

## Known Issues / Rough Edges

- **Gravity blocks** falling via MC physics can occasionally duplicate if a block update triggers them while the script is also placing one. Rare.
- **Enchanted item placement in chests** via `ItemEnchantableComponent` should work in 2.7.0 but has not been fully verified in-game.
- **structureManager.place() timing:** the spawner reads structure blocks back ~1 tick after placement to find a chest surface. place() should write synchronously into the force-loaded chunk, but this hasn't been confirmed live in 2.7.0 — if a chest ever lands on the roof of a structure with an obviously open interior, bump the settle delay.
- **Large structures:** `casco_marry` is ~64×64×100 (footprint radius ~46); it almost always lands in outer rings and dominates visually. Confirm that size is intentional.
- **File truncation risk:** see the Tooling note under File Structure.

### Distribution / Build

`build_template.bat` reads the version from `FF_BP/manifest.json`, syncs `FB_Template/manifest.json`, copies `FF_BP` into `FB_Template/behavior_packs/`, and zips `FB_Template/*` to `FB_v<version>.mctemplate` (Compress-Archive refuses `.mctemplate`, so it zips then renames). OUTPUT is derived dynamically — no manual edit needed on version bump. Behavior-pack folder names inside templates must be ≤10 chars (Xbox limit). The template uses `allow_random_seed: true` (no db folder), `lock_template_options: true`, and `base_game_version [1,21,0]`.

## Changelog

Full version history lives in `CHANGELOG.md`. The version-bump protocol is in **Instructions** at the top of this file.
