// ─── PORTAL PLATFORMS ────────────────────────────────────────────────────────
// Two milestone platforms (Nether day 20, End day 30). Each uses /tickingarea to
// force-load the chunk regardless of player position, then defers block placement
// in phases so the area is ready to accept writes. Works identically for the
// ff:portal command and the automatic day-threshold trigger.
import { world, system } from "@minecraft/server";
import { store } from "./store.js";
import { CFG, PORTAL_NETHER, PORTAL_END } from "./config.js";
import { getDim, broadcast, adminMsg } from "./util.js";
import { savePortalState } from "./persistence.js";

export function buildNetherPortalPlatform() {
  const dim = getDim();
  const cx  = PORTAL_NETHER.cx;
  const cz  = PORTAL_NETHER.cz;
  const py  = CFG.platformY;
  const sy  = py + 1;  // surface level (one above bedrock floor)

  // Force-load chunk; kept permanently so portal area stays ticking
  try { dim.runCommand(`tickingarea add ${cx-14} ${py} ${cz-14} ${cx+13} ${py+20} ${cz+13} ff_nether`); } catch(_) {}

  // Phase 1 — floor and base terrain (5-tick delay for chunk load)
  system.runTimeout(() => {
    const run = (cmd) => { try { dim.runCommand(cmd); } catch(_) {} };

    // Base floor (28x28)
    // Outer ring: nether brick (2 thick)
    run(`fill ${cx-14} ${py} ${cz-14} ${cx+13} ${py} ${cz+13} minecraft:nether_brick`);
    // Second ring: cracked nether brick
    run(`fill ${cx-12} ${py} ${cz-12} ${cx+11} ${py} ${cz+11} minecraft:cracked_nether_bricks`);
    // Inner border: blackstone
    run(`fill ${cx-10} ${py} ${cz-10} ${cx+9}  ${py} ${cz+9}  minecraft:blackstone`);
    // Inner fill: netherrack
    run(`fill ${cx-8}  ${py} ${cz-8}  ${cx+7}  ${py} ${cz+7}  minecraft:netherrack`);
    // Center magma cross (altar feel)
    run(`fill ${cx-4}  ${py} ${cz-1}  ${cx+5}  ${py} ${cz+2}  minecraft:magma`);
    run(`fill ${cx-1}  ${py} ${cz-4}  ${cx+2}  ${py} ${cz+5}  minecraft:magma`);
    // Lava pools (2x2) in four quadrants, inset from edge
    run(`fill ${cx-12} ${py} ${cz-12} ${cx-11} ${py} ${cz-11} minecraft:lava`);
    run(`fill ${cx+10} ${py} ${cz-12} ${cx+11} ${py} ${cz-11} minecraft:lava`);
    run(`fill ${cx-12} ${py} ${cz+10} ${cx-11} ${py} ${cz+11} minecraft:lava`);
    run(`fill ${cx+10} ${py} ${cz+10} ${cx+11} ${py} ${cz+11} minecraft:lava`);
    // Soul sand gardens (4x4 in each quadrant)
    run(`fill ${cx-8} ${py} ${cz-8} ${cx-5} ${py} ${cz-5} minecraft:soul_sand`);
    run(`fill ${cx+4} ${py} ${cz-8} ${cx+7} ${py} ${cz-5} minecraft:soul_sand`);
    run(`fill ${cx-8} ${py} ${cz+4} ${cx-5} ${py} ${cz+7} minecraft:soul_sand`);
    run(`fill ${cx+4} ${py} ${cz+4} ${cx+7} ${py} ${cz+7} minecraft:soul_sand`);
    // Soul soil accent corners of soul sand patches
    run(`setblock ${cx-8} ${py} ${cz-8} minecraft:soul_soil`);
    run(`setblock ${cx+7} ${py} ${cz-8} minecraft:soul_soil`);
    run(`setblock ${cx-8} ${py} ${cz+7} minecraft:soul_soil`);
    run(`setblock ${cx+7} ${py} ${cz+7} minecraft:soul_soil`);
  }, 5);

  // Phase 2 — vegetation, lighting, wall bases (10-tick delay)
  system.runTimeout(() => {
    const run = (cmd) => { try { dim.runCommand(cmd); } catch(_) {} };

    // Nether wart on soul sand gardens
    run(`setblock ${cx-7} ${sy} ${cz-7} minecraft:nether_wart`);
    run(`setblock ${cx-6} ${sy} ${cz-6} minecraft:nether_wart`);
    run(`setblock ${cx+6} ${sy} ${cz-7} minecraft:nether_wart`);
    run(`setblock ${cx+5} ${sy} ${cz-6} minecraft:nether_wart`);
    run(`setblock ${cx-7} ${sy} ${cz+6} minecraft:nether_wart`);
    run(`setblock ${cx-6} ${sy} ${cz+5} minecraft:nether_wart`);
    run(`setblock ${cx+6} ${sy} ${cz+6} minecraft:nether_wart`);
    run(`setblock ${cx+5} ${sy} ${cz+5} minecraft:nether_wart`);
    // Wither roses scattered on soul sand
    run(`setblock ${cx-8} ${sy} ${cz-6} minecraft:wither_rose`);
    run(`setblock ${cx+7} ${sy} ${cz-6} minecraft:wither_rose`);
    run(`setblock ${cx-8} ${sy} ${cz+5} minecraft:wither_rose`);
    run(`setblock ${cx+7} ${sy} ${cz+5} minecraft:wither_rose`);
    // Shroomlight accent lights around magma cross
    run(`setblock ${cx-5} ${sy} ${cz}   minecraft:shroomlight`);
    run(`setblock ${cx+6} ${sy} ${cz}   minecraft:shroomlight`);
    run(`setblock ${cx}   ${sy} ${cz-5} minecraft:shroomlight`);
    run(`setblock ${cx}   ${sy} ${cz+6} minecraft:shroomlight`);
    // Crying obsidian border accents on blackstone ring
    run(`setblock ${cx-10} ${py} ${cz}   minecraft:crying_obsidian`);
    run(`setblock ${cx+9}  ${py} ${cz}   minecraft:crying_obsidian`);
    run(`setblock ${cx}    ${py} ${cz-10} minecraft:crying_obsidian`);
    run(`setblock ${cx}    ${py} ${cz+9}  minecraft:crying_obsidian`);
  }, 10);

  // Phase 3 — corner fortress towers (15-tick delay)
  system.runTimeout(() => {
    const run = (cmd) => { try { dim.runCommand(cmd); } catch(_) {} };

    // Four corner towers at approximately ±11 from center — nether brick walls 7 high
    for (const [ox, oz] of [[-11,-11],[10,-11],[-11,10],[10,10]]) {
      const tx = cx + ox;
      const tz = cz + oz;
      // Tower base footprint 4x4
      run(`fill ${tx} ${py} ${tz} ${tx+3} ${py} ${tz+3} minecraft:nether_brick`);
      // Tower walls (hollow box, 7 high)
      run(`fill ${tx}   ${sy}   ${tz}   ${tx+3} ${sy+6} ${tz}   minecraft:nether_brick`);
      run(`fill ${tx}   ${sy}   ${tz+3} ${tx+3} ${sy+6} ${tz+3} minecraft:nether_brick`);
      run(`fill ${tx}   ${sy}   ${tz}   ${tx}   ${sy+6} ${tz+3} minecraft:nether_brick`);
      run(`fill ${tx+3} ${sy}   ${tz}   ${tx+3} ${sy+6} ${tz+3} minecraft:nether_brick`);
      // Cracked nether brick at base of walls for ruined look
      run(`fill ${tx}   ${sy}   ${tz}   ${tx+3} ${sy+1} ${tz+3} minecraft:cracked_nether_bricks`);
      // Nether brick fence crenellation on top
      run(`setblock ${tx}   ${sy+7} ${tz}   minecraft:nether_brick_fence`);
      run(`setblock ${tx+2} ${sy+7} ${tz}   minecraft:nether_brick_fence`);
      run(`setblock ${tx}   ${sy+7} ${tz+2} minecraft:nether_brick_fence`);
      run(`setblock ${tx+2} ${sy+7} ${tz+2} minecraft:nether_brick_fence`);
      // Glowstone on top of each tower
      run(`fill ${tx}   ${sy+7} ${tz}   ${tx+3} ${sy+7} ${tz+3} minecraft:glowstone`);
      run(`setblock ${tx+1} ${sy+8} ${tz+1} minecraft:glowstone`);
      run(`setblock ${tx+2} ${sy+8} ${tz+1} minecraft:glowstone`);
      // Chain hanging from underside of glowstone (decor)
      run(`setblock ${tx+1} ${sy+6} ${tz+1} minecraft:chain`);
    }
  }, 15);

  // Phase 4 — wall ruins connecting the towers (20-tick delay)
  system.runTimeout(() => {
    const run = (cmd) => { try { dim.runCommand(cmd); } catch(_) {} };

    // Ruined walls between towers — 2 wide, 4 high, broken gaps left intentionally
    // North wall (between NW and NE towers)
    run(`fill ${cx-7} ${sy} ${cz-11} ${cx-2} ${sy+3} ${cz-11} minecraft:nether_brick`);
    run(`fill ${cx+1} ${sy} ${cz-11} ${cx+6} ${sy+3} ${cz-11} minecraft:nether_brick`);
    // South wall
    run(`fill ${cx-7} ${sy} ${cz+10} ${cx-2} ${sy+3} ${cz+10} minecraft:nether_brick`);
    run(`fill ${cx+1} ${sy} ${cz+10} ${cx+6} ${sy+3} ${cz+10} minecraft:nether_brick`);
    // West wall
    run(`fill ${cx-11} ${sy} ${cz-7} ${cx-11} ${sy+3} ${cz-2} minecraft:nether_brick`);
    run(`fill ${cx-11} ${sy} ${cz+1} ${cx-11} ${sy+3} ${cz+6} minecraft:nether_brick`);
    // East wall
    run(`fill ${cx+10} ${sy} ${cz-7} ${cx+10} ${sy+3} ${cz-2} minecraft:nether_brick`);
    run(`fill ${cx+10} ${sy} ${cz+1} ${cx+10} ${sy+3} ${cz+6} minecraft:nether_brick`);
    // Wall tops with fence crenellations
    run(`fill ${cx-7} ${sy+4} ${cz-11} ${cx-2} ${sy+4} ${cz-11} minecraft:nether_brick_fence`);
    run(`fill ${cx+1} ${sy+4} ${cz-11} ${cx+6} ${sy+4} ${cz-11} minecraft:nether_brick_fence`);
    run(`fill ${cx-7} ${sy+4} ${cz+10} ${cx-2} ${sy+4} ${cz+10} minecraft:nether_brick_fence`);
    run(`fill ${cx+1} ${sy+4} ${cz+10} ${cx+6} ${sy+4} ${cz+10} minecraft:nether_brick_fence`);
    // Chains hanging from wall gaps (atmospheric)
    run(`setblock ${cx-1} ${sy+2} ${cz-11} minecraft:chain`);
    run(`setblock ${cx}   ${sy+1} ${cz-11} minecraft:chain`);
    run(`setblock ${cx-1} ${sy+2} ${cz+10} minecraft:chain`);
    run(`setblock ${cx}   ${sy+1} ${cz+10} minecraft:chain`);
  }, 20);

  // Phase 5 — portal altar and obsidian gate (25-tick delay)
  system.runTimeout(() => {
    const run = (cmd) => { try { dim.runCommand(cmd); } catch(_) {} };

    // Raised obsidian altar platform under the portal (3x6 raised 1 block)
    run(`fill ${cx-2} ${sy}   ${cz-1} ${cx+3} ${sy}   ${cz+1} minecraft:obsidian`);
    // Portal frame: 6 wide x 5 tall obsidian (inner 4x3 portal space)
    run(`fill ${cx-2} ${sy+1} ${cz}   ${cx+3} ${sy+1} ${cz}   minecraft:obsidian`);
    run(`fill ${cx-2} ${sy+5} ${cz}   ${cx+3} ${sy+5} ${cz}   minecraft:obsidian`);
    run(`fill ${cx-2} ${sy+1} ${cz}   ${cx-2} ${sy+5} ${cz}   minecraft:obsidian`);
    run(`fill ${cx+3} ${sy+1} ${cz}   ${cx+3} ${sy+5} ${cz}   minecraft:obsidian`);
    // Crying obsidian accent blocks on frame corners
    run(`setblock ${cx-2} ${sy+1} ${cz} minecraft:crying_obsidian`);
    run(`setblock ${cx+3} ${sy+1} ${cz} minecraft:crying_obsidian`);
    run(`setblock ${cx-2} ${sy+5} ${cz} minecraft:crying_obsidian`);
    run(`setblock ${cx+3} ${sy+5} ${cz} minecraft:crying_obsidian`);
    // Portal fill (4 wide x 3 tall inner space)
    run(`fill ${cx-1} ${sy+2} ${cz} ${cx+2} ${sy+4} ${cz} minecraft:portal ["portal_axis"="z"]`);
    // Shroomlight pillars flanking the portal
    run(`fill ${cx-3} ${sy}   ${cz}   ${cx-3} ${sy+3} ${cz}   minecraft:shroomlight`);
    run(`fill ${cx+4} ${sy}   ${cz}   ${cx+4} ${sy+3} ${cz}   minecraft:shroomlight`);
    // Nether brick stair-style decor around altar base
    run(`setblock ${cx-2} ${sy} ${cz-1} minecraft:nether_brick_stairs ["weirdo_direction"=3]`);
    run(`setblock ${cx-2} ${sy} ${cz+1} minecraft:nether_brick_stairs ["weirdo_direction"=2]`);
    run(`setblock ${cx+3} ${sy} ${cz-1} minecraft:nether_brick_stairs ["weirdo_direction"=1]`);
    run(`setblock ${cx+3} ${sy} ${cz+1} minecraft:nether_brick_stairs ["weirdo_direction"=0]`);
    // Chains above portal frame
    run(`setblock ${cx}   ${sy+6} ${cz} minecraft:chain`);
    run(`setblock ${cx+1} ${sy+6} ${cz} minecraft:chain`);

    store.portalState.netherBuilt = true;
    savePortalState();
    broadcast("§c[FF] §l★§r §cA Nether Fortress has risen to the North! Day 20 reached.");
    adminMsg(`§8[FF-OP] Nether portal platform built at (${cx}, ${py}, ${cz})`);
  }, 25);
}

export function buildEndPortalPlatform() {
  const dim = getDim();
  const cx  = PORTAL_END.cx;
  const cz  = PORTAL_END.cz;
  const py  = CFG.platformY;
  const sy  = py + 1;  // surface level

  try { dim.runCommand(`tickingarea add ${cx-14} ${py} ${cz-14} ${cx+13} ${py+25} ${cz+13} ff_end`); } catch(_) {}

  // Phase 1 — floor layout (5-tick delay)
  system.runTimeout(() => {
    const run = (cmd) => { try { dim.runCommand(cmd); } catch(_) {} };

    // Base floor (28x28)
    // Outer ring: end stone bricks (2 thick)
    run(`fill ${cx-14} ${py} ${cz-14} ${cx+13} ${py} ${cz+13} minecraft:end_bricks`);
    // Second ring: polished blackstone (contrast trim)
    run(`fill ${cx-12} ${py} ${cz-12} ${cx+11} ${py} ${cz+11} minecraft:polished_blackstone`);
    // Third ring: purpur block
    run(`fill ${cx-10} ${py} ${cz-10} ${cx+9}  ${py} ${cz+9}  minecraft:purpur_block`);
    // Inner fill: end stone
    run(`fill ${cx-8}  ${py} ${cz-8}  ${cx+7}  ${py} ${cz+7}  minecraft:end_stone`);
    // Central raised altar (4x4, one block higher) for the portal room
    run(`fill ${cx-3}  ${sy}  ${cz-3}  ${cx+4}  ${sy}  ${cz+4}  minecraft:purpur_pillar`);
    // End rod lighting scattered on inner floor
    run(`setblock ${cx-7} ${sy} ${cz-7} minecraft:end_rod`);
    run(`setblock ${cx+6} ${sy} ${cz-7} minecraft:end_rod`);
    run(`setblock ${cx-7} ${sy} ${cz+6} minecraft:end_rod`);
    run(`setblock ${cx+6} ${sy} ${cz+6} minecraft:end_rod`);
    run(`setblock ${cx-5} ${sy} ${cz}   minecraft:end_rod`);
    run(`setblock ${cx+5} ${sy} ${cz}   minecraft:end_rod`);
    run(`setblock ${cx}   ${sy} ${cz-5} minecraft:end_rod`);
    run(`setblock ${cx}   ${sy} ${cz+5} minecraft:end_rod`);
    // Obsidian corner blocks on purpur ring for dramatic contrast
    for (const [ox, oz] of [[-10,-10],[9,-10],[-10,9],[9,9]]) {
      run(`setblock ${cx+ox} ${py} ${cz+oz} minecraft:obsidian`);
    }
  }, 5);

  // Phase 2 — corner obsidian spires (10-tick delay)
  system.runTimeout(() => {
    const run = (cmd) => { try { dim.runCommand(cmd); } catch(_) {} };

    // Four massive obsidian spires at corners (2x2 base, 10 blocks tall)
    for (const [ox, oz] of [[-12,-12],[10,-12],[-12,10],[10,10]]) {
      const tx = cx + ox;
      const tz = cz + oz;
      // Spire shaft
      run(`fill ${tx} ${py} ${tz} ${tx+1} ${sy+9} ${tz+1} minecraft:obsidian`);
      // Crying obsidian accent halfway up
      run(`fill ${tx} ${sy+3} ${tz} ${tx+1} ${sy+4} ${tz+1} minecraft:crying_obsidian`);
      // Purpur cap at top
      run(`fill ${tx} ${sy+10} ${tz} ${tx+1} ${sy+10} ${tz+1} minecraft:purpur_pillar`);
      // End rods on top
      run(`setblock ${tx}   ${sy+11} ${tz}   minecraft:end_rod`);
      run(`setblock ${tx+1} ${sy+11} ${tz}   minecraft:end_rod`);
      run(`setblock ${tx}   ${sy+11} ${tz+1} minecraft:end_rod`);
      run(`setblock ${tx+1} ${sy+11} ${tz+1} minecraft:end_rod`);
    }
    // Midpoint purpur pillars between spires (smaller, varied heights)
    for (const [ox, oz, h] of [[-1,-13,5],[1,-13,7],[-1,12,5],[1,12,7],[-13,-1,6],[-13,1,4],[12,-1,6],[12,1,4]]) {
      run(`fill ${cx+ox} ${py} ${cz+oz} ${cx+ox} ${sy+h} ${cz+oz} minecraft:purpur_pillar`);
      run(`setblock ${cx+ox} ${sy+h+1} ${cz+oz} minecraft:end_rod`);
    }
  }, 10);

  // Phase 3 — chorus-like formations and inner structures (15-tick delay)
  system.runTimeout(() => {
    const run = (cmd) => { try { dim.runCommand(cmd); } catch(_) {} };

    // Chorus-style purpur column clusters (scattered, varied heights)
    const clusters = [
      [-6,-6,4], [5,-6,6], [-6,5,5], [5,5,3],
      [-8,-2,3], [7,-2,5], [-8,1,4], [7,1,3],
      [-2,-8,5], [1,-8,3], [-2,7,4], [1,7,6],
    ];
    for (const [ox, oz, h] of clusters) {
      run(`fill ${cx+ox} ${sy} ${cz+oz} ${cx+ox} ${sy+h} ${cz+oz} minecraft:purpur_pillar`);
      run(`setblock ${cx+ox} ${sy+h+1} ${cz+oz} minecraft:end_rod`);
      // Side branches for chorus-plant silhouette (1 block off main column)
      if (h >= 3) {
        run(`setblock ${cx+ox+1} ${sy+h-1} ${cz+oz} minecraft:purpur_pillar`);
        run(`setblock ${cx+ox-1} ${sy+h-2} ${cz+oz} minecraft:purpur_pillar`);
      }
    }
    // Ender chests as decorative elements (4 placed around inner area)
    run(`setblock ${cx-6} ${sy} ${cz-4} minecraft:ender_chest`);
    run(`setblock ${cx+5} ${sy} ${cz-4} minecraft:ender_chest`);
    run(`setblock ${cx-6} ${sy} ${cz+3} minecraft:ender_chest`);
    run(`setblock ${cx+5} ${sy} ${cz+3} minecraft:ender_chest`);
  }, 15);

  // Phase 4 — portal room on raised altar (25-tick delay)
  system.runTimeout(() => {
    const run = (cmd) => { try { dim.runCommand(cmd); } catch(_) {} };

    const ry = sy + 1;  // raised altar surface (py + 2)

    // Portal room walls on altar: 8x8 outer, purpur pillar
    run(`fill ${cx-3} ${ry} ${cz-3} ${cx+4} ${ry} ${cz-3} minecraft:purpur_pillar`);
    run(`fill ${cx-3} ${ry} ${cz+4} ${cx+4} ${ry} ${cz+4} minecraft:purpur_pillar`);
    run(`fill ${cx-3} ${ry} ${cz-3} ${cx-3} ${ry} ${cz+4} minecraft:purpur_pillar`);
    run(`fill ${cx+4} ${ry} ${cz-3} ${cx+4} ${ry} ${cz+4} minecraft:purpur_pillar`);
    // Portal room corner pillars: 5 high obsidian
    for (const [ox, oz] of [[-3,-3],[4,-3],[-3,4],[4,4]]) {
      run(`fill ${cx+ox} ${ry} ${cz+oz} ${cx+ox} ${ry+5} ${cz+oz} minecraft:obsidian`);
    }
    // 12 end portal frames — 3 per side, arranged around 3x3 interior
    for (let x = cx-1; x <= cx+1; x++)
      run(`setblock ${x} ${ry} ${cz-2} minecraft:end_portal_frame ["end_portal_eye_bit"=true,"minecraft:cardinal_direction"="south"]`);
    for (let x = cx-1; x <= cx+1; x++)
      run(`setblock ${x} ${ry} ${cz+2} minecraft:end_portal_frame ["end_portal_eye_bit"=true,"minecraft:cardinal_direction"="north"]`);
    for (let z = cz-1; z <= cz+1; z++)
      run(`setblock ${cx-2} ${ry} ${z} minecraft:end_portal_frame ["end_portal_eye_bit"=true,"minecraft:cardinal_direction"="east"]`);
    for (let z = cz-1; z <= cz+1; z++)
      run(`setblock ${cx+2} ${ry} ${z} minecraft:end_portal_frame ["end_portal_eye_bit"=true,"minecraft:cardinal_direction"="west"]`);
    // End portal fill (3x3 interior)
    run(`fill ${cx-1} ${ry} ${cz-1} ${cx+1} ${ry} ${cz+1} minecraft:end_portal`);
    // End rods as pillars inside room at corners
    run(`setblock ${cx-3} ${ry+1} ${cz-3} minecraft:end_rod`);
    run(`setblock ${cx+4} ${ry+1} ${cz-3} minecraft:end_rod`);
    run(`setblock ${cx-3} ${ry+1} ${cz+4} minecraft:end_rod`);
    run(`setblock ${cx+4} ${ry+1} ${cz+4} minecraft:end_rod`);
    // Ceiling of portal room: purpur slab canopy + end rods pointing down
    run(`fill ${cx-3} ${ry+5} ${cz-3} ${cx+4} ${ry+5} ${cz+4} minecraft:purpur_block`);
    run(`setblock ${cx}   ${ry+4} ${cz}   minecraft:end_rod`);
    run(`setblock ${cx+1} ${ry+4} ${cz}   minecraft:end_rod`);
    run(`setblock ${cx}   ${ry+4} ${cz+1} minecraft:end_rod`);
    run(`setblock ${cx+1} ${ry+4} ${cz+1} minecraft:end_rod`);

    store.portalState.endBuilt = true;
    savePortalState();
    broadcast("§5[FF] §l★§r §5An End City Ruin has materialized to the South! Day 30 reached.");
    adminMsg(`§8[FF-OP] End portal platform built at (${cx}, ${py}, ${cz})`);
  }, 25);
}
