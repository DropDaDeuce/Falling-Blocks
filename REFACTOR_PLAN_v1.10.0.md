# FallingFalling — Modular Refactor Plan (v1.10.0)

**Purpose:** Split the ~2920-line `FF_BP/scripts/main.js` into focused ES modules **without changing any behavior.** This is a structural change only. No gameplay, balance, loot, or wave changes. If you find a bug while refactoring, note it but do **not** fix it in this pass — file it for a separate version.

**Read `CLAUDE.md` first.** This plan assumes the conventions there (version-bump protocol, file-truncation tooling note, build process).

---

## 0. Hard rules for this pass

1. **Behavior-preserving.** The compiled behavior must be identical to v1.9.1. The win is maintainability and smaller files (which also reduces the editor/shell desync truncation pain), not new features.
2. **One tool per file per burst.** Per the CLAUDE.md tooling note: do not mix the editor file-tools and the shell on the same file in quick succession — it can desync and TRUNCATE. Pick one tool per file, and verify after every edit.
3. **`node --check` after every file is created or moved.** This is the whole reason to do it in a fresh session: confirm the bash mount is NOT frozen before relying on it (see §6). If the mount is frozen again, STOP and fall back to editor read-backs — do not trust a stale `node --check`.
4. **Back up first.** Copy `FF_BP/scripts/main.js` to `FF_BP/scripts/main.js.pre-1.10.0.bak` before touching anything. A pristine copy also exists in `FB_Template/behavior_packs/FF_BP/` after any build.
5. **Incremental + verifiable.** Extract leaf modules first (pure data, zero dependencies), check, then work bottom-up. Do not move everything in one giant edit.

---

## 1. Current state (v1.9.1)

- Single source file: `FF_BP/scripts/main.js` (~2920 lines).
- One already-separate module: `FF_BP/scripts/structures/index.js` (exports `CHALLENGE_STRUCT_DEFS`). This proves Bedrock + `@minecraft/server` 2.7.0 supports local ES modules with **relative imports that include the `.js` extension**.
- Manifest entry point: `scripts/main.js` (do NOT change this — `main.js` stays the entry; everything else is imported from it).
- The root-level `scripts/` folder is an out-of-date copy. **Ignore it. `FF_BP` is the source of truth.**

---

## 2. The core design problem: shared mutable state + import cycles

Almost everything references a shared mutable `state` object and a handful of mutable module-level containers (`activeDrops`, `platformState`, `portalState`, `structureState`, `structWeights`, `colHeightCache`, `adminUUIDs`, `mutedAdminUUIDs`, `dropsDirty`). Several functions **reassign** these (`activeDrops = []`, `platformState = {}`, etc.).

**Gotcha:** ES module exports are *live bindings* but are *read-only from the importing side*. A module that imports `activeDrops` cannot do `activeDrops = []`. If you naively split, every reassignment breaks.

**Solution — one shared store object.** Create `store.js` exporting a single object that holds all mutable runtime state as properties. Functions mutate `store.activeDrops`, `store.platformState`, etc. Reassignment becomes `store.activeDrops = []`, which works across modules because every module references the same object identity.

```js
// store.js
export const state = {
  running: false, paused: false, debug: false, tick: 0, dropTick: 0,
  category: "calm", wave: "calm", waveTick: 0, waveDur: 0,
  dropRate: 4, voteLastTick: -9999, votes: {}, forceRate: null,
  nextStructureTick: 0,
};
export const store = {
  activeDrops: [], dropsDirty: false, colHeightCache: {},
  platformState: {}, portalState: { netherBuilt: false, endBuilt: false },
  structureState: [], structWeights: {},
  adminUUIDs: new Set(), mutedAdminUUIDs: new Set(),
};
```

Then e.g. `loadDrops` does `store.activeDrops = [...]`, `dropBlock` does `store.activeDrops.push(...)`, the reset command does `store.activeDrops = store.activeDrops.filter(...)`. **Do a global pass to confirm no bare `activeDrops`/`platformState`/etc. references survive** — they must all go through `store`. (`state` can stay a direct import since it's never reassigned, only its properties mutated.)

**Avoiding cycles — the dependency DAG (import downward only):**

```
main.js  (init, event subscriptions, runInterval wiring)
  ├─ commands.js        (handleCommand, handleVote)
  ├─ gameloop.js        (gameTick, stepDrops)   [or keep these in main.js]
  ├─ waves.js           (applyWave, rollers, computeDropRate, pickBlock*)
  │     └─ loot.js, platforms.js, structures.js, pools.js, store, util, config
  ├─ structures.js      (buildChallengeStructure, pity, spawnStructureMobs)
  │     └─ loot.js, util, store, config, phase.js, ./structures/index.js
  ├─ portals.js
  ├─ platforms.js       (build/gap/ensure/assign/join/tp, spawnMobsOnPlatform)
  ├─ loot.js            (LOOT_* tables, tiers, rollLootTier, fillChest, chests)
  │     └─ pools.js (SPAWN_EGGS), phase.js, util, store, config
  ├─ pools.js           (block pools + SPAWN_EGGS — pure data)
  ├─ phase.js           (currentDay, lootPhase, PHASE_ORDER — tiny)
  ├─ persistence.js     (PROP_* keys + all save/load)  → store, config
  ├─ util.js            (rand, pick, weightedPick, broadcast, logErr,
  │                      setBlockFast, adminMsg, titleAll, isOp/isAdmin,
  │                      getDim, findLandingY, isFooting, findStructSurface,
  │                      findStructRoof, getPlatformById, getPlayerByName)
  │     └─ store, config
  ├─ config.js          (CFG, PLATFORMS, portal consts, ring/struct tunables,
  │                      GRAVITY_BLOCKS, PASS_THROUGH, BLIND_FALL_Y, etc.)
  └─ store.js           (state + store objects — imported by almost everything)
```

Key acyclic facts to preserve:
- `loot.js` does NOT import `waves.js` (it only needs phase + pools + store). `waves.js` → `loot.js` is one-directional. Good.
- `waves.applyWave` calls `spawnLootChest` (loot) and `spawnMobsOnPlatform` + `getActivePlatforms` (platforms). Neither loot nor platforms import waves. Good.
- `drops` calls `pickBlock` (waves/blocks). Whatever module owns `pickBlock` must not import `drops`.
- `structures.js` → `loot.js` (for `fillChest`/`LOOT_TIERS`), never the reverse.
- If you hit an unavoidable cycle, break it with lazy access (`store`-mediated) or move the shared piece down the DAG. Do **not** paper over it with dynamic `import()`.

---

## 3. What goes in each module (from current top-to-bottom layout)

- **config.js** — `CFG`; `PLATFORMS`; `TICKS_PER_DAY`, `NETHER_PORTAL_TICK`, `END_PORTAL_TICK`, `PORTAL_NETHER`, `PORTAL_END`; `GRAVITY_BLOCKS`, `BLIND_FALL_Y`, `PASS_THROUGH`, `EDGE_INSET_BLOCKS`; structure tunables (`STRUCT_RINGS`, `STRUCT_SPAWN_MIN/MAX`, `STRUCT_PAD`, `PLATFORM_CLEAR_RADIUS`, `DEFAULT_FOOT_R`, `MAX_STRUCTURES`, `STRUCT_MOB_*`, `DEFAULT_STRUCT_WEIGHT`); `CHEST_PROBE_OFFSETS`; `BLACKOUT_DROP_RATE`. Pure constants, zero imports.
- **store.js** — `state`, `store` (see §2). Zero imports.
- **phase.js** — `PHASE_ORDER`, `currentDay()`, `lootPhase()`. Imports `store`, `config`.
- **pools.js** — `POOL_*` (TERRAIN, RESOURCE, HAZARD, RARE, CHAOS, NETHER, END, ICE, CAVE, GRAVITY), `SPAWN_EGGS`. Pure data.
- **loot.js** — `LOOT_COMMON/UNCOMMON/RARE/MYTHIC`, `LOOT_TIERS`, `rollLootTier`, `fillChest`, `fillStarterChest`, `spawnStarterChest`, `spawnLootChest`. Imports pools, phase, util, store, config.
- **util.js** — `rand`, `pick`, `weightedPick`, `broadcast`, `logErr`, `setBlockFast`, admin/notify helpers (`adminMsg`, `isAdmin`, `isOp`, `titleAll`), `getDim`, `findLandingY`, `isFooting`, `findStructSurface`, `findStructRoof`, `getPlatformById`, `getPlayerByName`. Imports store, config. (Note: admin/op helpers read `store.adminUUIDs` / `store.mutedAdminUUIDs` and `PlayerPermissionLevel`.)
- **persistence.js** — `PROP_*` keys + every `save*`/`load*` function. Imports store, config, util(broadcast), getDim. **Preserve the eager-load-may-return-empty behavior** — do not "fix" the top-level load timing.
- **platforms.js** — `clearVoidSpawnPlatform`, `buildPlatformById`, `clearAbovePlatformById`, `ensurePlatforms`, `buildGapBedrock`, `getPlatformForPlayer`, `assignNextPlatform`, `getActivePlatforms`, `handlePlayerJoin`, `spawnAllPlayersToTheirPlatforms`, `spawnMobsOnPlatform`. Imports store, config, util, persistence, loot (starter chest). NOTE: `handlePlayerJoin` calls `spawnStarterChest` (loot) + `buildGapBedrock`.
- **portals.js** — `buildNetherPortalPlatform`, `buildEndPortalPlatform`. Imports store, config, util(broadcast/adminMsg), persistence(savePortalState).
- **structures.js** — `structFootprint`, `baseWeightOf`, `pickWeightedStructure`, `commitStructurePity`, `getStructSize`/`structSizeCache`, `buildChallengeStructure`, `spawnStructureMobs`, `structMobTimers`. Imports `CHALLENGE_STRUCT_DEFS` from `./structures/index.js`, plus loot, phase, util, store, config, persistence.
- **waves.js** — `WAVE_CATEGORIES`, `WAVE_BY_NAME`, `CATEGORY_REPEAT_BONUS`, `rollCategory`, `rollWaveInCategory`, `computeDropRate`, `applyWave`, `restoreDropRate`, and block selection (`pickRare`, `pickChaos`, `pickBlockBalanced`, `pickBlock`). Imports pools, store, config, loot(spawnLootChest), platforms(spawnMobsOnPlatform/getActivePlatforms), util, persistence(saveWaveState). (If the waves↔platforms edge feels heavy, splitting `pickBlock` into its own `blocks.js` is optional and clean.)
- **drops.js** — `dropBlock`, `stepDrops`. Imports store, config, util(setBlockFast), waves(pickBlock), persistence(saveDrops).
- **commands.js** — `handleCommand`, `handleVote`, `giveKit`. Imports basically everything (it's an orchestrator near the top of the DAG — that's expected and fine).
- **main.js** — imports + `validateIds` + init sequence (`startGame`, `waitForPlayers`) + the two `system.runInterval` calls + `world.afterEvents.playerSpawn.subscribe` + `system.afterEvents.scriptEventReceive.subscribe`. **All top-level side effects live here and nowhere else.** `gameTick` and `stepDrops` can stay in `main.js` or move to a `gameloop.js` that `main.js` imports — either is fine; if separate, `main.js` still owns the `runInterval` wiring.

---

## 4. Recommended extraction order (each step ends with `node --check`)

1. **Backup** `main.js` (§0.4).
2. `config.js` — move pure constants. Re-import into `main.js`. `node --check` both.
3. `store.js` — create the `state`/`store` objects. **This is the big one:** convert every bare reference to the shared containers into `store.*`, and every reassignment too. Grep for each name (`activeDrops`, `platformState`, `portalState`, `structureState`, `structWeights`, `colHeightCache`, `adminUUIDs`, `mutedAdminUUIDs`, `dropsDirty`) and confirm zero bare survivors. Keep `state` as a direct import. Check.
4. `pools.js`, `phase.js` — pure/near-pure data. Check.
5. `util.js` — move helpers. Check.
6. `persistence.js` — move save/load + PROP keys. Check.
7. `loot.js`. Check.
8. `platforms.js`. Check.
9. `portals.js`. Check.
10. `structures.js`. Check.
11. `waves.js` (+ optional `blocks.js`). Check.
12. `drops.js`. Check.
13. `commands.js`. Check.
14. `main.js` is now just imports + init + wiring. Final `node --check` on every file.

At each step, `main.js` temporarily imports back whatever you just moved; by the end `main.js` only contains init/wiring. Keeping the steps small means a broken `node --check` points at the one module you just touched.

---

## 5. Bedrock ES module specifics (don't get bitten)

- **Relative imports must include `.js`**: `import { CFG } from "./config.js";` — not `"./config"`. (Match the existing `./structures/index.js` import.)
- **Subfolder imports** work (`./structures/index.js`), so a flat `scripts/*.js` layout is fine. Optionally group under `scripts/ff/` — but then update every relative path and keep `main.js` at `scripts/main.js` (manifest entry). Simplest: keep all new modules directly in `scripts/`.
- **No top-level side effects** except pure table-building (e.g. `WAVE_BY_NAME` construction is fine; calling `loadPlatformState()` at import time is NOT — that belongs in `main.js` init). Module top-level runs at import; order is determined by the import graph, and dynamic properties may not be readable that early (already a documented caveat).
- **`@minecraft/server` imports** are per-file: each module imports exactly the symbols it uses (`world`, `system`, `ItemStack`, `BlockPermutation`, `EnchantmentTypes`, `EntityTypes`, `PlayerPermissionLevel`). Don't re-export them through `util` — import directly where needed.
- **Build:** `build_template.bat` copies the whole `FF_BP` folder, so all new `scripts/*.js` files are included automatically. No build-script change needed. Confirm the behavior-pack folder name stays ≤10 chars (`FF_BP`, fine).

---

## 6. FIRST THING in the new session: confirm the bash mount is live

The previous two sessions hit a frozen bash mount — editor writes never propagated to the Linux side, so `node --check` silently checked a stale snapshot. **Before trusting any `node --check`, prove the mount is fresh:**

1. Make a trivial edit to a scratch file in the workspace via the editor.
2. `cat` it from bash. If you see the edit, the mount is live.
3. Also sanity-check `wc -l` of `main.js` from bash equals what the editor reports.

If the mount is frozen: either restart the session, or fall back to editor read-backs for verification (read every edited region, confirm brace/paren balance) and run `node --check` manually on Windows. **Do not report "verified" off a stale mount.**

---

## 7. Verification checklist (before declaring done)

- [ ] `node --check` passes on a **confirmed-fresh** mount for every `scripts/*.js`.
- [ ] Grep proves no bare references to the moved mutable containers survive (all go through `store`).
- [ ] No circular imports (if a module mysteriously sees `undefined` exports at runtime, suspect a cycle).
- [ ] In-game smoke test on a test world:
  - [ ] Join → platform builds, starter chest, spawnpoint set.
  - [ ] Blocks fall and stack; `ff:wave chaos_storm` then `ff:wave calm` rotate correctly.
  - [ ] Drop rate changes with wave (meteor faster, blackout stops).
  - [ ] `ff:loot` / `ff:spawnloot rare` fill chests correctly.
  - [ ] `ff:structure spawn` places a structure with a chest; approach it → guards spawn.
  - [ ] `ff:reset 1` clears + rebuilds; `ff:unassign 1` frees the slot.
  - [ ] `ff:portal nether` / `ff:portal end` build.
  - [ ] Reload the world → state resumes (wave, tick, drops in flight, structures, platforms).
  - [ ] `ff:debug on` then trigger something → errors appear in the content log.
  - [ ] Startup `validateIds` reports clean (no false positives from the move).

---

## 8. Version + docs

- This is **v1.10.0** (minor bump — large internal change, no gameplay change).
- Per CLAUDE.md protocol: confirm the version with Mathew, then update `FF_BP/manifest.json` (`header.version` **and** `modules.version`) and the version string in the `ff:help` output (now in `commands.js`).
- Update `CLAUDE.md`: the `## File Structure` tree (list the new `scripts/*.js` modules), `Last updated`, and add a `## Latest Version` entry summarizing the split + the module map.
- Run `node --check` on every file on the Windows side before building.

---

## 9. Out of scope for this pass (note, don't do)

- No gameplay/balance/loot/wave/structure-content changes.
- No "while I'm here" bug fixes — log them separately.
- No change to `structures/index.js` data or the `.mcstructure` files.
- No change to the manifest entry point or the build script.
```
