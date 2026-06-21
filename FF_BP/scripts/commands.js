// ─── COMMANDS + VOTE + KIT ─────────────────────────────────────────────────────
import { world, PlayerPermissionLevel } from "@minecraft/server";
import { state, store } from "./store.js";
import { CFG, STRUCT_RINGS, NETHER_PORTAL_TICK, END_PORTAL_TICK, TICKS_PER_DAY } from "./config.js";
import { WAVE_CATEGORIES, WAVE_BY_NAME, rollCategory, rollWaveInCategory, applyWave, restoreDropRate } from "./waves.js";
import { LOOT_TIERS, spawnLootChest } from "./loot.js";
import { isOp, isAdmin, getPlatformById, getPlayerByName, broadcast, adminMsg } from "./util.js";
import { clearAbovePlatformById, buildPlatformById, spawnAllPlayersToTheirPlatforms } from "./platforms.js";
import { buildNetherPortalPlatform, buildEndPortalPlatform } from "./portals.js";
import { buildChallengeStructure } from "./structures.js";
import { saveDrops, saveWaveState, savePlatformState, saveAdmins, saveMutedAdmins } from "./persistence.js";
import { CHALLENGE_STRUCT_DEFS } from "./structures/index.js";

// ─── KIT ─────────────────────────────────────────────────────────────────────
export function giveKit(target, sender) {
  const targets = target ? [target] : [...world.getAllPlayers()];
  const items   = [
    "minecraft:stone_sword 1",  "minecraft:stone_pickaxe 1",
    "minecraft:stone_axe 1",    "minecraft:stone_shovel 1",
    "minecraft:bread 16",       "minecraft:torch 32",
  ];
  for (const p of targets) {
    for (const i of items) { try { p.runCommand(`give @s ${i}`); } catch(_) {} }
    p.sendMessage("§aKit received!");
  }
  if (sender) sender.sendMessage(
    `§aKit given to ${target ? target.name : "everyone"}.`
  );
}

// ─── VOTE ─────────────────────────────────────────────────────────────────────
// Players vote for a category; a random wave within that category is applied if
// the vote passes.
export function handleVote(player, catName) {
  const valid = Object.keys(WAVE_CATEGORIES);
  if (!valid.includes(catName)) {
    player.sendMessage("§cUsage: /scriptevent ff:vote <calm|events|storms|blackout>");
    return;
  }
  const remain = CFG.voteCooldown - (state.tick - state.voteLastTick);
  if (remain > 0) {
    player.sendMessage(`§cVote cooldown: ${Math.ceil(remain / 5)}s left.`); // 5 game ticks = 1s
    return;
  }
  state.votes[player.name] = catName;
  const needed = Math.ceil(world.getAllPlayers().length / 2);
  const counts = {};
  for (const v of Object.values(state.votes)) counts[v] = (counts[v] ?? 0) + 1;
  broadcast(
    `§7[Vote] ${player.name} -> §e${catName}§7 ` +
    `(${Object.keys(state.votes).length}/${needed})`
  );
  for (const [cat, count] of Object.entries(counts)) {
    if (count >= needed) {
      state.votes = {}; state.voteLastTick = state.tick;
      const newWave = rollWaveInCategory(cat);
      applyWave(cat, newWave, { announce: true, categoryChanged: cat !== state.category });
      return;
    }
  }
}

// ─── ADMIN COMMANDS ───────────────────────────────────────────────────────────
export function handleCommand(player, cmd, arg, fullMsg) {
  if (!isOp(player)) { player.sendMessage("§cOp required."); return; }

  if (cmd === "wave") {
    const catNames  = Object.keys(WAVE_CATEGORIES);
    const waveNames = Object.keys(WAVE_BY_NAME);
    if (arg === "random") {
      const newCat  = rollCategory(state.category);
      const newWave = rollWaveInCategory(newCat);
      applyWave(newCat, newWave, { announce: true, categoryChanged: newCat !== state.category });
    } else if (waveNames.includes(arg)) {
      const wd = WAVE_BY_NAME[arg];
      applyWave(wd.category, arg, { announce: true, categoryChanged: wd.category !== state.category });
    } else if (catNames.includes(arg)) {
      const newWave = rollWaveInCategory(arg);
      applyWave(arg, newWave, { announce: true, categoryChanged: arg !== state.category });
    } else {
      player.sendMessage("§c/scriptevent ff:wave <wave|category|random>");
      player.sendMessage(`§7Categories: ${catNames.join(", ")}`);
      player.sendMessage(`§7Waves: ${waveNames.join(", ")}`);
    }

  } else if (cmd === "rate") {
    if (arg === "reset") {
      state.forceRate = null; restoreDropRate();
      player.sendMessage("§aDrop rate reset."); return;
    }
    const n = parseInt(arg);
    if (isNaN(n) || n < 1 || n > 200) {
      player.sendMessage("§c/scriptevent ff:rate <1-200>"); return;
    }
    state.forceRate = n;
    if (state.category !== "blackout") state.dropRate = n;
    player.sendMessage(`§aDrop rate: ${n} ticks.`);

  } else if (cmd === "loot") {
    if (arg) {
      const num      = parseInt(arg);
      const platform = getPlatformById(num);
      if (!platform || !store.platformState[num]) {
        player.sendMessage(`§cPlatform ${num} not active.`); return;
      }
      spawnLootChest(platform);
    } else {
      for (const idStr of Object.keys(store.platformState)) {
        const p = getPlatformById(parseInt(idStr));
        if (p) spawnLootChest(p);
      }
    }

  } else if (cmd === "spawnloot") {
    const parts     = fullMsg.trim().split(/\s+/);
    const platArg   = parts[0]?.toLowerCase() ?? "";
    const tierArg   = parts[1]?.toLowerCase() ?? "";
    const validTiers = ["common", "uncommon", "rare", "mythic"];
    let forcedTier  = null;
    if (tierArg) {
      if (!validTiers.includes(tierArg)) {
        player.sendMessage(`§cInvalid rarity. Use: common, uncommon, rare, mythic`); return;
      }
      forcedTier = LOOT_TIERS.find(t => t.name === tierArg) ?? null;
    }
    if (platArg === "all") {
      for (const idStr of Object.keys(store.platformState)) {
        const p = getPlatformById(parseInt(idStr));
        if (p) spawnLootChest(p, forcedTier);
      }
    } else {
      const num      = parseInt(platArg);
      const platform = getPlatformById(num);
      if (!platform || !store.platformState[num]) {
        player.sendMessage(`§cPlatform ${num} not active.`); return;
      }
      spawnLootChest(platform, forcedTier);
    }

  } else if (cmd === "chaos") {
    // Route through applyWave so drop rate / wave timer / persistence all update.
    // Overriding waveDur lets the normal rotation take over when chaos expires —
    // no restore-timeout race with naturally rolled waves.
    const dur = parseInt(arg) || 400; // game ticks
    applyWave("storms", "chaos_storm", { announce: true, categoryChanged: state.category !== "storms" });
    state.waveDur = dur;
    saveWaveState();
    player.sendMessage(`§aChaos for ${dur} game ticks.`);

  } else if (cmd === "reset") {
    if (!arg || arg === "all") {
      store.activeDrops = []; saveDrops();
      broadcast("§e[FF] Resetting all platforms...");
      for (const idStr of Object.keys(store.platformState)) {
        const p = getPlatformById(parseInt(idStr));
        if (p) { clearAbovePlatformById(p); buildPlatformById(p); delete store.colHeightCache[p.id]; }
      }
      spawnAllPlayersToTheirPlatforms();
      state.tick = 0; // must reset BEFORE applyWave — applyWave persists state.tick
      applyWave("calm", "calm", { announce: false });
      broadcast("§a[FF] Reset done.");
    } else {
      const num      = parseInt(arg);
      const platform = getPlatformById(num);
      if (!platform || !store.platformState[num]) {
        player.sendMessage(`§cPlatform ${num} not active.`); return;
      }
      const half = Math.floor(CFG.platformSize / 2);
      store.activeDrops = store.activeDrops.filter(d =>
        !(d.x >= platform.cx - half && d.x < platform.cx + half &&
          d.z >= platform.cz - half && d.z < platform.cz + half)
      );
      saveDrops();
      clearAbovePlatformById(platform);
      buildPlatformById(platform);
      delete store.colHeightCache[platform.id];   // stale heights would mis-bias the next drops
      const data  = store.platformState[num];
      const owner = world.getAllPlayers().find(p => p.id === data.playerUUID);
      if (owner) {
        try { owner.teleport({ x: platform.cx, y: CFG.spawnY, z: platform.cz }); } catch(_) {}
      }
      broadcast(`§e[FF] Platform ${num} reset.`);
    }

  } else if (cmd === "unassign") {
    // Free a platform slot so a new player can claim it. Accepts a platform number
    // (1-9) or a player name (matches the stored assignment, so it works even if
    // the player is offline). Clears the platform for a clean slate. Deliberately
    // manual — there's no auto-free on disconnect.
    let idStr = null;
    const num = parseInt(arg);
    if (!isNaN(num) && num >= 1 && num <= 9) {
      idStr = String(num);
    } else if (arg) {
      for (const [k, d] of Object.entries(store.platformState)) {
        if (d.playerName?.toLowerCase() === arg) { idStr = k; break; }
      }
      if (!idStr) {
        const online = getPlayerByName(arg);
        if (online) {
          for (const [k, d] of Object.entries(store.platformState)) {
            if (d.playerUUID === online.id) { idStr = k; break; }
          }
        }
      }
    }
    if (!idStr || !store.platformState[idStr]) {
      player.sendMessage("§cUsage: /scriptevent ff:unassign <player|1-9> — no matching active assignment.");
      return;
    }
    const freed = store.platformState[idStr];
    const p     = getPlatformById(parseInt(idStr));
    if (p) {
      const half = Math.floor(CFG.platformSize / 2);
      store.activeDrops = store.activeDrops.filter(d =>
        !(d.x >= p.cx - half && d.x < p.cx + half &&
          d.z >= p.cz - half && d.z < p.cz + half));
      store.dropsDirty = true;
      clearAbovePlatformById(p);
      buildPlatformById(p);
      delete store.colHeightCache[p.id];
    }
    delete store.platformState[idStr];
    savePlatformState();
    broadcast(`§e[FF] Platform ${idStr} unassigned — slot is now free.`);
    adminMsg(`§8[FF-OP] ${player.name} unassigned Platform ${idStr} from ${freed.playerName} (${freed.playerUUID})`);

  } else if (cmd === "pause") {
    state.paused = !state.paused;
    broadcast(state.paused ? "§e[FF] Paused." : "§a[FF] Resumed.");

  } else if (cmd === "tp") {
    spawnAllPlayersToTheirPlatforms();
    player.sendMessage("§aTPd everyone to their platforms.");

  } else if (cmd === "kit") {
    if (arg) {
      const target = getPlayerByName(arg);
      // Bail on a bad name — null target means "everyone" in giveKit.
      if (!target) { player.sendMessage(`§c[FF] Player '${arg}' not found.`); return; }
      giveKit(target, player);
    } else {
      giveKit(null, player);
    }

  } else if (cmd === "admin") {
    const subCmd = arg;
    const targetName = fullMsg?.split(/\s+/)[1] ?? null;
    const target = targetName ? getPlayerByName(targetName) : player;
    if (!target) { player.sendMessage(`§c[FF] Player not found.`); return; }
    if (subCmd === "add") {
      store.adminUUIDs.add(target.id);
      saveAdmins();
      player.sendMessage(`§a[FF] ${target.name} added to admin notifications.`);
    } else if (subCmd === "remove") {
      store.adminUUIDs.delete(target.id);
      saveAdmins();
      player.sendMessage(`§e[FF] ${target.name} removed from admin notifications.`);
    } else if (subCmd === "list") {
      const names = world.getAllPlayers().filter(p => store.adminUUIDs.has(p.id)).map(p => p.name);
      player.sendMessage(`§e[FF] Online admins: ${names.join(", ") || "none"}`);
      player.sendMessage(`§e[FF] Total registered: ${store.adminUUIDs.size}`);
    } else {
      player.sendMessage("§cUsage: /scriptevent ff:admin <add|remove|list> [playerName]");
    }

  } else if (cmd === "portal") {
    if (arg === "nether") {
      store.portalState.netherBuilt = false;  // allow rebuild if previous attempt failed
      buildNetherPortalPlatform();
      player.sendMessage("§e[FF] Building nether portal platform...");
    } else if (arg === "end") {
      store.portalState.endBuilt = false;
      buildEndPortalPlatform();
      player.sendMessage("§e[FF] Building end portal platform...");
    } else {
      const nd = Math.max(0, NETHER_PORTAL_TICK - state.tick);
      const ed = Math.max(0, END_PORTAL_TICK - state.tick);
      player.sendMessage(`§e[FF] Portals — Nether: ${store.portalState.netherBuilt ? "§abuilt" : `§cpending (~${Math.ceil(nd/TICKS_PER_DAY)} days)`}§e  End: ${store.portalState.endBuilt ? "§abuilt" : `§cpending (~${Math.ceil(ed/TICKS_PER_DAY)} days)`}`);
      player.sendMessage("§7Usage: /scriptevent ff:portal <nether|end>");
    }

  } else if (cmd === "structure") {
    const sub = arg.toLowerCase();
    if (sub === "spawn") {
      const typeArg = fullMsg.trim().split(/\s+/)[1]?.toLowerCase() ?? null;
      buildChallengeStructure(typeArg || undefined);
      player.sendMessage(`§e[FF] Spawning challenge structure${typeArg ? ` (${typeArg})` : ""}...`);
    } else {
      // List status
      const total   = store.structureState.length;
      const claimed = store.structureState.filter(s => s.cleared).length;
      player.sendMessage(`§e[FF] Challenge Structures: ${total} placed§7 (${claimed} conquered)`);
      player.sendMessage(`§e[FF] Next spawn at tick ${state.nextStructureTick} (current: ${state.tick})`);
      for (const r of STRUCT_RINGS) {
        const filled = store.structureState.filter(s => s.ring === r.id).length;
        player.sendMessage(`§7  Ring ${r.id} (r${r.minRadius}-${r.maxRadius}): ${filled} placed§7`);
      }
      const outer = store.structureState.filter(s => s.ring > STRUCT_RINGS.length).length;
      if (outer > 0) player.sendMessage(`§7  Outer rings (${STRUCT_RINGS.length + 1}+): ${outer} placed§7`);
      const types = CHALLENGE_STRUCT_DEFS.map(s => s.type);
      player.sendMessage(`§7Types: ${types.join(", ")}`);
      player.sendMessage(`§7Usage: /scriptevent ff:structure spawn [type]`);
    }

  } else if (cmd === "msgs") {
    if (arg === "off") {
      store.mutedAdminUUIDs.add(player.id);
      saveMutedAdmins();
      player.sendMessage("§7[FF] OP messages muted. Use /scriptevent ff:msgs on to restore.");
    } else if (arg === "on") {
      store.mutedAdminUUIDs.delete(player.id);
      saveMutedAdmins();
      player.sendMessage("§a[FF] OP messages enabled.");
    } else {
      const muted = store.mutedAdminUUIDs.has(player.id);
      player.sendMessage(`§e[FF] OP messages: ${muted ? "§coff" : "§aon"}§e. Usage: /scriptevent ff:msgs <on|off>`);
    }

  } else if (cmd === "debug") {
    if (arg === "on" || arg === "off") {
      state.debug = arg === "on";
      player.sendMessage(`§e[FF] Verbose error logging ${state.debug ? "§aON" : "§coff"}§e — caught errors print to the content log.`);
      return;
    }
    player.sendMessage(`§e[FF-DEBUG] permissionLevel = ${JSON.stringify(player.playerPermissionLevel)}`);
    player.sendMessage(`§e[FF-DEBUG] isOp = ${isOp(player)}, isAdmin = ${isAdmin(player)}`);
    player.sendMessage(`§e[FF-DEBUG] PlayerPermissionLevel.Operator = ${PlayerPermissionLevel.Operator}`);
    player.sendMessage(`§e[FF-DEBUG] tick = ${state.tick}, category = ${state.category}, wave = ${state.wave}, drops = ${store.activeDrops.length}`);
    player.sendMessage(`§e[FF-DEBUG] verbose logging = ${state.debug}  (toggle: ff:debug on|off)`);

  } else if (cmd === "help") {
    [
      "§e--- FallingFalling v1.11.0 Commands ---",
      "§f/scriptevent ff:wave <wave|category|random>",
      "§7  Categories: calm, events, storms, blackout",
      "§7  Waves: calm, gold_rush, ore_shower, meteor_strike, gravity_surge,",
      "§7         nether_flare, deep_freeze, monster_swarm, pillager_raid,",
      "§7         chaos_storm, nether_storm, end_storm, frozen_storm,",
      "§7         cave_storm, blackout",
      "§f/scriptevent ff:rate <1-200> | reset",
      "§f/scriptevent ff:loot [1-9]",
      "§f/scriptevent ff:spawnloot <1-9|all> [common|uncommon|rare|mythic]",
      "§f/scriptevent ff:chaos [ticks]",
      "§f/scriptevent ff:reset <1-9|all>",
      "§f/scriptevent ff:unassign <player|1-9>",
      "§f/scriptevent ff:portal <nether|end>",
      "§f/scriptevent ff:structure [spawn [type]]",
      `§7  Types: ${CHALLENGE_STRUCT_DEFS.map(s => s.type).join(", ")}`,
      "§f/scriptevent ff:pause",
      "§f/scriptevent ff:tp",
      "§f/scriptevent ff:kit [player]",
      "§f/scriptevent ff:admin <add|remove|list> [player]",
      "§f/scriptevent ff:msgs <on|off>",
      "§f/scriptevent ff:debug [on|off]",
      "§7/scriptevent ff:vote <calm|events|storms|blackout>",
    ].forEach(l => player.sendMessage(l));

  } else {
    player.sendMessage("§cUnknown command. Try /scriptevent ff:help");
  }
}
