// VoxelCraft — 光照系统
// 挂在 window.VoxelLight 上。
// 天光从上往下，矿物光（荧石）从源点向外扩散。
// 关键：增量更新（onBlockChanged）必须快，不能每次都重算整个世界。
(function (global) {
  'use strict';

  const CHUNK_X = 16, CHUNK_Z = 16, CHUNK_Y = 128, SEA_LEVEL = 56;

  const BLK = global.VoxelBlocks || { isOpaque: () => true, ID: { GLOWSTONE: 27 } };
  const GLOWSTONE = BLK.ID.GLOWSTONE;

  /* ============================================================
   * 计算区块的天光和矿物光
   * ============================================================ */
  function computeChunkLight(chunk, world) {
    // 初始化两个光照数组
    chunk.skyLight = new Uint8Array(CHUNK_X * CHUNK_Z * CHUNK_Y);
    chunk.blockLight = new Uint8Array(CHUNK_X * CHUNK_Z * CHUNK_Y);

    const idx = (y, lz, lx) => (y * CHUNK_Z + lz) * CHUNK_X + lx;

    // A) 天光：从上往下，被不透明方块阻挡
    for (let lz = 0; lz < CHUNK_Z; lz++) {
      for (let lx = 0; lx < CHUNK_X; lx++) {
        let light = 15;
        for (let y = CHUNK_Y - 1; y >= 0; y--) {
          const id = chunk.blocks[idx(y, lz, lx)];
          // 记录当前光照
          chunk.skyLight[idx(y, lz, lx)] = light;
          // 如果是不透明方块，光照衰减；水衰减 1，其他完全阻挡
          if (BLK.isOpaque(id)) {
            light = 0;
          } else if (id === 15) {  // WATER
            if (light > 0) light--;
          }
        }
      }
    }

    // B) 矿物光：从荧石源点 BFS 扩散
    const queue = [];
    // 初始化：找所有荧石，加入队列
    for (let y = 0; y < CHUNK_Y; y++) {
      for (let lz = 0; lz < CHUNK_Z; lz++) {
        for (let lx = 0; lx < CHUNK_X; lx++) {
          const id = chunk.blocks[idx(y, lz, lx)];
          if (id === GLOWSTONE) {
            chunk.blockLight[idx(y, lz, lx)] = 15;
            queue.push([lx, y, lz, 15]);
          }
        }
      }
    }

    // BFS 扩散
    while (queue.length) {
      const [lx, y, lz, light] = queue.shift();
      if (light <= 0) continue;

      // 六个邻居
      const dirs = [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]];
      for (const [dx, dy, dz] of dirs) {
        const nlx = lx + dx, ny = y + dy, nlz = lz + dz;
        if (nlx < 0 || nlx >= CHUNK_X || ny < 0 || ny >= CHUNK_Y || nlz < 0 || nlz >= CHUNK_Z) continue;

        const nidx = idx(ny, nlz, nlx);
        const newLight = light - 1;
        if (chunk.blockLight[nidx] < newLight) {
          chunk.blockLight[nidx] = newLight;
          queue.push([nlx, ny, nlz, newLight]);
        }
      }
    }

    chunk.lightReady = true;
  }

  /* ============================================================
   * 增量更新：方块改动时的局部光照调整
   * ============================================================ */
  function onBlockChanged(x, y, z, oldId, newId, world) {
    // 这个版本的简化实现：仅标记相关区块为光照脏
    // 完整的增量 BFS 删除+添加会很复杂，这里先用暴力方案：
    // 标记该方块所在的区块和邻近区块需要重新光照计算
    const cx = Math.floor(x / CHUNK_X), cz = Math.floor(z / CHUNK_Z);
    if (world && typeof world.markDirty === 'function') {
      world.markDirty(cx, cz);
      for (let dcx = -1; dcx <= 1; dcx++) {
        for (let dcz = -1; dcz <= 1; dcz++) {
          world.markDirty(cx + dcx, cz + dcz);
        }
      }
    }
  }

  /* ============================================================
   * 查询接口
   * ============================================================ */
  function getSky(x, y, z) {
    if (y >= CHUNK_Y) return 15;
    if (y < 0) return 0;
    if (!world || typeof world.isLoaded !== 'function') return 15;

    const cx = Math.floor(x / CHUNK_X), cz = Math.floor(z / CHUNK_Z);
    if (!world.isLoaded(cx, cz)) return 15;  // 未加载按满光处理

    const chunk = world.peek(cx, cz);
    if (!chunk || !chunk.skyLight) return 15;

    const lx = x & 15, lz = z & 15;
    const idx = (y * CHUNK_Z + lz) * CHUNK_X + lx;
    // 注意不能用 || 15：天光 0 是合法值（洞穴、屋檐下），
    // 而 0 是假值，会把"全黑"读成"满天光"，导致洞穴在区块边界出现亮条纹。
    const v = chunk.skyLight[idx];
    return v === undefined ? 15 : v;
  }

  function getBlockLight(x, y, z) {
    if (y >= CHUNK_Y || y < 0) return 0;
    if (!world || typeof world.isLoaded !== 'function') return 0;

    const cx = Math.floor(x / CHUNK_X), cz = Math.floor(z / CHUNK_Z);
    if (!world.isLoaded(cx, cz)) return 0;

    const chunk = world.peek(cx, cz);
    if (!chunk || !chunk.blockLight) return 0;

    const lx = x & 15, lz = z & 15;
    const idx = (y * CHUNK_Z + lz) * CHUNK_X + lx;
    return chunk.blockLight[idx] || 0;
  }

  let world = null;

  global.VoxelLight = {
    CHUNK_X, CHUNK_Z, CHUNK_Y,
    computeChunkLight,
    onBlockChanged,
    getSky,
    getBlockLight,
    _setWorld: (w) => { world = w; },  // 内部用，engine.js 会调用
  };
})(window);
