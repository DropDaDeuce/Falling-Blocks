// ─── CHALLENGE STRUCTURES ─────────────────────────────────────────────────────
// Floating island structures that spawn at random intervals in concentric rings
// around the platform grid. Each has a themed build (native .mcstructure), mobs to
// fight, and a loot chest scaled to lootPhase(). Persisted in ff:structures; never
// despawn. Tunables live in config.js.
import { world, system } from "@minecraft/server";
import { state, store } from "./store.js";
import {
  CFG, STRUCT_RINGS, STRUCT_PAD, PLATFORM_CLEAR_RADIUS, DEFAULT_FOOT_R,
  MAX_STRUCTURES, STRUCT_MOB_RADIUS, STRUCT_MOB_CAP, STRUCT_MOB_COOLDOWN,
  DEFAULT_STRUCT_WEIGHT, CHEST_PROBE_OFFSETS,
} from "./config.js";
import { PHASE_ORDER, lootPhase } from "./phase.js";
import { LOOT_TIERS, fillChest } from "./loot.js";
import { rand, pick, getDim, isFooting, findStructSurface, findStructRoof, adminMsg, broadcast, logErr } from "./util.js";
import { saveStructureState, saveStructWeights } from "./persistence.js";
// Challenge structure definitions live in their own files under ./structures/.
// To add a new structure, see the instructions in structures/index.js.
import { CHALLENGE_STRUCT_DEFS } from "./structures/index.js";

// Bounding radius (half-diagonal) of a structure's XZ footprint. Native structures
// read their .mcstructure size; legacy build() structures use DEFAULT_FOOT_R.
export function structFootprint(nativeStruct) {
  if (!nativeStruct) return DEFAULT_FOOT_R;
  const sz = nativeStruct.size;
  return Math.ceil(Math.max(sz.x, sz.z) * 0.71);
}

// ─── STRUCTURE WEIGHTED PITY (v1.9.0) ──────────────────────────────────────────
// Anti-repeat + rarity dial. Each def carries an optional baseWeight (default
// DEFAULT_STRUCT_WEIGHT) setting its relative frequency. A running weight per type
// lives in store.structWeights: on each spawn the chosen type drops to 0 and every
// other AVAILABLE type gains its own baseWeight, so commons recover fast and rares
// stay rare. The selection is weighted by the current running weights, so a type
// just picked can't be chosen again until it accrues weight back. Persisted.
export function baseWeightOf(def) {
  const w = def.baseWeight;
  return (typeof w === "number" && w > 0) ? w : DEFAULT_STRUCT_WEIGHT;
}

// Weighted selection over `avail` (already phase-filtered). Seeds any not-yet-tracked
// type (e.g. one that just unlocked via minPhase) to the current average so it's
// neither starved nor instantly favored. Does NOT mutate pity — commit that only after
// a placement actually succeeds (see commitStructurePity). Falls back to uniform when
// every weight is 0. Returns the chosen def (or null on empty input).
export function pickWeightedStructure(avail) {
  if (avail.length === 0) return null;
  if (avail.length === 1) return avail[0];

  const tracked = avail.filter(d => store.structWeights[d.type] !== undefined);
  const avg = tracked.length
    ? tracked.reduce((s, d) => s + store.structWeights[d.type], 0) / tracked.length
    : 0;
  for (const d of avail) {
    if (store.structWeights[d.type] === undefined)
      store.structWeights[d.type] = avg > 0 ? Math.round(avg) : baseWeightOf(d);
  }

  const total = avail.reduce((s, d) => s + Math.max(0, store.structWeights[d.type]), 0);
  if (total <= 0) return pick(avail);

  let r = Math.random() * total;
  for (const d of avail) {
    r -= Math.max(0, store.structWeights[d.type]);
    if (r <= 0) return d;
  }
  return avail[avail.length - 1];
}

// Apply the pity update once a structure is confirmed placed: chosen type -> 0, every
// other available type climbs by its baseWeight. Safe whether or not `chosen` is in
// `avail` (a forced admin spawn of a gated type still zeroes its own weight).
export function commitStructurePity(chosen, avail) {
  for (const d of avail) {
    if (d.type !== chosen.type)
      store.structWeights[d.type] = (store.structWeights[d.type] ?? baseWeightOf(d)) + baseWeightOf(d);
  }
  store.structWeights[chosen.type] = 0;
  saveStructWeights();
}

// Cached .mcstructure size lookup (no chunk load) — used to map authored local offsets
// to world coords for mob spawn points. Cleared implicitly per session.
const structSizeCache = {};
export function getStructSize(def) {
  if (!def.structureId) return null;
  if (structSizeCache[def.structureId] !== undefined) return structSizeCache[def.structureId];
  let sz = null;
  try { const ns = world.structureManager.get(def.structureId); sz = ns ? ns.size : null; } catch(_) { sz = null; }
  structSizeCache[def.structureId] = sz;
  return sz;
}

// ─── Main structure spawner ───────────────────────────────────────────────────
export function buildChallengeStructure(forcedType) {
  if (store.structureState.length >= MAX_STRUCTURES) return;

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
      const tooClose = store.structureState.some(s => {
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
    adminMsg(`§8[FF-OP] Structure spawn deferred — no free space (${store.structureState.length}/${MAX_STRUCTURES} placed)`);
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
      } catch(e) { logErr(`structure.place ${def.type}`, e); }
    } else {
      const h = def.height + 6;
      run(`fill ${scx-15} ${sy-3} ${scz-15} ${scx+15} ${sy+h} ${scz+15} minecraft:air`);
      def.build(run, scx, sy, scz);
    }

    // Persist immediately — the structure is placed; chest/mobs settle just after.
    store.structureState.push({ x: scx, y: sy, z: scz, type: def.type, tick: state.tick, ring: ringId, r: footR, h: structH });
    saveStructureState();

    // Announce spawn
    const tierLabel =
      tierName === "mythic"   ? "§5✦ Mythic"   :
      tierName === "rare"     ? "§6★ Rare"     :
      tierName === "uncommon" ? "§bUncommon"   : "§7Common";
    broadcast(`§e[FF] §l⚔ ${def.label}§r §e(Ring ${ringId}) at §f(${scx}, ${sy}, ${scz})§e — ${tierLabel} §eloot inside!`);
    adminMsg(`§8[FF-OP] Structure: ${def.type} ring=${ringId} r=${footR} at (${scx}, ${sy}, ${scz}) tier=${tierName} total=${store.structureState.length}/${MAX_STRUCTURES}`);
    if (store.structureState.length >= MAX_STRUCTURES) {
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
export function spawnStructureMobs() {
  if (store.structureState.length === 0) return;
  const players = world.getAllPlayers();
  if (players.length === 0) return;
  const dim   = getDim();
  const phase = lootPhase();
  const R2    = STRUCT_MOB_RADIUS * STRUCT_MOB_RADIUS;

  for (const s of store.structureState) {
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
      } catch(err) { logErr(`spawnStructureMobs ${mob}`, err); }
    }
  }
}
