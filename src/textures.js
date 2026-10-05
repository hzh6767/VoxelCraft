// VoxelCraft — 程序化贴图库
// 所有贴图在运行时用 canvas 逐像素画出来，不加载任何外部图片。
// 目标是"像素风体素游戏"的观感：16x16、硬边、两级抖动、方向性明暗。
//
// 用法：
//   const atlas = VoxelTextures.buildAtlas(['grass_top','grass_side',...]);
//   atlas.canvas             -> 可直接喂给 THREE.CanvasTexture
//   atlas.indexOf(name)      -> 该贴图的主变体在图集里的序号（引擎据此算 UV）
//   atlas.uvOf(name)         -> 主变体 UV 范围
//   atlas.uvOfVariant(name,k)-> 第 k 个变体的 UV 范围
//   atlas.variants[name]     -> 该贴图有几个变体（1 表示无变体）
//
// 两个关键设计（详见文件内的注释）：
//   1) 每张贴图在图集里四周补一圈 PAD 像素的"边缘复制"（padding），
//      这样开启 mipmap 后相邻贴图不会互相渗色。
//   2) 常用地形贴图生成 3~4 个变体，网格构建时按方块世界坐标的 hash 选一个，
//      于是大片同类方块不再是同一张图平铺。
//
// 对外只暴露一个全局 VoxelTextures，因为 index.html 用的是普通 <script>。
(function (global) {
  'use strict';

  const TILE = 16;          // 单块贴图边长
  const PAD  = 8;           // 每边补边像素；16→8→4→2→1，整条 mip 链都被覆盖
  const CELL = TILE + PAD * 2;  // 图集里每个格子的边长 = 32（2 的幂，兼容 WebGL1 的 mipmap）
  const COLS = 8;           // 图集列数（行数按需增长，且取 2 的幂）
  const LUMA_MIN = 0.42;    // 明暗抖动下限，别让暗部死黑

  /* ---------- 确定性随机 ---------- */
  // 用整数 hash 而不是 Math.random：同一张贴图每次启动都长得一样，
  // 否则玩家每次开游戏看到的世界纹理会变。
  // _vshift 是"变体偏移"：生成第 k 个变体时把它设成 k*101，
  // 于是所有 noise 用同一套配色/结构、但换了一个随机实现 —— 变体之间
  // 既有差别又不会破坏原有的美术方向。主变体 _vshift=0，与改动前逐像素一致。
  let _vshift = 0;
  function hash(x, y, s) {
    let h = Math.imul(x | 0, 374761393) ^ Math.imul(y | 0, 668265263) ^ Math.imul(((s | 0) + _vshift), 2147483647);
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    h = h ^ (h >>> 16);
    return (h >>> 0) / 4294967296;
  }

  // 平滑值噪声：先格点插值，得到成片的斑块而不是白点噪声
  function smooth(t) { return t * t * (3 - 2 * t); }
  function vnoise(x, y, s) {
    const xi = Math.floor(x), yi = Math.floor(y);
    const xf = x - xi, yf = y - yi;
    const u = smooth(xf), v = smooth(yf);
    const a = hash(xi, yi, s), b = hash(xi + 1, yi, s);
    const c = hash(xi, yi + 1, s), d = hash(xi + 1, yi + 1, s);
    return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
  }
  function fbm(x, y, s, oct) {
    let sum = 0, amp = 0.5, freq = 1, norm = 0;
    for (let i = 0; i < (oct || 3); i++) {
      sum += vnoise(x * freq, y * freq, s + i * 37) * amp;
      norm += amp; amp *= 0.5; freq *= 2;
    }
    return sum / norm;
  }

  /* ---------- 颜色工具 ---------- */
  function clamp01(v) { return v < 0 ? 0 : v > 1 ? 1 : v; }
  function mix(a, b, t) {
    return [
      Math.round(a[0] + (b[0] - a[0]) * t),
      Math.round(a[1] + (b[1] - a[1]) * t),
      Math.round(a[2] + (b[2] - a[2]) * t),
    ];
  }
  function shade(c, f) {
    return [
      Math.max(0, Math.min(255, Math.round(c[0] * f))),
      Math.max(0, Math.min(255, Math.round(c[1] * f))),
      Math.max(0, Math.min(255, Math.round(c[2] * f))),
    ];
  }
  function rgba(c, a) {
    return 'rgba(' + c[0] + ',' + c[1] + ',' + c[2] + ',' + (a === undefined ? 1 : a) + ')';
  }

  // 把一格像素的颜色按"两级抖动"处理：亮部/暗部各一档，
  // 这是 16x16 像素画看起来有质感而不是糊成一片的关键。
  function dither(base, t, amp) {
    const level = t < 0.25 ? -1 : t < 0.5 ? 0 : t < 0.75 ? 0 : 1;
    return shade(base, 1 + level * (amp || 0.1));
  }

  /* ---------- 各贴图的逐像素配方 ---------- */
  // 每个配方签名 (x, y) => css color / rgba 字符串
  // 坐标是贴图内部 0..15

  const RECIPES = {

    /* ===== 泥土系 ===== */
    dirt: function (x, y) {
      const base = [134, 96, 67];
      const n = fbm(x * 0.9, y * 0.9, 11, 2);
      const m = fbm(x * 0.35, y * 0.35, 12, 2);
      let c = mix(shade(base, 0.80), shade(base, 1.13), m);
      c = shade(c, 1 + (n - 0.5) * 0.26);
      // 细小根须/腐殖质：低频的暗色团 + 偶尔一点亮沙粒，
      // 不是均匀撒点，否则会显得"脏"。
      const root = fbm(x * 0.55, y * 0.55, 13, 2);
      if (root > 0.66 && hash(x, y, 14) > 0.55) c = shade(c, 0.88);
      else if (root < 0.30 && hash(x, y, 15) > 0.72) c = shade(c, 1.06);
      return rgba(c);
    },

    // 草方块顶面：三档绿交错，带斑驳与细微叶脉方向感
    grass_top: function (x, y) {
      const dark = [86, 128, 54];
      const mid = [101, 148, 63];
      const light = [116, 166, 72];
      const n = fbm(x * 0.7, y * 0.7, 21, 3);
      let c = n < 0.5 ? mix(dark, mid, n * 2) : mix(mid, light, (n - 0.5) * 2);
      const speck = hash(x, y, 22);
      if (speck > 0.86) c = shade(c, 1.13);
      else if (speck < 0.12) c = shade(c, 0.86);
      if (fbm(x * 1.6, y * 0.5, 23, 2) > 0.72) c = shade(c, 1.05);
      return rgba(c);
    },

    // 草方块侧面：上半草皮 + 下沿不规则草须，其余泥土
    grass_side: function (x, y) {
      const fringe = 3 + Math.floor(vnoise(x * 0.6, 0, 31) * 3.2);
      if (y < fringe) {
        const dark = [80, 122, 50];
        const light = [112, 162, 68];
        let c = mix(dark, light, fbm(x * 0.8, y * 0.8, 32, 2));
        if (hash(x, y, 33) > 0.85) c = shade(c, 1.12);
        return rgba(c);
      }
      // 草须向下的过渡像素（深浅两档）
      if (y < fringe + 2) {
        const h = hash(x, y, 34);
        if (h > 0.55) return rgba(shade([92, 134, 58], h > 0.8 ? 1.08 : 1));
      }
      return RECIPES.dirt(x, y + 4);
    },

    // 覆盖草顶（灰化草，用于雪线以上）
    grass_top_snow: function (x, y) {
      return rgba(shade([150, 180, 140], 0.94 + hash(x, y, 41) * 0.12));
    },

    /* ===== 石系 ===== */
    // 石头：4 个八度的噪声叠细粒与轻微水平层理
    stone: function (x, y) {
      const base = [126, 126, 126];
      const n = fbm(x * 0.5, y * 0.5, 51, 4);
      const grain = fbm(x * 1.4, y * 1.4, 53, 2);
      const strata = vnoise(x * 0.18, y * 0.9, 54);   // 浅浅的层理走向
      let c = shade(base, 0.86 + n * 0.28);
      c = shade(c, 1 + (grain - 0.5) * 0.10);
      c = shade(c, 1 + (strata - 0.5) * 0.08);
      const g = hash(x, y, 52);
      if (g > 0.92) c = shade(c, 1.08);
      else if (g < 0.08) c = shade(c, 0.90);
      return rgba(c);
    },

    // 圆石：不规则石块 + 深色勾缝，每块石头给一个整体色调
    cobblestone: function (x, y) {
      const cell = fbm(x * 0.42, y * 0.42, 61, 2);
      const cell2 = fbm(x * 0.9 + 5, y * 0.9 + 5, 62, 2);
      const mortar = (cell < 0.30 || cell2 < 0.16);
      const base = [122, 122, 122];
      if (mortar) return rgba(shade(base, 0.60), 1);
      // 3x3 像素当作一块"石头"，整块共享一个色调偏移
      const stoneId = Math.floor(x / 3) * 97 + Math.floor(y / 3) * 13;
      let c = shade(base, 0.90 + cell * 0.30);
      c = shade(c, 0.94 + hash(stoneId, 0, 64) * 0.12);
      const g = hash(x, y, 63);
      if (g > 0.90) c = shade(c, 1.10); else if (g < 0.10) c = shade(c, 0.90);
      return rgba(c);
    },

    mossy_cobblestone: function (x, y) {
      const c = RECIPES.cobblestone(x, y);
      const moss = fbm(x * 0.5, y * 0.5, 71, 3);
      if (moss > 0.58) {
        const g = mix([70, 104, 50], [96, 140, 64], hash(x, y, 72));
        return rgba(mix([110, 110, 110], g, clamp01((moss - 0.58) * 3.2)));
      }
      return c;
    },

    // 基岩：极暗、杂乱、有深色裂纹
    bedrock: function (x, y) {
      const n = fbm(x * 1.1, y * 1.1, 81, 3);
      const g = hash(x, y, 82);
      let v = 0.42 + n * 0.5;
      if (g < 0.18) v *= 0.55;
      else if (g > 0.94) v *= 1.12;
      return rgba(shade([85, 85, 85], v));
    },

    /* ===== 沙 / 砂石 ===== */
    sand: function (x, y) {
      const base = [219, 207, 160];
      const n = fbm(x * 0.7, y * 0.7, 91, 2);
      let c = shade(base, 0.93 + n * 0.13);
      // 斜向沙纹，让平面有一点走向而不是纯颗粒
      c = shade(c, 1 + (vnoise(x * 0.3 + y * 0.5, y * 0.9, 93) - 0.5) * 0.07);
      if (hash(x, y, 92) > 0.9) c = shade(c, 1.06);
      return rgba(c);
    },

    sandstone_top: function (x, y) {
      const base = [217, 205, 158];
      return rgba(shade(base, 0.95 + hash(x, y, 101) * 0.1));
    },

    // 砂岩侧面：横向层理
    sandstone_side: function (x, y) {
      const base = [216, 203, 155];
      const band = Math.floor(y / 4);
      const f = [1.0, 0.93, 0.97, 0.9][band % 4];
      let c = shade(base, f * (0.97 + hash(x, y, 102) * 0.06));
      c = shade(c, 1 + (vnoise(x * 0.5, band * 2, 103) - 0.5) * 0.04);
      return rgba(c);
    },

    /* ===== 木头系 ===== */
    // 橡木侧面：竖向纹理 + 树皮结节 + 细木丝
    oak_log_side: function (x, y) {
      const base = [104, 82, 51];
      const grain = vnoise(x * 0.9, y * 0.18, 111);
      const fine = vnoise(x * 1.6, y * 0.5, 114);
      let c = shade(base, 0.84 + grain * 0.32);
      c = shade(c, 1 + (fine - 0.5) * 0.10);
      if (hash(x, y, 112) > 0.92) c = shade(c, 1.12);
      // 树皮上的深色竖条
      if (hash(x * 0.5, Math.floor(y / 6), 113) > 0.78) c = shade(c, 0.80);
      if (hash(x, y, 115) > 0.95) c = shade(c, 0.86);  // 小疤
      return rgba(c);
    },

    // 橡木顶面：年轮
    oak_log_top: function (x, y) {
      const base = [176, 143, 92];
      const dx = x - 7.5, dy = y - 7.5;
      const r = Math.sqrt(dx * dx + dy * dy);
      // 年轮半径上叠一点抖动，避免完美同心圆
      const rr = r + (vnoise(x * 0.6, y * 0.6, 116) - 0.5) * 1.2;
      const rings = Math.sin(rr * 2.1) * 0.5 + 0.5;
      let c = shade(base, 0.84 + rings * 0.24);
      if (r < 1.4) c = shade(c, 0.9); // 髓心
      return rgba(c);
    },

    // 白桦侧面：浅色 + 深色横向短划
    birch_log_side: function (x, y) {
      const base = [216, 214, 205];
      let c = shade(base, 0.95 + vnoise(x * 0.4, y * 0.8, 121) * 0.1);
      if (hash(Math.floor(x / 3), Math.floor(y / 2), 122) > 0.72 && y % 2 === 0) {
        c = shade([92, 92, 84], 1);
      }
      // 树皮上淡灰的纵向色带
      c = shade(c, 1 + (vnoise(x * 1.2, y * 0.2, 123) - 0.5) * 0.06);
      return rgba(c);
    },

    spruce_log_side: function (x, y) {
      const base = [70, 52, 33];
      let c = shade(base, 0.88 + vnoise(x * 0.7, y * 0.25, 131) * 0.26);
      c = shade(c, 1 + (vnoise(x * 1.5, y * 0.6, 133) - 0.5) * 0.10);
      if (hash(x, y, 132) > 0.93) c = shade(c, 1.15);
      return rgba(c);
    },

    /* ===== 树叶（带透明孔洞） ===== */
    oak_leaves: function (x, y) {
      const h = hash(x, y, 141);
      // 约 12% 的像素完全透明，形成树叶的镂空感
      if (h > 0.88) return 'rgba(0,0,0,0)';
      const dark = [44, 88, 32];
      const mid = [64, 114, 44];
      const light = [84, 140, 56];
      const n = fbm(x * 0.8, y * 0.8, 142, 2);
      let c = n < 0.5 ? mix(dark, mid, n * 2) : mix(mid, light, (n - 0.5) * 2);
      if (h < 0.1) c = shade(c, 0.8);
      return rgba(c);
    },

    spruce_leaves: function (x, y) {
      const h = hash(x, y, 151);
      if (h > 0.9) return 'rgba(0,0,0,0)';
      const dark = [32, 66, 44];
      const mid = [47, 85, 56];
      const light = [62, 104, 68];
      const n = fbm(x * 0.8, y * 0.8, 152, 2);
      return rgba(n < 0.5 ? mix(dark, mid, n * 2) : mix(mid, light, (n - 0.5) * 2));
    },

    /* ===== 木板 / 建材 ===== */
    oak_planks: function (x, y) {
      const base = [178, 141, 88];
      // 四行木板，行与行之间是暗缝
      const row = Math.floor(y / 4);
      const seam = (y % 4 === 3);
      let c = shade(base, 0.95 + (row % 2 ? 0.02 : -0.015));
      if (seam) c = shade(c, 0.70);
      // 板内木纹：更深的纵向纹路 + 偶尔的木节
      const grain = fbm(x * 0.35, row * 1.7, 161, 2);
      c = shade(c, 0.92 + grain * 0.16);
      if (hash(Math.floor(x / 4), row, 162) > 0.84) c = shade(c, 0.88);
      // 竖向短缝
      if (x === [3, 11, 6, 13][row % 4]) c = shade(c, 0.78);
      return rgba(c);
    },

    spruce_planks: function (x, y) {
      const base = [114, 84, 48];
      const row = Math.floor(y / 4);
      let c = shade(base, 0.94 + row * 0.02);
      if (y % 4 === 3) c = shade(c, 0.72);
      c = shade(c, 0.94 + fbm(x * 0.35, row * 1.7, 171, 2) * 0.13);
      if (hash(Math.floor(x / 4), row, 172) > 0.86) c = shade(c, 0.90);
      return rgba(c);
    },

    /* ===== 砖 / 石砖 ===== */
    bricks: function (x, y) {
      const row = Math.floor(y / 4);
      const shift = (row % 2) * 8;
      const bx = (x + shift) % 16;
      const mortar = (y % 4 === 0) || (bx % 8 === 0);
      if (mortar) return rgba([166, 160, 152]);
      const base = [150, 88, 74];
      // 每块砖一个整体色调：砖与砖之间有细微深浅差，而不是一块纯色
      const brickId = row * 4 + Math.floor(bx / 8);
      let c = shade(base, 0.88 + hash(brickId, row, 182) * 0.22);
      c = shade(c, 0.97 + hash(x, y, 181) * 0.06);
      return rgba(c);
    },

    stone_bricks: function (x, y) {
      const row = Math.floor(y / 4);
      const shift = (row % 2) * 8;
      const bx = (x + shift) % 16;
      const mortar = (y % 4 === 0) || (bx % 8 === 0);
      if (mortar) return rgba([92, 92, 92]);
      const base = [125, 125, 125];
      const brickId = row * 4 + Math.floor(bx / 8);
      let c = shade(base, 0.88 + hash(brickId, row, 193) * 0.18);
      c = shade(c, 0.94 + fbm(x * 0.6, y * 0.6, 191, 2) * 0.14);
      return rgba(c);
    },

    /* ===== 玻璃 / 冰 / 水 ===== */
    glass: function (x, y) {
      const edge = (x === 0 || y === 0 || x === TILE - 1 || y === TILE - 1);
      if (edge) return 'rgba(226,242,255,0.72)';
      // 一道斜向高光
      if ((x + y) === 6 || (x + y) === 7) return 'rgba(240,250,255,0.34)';
      if ((x + y) === 20 || (x + y) === 21) return 'rgba(240,250,255,0.16)';
      // 中间区域必须留透明——玻璃靠 alpha 通道透光，
      // 这里若返回不透明色，透明渲染通道就白开了。
      return 'rgba(200,228,255,0.10)';
    },

    ice: function (x, y) {
      const n = fbm(x * 0.4, y * 0.4, 201, 2);
      const c = mix([150, 190, 235], [200, 228, 250], n);
      return rgba(c, 0.82);
    },

    water: function (x, y) {
      const n = fbm(x * 0.35, y * 0.35, 211, 3);
      const c = mix([42, 94, 190], [72, 132, 224], n);
      const g = hash(x, y, 212);
      if (g > 0.93) return rgba(shade(c, 1.25), 0.78);
      return rgba(c, 0.72);
    },

    /* ===== 雪 / 砾石 / 黏土 ===== */
    snow: function (x, y) {
      return rgba(shade([240, 244, 250], 0.965 + hash(x, y, 221) * 0.035));
    },
    // 砾石：成团的鹅卵石感，而不是均匀噪点
    gravel: function (x, y) {
      const clump = fbm(x * 0.5, y * 0.5, 235, 2);   // 低频团块
      const n = fbm(x * 1.1, y * 1.1, 231, 3);
      let base = mix([108, 102, 96], [162, 156, 148], clamp01(clump * 0.6 + n * 0.5));
      const g = hash(x, y, 232);
      if (g > 0.90) return rgba(shade(base, 1.16));
      if (g < 0.10) return rgba(shade(base, 0.70));
      // 团块边缘的亮点，模拟卵石反光
      if (n > 0.62 && hash(x, y, 233) > 0.5) base = shade(base, 1.08);
      return rgba(base);
    },
    clay: function (x, y) {
      const base = [160, 166, 179];
      let c = shade(base, 0.95 + fbm(x * 0.7, y * 0.7, 241, 2) * 0.10);
      c = shade(c, 1 + (vnoise(x * 0.3, y * 0.3, 242) - 0.5) * 0.05);
      return rgba(c);
    },

    /* ===== 矿物：石头底 + 有色矿斑 ===== */
    // 每个矿物共用同一套斑块逻辑，只换颜色；斑块是稀疏的几个团，
    // 不是均匀撒点，这样才像"嵌在石头里的矿"。
    coal_ore:    oreRecipe([38, 38, 38],    251),
    iron_ore:    oreRecipe([216, 175, 147], 261),
    gold_ore:    oreRecipe([252, 238, 75],  271),
    diamond_ore: oreRecipe([93, 236, 245],  281),
    redstone_ore:oreRecipe([200, 40, 40],   291),
    lapis_ore:   oreRecipe([40, 80, 200],   301),
    emerald_ore: oreRecipe([60, 200, 110],  311),

    /* ===== 其他 ===== */
    // 荧石：发光的暖黄，带亮斑
    glowstone: function (x, y) {
      const n = fbm(x * 0.9, y * 0.9, 321, 3);
      let c = mix([214, 170, 88], [252, 236, 170], n);
      if (hash(x, y, 322) > 0.82) c = [255, 248, 210];
      return rgba(c);
    },

    // 黑曜石：近黑带紫
    obsidian: function (x, y) {
      const n = fbm(x * 0.8, y * 0.8, 331, 3);
      const c = mix([18, 14, 26], [58, 46, 84], n);
      return rgba(shade(c, 0.9 + hash(x, y, 332) * 0.2));
    },

    // 南瓜侧面：橙底 + 竖沟
    pumpkin_side: function (x, y) {
      const base = [198, 118, 30];
      let c = shade(base, 0.92 + vnoise(x * 0.5, 0, 341) * 0.18);
      if (x % 5 === 0) c = shade(c, 0.78);
      return rgba(c);
    },

    // 工作台顶面
    crafting_top: function (x, y) {
      const base = RECIPES.oak_planks(x, y);
      // 画一个内框 + 网格
      if (x === 0 || y === 0 || x === 15 || y === 15) return rgba([120, 92, 56]);
      if (x === 1 || y === 1 || x === 14 || y === 14) return rgba([150, 118, 74]);
      if (x === 7 || x === 8 || y === 7 || y === 8) return rgba([104, 80, 48]);
      return base;
    },

    /* ===== 十字形植物（引擎按两片交叉面片渲染） ===== */
    tall_grass: function (x, y) {
      // 只画几根草叶，其余透明
      const blades = [3, 6, 9, 12];
      let hit = false;
      for (let i = 0; i < blades.length; i++) {
        const bx = blades[i];
        const top = 2 + Math.floor(hash(bx, 0, 351) * 5);
        if (x === bx && y >= top) hit = true;
        if (x === bx + 1 && y >= top + 3) hit = true;
      }
      if (!hit) return 'rgba(0,0,0,0)';
      const g = mix([72, 118, 44], [116, 164, 66], hash(x, y, 352));
      return rgba(g, 0.96);
    },

    flower_red: flowerRecipe([196, 52, 44], [72, 120, 44], 361),
    flower_yellow: flowerRecipe([236, 208, 64], [72, 120, 44], 371),

    // 甘蔗：细高杆
    sugar_cane: function (x, y) {
      if (x < 6 || x > 9) return 'rgba(0,0,0,0)';
      const base = [140, 176, 92];
      let c = shade(base, 0.9 + hash(x, y, 381) * 0.16);
      if (y % 5 === 0) c = shade(c, 0.82);
      return rgba(c);
    },
  };

  // 工厂函数必须定义在后面，但对象字面量里已经引用了它们 —— 用函数声明提升解决
  function oreRecipe(color, seed) {
    return function (x, y) {
      const stone = RECIPES.stone(x, y);
      // 三个固定位置的矿斑，每个是 2~3 像素的团
      const blobs = [[3, 4], [9, 3], [6, 10], [11, 11]];
      for (let i = 0; i < blobs.length; i++) {
        const bx = blobs[i][0], by = blobs[i][1];
        const dx = x - bx, dy = y - by;
        const r = Math.sqrt(dx * dx + dy * dy) + hash(bx, by, seed) * 0.9;
        if (r < 2.2) {
          const t = Math.min(1, Math.max(0, 1 - r / 2.2));
          const c = shade(color, 0.82 + t * 0.32);
          if (r < 1.0 || hash(x, y, seed + 1) > 0.35) return rgba(c);
        }
      }
      return stone;
    };
  }

  function flowerRecipe(petal, stem, seed) {
    return function (x, y) {
      const dx = x - 7.5, dy = y - 6;
      const r = Math.sqrt(dx * dx + dy * dy);
      // 花冠
      if (r < 2.6 && y < 10) {
        const t = hash(x, y, seed);
        return rgba(shade(petal, 0.84 + t * 0.3));
      }
      // 茎
      if ((x === 7 || x === 8) && y >= 9) {
        return rgba(shade(stem, 0.9 + hash(x, y, seed + 1) * 0.2));
      }
      // 叶
      if (y > 11 && y < 14 && (x === 5 || x === 6 || x === 9 || x === 10)) {
        return rgba(shade(stem, 1.05));
      }
      return 'rgba(0,0,0,0)';
    };
  }

  /* ---------- 变体表 ----------
   * 出现频率越高、面积越大的地形贴图给越多变体。
   * 变体只改变噪声实现，不改变配色与结构，所以"像什么方块"永远不变。 */
  const VARIANT_NAMES = {
    // 4 个变体：最常铺满屏幕的地表
    stone: 4, dirt: 4, grass_top: 4, grass_side: 4, sand: 4,
    cobblestone: 4, sandstone_side: 4,
    // 3 个变体：其余地形与建材
    gravel: 3, clay: 3, mossy_cobblestone: 3, bedrock: 3,
    oak_log_side: 3, oak_log_top: 3, birch_log_side: 3, spruce_log_side: 3,
    oak_planks: 3, spruce_planks: 3, oak_leaves: 3, spruce_leaves: 3,
    bricks: 3, stone_bricks: 3, glowstone: 3, obsidian: 3, pumpkin_side: 3,
    coal_ore: 3, iron_ore: 3, gold_ore: 3, diamond_ore: 3,
    redstone_ore: 3, lapis_ore: 3, emerald_ore: 3,
  };
  function variantsFor(name) { return VARIANT_NAMES[name] || 1; }

  /* ---------- 图集构建 ---------- */
  //
  // 布局：图集被切成 cols 列、rows 行的格子，每格 CELL(=TILE+2*PAD) 像素。
  // 真正的贴图像素画在格子中心 TILE 区域；四周 PAD 像素是把贴图边缘像素
  // 复制出去的"补边"。开启 mipmap 后，取样会跨像素求平均，补边保证了
  // 平均窗口落在本贴图自己的边缘色上，而不是渗进邻格 —— 这就是防渗色的
  // 全部秘密。rows 与 cols 都取 2 的幂，于是图集尺寸本身是 2 的幂，
  // 即便退回 WebGL1 也能安全生成 mipmap。
  function buildAtlas(names, tilePx) {
    const T = tilePx || TILE;
    const cols = Math.min(COLS, Math.max(1, names.length));
    const cell = T + PAD * 2;

    // 展开成槽位：每个名字按 variantsFor 复制 k=0..n-1 份，k=0 用原名。
    const slots = [];
    const index = Object.create(null);
    const variants = Object.create(null);
    for (let i = 0; i < names.length; i++) {
      const name = names[i];
      if (!RECIPES[name]) {
        console.warn('[VoxelTextures] 缺少贴图配方:', name);
        continue;
      }
      const n = variantsFor(name);
      variants[name] = n;
      for (let k = 0; k < n; k++) {
        if (k === 0) index[name] = slots.length;
        slots.push({ name: name, variant: k });
      }
    }

    const neededRows = Math.ceil(slots.length / cols);
    let rows = 1;
    while (rows < neededRows) rows <<= 1;         // 取 2 的幂，保持图集是 POT

    const canvas = document.createElement('canvas');
    canvas.width = cols * cell;
    canvas.height = rows * cell;
    // 用 alpha:true，树叶/玻璃/植物要靠透明通道
    const ctx = canvas.getContext('2d', { alpha: true });
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    // 一次性画进一张 ImageData 再贴上去，比逐格 putImageData 少很多开销
    const img = ctx.createImageData(canvas.width, canvas.height);
    const data = img.data;

    for (let i = 0; i < slots.length; i++) {
      const slot = slots[i];
      const recipe = RECIPES[slot.name];
      _vshift = slot.variant * 101;               // 主变体为 0，与旧输出一致
      const cx = i % cols, cy = Math.floor(i / cols);
      const ox = cx * cell, oy = cy * cell;

      for (let py = 0; py < cell; py++) {
        // 补边：把格子内坐标钳到 [0, T-1] 再映射回贴图的 0..T-1
        const ly = py - PAD;
        const cy2 = ly < 0 ? 0 : (ly > T - 1 ? T - 1 : ly);
        const sy = Math.floor(cy2 * (TILE / T));
        for (let px = 0; px < cell; px++) {
          const lx = px - PAD;
          const cx2 = lx < 0 ? 0 : (lx > T - 1 ? T - 1 : lx);
          const sx = Math.floor(cx2 * (TILE / T));
          const o = ((oy + py) * canvas.width + (ox + px)) * 4;
          const m = parseColor(recipe(sx, sy));
          data[o] = m[0]; data[o + 1] = m[1]; data[o + 2] = m[2]; data[o + 3] = m[3];
        }
      }
    }
    _vshift = 0;
    ctx.putImageData(img, 0, 0);

    const W = cols * cell, H = rows * cell;
    function uvForIdx(i) {
      const cx = i % cols, cy = Math.floor(i / cols);
      // 只取贴图本体，不含补边，这样 mesher 的 UV 数学与旧版完全一致
      return {
        u0: (cx * cell + PAD) / W, v0: (cy * cell + PAD) / H,
        u1: (cx * cell + PAD + T) / W, v1: (cy * cell + PAD + T) / H,
      };
    }

    return {
      canvas: canvas,
      tile: T,
      pad: PAD,
      cell: cell,
      cols: cols,
      rows: rows,
      index: index,
      variants: variants,
      uvOf: function (name) {
        const i = index[name];
        return i === undefined ? null : uvForIdx(i);
      },
      // 第 k 个变体的 UV；k 会对该贴图的变体数取模，缺失时返回 null
      uvOfVariant: function (name, k) {
        const i = index[name];
        if (i === undefined) return null;
        const n = variants[name] || 1;
        const kk = n > 1 ? (((k | 0) % n) + n) % n : 0;
        return uvForIdx(i + kk);
      },
      slotName: function (i) { return slots[i] ? slots[i].name : null; },
    };
  }

  // 把 '#rrggbb' / 'rgba(r,g,b,a)' 解析成 [r,g,b,a(0-255)]
  const _cache = Object.create(null);
  function parseColor(s) {
    if (_cache[s]) return _cache[s];
    let out;
    if (s[0] === '#') {
      const n = parseInt(s.slice(1), 16);
      out = [(n >> 16) & 255, (n >> 8) & 255, n & 255, 255];
    } else {
      const m = s.match(/rgba?\(([^)]+)\)/);
      if (!m) { out = [255, 0, 255, 255]; }
      else {
        const p = m[1].split(',').map(function (v) { return parseFloat(v.trim()); });
        out = [p[0] | 0, p[1] | 0, p[2] | 0, p.length > 3 ? Math.round(p[3] * 255) : 255];
      }
    }
    _cache[s] = out;
    return out;
  }

  // 预置一份常用图集，引擎可以直接按名字引用
  const DEFAULT_ORDER = [
    'grass_top', 'grass_side', 'dirt', 'stone',
    'cobblestone', 'mossy_cobblestone', 'sand', 'sandstone_top',
    'sandstone_side', 'gravel', 'clay', 'snow',
    'oak_log_side', 'oak_log_top', 'birch_log_side', 'spruce_log_side',
    'oak_planks', 'spruce_planks', 'oak_leaves', 'spruce_leaves',
    'glass', 'ice', 'water', 'bricks',
    'stone_bricks', 'coal_ore', 'iron_ore', 'gold_ore',
    'diamond_ore', 'redstone_ore', 'lapis_ore', 'emerald_ore',
    'bedrock', 'glowstone', 'obsidian', 'pumpkin_side',
    'crafting_top', 'tall_grass', 'flower_red', 'flower_yellow',
    'sugar_cane', 'grass_top_snow',
  ];

  global.VoxelTextures = {
    TILE: TILE,
    PAD: PAD,
    CELL: CELL,
    RECIPES: RECIPES,
    DEFAULT_ORDER: DEFAULT_ORDER,
    VARIANT_NAMES: VARIANT_NAMES,
    buildAtlas: buildAtlas,
    hash: hash,
    fbm: fbm,
    // 暴露出来方便单测
    _parseColor: parseColor,
  };
})(typeof window !== 'undefined' ? window : globalThis);
