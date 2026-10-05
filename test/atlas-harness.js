// VoxelCraft — texture atlas verification harness (Node, no browser)
// Run: node test/atlas-harness.js
//
// Stubs the DOM/canvas surface textures.js needs, loads the REAL
// src/textures.js and src/voxel-blocks.js, builds the atlas, and asserts:
//   - atlas + cell dimensions
//   - every tile name referenced by VoxelBlocks.DEF[id].tiles resolves in the
//     atlas index (exhaustive cross-check of the two lists)
//   - uvOf(name) and uvOfVariant(name,k) return rects strictly inside [0,1]
//   - that rect stays INSIDE one cell with a >= PAD margin on every side
//     (the anti-bleed property that the padding exists for)
'use strict';
const fs = require('fs');
const path = require('path');
const vm = require('vm');

const ROOT = path.resolve(__dirname, '..');

/* ---------- minimal canvas / document stub ---------- */
function makeCtx(w, h) {
  return {
    _w: w, _h: h, _last: null,
    createImageData: (width, height) => ({ width, height, data: new Uint8ClampedArray(width * height * 4) }),
    clearRect() {},
    putImageData(img, x, y) { this._last = img; this._x = x; this._y = y; },
    getImageData(x, y, width, height) {
      const src = this._last && this._last.data;
      const out = new Uint8ClampedArray(width * height * 4);
      if (src) {
        for (let row = 0; row < height; row++)
          for (let col = 0; col < width; col++) {
            const si = ((y + row) * w + (x + col)) * 4;
            const di = (row * width + col) * 4;
            out[di] = src[si]; out[di + 1] = src[si + 1];
            out[di + 2] = src[si + 2]; out[di + 3] = src[si + 3];
          }
      }
      return { width, height, data: out };
    },
    drawImage() {},
    fillRect() {}, fillStyle: '#000',
    imageSmoothingEnabled: false,
  };
}
function makeCanvas() {
  const c = { width: 0, height: 0, _ctx: null, toDataURL() { return 'data:image/png;base64,stub'; } };
  c.getContext = function () { if (!this._ctx) this._ctx = makeCtx(this.width, this.height); return this._ctx; };
  return c;
}

const sandbox = {
  document: { createElement: (t) => (t === 'canvas' ? makeCanvas() : {}) },
  console,
  Math, Date,
  parseInt, parseFloat, isNaN, isFinite, Number, Object, Array, JSON, Set, Map,
  Uint8ClampedArray, Uint8Array, Float32Array, Int16Array,
};
sandbox.window = sandbox;
sandbox.globalThis = sandbox;
vm.createContext(sandbox);

function load(rel) {
  const f = path.join(ROOT, rel);
  vm.runInContext(fs.readFileSync(f, 'utf8'), sandbox, { filename: f });
}
load('src/textures.js');
load('src/voxel-blocks.js');

const TEX = sandbox.VoxelTextures;
const BLK = sandbox.VoxelBlocks;

const fails = [];
const ok = (cond, msg) => { if (!cond) fails.push(msg); };

/* ---------- build atlas from the block registry's own tile list ---------- */
const tileNames = (BLK.TILE_NAMES && BLK.TILE_NAMES.length) ? BLK.TILE_NAMES : TEX.DEFAULT_ORDER;
const t0 = Date.now();
const atlas = TEX.buildAtlas(tileNames);
const buildMs = Date.now() - t0;

/* ---------- (1) dimensions ---------- */
ok(!!atlas && !!atlas.canvas, 'atlas did not build');
const W = atlas.canvas.width, H = atlas.canvas.height;
ok(atlas.cell === TEX.CELL, 'atlas.cell (' + atlas.cell + ') != TEX.CELL (' + TEX.CELL + ')');
ok(atlas.cell === atlas.tile + 2 * atlas.pad, 'cell != tile + 2*pad');
ok(W === atlas.cols * atlas.cell, 'width != cols*cell');
ok(H === atlas.rows * atlas.cell, 'height != rows*cell');
ok((W & (W - 1)) === 0, 'width is not a power of two');
ok((H & (H - 1)) === 0, 'height is not a power of two');

/* ---------- (2) exhaustive tile-name cross-check ---------- */
const ctx2d = atlas.canvas.getContext('2d');
const img = ctx2d._last;  // whole atlas ImageData, written once by buildAtlas

function tileCenter(name, px, py) {     // px,py in 0..TILE-1
  const i = atlas.index[name];
  const cx = i % atlas.cols, cy = Math.floor(i / atlas.cols);
  const X = cx * atlas.cell + atlas.pad + px;
  const Y = cy * atlas.cell + atlas.pad + py;
  const o = (Y * W + X) * 4;
  return [img.data[o], img.data[o + 1], img.data[o + 2], img.data[o + 3]];
}

const missingIndex = [];
const missingUvOf = [];
const seen = new Set();
for (const id of Object.keys(BLK.DEF)) {
  const d = BLK.DEF[id];
  if (!d || !d.tiles) continue;
  for (const nm of d.tiles) {
    if (!nm) continue;
    if (seen.has(nm)) continue;
    seen.add(nm);
    if (atlas.index[nm] === undefined) missingIndex.push(nm);
    if (!atlas.uvOf(nm)) missingUvOf.push(nm);
  }
}
ok(missingIndex.length === 0, 'DEF references tile names absent from atlas index: ' + missingIndex.join(', '));
ok(missingUvOf.length === 0, 'uvOf() returned null for DEF tiles: ' + missingUvOf.join(', '));

const noRecipe = tileNames.filter((n) => !TEX.RECIPES[n]);
ok(noRecipe.length === 0, 'tile names with no RECIPES entry: ' + noRecipe.join(', '));

/* ---------- (3) UV sanity + anti-bleed (rect strictly inside one cell) ---------- */
const PAD = atlas.pad, T = atlas.tile, CELL = atlas.cell;
const badUv = [];
const badBleed = [];
function checkRect(name, tag, k) {
  const r = (k === undefined) ? atlas.uvOf(name) : atlas.uvOfVariant(name, k);
  if (!r) { badUv.push(name + tag + ' -> null'); return; }
  const inside01 = r.u0 >= 0 && r.v0 >= 0 && r.u1 <= 1 && r.v1 <= 1 &&
                   r.u0 < r.u1 && r.v0 < r.v1;
  if (!inside01) { badUv.push(name + tag); return; }
  const x0 = r.u0 * W, y0 = r.v0 * H, x1 = r.u1 * W, y1 = r.v1 * H;
  const spanX = x1 - x0, spanY = y1 - y0;
  const nv = atlas.variants[name] || 1;
  const kk = nv > 1 ? (((k | 0) % nv) + nv) % nv : 0;
  const idx = (k === undefined) ? atlas.index[name] : atlas.index[name] + kk;
  const ccx = idx % atlas.cols, ccy = Math.floor(idx / atlas.cols);
  const cellX = ccx * CELL, cellY = ccy * CELL;
  const crissCross = x0 < cellX - 0.001 || x1 > cellX + CELL + 0.001 || y0 < cellY - 0.001 || y1 > cellY + CELL + 0.001;
  const inPad = x0 < cellX + PAD - 0.001 || x1 > cellX + PAD + T + 0.001 ||
                y0 < cellY + PAD - 0.001 || y1 > cellY + PAD + T + 0.001;
  if (crissCross) badBleed.push(name + tag + ' crosses cell boundary');
  else if (inPad) badBleed.push(name + tag + ' enters padding');
  if (Math.abs(spanX - T) > 0.5 || Math.abs(spanY - T) > 0.5)
    badBleed.push(name + tag + ' span ' + spanX.toFixed(2) + 'x' + spanY.toFixed(2) + ' != ' + T);
}

const allNames = Object.keys(atlas.index);
for (const nm of allNames) {
  checkRect(nm, ' (uvOf)');
  const nv = atlas.variants[nm] || 1;
  for (let k = 0; k < nv; k++) checkRect(nm, ' (uvOfVariant#' + k + ')', k);
  checkRect(nm, ' (uvOfVariant#neg)', -1);
  checkRect(nm, ' (uvOfVariant#big)', nv * 7 + 3);
}
ok(badUv.length === 0, 'UV rects outside [0,1]: ' + badUv.slice(0, 6).join(' | '));
ok(badBleed.length === 0, 'UV rects crossing cell/padding boundary: ' + badBleed.slice(0, 6).join(' | '));

/* ---------- (4) padding actually duplicates edge pixels ---------- */
const eq = (a, b) => a[0] === b[0] && a[1] === b[1] && a[2] === b[2] && a[3] === b[3];
const padBad = [];
function cellPix(name, px, py) {
  const i = atlas.index[name];
  const cx = i % atlas.cols, cy = Math.floor(i / atlas.cols);
  const X = cx * CELL + PAD + px, Y = cy * CELL + PAD + py;
  const o = (Y * W + X) * 4;
  return [img.data[o], img.data[o + 1], img.data[o + 2], img.data[o + 3]];
}
for (const nm of ['stone', 'grass_top', 'sand', 'oak_planks']) {
  if (atlas.index[nm] === undefined) continue;
  if (!eq(cellPix(nm, -1, 7), cellPix(nm, 0, 7))) padBad.push(nm + ' left');
  if (!eq(cellPix(nm, T, 7), cellPix(nm, T - 1, 7))) padBad.push(nm + ' right');
  if (!eq(cellPix(nm, 7, -1), cellPix(nm, 7, 0))) padBad.push(nm + ' top');
  if (!eq(cellPix(nm, 7, T), cellPix(nm, 7, T - 1))) padBad.push(nm + ' bottom');
}
ok(padBad.length === 0, 'padding does not duplicate edge pixels: ' + padBad.join(', '));

/* ---------- (5) variant 0 is byte-identical to the raw recipe ---------- */
const P = TEX._parseColor;
const variant0Bad = [];
for (const nm of allNames) {
  for (let py = 0; py < 16; py++) {
    let hit = false;
    for (let px = 0; px < 16; px++) {
      const want = P(TEX.RECIPES[nm](px, py));
      const got = tileCenter(nm, px, py);
      if (!eq(want, got)) { variant0Bad.push(nm + '@' + px + ',' + py); hit = true; break; }
    }
    if (hit) break;
  }
}
ok(variant0Bad.length === 0, 'variant 0 differs from raw recipe: ' + variant0Bad.slice(0, 5).join(', '));

/* ---------- (6) variants 1..n-1 actually differ from variant 0 ---------- */
const variantFlat = [];
for (const nm of allNames) {
  const nv = atlas.variants[nm] || 1;
  if (nv < 2) continue;
  let diff = 0;
  for (let py = 0; py < 16; py++) for (let px = 0; px < 16; px++) {
    const a = tileCenter(nm, px, py);
    const i = atlas.index[nm] + 1;
    const cx = i % atlas.cols, cy = Math.floor(i / atlas.cols);
    const o = ((cy * CELL + PAD + py) * W + (cx * CELL + PAD + px)) * 4;
    if (a[0] !== img.data[o] || a[1] !== img.data[o + 1] || a[2] !== img.data[o + 2]) diff++;
  }
  if (diff === 0) variantFlat.push(nm);
}
ok(variantFlat.length === 0, 'declared variants identical to variant 0 (mechanism inert): ' + variantFlat.join(', '));

/* ---------- summary ---------- */
let namedWithVariants = 0, totalVariantSlots = 0;
for (const nm of allNames) {
  const nv = atlas.variants[nm] || 1;
  totalVariantSlots += nv;
  if (nv > 1) namedWithVariants++;
}

const summary = {
  atlas: { width: W, height: H },
  cols: atlas.cols, rows: atlas.rows, cell: CELL, pad: PAD, tile: T,
  blocks: Object.keys(BLK.DEF).length,
  tileNamesFed: tileNames.length,
  tilesIndexed: allNames.length,
  defTilesResolved: seen.size,
  namesWithVariants: namedWithVariants,
  totalVariantSlots,
  buildMs,
  failures: fails,
};
console.log(JSON.stringify(summary, null, 2));
process.exit(fails.length ? 1 : 0);
