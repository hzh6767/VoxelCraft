// VoxelCraft — 区块存储 + 网格构建
// 挂在 window.VoxelChunk 上。
//
// 索引约定（全项目统一）：idx = (y * CHUNK_Z + lz) * CHUNK_X + lx
//
// 网格构建是画面质量的关键：逐顶点环境光遮蔽 (AO) + 各面方向明暗 + 光照等级，
// 三者相乘烘进顶点色。AO 的四顶点翻转规则是避免地面上出现对角接缝的核心。
(function (global) {
  'use strict';

  const CHUNK_X = 16, CHUNK_Z = 16, CHUNK_Y = 128;

  const BLK = global.VoxelBlocks || {
    isOpaque: () => true, isCross: () => false, isTransparent: () => false,
    ID: { AIR: 0, WATER: 15 }, DEF: {},
  };
  const AIR = BLK.ID.AIR;
  const WATER = BLK.ID.WATER;

  function key(cx, cz) { return cx + ',' + cz; }

  /* ============================================================
   * Chunk
   * ============================================================ */
  class Chunk {
    constructor(cx, cz) {
      this.cx = cx;
      this.cz = cz;
      this.blocks = new Uint8Array(CHUNK_X * CHUNK_Z * CHUNK_Y);
      this.skyLight = new Uint8Array(CHUNK_X * CHUNK_Z * CHUNK_Y);
      this.blockLight = new Uint8Array(CHUNK_X * CHUNK_Z * CHUNK_Y);
      this.dirty = true;
      this.lightDirty = true;
      this.lightReady = false;    // VoxelLight.computeChunkLight 完成后置 true
      this.mesh = null;
      this.waterMesh = null;
      this.crossMesh = null;
      this.heightMap = null;      // 惰性计算
    }

    idx(lx, y, lz) { return (y * CHUNK_Z + lz) * CHUNK_X + lx; }

    get(lx, y, lz) {
      if (y < 0 || y >= CHUNK_Y) return AIR;
      return this.blocks[this.idx(lx, y, lz)];
    }
    set(lx, y, lz, v) {
      if (y < 0 || y >= CHUNK_Y) return;
      this.blocks[this.idx(lx, y, lz)] = v;
    }
    getSky(lx, y, lz) {
      if (y < 0) return 0;
      if (y >= CHUNK_Y) return 15;
      return this.skyLight[this.idx(lx, y, lz)];
    }
    getBlockLight(lx, y, lz) {
      if (y < 0 || y >= CHUNK_Y) return 0;
      return this.blockLight[this.idx(lx, y, lz)];
    }
    // 最高非空气方块的 y，用于生成和出生点
    columnTop(lx, lz) {
      if (!this.heightMap) {
        this.heightMap = new Int16Array(CHUNK_X * CHUNK_Z);
        for (let z = 0; z < CHUNK_Z; z++) for (let x = 0; x < CHUNK_X; x++) {
          let top = 0;
          for (let y = CHUNK_Y - 1; y >= 0; y--) {
            const b = this.blocks[this.idx(x, y, z)];
            if (b !== AIR && b !== WATER && !BLK.isCross(b)) { top = y; break; }
          }
          this.heightMap[z * CHUNK_X + x] = top;
        }
      }
      return this.heightMap[lz * CHUNK_X + lx];
    }
  }

  /* ============================================================
   * 六个面的顶点定义
   * 顺序 [+x, -x, +y, -y, +z, -z]，与 voxel-blocks 的 tiles 顺序一致。
   * shade = 方向明暗（顶面最亮，底面最暗），模拟天光方向。
   * ============================================================ */
  const FACES = [
    // shade 已压缩到 [0.75 .. 1.00]：真实方向光接手 N·L 后，
    // 这里只保留一点残余的朝向差，让纯环境光区域（洞穴、夜晚）仍有立体感，
    // 又不会在受光面/背光面上把方向对比乘两次。
    { dir: [ 1, 0, 0], corners: [[1,0,1],[1,0,0],[1,1,0],[1,1,1]], shade: 0.865, uAxis: 2, vAxis: 1, uDir: -1, vDir: 1 },
    { dir: [-1, 0, 0], corners: [[0,0,0],[0,0,1],[0,1,1],[0,1,0]], shade: 0.865, uAxis: 2, vAxis: 1, uDir: 1,  vDir: 1 },
    { dir: [ 0, 1, 0], corners: [[0,1,1],[1,1,1],[1,1,0],[0,1,0]], shade: 1.000, uAxis: 0, vAxis: 2, uDir: 1,  vDir: -1 },
    { dir: [ 0,-1, 0], corners: [[0,0,0],[1,0,0],[1,0,1],[0,0,1]], shade: 0.750, uAxis: 0, vAxis: 2, uDir: 1,  vDir: 1 },
    { dir: [ 0, 0, 1], corners: [[0,0,1],[1,0,1],[1,1,1],[0,1,1]], shade: 0.933, uAxis: 0, vAxis: 1, uDir: 1,  vDir: 1 },
    { dir: [ 0, 0,-1], corners: [[1,0,0],[0,0,0],[0,1,0],[1,1,0]], shade: 0.933, uAxis: 0, vAxis: 1, uDir: -1, vDir: 1 },
  ];

  /* AO 亮度档位：0=最暗（三面被挡），3=无遮挡。
   * 只有 4 档时暗部会出现肉眼可见的色带，所以这里按感知曲线展开成 16 档，
   * 保留整数值 0..3 用于四顶点翻转的判断（翻转需要对角线和的大小）。 */
  const AO_LEVELS = (function () {
    const a = [0.30, 0.52, 0.76, 1.0];
    const out = new Float32Array(16);
    for (let i = 0; i < 16; i++) {
      const t = i / 15 * 3;          // 0..3
      const lo = Math.floor(t), hi = Math.min(3, lo + 1), f = t - lo;
      out[i] = a[lo] + (a[hi] - a[lo]) * f;
    }
    return out;
  })();
  // 把整数 AO 值 (0..3) 映射到细档位
  const aoIndex = v => (v <= 0 ? 0 : v >= 3 ? 15 : (v * 5));

  /* 方块世界坐标 -> 稳定的 hash。用它给同一张贴图挑选变体：
   * 同一个方块六个面拿到同一个变体，整片地形则各不相同。 */
  function blockHash(x, y, z) {
    let h = Math.imul(x | 0, 374761393) ^ Math.imul(y | 0, 668265263) ^ Math.imul(z | 0, 2246822519);
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    h = h ^ (h >>> 16);
    return h >>> 0;
  }

  /* ============================================================
   * 网格构建
   * ============================================================ */
  function buildMesh(chunk, world) {
    // 三个输出流：不透明、水（单独材质以便动画/排序）、十字植物
    const op = { pos: [], uv: [], col: [], nrm: [], idx: [] };
    const tr = { pos: [], uv: [], col: [], nrm: [], idx: [] };
    const cr = { pos: [], uv: [], col: [], nrm: [], idx: [] };

    const ox = chunk.cx * CHUNK_X;
    const oz = chunk.cz * CHUNK_Z;

    // 世界坐标取样（跨区块用 world；未加载的邻区块由 world 给默认值）
    function at(x, y, z) {
      if (y < 0) return BLK.ID.BEDROCK !== undefined ? 6 : 1;   // 世界底以下视为实心，避免露空
      if (y >= CHUNK_Y) return AIR;
      const lx = x - ox, lz = z - oz;
      if (lx >= 0 && lx < CHUNK_X && lz >= 0 && lz < CHUNK_Z) return chunk.get(lx, y, lz);
      if (world && typeof world.getBlock === 'function') return world.getBlock(x, y, z);
      return AIR;
    }
    function skyAt(x, y, z) {
      if (y >= CHUNK_Y) return 15;
      if (y < 0) return 0;
      // 光照还没算过的区块一律按满天光处理，否则开场整片地形会暗到看不见
      if (!chunk.lightReady) return 15;
      const lx = x - ox, lz = z - oz;
      if (lx >= 0 && lx < CHUNK_X && lz >= 0 && lz < CHUNK_Z) return chunk.getSky(lx, y, lz);
      if (world && typeof world.getSkyLight === 'function') return world.getSkyLight(x, y, z);
      return 15;
    }
    function blAt(x, y, z) {
      const lx = x - ox, lz = z - oz;
      if (lx >= 0 && lx < CHUNK_X && lz >= 0 && lz < CHUNK_Z) return chunk.getBlockLight(lx, y, lz);
      if (world && typeof world.getBlockLightAt === 'function') return world.getBlockLightAt(x, y, z);
      return 0;
    }
    // 用于 AO 的遮挡判定：只有不透明方块才算遮挡
    function occludes(x, y, z) {
      const b = at(x, y, z);
      if (b === AIR) return 0;
      return BLK.isOpaque(b) ? 1 : 0;
    }

    const atlas = global.__voxelAtlas;
    // variantHash：方块坐标 hash。优先取该贴图的第 (hash % 变体数) 个变体；
    // 图集没有变体 API（或该贴图只有 1 个变体）时退回主变体。
    function uvRect(tileName, variantHash) {
      if (atlas && typeof atlas.uvOfVariant === 'function') {
        const r = atlas.uvOfVariant(tileName, variantHash || 0);
        if (r) return r;
      }
      if (atlas && typeof atlas.uvOf === 'function') {
        const r = atlas.uvOf(tileName);
        if (r) return r;
      }
      return { u0: 0, v0: 0, u1: 1, v1: 1 };
    }

    for (let y = 0; y < CHUNK_Y; y++) {
      for (let lz = 0; lz < CHUNK_Z; lz++) {
        for (let lx = 0; lx < CHUNK_X; lx++) {
          const id = chunk.get(lx, y, lz);
          if (id === AIR) continue;

          const wx = ox + lx, wz = oz + lz;
          const def = BLK.DEF && BLK.DEF[id];

          /* ---- 十字植物：两片交叉面 ---- */
          if (BLK.isCross(id)) {
            const tileName = (def && def.tiles && def.tiles[0]) || null;
            if (tileName) {
              const light = Math.max(skyAt(wx, y, wz), blAt(wx, y, wz)) / 15;
              const bright = 0.35 + light * 0.65;
              // 两片对角面
              const quads = [
                [[0.146, 0, 0.146], [0.854, 0, 0.854]],
                [[0.854, 0, 0.146], [0.146, 0, 0.854]],
              ];
              for (const pair of quads) {
                const p0 = pair[0], p1 = pair[1];
                const base = cr.pos.length / 3;
                // 每片对角面有自己的水平法线：把面内的对角方向绕 Y 轴转 90°，
                // 于是两片交叉面朝向互相垂直，Lambert 下才能分辨出两个朝向。
                const dxq = p1[0] - p0[0], dzq = p1[2] - p0[2];
                let nxq = dzq, nzq = -dxq;
                const nlen = Math.hypot(nxq, nzq) || 1;
                nxq /= nlen; nzq /= nlen;
                const pts = [
                  [p0[0], 0, p0[2]], [p1[0], 0, p1[2]], [p1[0], 1, p1[2]], [p0[0], 1, p0[2]],
                ];
                const rect = uvRect(tileName, blockHash(wx, y, wz));
                const uvs = [[rect.u0, rect.v1], [rect.u1, rect.v1], [rect.u1, rect.v0], [rect.u0, rect.v0]];
                for (let k = 0; k < 4; k++) {
                  cr.pos.push(wx + pts[k][0], y + pts[k][1], wz + pts[k][2]);
                  cr.uv.push(uvs[k][0], uvs[k][1]);
                  cr.col.push(bright, bright, bright);
                  cr.nrm.push(nxq, 0, nzq);
                }
                cr.idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
              }
            }
            continue;
          }

          const isWater = (id === WATER);

          /* ---- 六个面 ---- */
          for (let f = 0; f < 6; f++) {
            const F = FACES[f];
            const nx = wx + F.dir[0], ny = y + F.dir[1], nz = wz + F.dir[2];
            const nb = at(nx, ny, nz);

            // 可见性：邻块不透明 -> 剔除；邻块与自己同类 -> 剔除（水与水、玻璃与玻璃之间不出面）
            if (BLK.isOpaque(nb)) continue;
            if (nb === id) continue;
            // 水下方块只对水露面：水面下的方块朝上的面若邻接水，仍绘制（水是半透明的）
            if (isWater && BLK.isOpaque(nb)) continue;

            const target = isWater ? tr : op;
            const rect = uvRect((def && def.tiles && def.tiles[f]) || 'stone', blockHash(wx, y, wz));

            // 依据面法线所在轴，取另外两轴作为切向
            const axis = F.dir[0] !== 0 ? 0 : (F.dir[1] !== 0 ? 1 : 2);
            const t1 = axis === 0 ? 1 : 0;
            const t2 = axis === 2 ? 1 : 2;

            // 四角 AO
            const aoVals = [0, 0, 0, 0];
            for (let k = 0; k < 4; k++) {
              const C = F.corners[k];                 // 面内 0/1 局部坐标
              const s1 = C[t1] === 0 ? -1 : 1;
              const s2 = C[t2] === 0 ? -1 : 1;
              // 面外的邻居基准点
              const bx = nx, by = ny, bz = nz;
              let px1, py1, pz1, px2, py2, pz2, pcx, pcy, pcz;

              const o1 = [0, 0, 0], o2 = [0, 0, 0], oc = [0, 0, 0];
              o1[t1] = s1; o2[t2] = s2; oc[t1] = s1; oc[t2] = s2;

              const side1 = occludes(bx + o1[0], by + o1[1], bz + o1[2]);
              const side2 = occludes(bx + o2[0], by + o2[1], bz + o2[2]);
              const corn  = occludes(bx + oc[0], by + oc[1], bz + oc[2]);

              // 经典 AO 公式
              aoVals[k] = (side1 && side2) ? 0 : (3 - (side1 + side2 + corn));
            }

            const base = target.pos.length / 3;
            const shade = F.shade;
            const skyL = skyAt(nx, ny, nz) / 15;
            const blkL = blAt(nx, ny, nz) / 15;
            // 天光为主，方块光补充；再叠一点最低环境光，免得洞穴里全黑
            const lightMul = 0.18 + 0.62 * Math.max(skyL, blkL * 0.9) + 0.20 * blkL;

            const uvs = [
              [rect.u0, rect.v1], [rect.u1, rect.v1], [rect.u1, rect.v0], [rect.u0, rect.v0],
            ];

            for (let k = 0; k < 4; k++) {
              const C = F.corners[k];
              target.pos.push(wx + C[0], y + C[1], wz + C[2]);
              target.uv.push(uvs[k][0], uvs[k][1]);
              const b = shade * lightMul * AO_LEVELS[aoIndex(aoVals[k])];
              target.col.push(b, b, b);
              target.nrm.push(F.dir[0], F.dir[1], F.dir[2]);
            }

            // 四顶点翻转：AO 各向异性时改对角线走向，消除可见接缝
            // 沿 (a00+a11) 与 (a01+a10) 中"和较大"的那条对角线切分
            const a00 = aoVals[0], a01 = aoVals[1], a11 = aoVals[2], a10 = aoVals[3];
            const diagA = a00 + a11;   // 顶点 0-2
            const diagB = a01 + a10;   // 顶点 1-3
            if (diagA > diagB) {
              // 沿 0-2 切
              target.idx.push(base, base + 1, base + 2, base, base + 2, base + 3);
            } else {
              // 沿 1-3 切
              target.idx.push(base + 1, base + 2, base + 3, base + 1, base + 3, base);
            }
          }
        }
      }
    }

    function toGeo(d) {
      if (!d.idx.length) return null;
      const g = new THREE.BufferGeometry();
      g.setAttribute('position', new THREE.Float32BufferAttribute(d.pos, 3));
      g.setAttribute('uv', new THREE.Float32BufferAttribute(d.uv, 2));
      g.setAttribute('color', new THREE.Float32BufferAttribute(d.col, 3));
      g.setAttribute('normal', new THREE.Float32BufferAttribute(d.nrm, 3));
      g.setIndex(d.idx);
      g.computeBoundingSphere();
      return g;
    }

    return {
      opaque: toGeo(op),
      water: toGeo(tr),
      cross: toGeo(cr),
      // 供统计/调试
      counts: { opaque: op.idx.length / 6, water: tr.idx.length / 6, cross: cr.idx.length / 6 },
    };
  }

  global.VoxelChunk = {
    CHUNK_X, CHUNK_Z, CHUNK_Y,
    Chunk,
    buildMesh,
    key,
    FACES,
    AO_LEVELS,
  };
})(window);
