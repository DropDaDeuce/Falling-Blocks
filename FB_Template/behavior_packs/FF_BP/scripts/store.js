// ─── SHARED RUNTIME STATE ───────────────────────────────────────────────────
// One shared store object so cross-module reassignment works. ES module exports
// are live but read-only from the importing side: a module that imports a bare
// `activeDrops` cannot do `activeDrops = []`. By holding all mutable runtime state
// as properties of a single object (same identity in every module), reassignment
// becomes `store.activeDrops = []`, which works everywhere. (Refactor v1.10.0.)
//
// `state` is never reassigned (only its properties mutated), so it can be imported
// directly. Zero imports here — store sits at the bottom of the dependency graph.

export const state = {
  running:      false,
  paused:       false,
  debug:        false,   // verbose error logging to the content log (ff:debug on|off)
  tick:         0,
  dropTick:     0,
  category:     "calm",  // active category name
  wave:         "calm",  // active wave name within the category
  waveTick:     0,
  waveDur:      0,
  dropRate:     4,       // = CFG.tickInterval; overwritten on startup by applyWave/restoreDropRate
  voteLastTick:      -9999,
  votes:             {},
  forceRate:         null,
  nextStructureTick: 0,   // game tick when next challenge structure spawns
};

export const store = {
  // activeDrops: { x, y, z, block, platformId }
  activeDrops: [],
  // Set whenever activeDrops changes meaningfully (block landed or new drop added).
  // stepDrops flushes to the dynamic property on a throttle instead of saving on
  // every landing tick — see Fix #4 (v1.9.1).
  dropsDirty: false,
  // colHeightCache: { [platformId]: { "x,z": lastLandY } }
  // Lazily populated as blocks land. Used by dropBlock() to bias toward shorter columns.
  colHeightCache: {},
  // platformState: { [platformId]: { playerUUID, playerName, nextChestTick, rarePity, mythicPity } }
  // nextChestTick = -1 means "not yet initialized" (platform just assigned, game may not be running)
  platformState: {},
  // portalState: { netherBuilt: bool, endBuilt: bool }
  portalState: { netherBuilt: false, endBuilt: false },
  // structureState: [{ x, y, z, type, tick, ring, r, h }] — persistent list of all placed structures
  structureState: [],
  // structWeights: { [type]: runningWeight } — weighted anti-repeat / rarity dial (v1.9.0)
  structWeights: {},
  // Persisted set of admin player UUIDs. permissionLevel is undefined in this API
  // version, so we maintain our own list via ff:admin add/remove.
  adminUUIDs: new Set(),
  mutedAdminUUIDs: new Set(),
};
