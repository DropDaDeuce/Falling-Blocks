// ─── LOOT PROGRESSION PHASES ─────────────────────────────────────────────────
// Loot quality is tied to the world day counter (state.tick / TICKS_PER_DAY —
// the same clock that drives the portal milestones). Phases anchor to portals:
//   early: days 0-5   — stone/leather era, smaller chests, no mythics
//   mid:   days 5-20  — iron era, runs until the Nether portal spawns
//   late:  days 20-30 — Nether portal era; odds climb, netherite scrap drips
//   end:   day 30+    — End portal era; elytra / netherite / wither path open
import { state } from "./store.js";
import { TICKS_PER_DAY } from "./config.js";

// Phase ordering for minPhase comparisons.
export const PHASE_ORDER = ["early", "mid", "late", "end"];

export function currentDay() {
  return Math.floor(state.tick / TICKS_PER_DAY);
}
export function lootPhase() {
  const d = currentDay();
  return d < 5 ? "early" : d < 20 ? "mid" : d < 30 ? "late" : "end";
}
