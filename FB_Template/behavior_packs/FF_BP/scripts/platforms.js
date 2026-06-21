// ─── PLATFORM FUNCTIONS ───────────────────────────────────────────────────────
import { world, system } from "@minecraft/server";
import { store } from "./store.js";
import { CFG, PLATFORMS } from "./config.js";
import { getDim, rand, findLandingY, broadcast, adminMsg, getPlatformById, logErr } from "./util.js";
import { savePlatformState, loadPlatformState } from "./persistence.js";
import { spawnStarterChest } from "./loot.js";

// Wipe the vanilla void-world spawn stone across the entire 9-platform footprint.
// Called once, just before platform 1 is built for the first time.
export function clearVoidSpawnPlatform() {
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
export function buildPlatformById(platform) {
  const dim  = getDim();
  const half = Math.floor(CFG.platformSize / 2);
  const x1 = platform.cx - half, x2 = platform.cx + half - 1;
  const z1 = platform.cz - half, z2 = platform.cz + half - 1;
  const run = (cmd) => { try { dim.runCommand(cmd); } catch(_) {} };
  // Clear 4 blocks BELOW the platform only — never above (would wipe landed blocks)
  run(`fill ${x1} ${CFG.platformY - 4} ${z1} ${x2} ${CFG.platformY - 1} ${z2} minecraft:air`);
  run(`fill ${x1} ${CFG.platformY} ${z1} ${x2} ${CFG.platformY} ${z2} ${CFG.platformBlock}`);
}

export function clearAbovePlatformById(platform) {
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
export function ensurePlatforms() {
  for (const idStr of Object.keys(store.platformState)) {
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
export function buildGapBedrock() {
  const dim = getDim();
  const gy  = CFG.platformY + 1;              // y=-63
  const h   = Math.floor(CFG.platformSize / 2); // 16
  // h     = 16 → platform spans cx-h..cx+h-1
  // gap   = 3 blocks wide
  // east edge at cx+h (16), east gap x=[cx+h, cx+h+2]
  // west edge at cx-h (-16), west gap x=[cx-h-3, cx-h-1] = [cx-19, cx-17]
  // south edge at cz+h (16), south gap z=[cz+h, cz+h+2]
  // north edge at cz-h (-16), north gap z=[cz-h-3, cz-h-1] = [cz-19, cz-17]
  for (const idStr of Object.keys(store.platformState)) {
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

// ─── PLATFORM ASSIGNMENT ─────────────────────────────────────────────────────
export function getPlatformForPlayer(uuid) {
  for (const [idStr, data] of Object.entries(store.platformState)) {
    if (data.playerUUID === uuid) return getPlatformById(parseInt(idStr));
  }
  return null;
}

export function assignNextPlatform(player) {
  for (const p of PLATFORMS) {
    if (!store.platformState[p.id]) {
      store.platformState[p.id] = {
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
export function getActivePlatforms() {
  const online = new Set(world.getAllPlayers().map(p => p.id));
  return Object.entries(store.platformState)
    .filter(([, d]) => online.has(d.playerUUID))
    .map(([idStr]) => getPlatformById(parseInt(idStr)))
    .filter(Boolean);
}

// ─── PLAYER SPAWN HANDLING ────────────────────────────────────────────────────
// NOTE: the world.afterEvents.playerSpawn subscription lives in main.js (all
// top-level side effects are owned there); it calls this function.
export function handlePlayerJoin(player) {
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

// ─── PLAYER TP ────────────────────────────────────────────────────────────────
export function spawnAllPlayersToTheirPlatforms() {
  for (const p of world.getAllPlayers()) {
    const platform = getPlatformForPlayer(p.id);
    if (platform) {
      try { p.teleport({ x: platform.cx, y: CFG.spawnY, z: platform.cz }); } catch(_) {}
    }
  }
}

// ─── MOB SPAWNING ─────────────────────────────────────────────────────────────
// Spawns mobs in the outer ring of a platform (3-6 blocks inside the edge).
// At half=16 and edgeDist=3-6, spawn x/z land 10-13 blocks from center —
// close enough to be a threat, far enough not to land on the player.
export function spawnMobsOnPlatform(platform, types, count) {
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
    } catch(e) { logErr("spawnMobsOnPlatform", e); }
  }
}
