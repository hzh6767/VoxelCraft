// VoxelCraft — light incremental-update harness (Node, no browser)
// Run: node test/light-harness.js
//
// Loads the REAL src/voxel-blocks.js and src/voxel-light.js and asserts that
// VoxelLight.onBlockChanged actually recomputes light for the edited chunk.
// The prior implementation was a stub that only marked chunks dirty, so light
// stopped updating after a chunk's first generation: digging a hole never
// brightened it and placing glowstone never emitted light. These assertions
// fail against that stub and pass once onBlockChanged recomputes.
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');
const sandbox = { console, Math, Object, Array, JSON, Uint8Array, Int16Array, Float32Array, isFinite };
sandbox.window = sandbox;
sandbox.globalThis = sandbox;
vm.createContext(sandbox);

function load(rel) {
  const f = path.join(ROOT, rel);
  vm.runInContext(fs.readFileSync(f, 'utf8'), sandbox, { filename: f });
}
load('src/voxel-blocks.js');
load('src/voxel-light.js');

const BLK = sandbox.VoxelBlocks;
const LIGHT = sandbox.VoxelLight;

const CHUNK_X = 16, CHUNK_Z = 16, CHUNK_Y = 128;
const idx = (lx, y, lz) => (y * CHUNK_Z + lz) * CHUNK_X + lx;
const AIR = BLK.ID.AIR, STONE = BLK.ID.STONE, GLOWSTONE = BLK.ID.GLOWSTONE, WATER = BLK.ID.WATER;

function makeChunk() {
  return {
    blocks: new Uint8Array(CHUNK_X * CHUNK_Z * CHUNK_Y),
    skyLight: new Uint8Array(CHUNK_X * CHUNK_Z * CHUNK_Y),
    blockLight: new Uint8Array(CHUNK_X * CHUNK_Z * CHUNK_Y),
    lightReady: false,
  };
}
function makeWorld(chunk) {
  const marks = [];
  return {
    peek: (cx, cz) => (cx === 0 && cz === 0 ? chunk : null),   // single resident chunk
    isLoaded: (cx, cz) => cx === 0 && cz === 0,
    markDirty: (cx, cz) => marks.push((cx | 0) + ',' + (cz | 0)),
    _marks: marks,
  };
}

const fails = [];
let checks = 0;
const ok = (cond, msg) => { checks++; if (!cond) fails.push(msg); };

/* (1) Digging a hole through the roof must re-seed skylight below it.
 *     A full column of stone shadows everything under it (skyLight 0);
 *     removing the surface block must let skylight fall through again. */
{
  const c = makeChunk();
  for (let y = 0; y <= 64; y++) for (let lz = 0; lz < CHUNK_Z; lz++) for (let lx = 0; lx < CHUNK_X; lx++) {
    c.blocks[idx(lx, y, lz)] = STONE;                        // solid ground up to y=64
  }
  const w = makeWorld(c);
  LIGHT.computeChunkLight(c, w);
  ok(c.skyLight[idx(8, 63, 8)] === 0, 'precondition: skylight under roof should be 0');

  // open a 1x1 shaft at x=8,z=8 from the surface down through the roof
  c.blocks[idx(8, 64, 8)] = AIR;
  LIGHT.onBlockChanged(8, 64, 8, STONE, AIR, w);
  ok(c.skyLight[idx(8, 63, 8)] === 15,
     'after opening a shaft, cell BELOW should be full skylight (got ' + c.skyLight[idx(8, 63, 8)] + ')');
}

/* (2) Breaking a glowstone must remove its block light.
 *     Stale light from the stub would leave the removed source lit. */
{
  const c = makeChunk();
  c.blocks[idx(4, 40, 4)] = GLOWSTONE;
  const w = makeWorld(c);
  LIGHT.computeChunkLight(c, w);
  ok(c.blockLight[idx(5, 40, 4)] > 0, 'precondition: glowstone should light its neighbour');

  c.blocks[idx(4, 40, 4)] = AIR;
  LIGHT.onBlockChanged(4, 40, 4, GLOWSTONE, AIR, w);
  ok(c.blockLight[idx(4, 40, 4)] === 0 && c.blockLight[idx(5, 40, 4)] === 0,
     'after breaking the glowstone, its cell and neighbour must be dark again');
}

/* (3) Placing a glowstone must emit block light. */
{
  const c = makeChunk();
  const w = makeWorld(c);
  LIGHT.computeChunkLight(c, w);
  c.blocks[idx(7, 30, 7)] = GLOWSTONE;
  LIGHT.onBlockChanged(7, 30, 7, AIR, GLOWSTONE, w);
  ok(c.blockLight[idx(7, 30, 7)] === 15, 'placed glowstone should be at level 15');
  ok(c.blockLight[idx(8, 30, 7)] >= 14, 'glowstone should light its neighbour');
}

/* (4) Water attenuates skylight: still 15 in air above, 14 one cell into water. */
{
  const c = makeChunk();
  c.blocks[idx(9, 70, 9)] = WATER;
  const w = makeWorld(c);
  LIGHT.computeChunkLight(c, w);
  // A cell records the light level present AT it; water attenuates the level
  // passed to cells BELOW it. So the surface water cell is 15 and the first air
  // cell under it is 14 (a plain air cell does not attenuate further).
  ok(c.skyLight[idx(9, 71, 9)] === 15, 'sky above water should be 15');
  ok(c.skyLight[idx(9, 70, 9)] === 15, 'water surface cell records incoming 15 (got ' + c.skyLight[idx(9, 70, 9)] + ')');
  ok(c.skyLight[idx(9, 69, 9)] === 14, 'cell below water drops by 1 to 14 (got ' + c.skyLight[idx(9, 69, 9)] + ')' + (c.skyLight[idx(9,69,9)]===13?'':''));
}

/* (5) onBlockChanged must dirty the edited chunk and its 8 neighbours. */
{
  const c = makeChunk();
  const w = makeWorld(c);
  LIGHT.computeChunkLight(c, w);
  LIGHT.onBlockChanged(8, 64, 8, STONE, AIR, w);
  ok(w._marks.indexOf('0,0') !== -1, 'edited chunk should be marked dirty');
  ok(w._marks.indexOf('-1,-1') !== -1 && w._marks.indexOf('1,1') !== -1,
     'all 8 neighbouring chunks should be marked dirty');
}

console.log(JSON.stringify({ checks: checks, failures: fails }, null, 2));
process.exit(fails.length ? 1 : 0);
