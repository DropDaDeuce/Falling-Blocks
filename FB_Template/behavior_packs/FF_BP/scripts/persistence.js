// ─── PERSISTENCE ─────────────────────────────────────────────────────────────
// All state survives world reload via world dynamic properties.
import { world } from "@minecraft/server";
import { state, store } from "./store.js";
import { CFG } from "./config.js";
import { getDim, getPlatformById, broadcast } from "./util.js";

const PROP_DROPS      = "ff:activeDrops";
const PROP_WAVE       = "ff:wave";
const PROP_TICK       = "ff:tick";
const PROP_PLATFORMS  = "ff:platforms";
const PROP_ADMINS     = "ff:admins";
const PROP_MUTED      = "ff:msgsMuted";
const PROP_PORTALS    = "ff:portals";
const PROP_STRUCTURES = "ff:structures";
const PROP_STRUCT_WEIGHTS = "ff:structWeights";

export function saveDrops() {
  try {
    const data = store.activeDrops.map(d => ({ x: d.x, y: d.y, z: d.z, block: d.block, p: d.platformId }));
    world.setDynamicProperty(PROP_DROPS, JSON.stringify(data));
  } catch(_) {}
}

export function loadDrops() {
  try {
    const dim  = getDim();
    const half = Math.floor(CFG.platformSize / 2);

    // Sweep blockDropY across all assigned platforms. Blocks added to activeDrops
    // after the last periodic save won't be in saved data, but they're always
    // sitting at blockDropY in the world — clear them so they don't stick.
    for (const idStr of Object.keys(store.platformState)) {
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
    store.activeDrops = [];
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
      // d.p may be undefined for blocks saved before v1.9.1 — harmless, the
      // column-height cache simply repopulates as those blocks land.
      store.activeDrops.push({ x: d.x, y: d.y, z: d.z, block: d.block, platformId: d.p });
    }
    if (store.activeDrops.length > 0)
      broadcast(`§e[FF] Resumed ${store.activeDrops.length} block(s) in flight.`);
  } catch(_) { store.activeDrops = []; }
}

export function saveWaveState() {
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

export function loadWaveState() {
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

export function savePlatformState() {
  try {
    world.setDynamicProperty(PROP_PLATFORMS, JSON.stringify(store.platformState));
  } catch(_) {}
}

export function loadPlatformState() {
  try {
    const raw = world.getDynamicProperty(PROP_PLATFORMS);
    store.platformState = raw ? JSON.parse(raw) : {};
  } catch(_) { store.platformState = {}; }
}

export function savePortalState() {
  try { world.setDynamicProperty(PROP_PORTALS, JSON.stringify(store.portalState)); } catch(_) {}
}
export function loadPortalState() {
  try {
    const raw = world.getDynamicProperty(PROP_PORTALS);
    store.portalState = raw ? JSON.parse(raw) : { netherBuilt: false, endBuilt: false };
  } catch(_) { store.portalState = { netherBuilt: false, endBuilt: false }; }
}

export function saveStructureState() {
  try { world.setDynamicProperty(PROP_STRUCTURES, JSON.stringify(store.structureState)); } catch(_) {}
}
export function loadStructureState() {
  try {
    const raw = world.getDynamicProperty(PROP_STRUCTURES);
    store.structureState = raw ? JSON.parse(raw) : [];
  } catch(_) { store.structureState = []; }
}

export function saveStructWeights() {
  try { world.setDynamicProperty(PROP_STRUCT_WEIGHTS, JSON.stringify(store.structWeights)); } catch(_) {}
}
export function loadStructWeights() {
  try {
    const raw = world.getDynamicProperty(PROP_STRUCT_WEIGHTS);
    store.structWeights = raw ? JSON.parse(raw) : {};
  } catch(_) { store.structWeights = {}; }
}

export function loadAdmins() {
  try {
    const raw = world.getDynamicProperty(PROP_ADMINS);
    store.adminUUIDs = new Set(raw ? JSON.parse(raw) : []);
  } catch(_) { store.adminUUIDs = new Set(); }
}
export function saveAdmins() {
  try { world.setDynamicProperty(PROP_ADMINS, JSON.stringify([...store.adminUUIDs])); } catch(_) {}
}

export function loadMutedAdmins() {
  try {
    const raw = world.getDynamicProperty(PROP_MUTED);
    store.mutedAdminUUIDs = new Set(raw ? JSON.parse(raw) : []);
  } catch(_) { store.mutedAdminUUIDs = new Set(); }
}
export function saveMutedAdmins() {
  try { world.setDynamicProperty(PROP_MUTED, JSON.stringify([...store.mutedAdminUUIDs])); } catch(_) {}
}
