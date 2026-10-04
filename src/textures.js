// VoxelCraft — 程序化贴图库
// 所有贴图在运行时用 canvas 逐像素画出来，不加载任何外部图片。
// 目标是"像素风体素游戏"的观感：16x16、硬边、两级抖动、方向性明暗。
//
// 用法：
//   const atlas = VoxelTextures.buildAtlas(['grass_top','grass_side',...]);
//   atlas.canvas        -> 可直接喂给 THREE.CanvasTexture
//   atlas.indexOf('x')  -> 该贴图在图集里的序号（引擎据此算 UV）
//
// 对外只暴露一个全局 VoxelTextures，因为 index.html 用的是普通 <script>。
(function (global) {
  'use strict';

  const TILE = 16;          // 单块贴图边长
  const COLS = 8;           // 图集列数（行数按需增长）
  const LUMA_MIN = 0.42;    // 明暗抖动下限，别让暗部死黑

  /* ---------- 确定性随机 ---------- */
  // 用整数 hash 而不是 Math.random：同一张贴图每次启动都长得一样，
  // 否则玩家每次开游戏看到的世界纹理会变。
  function hash(x, y, s) {
    let h = Math.imul(x | 0, 374761393) ^ Math.imul(y | 0, 668265263) ^ Math.imul(s | 0, 2147483647);
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

  const SR = 1; // 配方间 seed 隔离用

  const RECIPES = {

    /* ===== 泥土系 ===== */
    dirt: function (x, y) {
      const base = [134, 96, 67];
      const n = fbm(x * 0.9, y * 0.9, 11, 2);
      const m = fbm(x * 0.35, y * 0.35, 12, 2);
      let c = mix(shade(base, 0.82), shade(base, 1.12), m);
      c = shade(c, 1 + (n - 0.5) * 0.24);
      return rgba(c);
    },

    // 草方块顶面：两种绿交错，带斑驳
    grass_top: function (x, y) {
      const dark = [86, 128, 54];
      const light = [116, 166, 72];
      const n = fbm(x * 0.75, y * 0.75, 21, 3);
      const speck = hash(x, y, 22);
      let c = mix(dark, light, n);
      if (speck > 0.86) c = shade(c, 1.14);
      else if (speck < 0.12) c = shade(c, 0.86);
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
      // 草须向下的过渡像素
      if (y < fringe + 2 && hash(x, y, 34) > 0.55) {
        return rgba([92, 134, 58]);
      }
      return RECIPES.dirt(x, y + 4);
    },

    // 覆盖草顶（灰化草，用于雪线以上）
    grass_top_snow: function (x, y) {
      return rgba(shade([150, 180, 140], 0.94 + hash(x, y, 41) * 0.12));
    },

    /* ===== 石系 ===== */
    stone: function (x, y) {
      const base = [126, 126, 126];
      const n = fbm(x * 0.55, y * 0.55, 51, 3);
      const grain = hash(x, y, 52);
      let c = shade(base, 0.88 + n * 0.26);
      if (grain > 0.9) c = shade(c, 1.1);
      else if (grain < 0.1) c = shade(c, 0.9);
      return rgba(c);
    },

    // 圆石：不规则石块 + 深色勾缝
    cobblestone: function (x, y) {
      // 用低频噪声切分"石头块"，噪声脊线当作灰浆
      const cell = fbm(x * 0.42, y * 0.42, 61, 2);
      const cell2 = fbm(x * 0.9 + 5, y * 0.9 + 5, 62, 2);
      const mortar = (cell < 0.30 || cell2 < 0.16);
      const base = [122, 122, 122];
      if (mortar) return rgba(shade(base, 0.62), 1);
      let c = shade(base, 0.9 + cell * 0.3);
      const g = hash(x, y, 63);
      if (g > 0.88) c = shade(c, 1.12); else if (g < 0.12) c = shade(c, 0.88);
      return rgba(c);
    },

    mossy_cobblestone: function (x, y) {
      const c = RECIPES.cobblestone(x, y);
      const moss = fbm(x * 0.5, y * 0.5, 71, 3);
      if (moss > 0.58) {
        const g = [78, 116, 56];
        return rgba(mix([110, 110, 110], g, Math.min(1, (moss - 0.58) * 3.2)));
      }
      return c;
    },

    // 基岩：极暗、杂乱、有深色裂纹
    bedrock: function (x, y) {
      const n = fbm(x * 1.1, y * 1.1, 81, 3);
      const g = hash(x, y, 82);
      let v = 0.42 + n * 0.5;
      if (g < 0.18) v *= 0.55;
      return rgba(shade([85, 85, 85], v));
    },

    /* ===== 沙 / 砂石 ===== */
    sand: function (x, y) {
      const base = [219, 207, 160];
      const n = fbm(x * 0.7, y * 0.7, 91, 2);
      let c = shade(base, 0.94 + n * 0.12);
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
      return rgba(shade(base, f * (0.97 + hash(x, y, 102) * 0.06)));
    },

    /* ===== 木头系 ===== */
    // 橡木侧面：竖向纹理 + 树皮结节
    oak_log_side: function (x, y) {
      const base = [104, 82, 51];
      const grain = vnoise(x * 0.85, y * 0.22, 111);
      let c = shade(base, 0.86 + grain * 0.3);
      if (hash(x, y, 112) > 0.92) c = shade(c, 1.12);
      // 树皮上的深色竖条
      if (hash(x * 0.5, Math.floor(y / 6), 113) > 0.78) c = shade(c, 0.82);
      return rgba(c);
    },

    // 橡木顶面：年轮
    oak_log_top: function (x, y) {
      const base = [176, 143, 92];
      const dx = x - 7.5, dy = y - 7.5;
      const r = Math.sqrt(dx * dx + dy * dy);
      const rings = Math.sin(r * 2.1) * 0.5 + 0.5;
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
      return rgba(c);
    },

    spruce_log_side: function (x, y) {
      const base = [70, 52, 33];
      let c = shade(base, 0.88 + vnoise(x * 0.7, y * 0.25, 131) * 0.26);
      if (hash(x, y, 132) > 0.93) c = shade(c, 1.15);
      return rgba(c);
    },

    /* ===== 树叶（带透明孔洞） ===== */
    oak_leaves: function (x, y) {
      const h = hash(x, y, 141);
      // 约 12% 的像素完全透明，形成树叶的镂空感
      if (h > 0.88) return 'rgba(0,0,0,0)';
      const dark = [44, 88, 32];
      const light = [84, 140, 56];
      const n = fbm(x * 0.8, y * 0.8, 142, 2);
      let c = mix(dark, light, n);
      if (h < 0.1) c = shade(c, 0.8);
      return rgba(c);
    },

    spruce_leaves: function (x, y) {
      const h = hash(x, y, 151);
      if (h > 0.9) return 'rgba(0,0,0,0)';
      const dark = [32, 66, 44];
      const light = [62, 104, 68];
      return rgba(mix(dark, light, fbm(x * 0.8, y * 0.8, 152, 2)));
    },

    /* ===== 木板 / 建材 ===== */
    oak_planks: function (x, y) {
      const base = [178, 141, 88];
      // 四行木板，行与行之间是暗缝
      const row = Math.floor(y / 4);
      const seam = (y % 4 === 3);
      let c = shade(base, 0.93 + row * 0.02);
      if (seam) c = shade(c, 0.72);
      // 板内木纹
      const grain = vnoise(x * 0.28, row * 3.1, 161);
      c = shade(c, 0.95 + grain * 0.11);
      // 竖向短缝
      if (x === [3, 11, 6, 13][row % 4]) c = shade(c, 0.8);
      return rgba(c);
    },

    spruce_planks: function (x, y) {
      const base = [114, 84, 48];
      const row = Math.floor(y / 4);
      let c = shade(base, 0.94 + row * 0.02);
      if (y % 4 === 3) c = shade(c, 0.72);
      c = shade(c, 0.95 + vnoise(x * 0.28, row * 3.1, 171) * 0.1);
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
      return rgba(shade(base, 0.9 + hash(x, y, 181) * 0.18));
    },

    stone_bricks: function (x, y) {
      const row = Math.floor(y / 4);
      const shift = (row % 2) * 8;
      const bx = (x + shift) % 16;
      const mortar = (y % 4 === 0) || (bx % 8 === 0);
      if (mortar) return rgba([92, 92, 92]);
      const base = [125, 125, 125];
      return rgba(shade(base, 0.9 + fbm(x * 0.6, y * 0.6, 191, 2) * 0.2));
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
    gravel: function (x, y) {
      const n = fbm(x * 1.0, y * 1.0, 231, 3);
      const base = mix([118, 112, 106], [156, 150, 142], n);
      const g = hash(x, y, 232);
      if (g > 0.9) return rgba(shade(base, 1.15));
      if (g < 0.12) return rgba(shade(base, 0.72));
      return rgba(base);
    },
    clay: function (x, y) {
      const base = [160, 166, 179];
      return rgba(shade(base, 0.95 + fbm(x * 0.7, y * 0.7, 241, 2) * 0.1));
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

  /* ---------- 图集构建 ---------- */
  function buildAtlas(names, tilePx) {
    const T = tilePx || TILE;
    const cols = Math.min(COLS, Math.max(1, names.length));
    const rows = Math.ceil(names.length / cols);

    const canvas = document.createElement('canvas');
    canvas.width = cols * T;
    canvas.height = rows * T;
    // 用 alpha:true，树叶/玻璃/植物要靠透明通道
    const ctx = canvas.getContext('2d', { alpha: true });
    ctx.clearRect(0, 0, canvas.width, canvas.height);

    const index = Object.create(null);
    const pixels = [];   // 每张贴图的像素数据，供合成/预览用

    for (let i = 0; i < names.length; i++) {
      const name = names[i];
      const recipe = RECIPES[name];
      if (!recipe) {
        console.warn('[VoxelTextures] 缺少贴图配方:', name);
        continue;
      }
      index[name] = i;
      const ox = (i % cols) * T, oy = Math.floor(i / cols) * T;
      const px = ctx.createImageData(T, T);

      for (let y = 0; y < T; y++) {
        for (let x = 0; x < T; x++) {
          // 配方内部按 16x16 设计；若 T 不是 16 就按比例取样
          const sx = Math.floor(x * (TILE / T));
          const sy = Math.floor(y * (TILE / T));
          const css = recipe(sx, sy);
          const o = (y * T + x) * 4;
          const m = parseColor(css);
          px.data[o] = m[0]; px.data[o + 1] = m[1];
          px.data[o + 2] = m[2]; px.data[o + 3] = m[3];
        }
      }
      ctx.putImageData(px, ox, oy);
      pixels.push(px);
    }

    return {
      canvas: canvas,
      tile: T,
      cols: cols,
      rows: rows,
      index: index,
      // 取某张贴图在图集中的 UV 范围（注意 three.js 的 flipY 行为由调用方决定）
      uvOf: function (name) {
        const i = index[name];
        if (i === undefined) return null;
        const cx = i % cols, cy = Math.floor(i / cols);
        return {
          u0: cx / cols, v0: cy / rows,
          u1: (cx + 1) / cols, v1: (cy + 1) / rows,
        };
      },
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
    RECIPES: RECIPES,
    DEFAULT_ORDER: DEFAULT_ORDER,
    buildAtlas: buildAtlas,
    hash: hash,
    fbm: fbm,
    // 暴露出来方便单测
    _parseColor: parseColor,
  };
})(typeof window !== 'undefined' ? window : globalThis);
