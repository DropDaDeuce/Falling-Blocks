// ─── DROP SYSTEM ─────────────────────────────────────────────────────────────
import { state, store } from "./store.js";
import { CFG, GRAVITY_BLOCKS, EDGE_INSET_BLOCKS, BLIND_FALL_Y, PASS_THROUGH } from "./config.js";
import { rand, getDim, setBlockFast } from "./util.js";
import { pickBlock } from "./waves.js";
import { saveDrops } from "./persistence.js";

export function dropBlock(platform) {
  if (state.wave === "blackout") return;

  const half    = Math.floor(CFG.platformSize / 2);
  const cache   = store.colHeightCache[platform.id] ?? {};
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
    store.activeDrops.push({ x, y: CFG.blockDropY, z, block, platformId: platform.id });
    store.dropsDirty = true;
  }
}

// Runs every real tick — animates falling blocks independently of gameTick
export function stepDrops() {
  if (!state.running || state.paused) return;
  state.dropTick++;
  if (store.activeDrops.length === 0) return;

  const dim      = getDim();
  const toRemove = [];

  for (let i = 0; i < store.activeDrops.length; i++) {
    const d     = store.activeDrops[i];
    const curY  = d.y;
    const nextY = curY - CFG.dropStepSize;

    setBlockFast(dim, d.x, curY, d.z, "minecraft:air");

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
      setBlockFast(dim, d.x, curY, d.z, d.block);
      continue;
    }

    if (landed) {
      const landY = hitY + 1;
      setBlockFast(dim, d.x, landY, d.z, d.block);
      // Update column-height cache for drop-targeting bias
      if (d.platformId !== undefined) {
        if (!store.colHeightCache[d.platformId]) store.colHeightCache[d.platformId] = {};
        store.colHeightCache[d.platformId][`${d.x},${d.z}`] = landY + 1; // next available slot above placed block
      }
      toRemove.push(i);
    } else {
      d.y = nextY;
      setBlockFast(dim, d.x, nextY, d.z, d.block);
    }
  }

  if (toRemove.length > 0) {
    for (let i = toRemove.length - 1; i >= 0; i--) store.activeDrops.splice(toRemove[i], 1);
    store.dropsDirty = true;
  }
  // Throttled persistence: flush at most once per 10 ticks, and only when the
  // in-flight set actually changed (landing or new drop). Previously this saved
  // on every landing tick — a full JSON serialize + setDynamicProperty per tick
  // during storms. (Fix #4, v1.9.1.)
  if (store.dropsDirty && state.dropTick % 10 === 0) {
    saveDrops();
    store.dropsDirty = false;
  }
}
