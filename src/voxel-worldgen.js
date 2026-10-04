// VoxelCraft — 程序化地形生成
// 挂在 window.VoxelWorldgen 上。
//
// 关键约束：生成必须是确定性的。区块是随玩家走动惰性生成的，
// 同一 (cx,cz) 第二次生成必须得到逐字节相同的结果，否则玩家回头时地形会变。
// 因此这里只用整数 hash，绝不使用 Math.random。
(function (global) {
  'use strict';

  const CHUNK_X = 16, CHUNK_Z = 16, CHUNK_Y = 128, SEA_LEVEL = 56;

  const B = global.VoxelBlocks ? global.VoxelBlocks.ID : {
    AIR: 0, STONE: 1, GRASS: 2, DIRT: 3, COBBLESTONE: 4, BEDROCK: 6,
    OAK_LOG: 7, OAK_LEAVES: 8, SPRUCE_LOG: 10, SPRUCE_LEAVES: 11,
    SNOW: 12, WATER: 15, SAND: 16, GRAVEL: 17, SNOW_GRASS: 18,
    COAL_ORE: 19, IRON_ORE: 20, GOLD_ORE: 21, DIAMOND_ORE: 22,
    REDSTONE_ORE: 23, LAPIS_ORE: 24, GLOWSTONE: 27,
    EMERALD_ORE: 30, TALL_GRASS: 31, FLOWER_RED: 32, FLOWER_YELLOW: 33,
    SUGAR_CANE: 34, SANDSTONE: 35, BIRCH_LOG: 36, CLAY: 38,
  };

  /* ============================================================
   * 确定性噪声
   * ============================================================ */
  function hash2(x, y, seed) {
    let h = Math.imul(x | 0, 374761393) ^ Math.imul(y | 0, 668265263) ^ Math.imul(seed | 0, 1442695041);
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    h = h ^ (h >>> 16);
    return (h >>> 0) / 4294967296;
  }
  function hash3(x, y, z, seed) {
    let h = Math.imul(x | 0, 374761393) ^ Math.imul(y | 0, 668265263) ^
            Math.imul(z | 0, 2246822519) ^ Math.imul(seed | 0, 1442695041);
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    h = h ^ (h >>> 16);
    return (h >>> 0) / 4294967296;
  }
  const smooth = t => t * t * (3 - 2 * t);

  function noise2(x, y, seed) {
    const xi = Math.floor(x), yi = Math.floor(y);
    const xf = x - xi, yf = y - yi;
    const u = smooth(xf), v = smooth(yf);
    const a = hash2(xi, yi, seed), b = hash2(xi + 1, yi, seed);
    const c = hash2(xi, yi + 1, seed), d = hash2(xi + 1, yi + 1, seed);
    return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
  }
  function noise3(x, y, z, seed) {
    const xi = Math.floor(x), yi = Math.floor(y), zi = Math.floor(z);
    const xf = x - xi, yf = y - yi, zf = z - zi;
    const u = smooth(xf), v = smooth(yf), w = smooth(zf);
    function h(dx, dy, dz) { return hash3(xi + dx, yi + dy, zi + dz, seed); }
    const c000 = h(0,0,0), c100 = h(1,0,0), c010 = h(0,1,0), c110 = h(1,1,0);
    const c001 = h(0,0,1), c101 = h(1,0,1), c011 = h(0,1,1), c111 = h(1,1,1);
    const x00 = c000 + (c100 - c000) * u, x10 = c010 + (c110 - c010) * u;
    const x01 = c001 + (c101 - c001) * u, x11 = c011 + (c111 - c011) * u;
    const y0 = x00 + (x10 - x00) * v, y1 = x01 + (x11 - x01) * v;
    return y0 + (y1 - y0) * w;
  }
  function fbm2(x, y, seed, oct) {
    let s = 0, amp = 0.5, f = 1, n = 0;
    for (let i = 0; i < oct; i++) {
      s += noise2(x * f, y * f, seed + i * 131) * amp;
      n += amp; amp *= 0.5; f *= 2;
    }
    return s / n;
  }

  /* ============================================================
   * 生物群系
   * ============================================================ */
  const BIOME = {
    OCEAN: 0, PLAINS: 1, DESERT: 2, FOREST: 3, SNOW: 4, HILLS: 5,
  };

  // 温度随纬度（x/z 的大尺度噪声）变化，湿度独立
  function tempAt(x, z) { return fbm2(x * 0.0022, z * 0.0022, 8111, 3); }
  function humidAt(x, z) { return fbm2(x * 0.0028 + 100, z * 0.0028 + 100, 8222, 3); }

  function biomeAt(x, z) {
    const t = tempAt(x, z);
    const h = humidAt(x, z);
    const cont = fbm2(x * 0.006, z * 0.006, 8333, 4);   // 大陆性：低=海洋
    if (cont < 0.34) return BIOME.OCEAN;
    if (t < 0.32) return BIOME.SNOW;
    if (t > 0.68 && h < 0.42) return BIOME.DESERT;
    if (h > 0.58) return BIOME.FOREST;
    if (cont > 0.66) return BIOME.HILLS;
    return BIOME.PLAINS;
  }

  /* ============================================================
   * 高度
   * ============================================================ */
  function heightAt(x, z) {
    const biome = biomeAt(x, z);
    const cont = fbm2(x * 0.006, z * 0.006, 8333, 4);
    const detail = fbm2(x * 0.021, z * 0.021, 8444, 3);
    const ridge = 1 - Math.abs(fbm2(x * 0.011, z * 0.011, 8555, 3) * 2 - 1);

    let base;
    switch (biome) {
      case BIOME.OCEAN:
        // 海床：低一点，让水面之下有起伏
        base = 40 + cont * 26 + detail * 4;
        break;
      case BIOME.DESERT:
        base = 58 + detail * 5;
        break;
      case BIOME.SNOW:
        base = 63 + detail * 9;
        break;
      case BIOME.FOREST:
        base = 62 + detail * 7;
        break;
      case BIOME.HILLS:
        base = 66 + ridge * 34 + detail * 6;
        break;
      default: // PLAINS
        base = 60 + detail * 5;
        break;
    }
    let h = Math.round(base);
    if (h < 2) h = 2;
    if (h > CHUNK_Y - 18) h = CHUNK_Y - 18;
    return h;
  }

  /* ============================================================
   * 矿脉
   * ============================================================ */
  // 按深度分带的矿脉。vein: 在给定 y 区间内按 3D 噪声阈值成簇出现，
  // 而不是单块孤点 —— 挖矿时应该挖到一小团。
  const ORES = [
    { id: B.COAL_ORE,     maxY: 64, minY: 5,  thresh: 0.78, seed: 9101 },
    { id: B.IRON_ORE,     maxY: 48, minY: 4,  thresh: 0.815, seed: 9202 },
    { id: B.GOLD_ORE,     maxY: 32, minY: 2,  thresh: 0.865, seed: 9303 },
    { id: B.REDSTONE_ORE, maxY: 26, minY: 2,  thresh: 0.845, seed: 9404 },
    { id: B.DIAMOND_ORE,  maxY: 16, minY: 1,  thresh: 0.90, seed: 9505 },
    { id: B.LAPIS_ORE,    maxY: 32, minY: 4,  thresh: 0.875, seed: 9606 },
    { id: B.EMERALD_ORE,  maxY: 30, minY: 2,  thresh: 0.925, seed: 9707 },
  ];

  function oreAt(x, y, z, biome) {
    for (let i = 0; i < ORES.length; i++) {
      const o = ORES[i];
      if (y > o.maxY || y < o.minY) continue;
      // emerald 只在高地群系，稀有度再压一档
      if (o.id === B.EMERALD_ORE && biome !== BIOME.HILLS && hash3(x, y, z, 9799) > 0.25) continue;
      const n = noise3(x * 0.14, y * 0.14, z * 0.14, o.seed);
      if (n > o.thresh) return o.id;
    }
    return 0;
  }

  /* ============================================================
   * 洞穴
   * ============================================================ */
  // 两根 3D 噪声的脊线相交处才开洞（worm 式），比单纯阈值更像隧道，
  // 而且可以限制在 surface-2 以下，不会把地表打成筛子。
  function isCave(x, y, z, surfaceY) {
    if (y < 3 || y > surfaceY - 2) return false;
    const n1 = noise3(x * 0.045, y * 0.09, z * 0.045, 9801);
    const n2 = noise3(x * 0.045, y * 0.09, z * 0.045, 9802);
    const t = 0.055;
    // 两根脊线都接近 0.5 时相交
    return Math.abs(n1 - 0.5) < t && Math.abs(n2 - 0.5) < t;
  }

  /* ============================================================
   * 树
   * ============================================================ */
  // 树只由"拥有该列"的区块生成。离边界不足 3 格的树一律跳过，
  // 保证不会出现到一半的树。
  const TREE_MARGIN = 3;

  function treeDensity(biome) {
    switch (biome) {
      case BIOME.FOREST: return 0.055;
      case BIOME.PLAINS: return 0.008;
      case BIOME.SNOW:   return 0.030;
      default:           return 0;
    }
  }

  function treeTypeAt(biome, x, z) {
    if (biome === BIOME.SNOW) return 'spruce';
    if (biome === BIOME.FOREST) return hash2(x, z, 9901) > 0.55 ? 'birch' : 'oak';
    return 'oak';
  }

  function stampTree(blocks, lx, lz, groundY, type, world) {
    const log = type === 'spruce' ? B.SPRUCE_LOG : (type === 'birch' ? B.BIRCH_LOG : B.OAK_LOG);
    const leaf = type === 'spruce' ? B.SPRUCE_LEAVES : B.OAK_LEAVES;
    const wx = world.ox + lx, wz = world.oz + lz;
    const height = type === 'spruce'
      ? 6 + Math.floor(hash2(wx, wz, 9911) * 4)
      : 4 + Math.floor(hash2(wx, wz, 9912) * 3);

    function put(x, y, z, id, onlyAir) {
      if (y < 0 || y >= CHUNK_Y) return;
      if (x < 0 || x >= CHUNK_X || z < 0 || z >= CHUNK_Z) return;
      const i = (y * CHUNK_Z + z) * CHUNK_X + x;
      if (onlyAir && blocks[i] !== B.AIR) return;
      blocks[i] = id;
    }

    // 树干
    for (let i = 1; i <= height; i++) put(lx, groundY + i, lz, log, false);

    // 树冠
    const top = groundY + height;
    if (type === 'spruce') {
      // 云杉：塔形，逐层收窄
      for (let ly = top - 1; ly >= groundY + 2; ly--) {
        const depth = top - ly;
        const r = depth <= 2 ? 1 : depth <= 4 ? 2 : depth <= 6 ? 2 : 1;
        for (let dx = -r; dx <= r; dx++) for (let dz = -r; dz <= r; dz++) {
          if (Math.abs(dx) === r && Math.abs(dz) === r && r > 1) continue;
          put(lx + dx, ly + 1, lz + dz, leaf, true);
        }
      }
      put(lx, top + 1, lz, leaf, true);
    } else {
      // 橡木/白桦：球形
      const r = type === 'birch' ? 2 : 2;
      for (let ly = top - 2; ly <= top + 1; ly++) {
        const rr = (ly === top + 1) ? 1 : r;
        for (let dx = -rr; dx <= rr; dx++) for (let dz = -rr; dz <= rr; dz++) {
          if (Math.abs(dx) === rr && Math.abs(dz) === rr && rr > 1) continue;
          if (dx === 0 && dz === 0 && ly <= top) continue;
          put(lx + dx, ly, lz + dz, leaf, true);
        }
      }
    }
  }

  /* ============================================================
   * 区块生成
   * ============================================================ */
  function generateChunk(cx, cz) {
    const blocks = new Uint8Array(CHUNK_X * CHUNK_Z * CHUNK_Y);
    const ox = cx * CHUNK_X, oz = cz * CHUNK_Z;

    // 预计算每列的高度、群系、地表方块，避免在 y 循环里重复算
    const colH = new Int16Array(CHUNK_X * CHUNK_Z);
    const colB = new Uint8Array(CHUNK_X * CHUNK_Z);
    const colTop = new Uint8Array(CHUNK_X * CHUNK_Z);

    for (let lz = 0; lz < CHUNK_Z; lz++) {
      for (let lx = 0; lx < CHUNK_X; lx++) {
        const x = ox + lx, z = oz + lz;
        const biome = biomeAt(x, z);
        let h = heightAt(x, z);
        const ci = lz * CHUNK_X + lx;
        colH[ci] = h;
        colB[ci] = biome;

        // 地表材质
        let top;
        if (h <= SEA_LEVEL + 1) {
          top = (biome === BIOME.DESERT || h >= SEA_LEVEL - 1) ? B.SAND : B.GRAVEL;
        } else if (biome === BIOME.DESERT) {
          top = B.SAND;
        } else if (biome === BIOME.SNOW) {
          top = B.SNOW_GRASS;
        } else {
          top = B.GRASS;
        }
        colTop[ci] = top;
      }
    }

    // 填充地层 + 洞穴 + 矿脉
    for (let lz = 0; lz < CHUNK_Z; lz++) {
      for (let lx = 0; lx < CHUNK_X; lx++) {
        const ci = lz * CHUNK_X + lx;
        const h = colH[ci];
        const biome = colB[ci];
        const top = colTop[ci];
        const x = ox + lx, z = oz + lz;

        const dirtDepth = (biome === BIOME.DESERT) ? 4 : 3;

        for (let y = 0; y <= h; y++) {
          const i = (y * CHUNK_Z + lz) * CHUNK_X + lx;

          // 基岩：最底 3 层，且永远不会被洞穴/矿脉穿透
          if (y <= 2) {
            blocks[i] = B.BEDROCK;
            continue;
          }

          // 洞穴挖空
          if (isCave(x, y, z, h)) {
            blocks[i] = B.AIR;
            continue;
          }

          let id;
          if (y === h) {
            id = top;
          } else if (y > h - dirtDepth) {
            id = (biome === BIOME.DESERT) ? B.SANDSTONE : B.DIRT;
          } else {
            id = B.STONE;
          }

          // 石头层内替换成矿脉
          if (id === B.STONE && y < h - 1) {
            const ore = oreAt(x, y, z, biome);
            if (ore) id = ore;
          }

          // 水下表层换成沙/砾石更自然（已在 colTop 处理表层，这里处理水下泥土）
          if (y > SEA_LEVEL && h <= SEA_LEVEL && id === B.DIRT) id = B.SAND;

          blocks[i] = id;
        }

        // 水：地表低于海平面的每一格填水
        for (let y = h + 1; y <= SEA_LEVEL; y++) {
          const i = (y * CHUNK_Z + lz) * CHUNK_X + lx;
          blocks[i] = B.WATER;
        }
      }
    }

    // 洞穴可能把地表打通到海平面以下，需要在洞口补一层水，否则会出现"悬空水墙"
    // 这里不做处理：isCave 已限制在 surface-2 以下，地表本身不会被穿透。

    // 树（只处理属于本区块、且离边界足够远的列）
    const worldCtx = { ox, oz };
    for (let lz = TREE_MARGIN; lz < CHUNK_Z - TREE_MARGIN; lz++) {
      for (let lx = TREE_MARGIN; lx < CHUNK_X - TREE_MARGIN; lx++) {
        const ci = lz * CHUNK_X + lx;
        const h = colH[ci];
        const biome = colB[ci];
        if (h <= SEA_LEVEL + 1) continue;              // 水里不长树
        const density = treeDensity(biome);
        if (density <= 0) continue;
        const x = ox + lx, z = oz + lz;

        // 每格一个确定性的树判定；邻域查重避免树挤在一起
        if (hash2(x, z, 9921) >= density) continue;
        let crowded = false;
        for (let dx = -1; dx <= 1 && !crowded; dx++) {
          for (let dz = -1; dz <= 1; dz++) {
            if (dx === 0 && dz === 0) continue;
            if (hash2(x + dx, z + dz, 9921) < density && hash2(x + dx, z + dz, 9922) > hash2(x, z, 9922)) {
              crowded = true; break;
            }
          }
        }
        if (crowded) continue;

        stampTree(blocks, lx, lz, h, treeTypeAt(biome, x, z), worldCtx);
      }
    }

    // 草/花：地表上方一格，稀疏撒
    for (let lz = 0; lz < CHUNK_Z; lz++) {
      for (let lx = 0; lx < CHUNK_X; lx++) {
        const ci = lz * CHUNK_X + lx;
        const h = colH[ci];
        const biome = colB[ci];
        if (h <= SEA_LEVEL + 1) continue;
        if (colTop[ci] !== B.GRASS && colTop[ci] !== B.SNOW_GRASS) continue;
        if (h + 1 >= CHUNK_Y) continue;
        const i = ((h + 1) * CHUNK_Z + lz) * CHUNK_X + lx;
        if (blocks[i] !== B.AIR) continue;              // 树占住了就不长草
        const x = ox + lx, z = oz + lz;
        const r = hash2(x, z, 9931);
        if (r < 0.14) blocks[i] = B.TALL_GRASS;
        else if (r > 0.985) blocks[i] = B.FLOWER_RED;
        else if (r > 0.972) blocks[i] = B.FLOWER_YELLOW;
      }
    }

    // 甘蔗：水边沙滩
    for (let lz = 0; lz < CHUNK_Z; lz++) {
      for (let lx = 0; lx < CHUNK_X; lx++) {
        const ci = lz * CHUNK_X + lx;
        const h = colH[ci];
        if (h !== SEA_LEVEL + 1) continue;              // 紧贴水线
        if (colTop[ci] !== B.SAND) continue;
        const x = ox + lx, z = oz + lz;
        if (hash2(x, z, 9941) > 0.22) continue;
        for (let k = 1; k <= 2; k++) {
          const y = h + k;
          if (y >= CHUNK_Y) break;
          const i = (y * CHUNK_Z + lz) * CHUNK_X + lx;
          if (blocks[i] === B.AIR) blocks[i] = B.SUGAR_CANE;
        }
      }
    }

    return blocks;
  }

  global.VoxelWorldgen = {
    CHUNK_X, CHUNK_Z, CHUNK_Y, SEA_LEVEL,
    BIOME,
    generateChunk,
    heightAt,
    biomeAt,
    tempAt,
    humidAt,
    // 暴露出来便于单测与其它模块复用
    hash2, hash3, noise2, noise3, fbm2,
  };
})(window);
