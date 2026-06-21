// ─── FallingFalling — entry point ──────────────────────────────────────────────
// v1.10.0 modular refactor: the former ~2900-line monolith is split into focused
// modules (config, store, pools, phase, util, persistence, loot, platforms,
// portals, structures, waves, drops, commands). This file owns ONLY: startup ID
// validation, the game-logic tick (gameTick), the init/restore sequence, the two
// runInterval wirings, and the event subscriptions. All top-level side effects
// live here and nowhere else.
import { world, system, BlockPermutation, ItemStack, EntityTypes } from "@minecraft/server";

import { state, store } from "./store.js";
import {
  CFG, NETHER_PORTAL_TICK, END_PORTAL_TICK,
  STRUCT_FIRST_SPAWN, STRUCT_SPAWN_INTERVAL, STRUCT_MOB_CHECK, GRAVITY_BLOCKS,
} from "./config.js";
import { PHASE_ORDER } from "./phase.js";
import {
  POOL_TERRAIN, POOL_RESOURCE, POOL_HAZARD, POOL_RARE, POOL_CHAOS,
  POOL_NETHER, POOL_END, POOL_ICE, POOL_CAVE, POOL_GRAVITY, SPAWN_EGGS,
} from "./pools.js";
import { LOOT_COMMON, LOOT_UNCOMMON, LOOT_RARE, LOOT_MYTHIC, LOOT_TIERS, spawnLootChest } from "./loot.js";
import {
  WAVE_CATEGORIES, WAVE_BY_NAME, rollCategory, rollWaveInCategory,
  applyWave, restoreDropRate,
} from "./waves.js";
import { rand, adminMsg, broadcast, getDim, getPlatformById } from "./util.js";
import {
  getActivePlatforms, spawnMobsOnPlatform, ensurePlatforms, buildGapBedrock,
  handlePlayerJoin,
} from "./platforms.js";
import { buildNetherPortalPlatform, buildEndPortalPlatform } from "./portals.js";
import { buildChallengeStructure, spawnStructureMobs } from "./structures.js";
import { dropBlock, stepDrops } from "./drops.js";
import { handleCommand, handleVote } from "./commands.js";
import {
  loadPlatformState, loadAdmins, loadMutedAdmins, loadWaveState, loadPortalState,
  loadStructureState, loadStructWeights, loadDrops, saveWaveState, savePlatformState,
} from "./persistence.js";
import { CHALLENGE_STRUCT_DEFS } from "./structures/index.js";

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
  const checkEntity = (id) => {
    try { if (!EntityTypes.get(id)) bad.push(`entity:${id}`); } catch(_) { bad.push(`entity:${id}`); }
  };
  for (const id of [
    ...POOL_TERRAIN, ...POOL_RESOURCE, ...POOL_HAZARD,
    ...POOL_NETHER, ...POOL_END, ...POOL_ICE, ...POOL_CAVE, ...POOL_GRAVITY,
    ...GRAVITY_BLOCKS,
  ]) checkBlock(id);
  for (const e of [...POOL_RARE, ...POOL_CHAOS]) checkBlock(e.id);
  for (const e of [...LOOT_COMMON, ...LOOT_UNCOMMON, ...LOOT_RARE, ...LOOT_MYTHIC]) checkItem(e.id);
  for (const pool of Object.values(SPAWN_EGGS)) for (const id of pool) checkItem(id);

  // Mob ids — wave events (spawnMobs.types) and structure guards (def.mobs.<phase>).
  // A typo here used to fail silently inside spawnEntity's try/catch.
  const mobIds = new Set();
  for (const cat of Object.values(WAVE_CATEGORIES))
    for (const w of cat.waves)
      if (w.spawnMobs) for (const m of w.spawnMobs.types) mobIds.add(m);
  for (const d of CHALLENGE_STRUCT_DEFS)
    if (d.mobs) for (const ph of PHASE_ORDER)
      if (Array.isArray(d.mobs[ph])) for (const m of d.mobs[ph]) mobIds.add(m);
  for (const id of mobIds) checkEntity(id);

  // Structure author-data: per-phase lootTier and per-chest rarity overrides must be
  // real tier names, otherwise they silently fall back to the structure tier at runtime.
  const tierNames = new Set(LOOT_TIERS.map(t => t.name));
  for (const d of CHALLENGE_STRUCT_DEFS) {
    if (d.lootTier) for (const ph of PHASE_ORDER) {
      const tn = d.lootTier[ph];
      if (tn && !tierNames.has(tn)) bad.push(`lootTier:${d.type}.${ph}=${tn}`);
    }
    if (Array.isArray(d.chests)) for (const c of d.chests) {
      if (c.rarity && !tierNames.has(c.rarity)) bad.push(`chestRarity:${d.type}=${c.rarity}`);
    }
  }
  // Invariant: every POOL_GRAVITY entry must also be in GRAVITY_BLOCKS — it's placed
  // statically and relies on MC physics; a miss would (wrongly) animate as a normal block.
  for (const id of POOL_GRAVITY) if (!GRAVITY_BLOCKS.has(id)) bad.push(`gravity-miss:${id}`);

  const unique = [...new Set(bad)];
  if (unique.length > 0) {
    console.warn(`[FF] ${unique.length} invalid ID(s): ${unique.join(", ")}`);
    adminMsg(`§c[FF-OP] ${unique.length} invalid ID(s) in pools/loot (see content log): ${unique.slice(0, 5).join(", ")}${unique.length > 5 ? " …" : ""}`);
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
  for (const [idStr, data] of Object.entries(store.platformState)) {
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
    adminMsg(`§8[FF-OP] ${store.activeDrops.length} block(s) in flight | ${getActivePlatforms().length} platform(s) active | tick ${state.tick} | ${state.category}/${state.wave}`);
  }

  // Periodic jobs are staggered across the 100-tick cycle (offsets 0/25/50/75) so
  // the per-100-tick save + portal + structure work doesn't all land on one tick
  // and produce a visible hitch. (Fix #6, v1.9.1.)
  if (state.tick % 100 === 0) saveWaveState();
  if (chestTimerDirty || state.tick % 100 === 50) savePlatformState();

  // Portal platform milestones — checked once per 100-tick cycle (offset 25)
  if (state.tick % 100 === 25) {
    if (!store.portalState.netherBuilt && state.tick >= NETHER_PORTAL_TICK) {
      buildNetherPortalPlatform();
    }
    if (!store.portalState.endBuilt && state.tick >= END_PORTAL_TICK) {
      buildEndPortalPlatform();
    }
  }

  // Challenge structure spawning — one per in-game day, no cap (offset 75).
  if (state.tick % 100 === 75) {
    if (state.nextStructureTick === 0) {
      // First run: seed the first spawn one full day in (≈ start of day 2).
      state.nextStructureTick = STRUCT_FIRST_SPAWN;
    } else if (state.tick >= state.nextStructureTick) {
      buildChallengeStructure();
      state.nextStructureTick = state.tick + STRUCT_SPAWN_INTERVAL;
      saveWaveState();
    }
  }

  // Structure guards — spawn/refill only while a player is near each structure.
  if (state.tick % STRUCT_MOB_CHECK === 0) spawnStructureMobs();
}

// ─── EVENT SUBSCRIPTIONS ──────────────────────────────────────────────────────
world.afterEvents.playerSpawn.subscribe((ev) => {
  if (!ev.initialSpawn) return;
  system.run(() => handlePlayerJoin(ev.player));
});

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
