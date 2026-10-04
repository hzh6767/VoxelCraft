# VoxelCraft — Integrated Implementation Blueprint

Target: offline single-player voxel sandbox for Windows, packaged as a `.exe`, Electron + three.js **r149**, WebGL2, runs entirely from `file://`, **no network at runtime**. All textures and audio are generated procedurally in code; no Mojang assets are bundled, sampled, or downloaded. The achievable reading of "looks like the real thing" is **same visual language** — 16×16 pixel tiles, restricted palettes, ordered dither, per-face shading, square-cube silhouettes, matching UI proportions — with independently generated pixels and sound.

This document integrates the three subsystem designs (rendering/world-meshing, textures, gameplay/player/interaction) and **fixes every issue raised in the two critique sections**. Where the three designs disagreed, the values fixed by the task are authoritative and the designs are corrected here.

---

## 0. Reconciliation of conflicts in the source designs

| Item | Render design | Gameplay design | **Blueprint (authoritative)** |
|---|---|---|---|
| `CHUNK_Y` | 256 | 128 | **128** |
| `SEA_LEVEL` | 62 | 64 | **56** |
| Block index | `(y<<8)|(lz<<4)|lx` | `(y*CH+z)*CH+x` | **`(y*16+lz)*16+lx` = `y*256+lz*16+lx`** (identical) |
| Chunk key | `cx=x>>4, cz=z>>4` | same | **`"cx,cz"`, `cx=x>>4`, `lx=x&15`** |
| Atlas filtering | Nearest, **no mips** (anti-bleed) | padded atlas + **mips + anisotropy** (anti-shimmer) | **Padded atlas + mips + anisotropy** (texture subsystem wins; it is already "done") |

Both critical constants (`CHUNK_Y=128`, `SEA_LEVEL=56`) are **corrected** against the designs. The `blocks` array is therefore `16*16*128 = 32,768` entries (`Uint16Array`, 64 KB/chunk), not 131,072. `SECTION_COUNT = CHUNK_Y/16 = 8` (not 16). The padded scratch height becomes `CHUNK_Y+2 = 130`.

Terrain height mapping in `voxel-worldgen.js` is remapped so that `SEA_LEVEL=56` stays the water line: continental base spans `[SEA-20, 100]` clamped to `[4, CHUNK_Y-8]`.

---

## 1. FILE LAYOUT — everything under `D:/VoxelCraft/src`

```
D:/VoxelCraft/
├─ package.json                 (electron-builder config: win portable/nsis, no network)
├─ main.js                      Electron main process (NOT under src; see below)
├─ index.html                   file:// shell: <script> tags in load order, canvas host
├─ BLUEPRINT.md                 this file
└─ src/
   ├─ textures.js    (DONE)     procedural atlas: palettes, Bayer dither, periodic noise,
   │                            per-tile recipes, padded atlas + mips + anisotropy, waterTex,
   │                            crack decals (10 levels). Exposes `Atlas` object + `uvRect(i)`.
   ├─ voxel-blocks.js           block catalog: id → {name, tiles[6], layer, shape, collision,
   │                            hardness, sound, placement rules, cullSameType, opaque,
   │                            translucent, liquid, lightLevel, lightAtten}. Lookup tables.
   ├─ voxel-worldgen.js         seeded PRNG (mulberry32 + splitmix64), value/Perlin fbm +
   │                            domain warp, biomes (temp/humidity), heightmap, caves, ore
   │                            veins, lakes, trees. Exposes deterministic per-coordinate
   │                            sampling AND full-chunk generation + pendingEdits.
   ├─ voxel-chunk.js            Chunk container (blocks/lightmap/heightmap/padded mirror),
   │                            index math, the mesher (per-face quads, AO, quad-flip, cross &
   │                            pane shapes, 3 render buckets), bounding sphere/box from
   │                            heightmap. Owns ChunkStore (Map<key, Chunk>).
   ├─ voxel-light.js            skylight + blocklight engine: 16-bucket BFS, vertical column
   │                            pass, cross-chunk propagation, incremental add/remove on edit,
   │                            budgeted drain, dirty-chunk set.
   ├─ voxel-player.js           fixed-step physics, AABB collision solver, movement states
   │                            (walk/sprint/sneak/swim/ladder/fly), step-up, sneak edge-guard,
   │                            fall damage, camera/eye, game modes (survival/creative),
   │                            health/hunger-lite, death/respawn.
   ├─ voxel-raycast.js          Amanatides–Woo DDA voxel ray; returns block, face normal,
   │                            exact hit point; block mining progress + tool/hardness math.
   ├─ voxel-inventory.js        36-slot inventory + 9 hotbar, cursor stack, drag/quick-move,
   │                            crafting grid (shaped/unshaped/mirrored), furnace feed/out, item
   │                            stack model, drop/pickup glue, container (chest) model.
   ├─ voxel-mobs.js             passive wanderer + hostile stalker, parameterized-AABB physics
   │                            (reuses player solver), A* flat cost grid, spawn/despawn rules,
   │                            daylight/light-driven spawn gate.
   ├─ voxel-sound.js            WebAudio synth: noise buffer, footstep/break/place/mine SFX,
   │                            polyphony cap, node recycling, material→filter table.
   ├─ voxel-save.js             binary chunk codec (RLE) + level.json, debounced flush, IPC
   │                            client to main process; world-level metadata.
   └─ engine.js       (WRITE)    GLUE LAYER — see §1.1. Everything that coordinates modules.
```

Load order in `index.html`: `voxel-blocks.js` → `textures.js` → `voxel-worldgen.js` → `voxel-chunk.js` → `voxel-light.js` → `voxel-raycast.js` → `voxel-player.js` → `voxel-inventory.js` → `voxel-mobs.js` → `voxel-sound.js` → `voxel-save.js` → `engine.js`. All plain `<script>` (no bundler, no modules, works from `file://`).

### 1.1 What `engine.js` must own (the glue)

`engine.js` is the only module that knows about three.js, the DOM, timing, and cross-module ordering. It owns:

1. **Bootstrap** — create `WebGLRenderer` (`alpha:false, antialias:false, powerPreference:'high-performance'`), `Scene`, `Camera`, `root` Object3D; build the atlas via `textures.js`; construct all three shared materials (opaque/cutout/blend); restore `sRGBEncoding` consistency (r149: `renderer.outputEncoding = THREE.sRGBEncoding`, atlas `.encoding = THREE.sRGBEncoding`).
2. **The `World` facade** (§4) handed to every module — the single object other modules call for blocks, light, and loaded-chunk queries. Modules never touch `ChunkStore` directly.
3. **Fixed-step loop** with interpolation (§3.1).
4. **Chunk streaming manager** — load/unload rings, budgeted, prioritized by distance and by edit-priority.
5. **Dirty queues** — one mesh-remesh queue (priority by distance, coalesced by revision) and the light-drain hook into `voxel-light.js`.
6. **Budget scheduler** — per-frame time slices for streaming, light, meshing (§3.2).
7. **Render buckets & materials** — opaque / cutout / blend, per-chunk `Mesh` lifecycle, `matrixAutoUpdate=false`, bounding sphere assignment, frustum pass.
8. **Global uniforms** — `uSkyColor` (fog/background), `uSkyLightColor` (neutral light tint — **separate**, see fix R7), `uSkyIntensity`, `uSunDir` (**normalized**), `uTime`, fog. Day/night cycle.
9. **Water animation** — drive `waterTex.offset`, wave uniforms, underwater overlay pass, submersion state.
10. **Particle system** — mining/break particles (custom `ShaderMaterial` with per-instance attributes, or `Points`; see fix G13).
11. **Crack overlay** — the 10-level progressive-break decal mesh (pooled, `polygonOffset`, scale 1.002).
12. **Input** — pointer lock, keyboard/mouse, hotbar scroll, mouse-button semantics routing to inventory/raycast, `preventDefault` on middle-click.
13. **HUD/UI glue** — hotbar, health, inventory screen, crafting screen, crosshair.
14. **Game-mode state** and settings (render distance, LOD bands, fancy-leaves toggle, step-height toggle).
15. **Save flush timer** and `before-quit` hook wiring.

`engine.js` must **not** contain meshing, lighting, physics, or generation algorithms — those live in their modules. It only sequences them.

### 1.2 Main process (`main.js`)

Electron main: window creation with `contextIsolation:true`, `nodeIntegration:false`, a `preload.js` exposing `window.api.{saveChunk, loadChunk, readLevel, writeLevel}` over `ipcRenderer.invoke`. **All zlib work happens here** (Node `zlib`), because the renderer has no `zlib` (fix G12). Save dir = `app.getPath('userData')/saves/<worldName>/`. Atomic writes via `tmp` + `rename`; forced flush on `before-quit`.

---

## 2. SHARED CONSTANTS AND DATA STRUCTURES

### 2.1 Confirmed / corrected constants

```js
const CHUNK_X = 16, CHUNK_Z = 16, CHUNK_Y = 128;   // CHUNK_Y corrected from render design's 256
const SEA_LEVEL = 56;                              // fixed by task; designs' 62/64 overridden
const SECTION = 16;
const SECTION_COUNT = CHUNK_Y / SECTION;           // = 8  (corrected from 16)
const VOXELS = CHUNK_X * CHUNK_Y * CHUNK_Z;        // = 32768

// canonical voxel index (task-fixed) — slab-major in y:
const idx = (lx, y, lz) => (y * CHUNK_Z + lz) * CHUNK_X + lx;   // = y*256 + lz*16 + lx
// chunk coords:
const cx = x >> 4, cz = z >> 4;
const lx = x & 15, lz = z & 15;
const key = (cx, cz) => cx + ',' + cz;             // "cx,cz"
```

Packed block word (`Uint16`): `bits 15..12 = state/variant (0..15)`, `bits 11..0 = blockId (0..4095)`.

### 2.2 Per-chunk storage

```js
// Resident in ChunkStore: Map<string, Chunk>
blocks    : Uint16Array(VOXELS)          // 64 KB  — packed id+state
lightmap  : Uint8Array (VOXELS)          // 32 KB  — (skylight<<4)|blocklight
height    : Uint8Array (256)             // per (lx,lz): topmost OPAQUE block y   (see fix R2)
maxHeight : int                          // max(height)+1, for bounding sphere
flags     : Uint8Array (SECTION_COUNT)   // per 16³ section: bit0 hasAnyNonAir,
                                         //   bit1 hasGeometry, bit2 liquid-present
padded    : Uint16Array(PW*PH*PD)        // 18×130×18 mirror, 82 KB — see §2.4
revision  : int                          // bumped on every block edit
meshRev   : int                          // revision of last successful mesh
modified  : bool                         // player-edited → must be saved
tileEntities : Map<localIdx, TE>         // chests/furnaces (tiny)
```

Per-chunk CPU ≈ 178 KB. RD=10 → 441 chunks ≈ 78 MB CPU. GPU vertex budget with LOD ≈ 80–140 MB.

### 2.3 Corrected vertex format (fix R6)

The render design's "16-byte vertex" is arithmetically impossible (pos 3×f32 = 12 B alone). **Use a 20-byte aligned interleaved vertex:**

```
position : 3 × Float32   (12 B)  chunk-local, x∈[0,16], y∈[0,128], z∈[0,16]
uv       : 2 × Uint16    ( 4 B)  atlas texel coords (or layer index for DataArrayTexture)
attrs    : 1 × Uint16    ( 2 B)  packed:
             bits 0..3   skylight (0..15)
             bits 4..7   blocklight (0..15)
             bits 8..9   ao (0..3)
             bits 10..12 faceIndex (0..5)   -> faceShade + normal reconstructed in shader
             bit  13     waterTop (1 if +Y water surface)
             bits 14..15 reserved
pad      : 1 × Uint16    ( 2 B)  alignment / future use
= 20 bytes/vertex;  4 verts + 6 indices(Uint32) = 80 + 24 = 104 B/quad
```

Per-quad is **104 B**, not 76. Typical exposed chunk 2k–5k quads → 208–520 KB; dense worst ~15k → 1.56 MB. Indices are `Uint32Array` (WebGL2 supports it natively; avoids 65 536-vertex splitting). Memory figures in §13 of the render design are superseded by this.

### 2.4 Padded mirror — the fix for R4 (missing neighbor data) and R11 (fill cost)

Instead of rebuilding an 18×130×18 snapshot from scratch on every remesh (which is ~2048 row copies, not "4 set() calls"), **each chunk keeps a persistent padded mirror**, updated incrementally:

- Center `[1..16]×[0..127]×[1..16]` mirrors the chunk's own `blocks`.
- The 1-voxel X/Z shell is a **copy of the neighbor's border**; the `py=0` shell is BEDROCK, `py=129` shell is AIR.
- **On a local write**: update the center cell and, if the cell is on a border, also update the mirror cells of every resident neighbor, and bump their `revision`.
- **On neighbor load**: when chunk N finishes generating, copy its border into each already-resident neighbor's shell and **re-dirty those neighbors** for remesh + relight. This is the "re-dirty-on-load" step the critique demanded (fix R4).
- **On neighbor unload**: keep the last known shell (do not blank it) so an edge chunk meshes consistently; when the neighbor is regenerated it is deterministic and identical, so the shell stays valid.

This makes meshing read neighbors with **zero hash-map lookups in the inner loop**, guarantees both sides of a border see identical data (zero AO/vertex seams), and costs one row-copy per edit instead of a full snapshot per remesh.

### 2.5 Emitters & heightmap semantics

- `height[c]` = topmost cell whose block is **`opaque`** (not "non-transparent"). Sections are skipped only via the per-section `hasAnyNonAir` flag, **never** by comparing `maxHeight` (fix R2 — water, glass, leaf canopies and saplings live above the opaque height and must still emit).
- `height` is used for: skylight column seeding, bounding-sphere sizing, and a fast "is this column fully air above y" test. It is **not** used as a geometry-existence test.

---

## 3. MAIN LOOP ORDER

### 3.1 Frame structure

```
animate(tNow):
  realDt = min(tNow - tPrev, 0.1)          // clamp wall dt
  acc   += realDt
  steps  = 0
  while acc >= h and steps < MAX_STEPS:    // h = 1/60; MAX_STEPS = 5
      input.sample(); physics.step(h)      // own fixed step inside player module
      acc -= h; steps++
  acc = min(acc, h * MAX_STEPS)            // FIX G1: clamp residual to maxSteps*h
  interp = acc / h
```

**Fix G1 (accumulator death-spiral / time dilation):** the residual `acc` is clamped to `h*MAX_STEPS` after the loop. Previous design clamped to `0.1 s` while only `5*h = 0.0833 s` could ever be consumed, so at <20 fps `acc` grew unbounded. Rendering interpolates player/camera between the previous and current fixed-step states (`lerp(prevPos, curPos, interp)`); step-up height changes and landing clamps are applied **inside** physics and never interpolated as free motion, so no rebound jitter.

### 3.2 Per-frame sequence (exact order)

```
1.  poll input                (was sampled per fixed step too; edge events latched here)
2.  player physics            (fixed steps; mobs also stepped here, §3.3)
3.  chunk streaming           budget STREAM_MS = 2.0   (load/unload ring, nearest-first,
                               edit-priority first; generates at most N chunks/frame)
4.  apply pendingEdits        (worldgen cross-chunk writes into now-loaded neighbors;
                               re-dirty their borders)
5.  light updates             budget LIGHT_MS  = 2.0   (drain light engine queues)
6.  mesh rebuild              budget MESH_MS   = 4.0   (pop nearest dirty chunk, remesh)
7.  mob updates               (AI tick, spawn/despawn, budgeted pathfind: ≤2 A* per frame)
8.  audio                     (footstep/break/place triggers; WebAudio is async)
9.  uniforms                  (uSkyColor, uSkyLightColor, uSkyIntensity, uSunDir, uTime, fog)
10. visibility pass           (once): frustum + vertical band test -> mesh.visible
11. render                    opaque -> cutout -> blend(transparent, back-to-front)
12. save flush                (debounced: every 5 s if dirty)
```

### 3.3 Remeshes per frame and hitch avoidance

- A single **full** chunk mesh at CHUNK_Y=128 costs **~0.6–1.2 ms** typical, up to ~1.5 ms dense.
- **Budgeted, section-granular:** the mesher can stop at any 16³ section boundary. Per frame the queue consumes until `MESH_MS` (4 ms) is spent, with a **hard cap of 4 full chunks**. Practically that is **2–4 chunks/frame** typical, or up to ~8 mostly-empty sections.
- **Preemption:** on a multi-section chunk, if the budget is exhausted mid-chunk, the remaining sections are finished next frame via a per-chunk `sectionCursor` — so a single dense chunk can never blow a whole frame (fix R13).
- **Coalescing:** each chunk carries `revision`/`meshRev`; if a newer edit lands while the chunk is queued, the queued rebuild is a no-op and only the latest is meshed (holding left-click on one block ⇒ one rebuild).
- **Edit priority:** the queue is a binary min-heap keyed `(priority, distance)`, where an edit-dirtied chunk (own + border neighbors) gets priority 0 and streamed-in chunks priority 1. Edits never wait behind a large streaming ring (fix G4).
- **No GC churn:** each chunk reuses one pre-allocated interleaved `ArrayBuffer` sized to its high-water mark; after a rebuild, `attribute.needsUpdate = true` + `attribute.updateRange` uploads only the used range. Geometry objects are pooled by power-of-two size on stream in/out.
- **Loading/settings changes** schedule all affected chunks into the same queue with a larger budget (8 ms) — never a synchronous full-ring rebuild.

---

## 4. INTERFACES

### 4.1 The `World` facade (defined in `engine.js`, passed to all modules)

```js
World = {
  // --- read ---
  getBlock(wx, y, wz)            // packed u16; UNSAFE for collision (may trigger load, see below)
  getBlockId(wx, y, wz)          // id only, fast path
  isLoaded(cx, cz)
  getChunk(cx, cz)               // Chunk | null

  // --- render/mesh sampling (NEVER forces a full chunk generate) ---
  sampleBlockForMesh(wx, y, wz)  // returns block id using: resident chunk data if loaded,
                                 //   else the deterministic worldgen sample (no allocation)
  // --- collision sampling (treats unloaded as SOLID, no load) ---
  isSolidForCollision(wx, y, wz) // true if block solid, or chunk not resident (prevents void)

  // --- light ---
  getSky(wx, y, wz)              // 0..15
  getBlockLight(wx, y, wz)       // 0..15
  getPackedLight(wx, y, wz)      // u8

  // --- write ---
  setBlock(wx, y, wz, packed)    // edits: dirties mesh (own+border, ≤4 chunks),
                                 //   light (1-chunk margin), heightmap, tiles, save mark
  setBlockNoSave(...)            // worldgen/pendingEdits path
}
```

**Fix G3 / R4 (render vs collision block reads):** the old design conflated one `getBlock`. VoxelCraft exposes **two distinct sampling paths**:

- `sampleBlockForMesh` — used **only** by the mesher and worldgen edge features. It reads resident data when available and otherwise evaluates the deterministic `voxel-worldgen` sample function for that coordinate (no chunk object allocated, no tree/ore loop). This is why a boundary face can be meshed correctly **without** synchronously generating the whole neighbor (fix G5/R4).
- `isSolidForCollision` — used **only** by physics. It returns `true` for any coordinate in a non-resident chunk, so the player/mobs can never fall through the void during streaming. It never triggers generation.

`setBlock` is the single mutation point; every subsystem that needs to react to edits subscribes via the engine (mesh dirty, light dirty, heightmap, tile entities, save mark, mob path invalidation).

### 4.2 What each module calls / needs back

| Module | Calls on `World` | Engine calls on it |
|---|---|---|
| `voxel-chunk` (mesher) | `sampleBlockForMesh`, chunk `padded`/`lightmap` (direct) | `meshChunk(chunk, pass) -> {positions, attrs, indices}` |
| `voxel-light` | `getBlockId`, `isLoaded`, `getChunk`, writes `lightmap` | `enqueueLight(chunk, cell, channel)`, `drainLight(msBudget)` |
| `voxel-player` | `isSolidForCollision`, `getBlock`, `getBlockId`, `inWater/inLava/onLadder` | `step(h)`, `getCamera()`, `getInterp()` |
| `voxel-raycast` | `getBlockId`, `isLoaded`, `defOf` | `raycast(maxDist) -> hit|null` |
| `voxel-inventory` | `defOf`, item registry | event hooks; `World.setBlock` on placement |
| `voxel-mobs` | `isSolidForCollision`, `getBlockId`, `getSky/getBlockLight`, `isLoaded` | `tick(dt, world)`, `spawnTick()` |
| `voxel-worldgen` | pure functions + `pendingEdits` sink | `generateChunk(cx,cz) -> Uint16Array`, `pendingEditsFor(cx,cz)` |
| `voxel-save` | chunk `blocks`/`modified`, level meta | `serializeChunk(chunk) -> ArrayBuffer`, `flush()` |
| `voxel-sound` | none | `playStep(mat)`, `playBreak(mat)`, `playPlace(mat)` |

Every module that mutates state does so through `World`; no module reaches into another's internals.

---

## 5. PER-SUBSYSTEM PLAN

### 5.1 Rendering & world meshing (`voxel-chunk.js`, materials in `engine.js`)

**Good algorithms kept:** slab-major index; per-face quads (no greedy meshing — greedy breaks per-vertex AO, which is exactly the Minecraft look); corner AO with the 3-sample algorithm; the quad-flip rule; `faceShade` directional constants; light baked as **separate sky/block attributes** combined in the shader; chunk-local vertex positions; three render buckets; frustum culling from a heightmap-sized bounding sphere; LOD bands.

**Face-visibility predicate — CORRECTED (fix R1).** The render design's four-clause OR culled solid faces next to water/glass. The correct, complete rule is a **two-condition rejection**:

```js
// emit face iff:
emit = !def(nb).opaque                          // opaque neighbor always hides the face
     && !(def(self).cullSameType && nbId === selfId);  // same-type non-opaque self-culls
```

Check against the intended examples: stone↔dirt → `nb.opaque` → cull. stone↔water → water not opaque → **emit**. water↔water → cullSameType + same id → cull. water↔stone → stone opaque → cull the water face. glass↔glass → cull. glass↔stone → emit glass face; stone face emitted (glass not opaque). leaves↔leaves → cull; leaves↔air → emit; leaves↔stone → cull. Cross blocks bypass all culling (own path). All correct.

**Corner AO (kept):**

```js
function vertexAO(occ, bx,by,bz, u,v, su,sv){
  const s1 = occ(bx+u[0]*su, by+u[1]*su, bz+u[2]*su);
  const s2 = occ(bx+v[0]*sv, by+v[1]*sv, bz+v[2]*sv);
  const co = occ(bx+u[0]*su+v[0]*sv, by+u[1]*su+v[1]*sv, bz+u[2]*su+v[2]*sv);
  if (s1 && s2) return 0;            // both edges solid
  return 3 - (s1 + s2 + co);         // 3 open .. 0 max occluded
}
const aoTable = [0.50, 0.70, 0.85, 1.00];
```

`occ` counts only `opaque` blocks. Brightness tint = `faceShade[f] * aoTable[ao]`, with `faceShade = {+Y:1.0, -Y:0.5, +Z:0.8, -Z:0.8, +X:0.6, -X:0.6}`.

**Quad-flip rule (kept, explicitly required):** corners `c0..c3` in CCW order; default diagonal `c0–c2`. **Flip to diagonal `c1–c3` when `AO(c1)+AO(c3) > AO(c0)+AO(c2)`** — always split along the brighter diagonal so the gradient seam is hidden.

```js
const flip = (ao[1]+ao[3]) > (ao[0]+ao[2]);
indices = flip
  ? [b,b+1,b+3,  b+1,b+2,b+3]
  : [b,b+1,b+2,  b,b+2,b+3];
```

**Sky light color separation — CORRECTED (fix R7):** the shader now uses a **neutral light tint**, distinct from the blue fog/background:

```glsl
float sky = vSky/15.0, blk = vBlock/15.0;
vec3 lightCol = mix(BLOCK_TINT, uSkyLightColor * uSkyIntensity, sky);
lightCol = max(lightCol, BLOCK_TINT * blk);
col = tex.rgb * vAO * vFaceShade * lightCol;
```

`uSkyColor` (≈ `(0.53,0.71,1.0)` at noon) drives background/fog only; `uSkyLightColor` stays near neutral-white (`(1.0,0.98,0.94)` day → warm dusk → dim blue night). This removes the "world looks underwater" bug.

**Transparent bucket sides — CORRECTED (fix R8):** only **water** uses `side: DoubleSide`; **glass and ice use `FrontSide`** with `depthWrite:false`. DoubleSide on glass cubes rasterized near+far faces and doubled the blend.

**Water geometry — CORRECTED (fix R16):** the lowered surface (`y + 14/16`) is applied consistently — a side face's **top edge** is lowered to the same level as the adjacent top quad, so no 2/16 lip appears at exposed edges. The water `state` bits `0..7` are now **read** by the mesher to set partial-fill height, so flowing/partial water renders at the right level.

**Water waves — CORRECTED (fix R5):** the wave phase uses **world** coordinates via a `uChunkOrigin` uniform:

```glsl
vec2 wp = position.xz + uChunkOrigin;
transformed.y += (sin(uTime*1.6 + wp.x*0.7) + sin(uTime*1.1 + wp.y*0.9)) * 0.03 * vWaterTop;
```

so ripples are continuous across chunk borders. UV scroll uses `fract()` inside the tile; two samples blended by `sin(uTime)`. Fake reflection: `mix(waterDeep, uSkyColor, pow(1-|dot(viewDir,up)|,2))` + a `pow(...,64)` sun glint from the analytic wave normal. Underwater = fullscreen tinted overlay + reduced fog (`~16`).

**Atlas filtering — CORRECTED to match the texture subsystem (fix R17):** padded atlas, `magFilter=NearestFilter`, `minFilter=NearestMipmapLinearFilter`, `generateMipmaps=true`, `anisotropy=max`. This is the correct anti-shimmer fix; the render design's no-mip choice aliased at distance. (No half-texel UV inset is needed with padding; per-tile clamp is impossible and was dropped.)

**LOD — CORRECTED (fix R9):** bands by distance (in chunks): `d≤4` full+AO; `4<d≤8` full, skip faces below `SEA_LEVEL-10`; `8<d≤14` 2×2×2 downsample; `d>14` heightfield strip. For each merged 2³/4³ cell the mesher picks the **dominant opaque** block (most frequent opaque), its **median tile**, **min AO contribution**, and **max light** of the cell. Because downsampling genuinely changes silhouettes, **skirts alone are insufficient**; the blueprint (a) uses **height-snapping** — the coarse mesh borrows the fine neighbor's column height along the shared edge — plus (b) downward skirts of length `2*lodScale` for sub-vertex cracks. LOD re-meshes go through the same budgeted queue.

**Padded mirror:** see §2.4 (fix R4/R11). Meshing never lazily reads a neighbor chunk; it reads the chunk's own padded mirror.

**Section early-out — CORRECTED (fix R2):** sections are skipped using the per-section `hasAnyNonAir` flag, not `maxHeight`.

**Bounding volume:** `boundingSphere` center `(8,(maxH+1)/2,8)`, radius `sqrt(8² + ((maxH+1)/2)²)+1`; `boundingBox` `[0,0,0]-[16,maxH+1,16]`; set manually, `matrixAutoUpdate=false`, matrix updated once at placement. Plus one manual vertical band test per frame.

**Worker offload (fix R15):** ship the synchronous budgeted path first. Web Workers with `SharedArrayBuffer` are **not** assumed — on `file://` `crossOriginIsolated` is false and SAB is undefined unless the Electron build forces the Chromium flag. If workers are enabled, use a **transferable snapshot protocol**: main copies chunk + 8 neighbor shells into a transferable buffer tagged with the chunk's `revision`; the worker returns transferable vertex/index buffers; the main thread discards results whose `revision` is stale. The worker interface mirrors the sync one (`mesh(chunkData) -> {positions, attrs, indices}`).

### 5.2 Light (`voxel-light.js`)

**Good algorithms kept:** 16-bucket BFS (no priority queue); sky column seeding; blocklight seeded from emitters; **two-queue incremental removal** (drain a removal queue, collect independent re-propagation seeds, then add-BFS).

**Fixes for the gameplay critique:**

- **Cross-chunk propagation (fix G2/R3).** The BFS queue is a **global** queue of `(cx, cz, localIdx, level, channel)`. When a cell's neighbor lies in another chunk, that chunk is fetched (or its lightmap created) and the neighbor is seeded there. A border cell write **bumps the neighbor's light-dirty flag and revision**. This eliminates the hard dark walls / seams at chunk boundaries. Light levels written into a not-yet-loaded neighbor are queued in a per-border `pendingLight` list applied on load (mirrors `pendingEdits`).
- **Skylight is a real propagation, not a binary "sees sky" flag (fix G2).** Phase A seeds 15 down each column to the first attenuating block (water/leaves attenuate extra). Phase B is the horizontal BFS with per-block attenuation. Under trees/cliffs, skylight falls off correctly, so the mob-spawn gate is meaningful.
- **Incremental vertical column re-seed (fix R14).** On an edit at `(x,y,z)`:
  - If the block **becomes** opaque/attenuating — run the removal BFS **down the column** (and outward) so cells below that were lit 15 are darkened.
  - If the block **becomes** transparent — re-seed skylight downward from the highest unshadowed sky above `y` for that column, then add-BFS.
  This prevents the classic "light stuck" bug (dark under an opened hole, lit under a new roof).
- **Budgeted drain (kept).** Cap `~4000` nodes/frame (`LIGHT_MS = 2`), carry over the rest; per-chunk `revision` coalesces repeated edits.
- **Emitters** register per chunk; furnace feeds an emissive state.

### 5.3 Textures (`textures.js`, done)

**Kept:** palette + 4×4 Bayer ordered dither (`pick`); seamless periodic value noise `pnoise`/`pfbm` with integer-frequency octaves; Worley F2−F1 cobble; per-block recipes (grass/dirt/stone/cobble/sand/bark+rings/leaves/planks/glass/water/ores/plants); `putImageData` blit; deterministic `hash2` only (no `Math.random`).

**Kept fixes from its own pitfalls:** padded atlas (`PAD=8, STRIDE=32`, 8×4 grid → 256×128 POT) so mips never bleed between tiles; `NearestMipmapLinearFilter` to kill shimmer; ores copy the exact stone tile before stamping; glass interior `alpha=0` in the **cutout** layer; water in its own `waterTex` with `RepeatWrapping`; sRGB consistency; `uvRect(i)` as the single UV source of truth.

### 5.4 Gameplay / player (`voxel-player.js`, `voxel-raycast.js`)

**Kept:** fixed-step accumulator; per-axis clip with axis order **Y → X → Z**; `stepUp`; sneak edge-guard; fall-distance rules; DDA ray; hardness/tool math; 10-level crack decal; mining particles; inventory/crafting model; A* cost grid (no corner-cutting).

**Fixes for the gameplay critique:**

- **AABB solver is parameterized (fix G7).** `tryMove`/`hitsWorld` take a half-width/height pair, not the hardcoded `W=0.6,H=1.8,EYE=1.62`. Player, passive mob (`0.9×0.9×1.2`), and hostile mob (`0.6×1.95`) all reuse one solver.
- **`stepUp` corrected (fix G8).** Remove the no-op `P.vel[axis]=P.vel[axis]`. On success, snap `pos.y` to the top of the stepped block (not `+STEP_HEIGHT`), set `onGround=true`, keep velocity. **Step-up is disabled while sneaking** — `sneakClamp` is tested **before** `stepUp`, so sneaking into a 1-block ledge does not auto-climb.
- **`land()` gating (fix G8).** Track `prevOnGround`; fall damage and landing SFX fire **only** on the `false→true` transition. `fallDistance` cleared on water/ladder/bed/hay landing and on jump.
- **`STEP_HEIGHT` default 0.6 (fix G9).** The design's `1.0` (auto-climb full blocks) is a fidelity regression vs. vanilla; default is **`0.6`** with an explicit `AUTO_STEP_FULL_BLOCK` setting. Full blocks require a jump by default.
- **Raycast / water-placement unified (fix G10).** Rule: the ray **hits fluids** (returns them as `hit.block`) but the *mining* path treats fluids as non-mineable; the *placement* path treats a fluid hit as **replaceable**, so placing into water works. One rule, no text/code contradiction. `NON_SOLID` decorations other than fluids are hit-testable but non-collidable.
- **Crafting corrected (fix G11).** `stick` becomes a **shaped** recipe (`[P]_`, `[P]_` vertical). `matchShaped` only mirrors when `recipe.mirror === true`. Matching validates **id + count≥1 + meta**; taking the result consumes exactly 1 per non-empty cell. Shift-craft loops until materials/space exhausted.
- **Particles corrected (fix G13).** `InstancedMesh` cannot give per-instance alpha via a shared material — use a custom `ShaderMaterial` with per-instance `alpha`/`life` attributes (or `Points` with a per-particle alpha attribute). Pool ≤2000.
- **Game modes & lifecycle added (fix G14).** Explicit `mode ∈ {SURVIVAL, CREATIVE}`: creative = instant break, infinite blocks, fly, no fall damage; survival = reach 4.5, break time, health 20 HP. Death → respawn at spawn point; tool durability for survival tools. Mode toggle key + UI.

### 5.5 Worldgen (`voxel-worldgen.js`)

**Kept:** mulberry32/splitmix64 seeded PRNG; value/Perlin fbm + **domain warp**; temp/humidity biomes; continental+hills heightmap with sea clamp; 3D-fbm caves (+ optional worm caves); depth-banded ore veins; lakes; **global-coordinate hash for cross-chunk feature ownership** with `pendingEdits`.

**Fixes:**
- **No lazy whole-chunk generation inside getBlock (fix G3/G5).** Worldgen exposes a **pure `sampleColumn(x,z)` / `sampleBlock(x,y,z)`** function (heights, biome, cave carve test, ore test) memoized per column, that the mesher's `sampleBlockForMesh` uses for non-resident coordinates. Full `generateChunk` runs only in the streaming step, never inside a mesh rebuild.
- **`pendingEdits` policy defined:** trees/ores compute ownership by hash; parts landing in a neighbor are written to that neighbor's `pendingEdits` list. On load, `apply pendingEdits` runs **before** the chunk is meshed/relit; if a neighbor is already resident, the edit is applied immediately and the owner + neighbor are marked dirty.
- Height mapping uses `SEA_LEVEL=56` (§0).

### 5.6 Mobs (`voxel-mobs.js`)

**Kept:** passive wanderer + hostile stalker; A* flat cost grid; attack/knockback; spawn ring 24–48; despawn >64.

**Fixes:**
- **A* uses in-memory collision sampling only (fix G6).** `walkable` reads through `isSolidForCollision`/cached columns, never lazy generation. Cap 2000 nodes, **≤2 pathfinds/frame**, recompute every 0.5 s or on >2-block player move. Over-budget or unreachable → fall back to wander (documented, not a hang).
- **Cave/vertical targets:** when the player is below the surface, the flat grid falls back to a **3-D local search** (≤2000 nodes, height encoded in the key `x,y,z`) or, if that fails, the stalker wanders. Prevents "hostile can never path underground."
- **Physics reuses the parameterized solver** (§5.4, fix G7).
- **Spawn gate uses real light** (`sky`/`blocklight` from `voxel-light`, §5.2): hostile spawn where light < 7; passive on lit grass by day.

### 5.7 Save (`voxel-save.js` + `main.js`)

**Kept:** binary format `magic "VXCH" + version + cx + cz + rawLen + deflateRaw(RLE(blocks))`; only `modified` chunks stored; debounced flush; atomic tmp+rename; `before-quit` flush.

**Fixes (fix G12):**
- **RLE runs in the renderer** (it can see `chunk.blocks`); **zlib runs in the main process**. The renderer sends the RLE `ArrayBuffer` over IPC; main compresses, writes, and returns. (Pure-JS inflate/pako is *not* used — no bundled deps.)
- **`modified` propagation defined:** any write through `World.setBlock` — including cascades (falling sand, neighbor-update self-destruction, fluid spread) — sets `chunk.modified = true`. A chunk that only *received* a `pendingEdit` is also marked modified so regenerated terrain matches.
- Level meta in `level.json` (seed, spawn, version, time, mode, player inventory).

### 5.8 Sound (`voxel-sound.js`)

**Kept:** procedural WebAudio — noise buffer, footstep/break/place/mine bursts, material→filter table, polyphony cap 16, `onended` recycling.

**Fix:** `AudioContext` is created/resumed on the **first user gesture** (pointer-lock entry); a global cap prevents node growth on long sessions.

### 5.9 Day/night (`engine.js`)

**Kept:** 20-minute day; `skyIntensity`; fog follows `uSkyColor`; stars/moon; optional per-face sun term from `vDot(vNormal, uSunDir)`.

**Fixes (fix R18):** `uSunDir` is **normalized** every frame. The `t=0` keyframe is relabeled so **sunrise is bright** (`clamp(sin(ang),0,1)` at `ang=0` must map to the day/dawn blend, not night — the keyframe order is `[night, dawn, day, dusk]` indexed so that `ang=0` sits at dawn→day). The night floor is raised to `~4/15` (`skyIntensity ≥ 0.27`) to match vanilla's dark-but-visible minimum.

---

## 6. CRITIQUE → FIX CROSS-REFERENCE

| # | Flagged | Fixed in |
|---|---|---|
| G1 | accumulator clamp ≤ maxSteps·h; interpolation at step-up/land | §3.1 |
| G2 | light not implementable; no cross-chunk; no incremental/dirty; binary sky | §5.2 |
| G3 | unloaded-chunk semantics conflict; one getBlock can't serve both | §4.1 (`sampleBlockForMesh` vs `isSolidForCollision`) |
| G4 | remesh budget not rescaled for CHUNK_Y=128; ring order; no edit priority | §3.3 |
| G5 | mesher triggers synchronous `generateChunk` | §4.1, §5.5 |
| G6 | A* unbounded / lazy generation / no cave handling | §5.6 |
| G7 | mobs can't reuse player solver (hardcoded dims) | §5.4 (parameterized AABB) |
| G8 | step-up no-op; sneak vs step-up; land() gating | §5.4 |
| G9 | STEP_HEIGHT=1.0 fidelity regression | §5.4 (default 0.6 + toggle) |
| G10 | raycast vs "place on water" contradiction | §5.4 |
| G11 | stick recipe; unconditional mirror; count/meta | §5.4 |
| G12 | zlib location; modified propagation | §5.7 |
| G13 | InstancedMesh per-instance alpha | §5.4 |
| G14 | missing modes/death/durability | §5.4 |
| R1 | face predicate missing `!nb.opaque` | §5.1 |
| R2 | heightmap used as geometry-existence test | §2.5, §5.1 (`hasAnyNonAir`) |
| R3 | border light propagation undefined | §5.2 |
| R4 | neighbor data required but not guaranteed | §2.4, §4.1 |
| R5 | water wave local coords → seams | §5.1 (`uChunkOrigin`) |
| R6 | impossible 16-byte vertex / memory math | §2.3 (20-byte format) |
| R7 | `uSkyColor` used for fog and skylight | §5.1 (`uSkyLightColor`) |
| R8 | DoubleSide on all transparent | §5.1 (water only) |
| R9 | LOD silhouette change not fixed by skirts | §5.1 (dominant-cell + height-snap + skirts) |
| R10 | slab-major justification wrong (Phase A per-column) | §5.2 (Phase A rewritten layer-by-layer) |
| R11 | padded snapshot can't fill in "4 set() calls" | §2.4 (incremental mirror) |
| R12 | budget loop contradictory / `timeSliceExceeded` | §3.3 (section-granular preemption) |
| R13 | one dense chunk blows the frame | §3.3 |
| R14 | incremental skylight vertical column | §5.2 |
| R15 | worker/SAB assumption on file:// | §5.1 (transferable snapshot protocol) |
| R16 | water top lowered but sides not; level bits unused | §5.1 |
| R17 | NearestFilter shimmer; half-texel inset | §5.1 (padded atlas + mips + anisotropy) |
| R18 | sunDir not normalized; dawn=night; night floor | §5.9 |

**Fix R10 note:** Phase A skylight is written **layer-by-layer** — for each y from top down, iterate all 256 columns, tracking still-open columns in a bitmap — so the slab-major `blocks` layout is actually exploited. This restores the locality claim behind slab-major storage.

---

## 7. KNOWN LIMITS — what VoxelCraft deliberately does NOT do

- **No multiplayer / networking.** Offline single-player only; `file://`; no sockets.
- **No Mojang assets.** All textures/audio procedural; no bundled or downloaded files.
- **No mob models beyond axis-aligned boxes.** No articulated limbs, no skin textures, no animations beyond a simple arm-swing on attack.
- **No redstone logic**, no pistons, no comparators, no rails/minecarts, no boats.
- **No enchantments, potions, XP, or anvil.**
- **No Nether / End / portals**, no other dimensions.
- **No generated structures** (villages, dungeons, strongholds, temples).
- **Simplified fluids** — no infinite-source chains or complex flow; water levels render but flow is limited to short spreads (optional, off by default).
- **Simplified entity physics** — dropped items are simple billboards with pickup, no item-entity collision stacking; no item frames, no armor stands.
- **Limited block set** (~24 block types per the catalog's 32 atlas slots); no slabs/stairs/fences/walls (only full cubes, cross plants, and one pane variant).
- **No weather** (rain/snow) and no seasons.
- **No achievements, statistics, or advancements.**
- **No shader pack / post-processing beyond the underwater overlay** and optional FXAA; no real shadows or screen-space reflections.
- **Mob AI is single-tier** — one passive and one hostile archetype, no breeding, no taming, no villager trading.
- **No controller/gamepad support**; keyboard + mouse only.
- **LOD is distance-banded** and coarse (max 4×/heightfield); the far band is intentionally low-detail behind fog.
- **No mod/plugin API.**
- **Windows target only** (packaged `.exe`); no macOS/Linux build in this scope.
