// ─── UTILITIES ────────────────────────────────────────────────────────────────
import { world, PlayerPermissionLevel } from "@minecraft/server";
import { state, store } from "./store.js";
import { CFG, PLATFORMS } from "./config.js";

export function rand(min, max) {
  return Math.floor(Math.random() * (max - min + 1)) + min;
}
export function pick(arr) {
  return arr[Math.floor(Math.random() * arr.length)];
}
export function weightedPick(weights) {
  const total = weights.reduce((s, e) => s + e.w, 0);
  let r = Math.random() * total;
  for (const e of weights) { r -= e.w; if (r <= 0) return e.pool; }
  return weights[weights.length - 1].pool;
}
export function broadcast(msg) {
  try { world.sendMessage(msg); } catch(_) {}
}
// Verbose error logging — only emits when state.debug is on (toggle via ff:debug
// on|off). The codebase swallows exceptions broadly to stay crash-proof; this lets
// the important catches surface to the content log when something's actually wrong.
export function logErr(ctx, e) {
  if (!state.debug) return;
  try { console.warn(`[FF] ${ctx}: ${e?.message ?? e}`); } catch(_) {}
}
// Fast block write: prefer the script API (getBlock().setType) — far cheaper than
// the command parser — and fall back to /setblock only when getBlock returns
// undefined (high, sparse subchunks above BLIND_FALL_Y where the API is unreliable;
// see BLIND_FALL_Y). Used by the per-tick fall animation. (Fix #5, v1.9.1.)
export function setBlockFast(dim, x, y, z, typeId) {
  try {
    const b = dim.getBlock({ x, y, z });
    if (b) { b.setType(typeId); return true; }
  } catch(_) { /* fall through to the command path */ }
  try { dim.runCommand(`setblock ${x} ${y} ${z} ${typeId}`); } catch(_) {}
  return false;
}
export function isAdmin(player) {
  return store.adminUUIDs.has(player.id);
}
// Sends a message only to online OPs — debug/status info.
// Uses PlayerPermissionLevel enum; falls back to manual UUID list if API returns undefined.
export function adminMsg(msg) {
  for (const p of world.getAllPlayers()) {
    try {
      if (store.mutedAdminUUIDs.has(p.id)) continue;
      const lvl = p.playerPermissionLevel;
      const opByLevel = lvl !== undefined
        ? (lvl === PlayerPermissionLevel.Operator || lvl === PlayerPermissionLevel.Custom)
        : isAdmin(p);
      if (opByLevel) p.sendMessage(msg);
    } catch(_) {}
  }
}
export function titleAll(title, subtitle) {
  for (const p of world.getAllPlayers()) {
    try {
      p.onScreenDisplay.setTitle(title, {
        subtitle: subtitle ?? "",
        fadeInDuration: 5, stayDuration: 60, fadeOutDuration: 20,
      });
    } catch(_) {}
  }
}
export function isOp(player) {
  try {
    const lvl = player.playerPermissionLevel;
    if (lvl === undefined) {
      // API didn't expose the level — fall back to the persisted admin list.
      // Fail open ONLY while no admins are registered (bootstrap escape hatch),
      // otherwise every player would silently become an op.
      return isAdmin(player) || store.adminUUIDs.size === 0;
    }
    return lvl === PlayerPermissionLevel.Operator || lvl === PlayerPermissionLevel.Custom;
  } catch(_) { return isAdmin(player) || store.adminUUIDs.size === 0; }
}
export function getDim() {
  return world.getDimension("overworld");
}
export function findLandingY(dim, x, z) {
  for (let y = CFG.platformY + 1; y <= CFG.blockDropY; y++) {
    try {
      const b = dim.getBlock({ x, y, z });
      if (b && b.typeId === "minecraft:air") return y;
    } catch(_) { return CFG.platformY + 1; }
  }
  return CFG.platformY + 1;
}
// A block counts as footing if it exists, isn't air, and isn't liquid.
export function isFooting(b) { return !!b && !b.isAir && !b.isLiquid; }

// Find a standing/chest spot inside a FLOATING structure: scan a column from the
// structure base upward for the first Y with solid footing below and air at the spot
// plus headroom above. Returns the Y, or null if the column has no such surface.
// (findLandingY can't be used here — it finds the first AIR from platformY up, which
// for a floating island is the void *below* the structure.)
export function findStructSurface(dim, x, z, baseY, maxY) {
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
export function findStructRoof(dim, x, z, baseY, maxY) {
  for (let y = maxY; y >= baseY; y--) {
    try {
      const b = dim.getBlock({ x, y, z });
      if (isFooting(b)) return y + 1;
    } catch(_) {}
  }
  return baseY;
}

export function getPlatformById(id) {
  return PLATFORMS.find(p => p.id === id) ?? null;
}
export function getPlayerByName(name) {
  for (const p of world.getAllPlayers()) {
    if (p.name.toLowerCase() === name.toLowerCase()) return p;
  }
  return null;
}
