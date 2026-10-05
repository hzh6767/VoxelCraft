// VoxelCraft — 引擎粘合层
// 只做四件事：建场景、装配模块、跑主循环、驱动 UI。
// 所有游戏规则都在各自模块里；这里不实现任何一条规则。
//
// 装配原则：模块之间的调用一律经过下面的 pick()/call() 适配器。
// 模块由多个子智能体并行写成，个别签名可能和契约有细微出入；
// 适配器让引擎在签名漂移时降级而不是整个崩掉。
(function (global) {
  'use strict';

  /* ============================================================
   * 0. 常量
   * ============================================================ */
  const CHUNK_X = 16, CHUNK_Z = 16, CHUNK_Y = 128, SEA_LEVEL = 56;
  const RENDER_DIST = 8;                 // 区块
  const REMESH_BUDGET_STARTUP = 12;      // 开场赶进度
  const REMESH_BUDGET_STEADY = 2;        // 稳态每帧重建上限
  const DAY_LENGTH = 12 * 60;            // 一昼夜 12 分钟

  /* ============================================================
   * 1. 模块适配器
   * ============================================================ */
  function mod(name) {
    const m = global[name];
    if (!m) console.warn('[engine] 模块缺失:', name);
    return m || {};
  }
  // 从若干候选名里取第一个存在的函数
  function pick(obj, names) {
    for (const n of names) if (typeof obj[n] === 'function') return obj[n].bind(obj);
    return null;
  }

  const TEX      = mod('VoxelTextures');
  const BLOCKS   = mod('VoxelBlocks');
  const WORLDGEN = mod('VoxelWorldgen');
  const CHUNKMOD = mod('VoxelChunk');
  const RAYCAST  = mod('VoxelRaycast');
  const PLAYERM  = mod('VoxelPlayer');
  const LIGHT    = mod('VoxelLight');
  const INV      = mod('VoxelInventory');
  const MOBS     = mod('VoxelMobs');
  const SOUND    = mod('VoxelSound');
  const SAVE     = mod('VoxelSave');

  /* ============================================================
   * 2. three.js 场景
   * ============================================================ */
  const SKY_DAY = new THREE.Color(0x87ceeb);
  const SKY_NIGHT = new THREE.Color(0x0a0e1a);

  const scene = new THREE.Scene();
  scene.background = SKY_DAY.clone();
  scene.fog = new THREE.Fog(SKY_DAY.getHex(), RENDER_DIST * CHUNK_X * 0.55, RENDER_DIST * CHUNK_X - 8);

  const camera = new THREE.PerspectiveCamera(75, innerWidth / innerHeight, 0.1, 600);
  camera.rotation.order = 'YXZ';

  const renderer = new THREE.WebGLRenderer({
    antialias: false,                 // 体素游戏靠像素风，MSAA 收益低、开销高
    powerPreference: 'high-performance',
    alpha: false,
  });
  renderer.setPixelRatio(Math.min(devicePixelRatio, 1.5));
  renderer.setSize(innerWidth, innerHeight);
  document.getElementById('game').appendChild(renderer.domElement);

  /* ---- Bloom 后处理（电影级光晕）----
   * three.js r149 的 min 构建里没有 EffectComposer/RenderPass/UnrealBloomPass，
   * 所以这里用 ShaderMaterial + WebGLRenderTarget 自己搭一条最小管线：
   *   场景 -> sceneRT
   *   sceneRT 提亮（阈值以上）-> brightRT（半分辨率）
   *   横向模糊 + 纵向模糊，两次乒乓 -> 得到泛光
   *   合成：sceneRT + 泛光 * strength，带 ACES 色调映射与曝光
   * 全程不依赖任何外部文件。 */
  const BloomFX = (function () {
    const VERT = [
      'varying vec2 vUv;',
      'void main() {',
      '  vUv = uv;',
      '  gl_Position = vec4(position.xy, 0.0, 1.0);',
      '}',
    ].join('\n');

    // 亮度阈值提取
    const FRAG_BRIGHT = [
      'uniform sampler2D tDiffuse;',
      'uniform float uThreshold;',
      'uniform float uKnee;',
      'varying vec2 vUv;',
      'void main() {',
      '  vec3 c = texture2D(tDiffuse, vUv).rgb;',
      '  float lum = dot(c, vec3(0.2126, 0.7152, 0.0722));',
      '  // 软阈值，避免出现硬边',
      '  float soft = clamp(lum - uThreshold + uKnee, 0.0, 2.0 * uKnee);',
      '  soft = soft * soft / (4.0 * uKnee + 1e-4);',
      '  float contrib = max(soft, lum - uThreshold) / max(lum, 1e-4);',
      '  gl_FragColor = vec4(c * contrib, 1.0);',
      '}',
    ].join('\n');

    // 分离式高斯模糊（9 抽头）
    const FRAG_BLUR = [
      'uniform sampler2D tDiffuse;',
      'uniform vec2 uDirection;',
      'varying vec2 vUv;',
      'void main() {',
      '  float w[5];',
      '  w[0] = 0.227027; w[1] = 0.194594; w[2] = 0.121621; w[3] = 0.054054; w[4] = 0.016216;',
      '  vec3 sum = texture2D(tDiffuse, vUv).rgb * w[0];',
      '  for (int i = 1; i < 5; i++) {',
      '    vec2 off = uDirection * float(i) * 1.3;',
      '    sum += texture2D(tDiffuse, vUv + off).rgb * w[i];',
      '    sum += texture2D(tDiffuse, vUv - off).rgb * w[i];',
      '  }',
      '  gl_FragColor = vec4(sum, 1.0);',
      '}',
    ].join('\n');

    // 合成 + ACES 近似色调映射 + 曝光
    const FRAG_COMPOSITE = [
      'uniform sampler2D tScene;',
      'uniform sampler2D tBloom;',
      'uniform float uStrength;',
      'uniform float uExposure;',
      'varying vec2 vUv;',
      'vec3 aces(vec3 x) {',
      '  const float a = 2.51, b = 0.03, c = 2.43, d = 0.59, e = 0.14;',
      '  return clamp((x * (a * x + b)) / (x * (c * x + d) + e), 0.0, 1.0);',
      '}',
      'void main() {',
      '  vec3 scene = texture2D(tScene, vUv).rgb;',
      '  vec3 bloom = texture2D(tBloom, vUv).rgb;',
      '  vec3 c = scene + bloom * uStrength;',
      '  c *= uExposure;',
      '  c = aces(c);',
      '  gl_FragColor = vec4(c, 1.0);',
      '}',
    ].join('\n');

    function makeMat(frag, uniforms) {
      return new THREE.ShaderMaterial({
        uniforms: uniforms,
        vertexShader: VERT,
        fragmentShader: frag,
        depthTest: false,
        depthWrite: false,
      });
    }

    const fsGeo = new THREE.PlaneGeometry(2, 2);
    const fsCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
    const fsScene = new THREE.Scene();
    const fsQuad = new THREE.Mesh(fsGeo, makeMat(FRAG_BRIGHT, {
      tDiffuse: { value: null }, uThreshold: { value: 0.85 }, uKnee: { value: 0.3 },
    }));
    fsQuad.frustumCulled = false;
    fsScene.add(fsQuad);

    let w = 1, h = 1;
    const rtScene = new THREE.WebGLRenderTarget(1, 1, { minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter });
    const rtBright = new THREE.WebGLRenderTarget(1, 1, { minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter });
    const rtBlurA = new THREE.WebGLRenderTarget(1, 1, { minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter });
    const rtBlurB = new THREE.WebGLRenderTarget(1, 1, { minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter });

    const brightMat = fsQuad.material;
    const blurMat = makeMat(FRAG_BLUR, { tDiffuse: { value: null }, uDirection: { value: new THREE.Vector2() } });
    const compMat = makeMat(FRAG_COMPOSITE, {
      tScene: { value: null }, tBloom: { value: null },
      uStrength: { value: 0.85 }, uExposure: { value: 1.05 },
    });

    function setSize(width, height) {
      w = Math.max(1, width | 0); h = Math.max(1, height | 0);
      const hw = Math.max(1, (w / 2) | 0), hh = Math.max(1, (h / 2) | 0);
      rtScene.setSize(w, h);
      rtBright.setSize(hw, hh);
      rtBlurA.setSize(hw, hh);
      rtBlurB.setSize(hw, hh);
    }

    function quad(renderer, material, target, uniforms) {
      fsQuad.material = material;
      if (uniforms) for (const k in uniforms) material.uniforms[k].value = uniforms[k];
      renderer.setRenderTarget(target);
      renderer.clear();
      renderer.render(fsScene, fsCam);
    }

    function render(renderer, scene, camera) {
      // 1) 场景 -> rtScene
      renderer.setRenderTarget(rtScene);
      renderer.clear();
      renderer.render(scene, camera);

      // 2) 提亮
      brightMat.uniforms.tDiffuse.value = rtScene.texture;
      quad(renderer, brightMat, rtBright);

      // 3) 横模糊
      blurMat.uniforms.tDiffuse.value = rtBright.texture;
      blurMat.uniforms.uDirection.value.set(1 / (w / 2), 0);
      quad(renderer, blurMat, rtBlurA);

      // 4) 纵模糊
      blurMat.uniforms.tDiffuse.value = rtBlurA.texture;
      blurMat.uniforms.uDirection.value.set(0, 1 / (h / 2));
      quad(renderer, blurMat, rtBlurB);

      // 5) 合成到屏幕
      compMat.uniforms.tScene.value = rtScene.texture;
      compMat.uniforms.tBloom.value = rtBlurB.texture;
      renderer.setRenderTarget(null);
      quad(renderer, compMat, null);
    }

    return { render, setSize, setStrength: (v) => { compMat.uniforms.uStrength.value = v; } };
  })();

  /* ---- 贴图图集 ---- */
  const tileNames = (BLOCKS.TILE_NAMES && BLOCKS.TILE_NAMES.length)
    ? BLOCKS.TILE_NAMES
    : (TEX.DEFAULT_ORDER || []);
  const atlas = (typeof TEX.buildAtlas === 'function')
    ? TEX.buildAtlas(tileNames)
    : null;

  let atlasTexture = null;
  if (atlas && atlas.canvas) {
    atlasTexture = new THREE.CanvasTexture(atlas.canvas);
    atlasTexture.magFilter = THREE.NearestFilter;
    atlasTexture.minFilter = THREE.NearestFilter;
    atlasTexture.generateMipmaps = false;
    atlasTexture.flipY = false;
    // mesher 通过这个全局取每张贴图的 UV 范围。没有它 mesher 会退回
    // “整张图集”的 UV，导致每个方块面都贴上全部 42 张贴图。
    global.__voxelAtlas = atlas;
  } else {
    console.error('[engine] 图集构建失败，贴图将退化为纯色');
  }

  /* ---- 材质 ----
   * 用 MeshBasicMaterial 而不是 Lambert：mesher 只输出 position/uv/color/index，
   * 没有法线属性。Lambert 需要 normal 参与光照，缺失时法线为 0、光照贡献接近 0，
   * 整个地形会渲染成接近纯黑。方向明暗、AO、天光已经在顶点色里烘焙好了，
   * 所以这里只需要 Basic + fog 就够，昼夜由 material.color 统一调制。 */
  const matOpaque = new THREE.MeshBasicMaterial({
    map: atlasTexture, vertexColors: true, fog: true,
    // 图集里树叶的孔洞、植物镂空的像素是 alpha=0 的黑色。
    // 不做 alphaTest 的话这些像素会被画成黑块，树叶上就全是黑洞。
    alphaTest: 0.5,
  });
  const matWater = new THREE.MeshBasicMaterial({
    map: atlasTexture, vertexColors: true, fog: true,
    transparent: true, opacity: 0.72, depthWrite: false, side: THREE.DoubleSide,
  });
  const matCross = new THREE.MeshBasicMaterial({
    map: atlasTexture, vertexColors: true, fog: true,
    transparent: true, alphaTest: 0.5, side: THREE.DoubleSide,
  });
  const WORLD_MATS = [matOpaque, matWater, matCross];

  /* ---- 光照（电影级三级色温） ---- */
  const sun = new THREE.DirectionalLight(0xffffff, 1.0);
  sun.position.set(0.6, 1, 0.35).multiplyScalar(100);
  scene.add(sun);
  // 半球光补暗部，避免背光面死黑
  const hemi = new THREE.HemisphereLight(0xbfd8ff, 0x6b5a44, 0.45);
  scene.add(hemi);

  // 昼夜色温关键帧（清晨橙红 -> 正午纯白 -> 黄昏深蓝 -> 夜晚冷蓝）
  const TIME_KEYS = [
    { t: 0.00, sun: 0xffa04a, sky: 0xff8c66, fog: 0xffa888, intensity: 0.3 },  // 黎明
    { t: 0.15, sun: 0xfff0d0, sky: 0xffb880, fog: 0xffc89a, intensity: 0.8 },  // 清晨
    { t: 0.25, sun: 0xffffff, sky: 0x87ceeb, fog: 0xa8d8f0, intensity: 1.0 },  // 正午
    { t: 0.65, sun: 0xffe8c0, sky: 0xffa060, fog: 0xffb080, intensity: 0.85 }, // 黄昏
    { t: 0.75, sun: 0x6080c0, sky: 0x1a2844, fog: 0x2a3a58, intensity: 0.2 },  // 傍晚
    { t: 1.00, sun: 0x405080, sky: 0x0a0e1a, fog: 0x15192a, intensity: 0.15 }, // 深夜
  ];

  /* ---- 高亮框 ---- */
  const highlight = new THREE.LineSegments(
    new THREE.EdgesGeometry(new THREE.BoxGeometry(1.002, 1.002, 1.002)),
    new THREE.LineBasicMaterial({ color: 0x000000, transparent: true, opacity: 0.4 })
  );
  highlight.visible = false;
  scene.add(highlight);

  /* ============================================================
   * 3. 世界
   * ============================================================ */
  const chunkKey = (typeof CHUNKMOD.key === 'function')
    ? CHUNKMOD.key
    : (cx, cz) => cx + ',' + cz;

  const ChunkClass = CHUNKMOD.Chunk;

  const world = {
    chunks: new Map(),
    overrides: new Map(),      // "cx,cz" -> Map("lx,y,lz" -> id)，玩家改动，存档用

    chunk(cx, cz) {
      const k = chunkKey(cx, cz);
      let c = this.chunks.get(k);
      if (c) return c;

      if (typeof ChunkClass !== 'function') {
        console.error('[engine] VoxelChunk.Chunk 缺失，无法生成区块');
        return null;
      }
      c = new ChunkClass(cx, cz);
      c.key = k;
      c.dirty = true;
      this.chunks.set(k, c);

      // 地形
      if (typeof WORLDGEN.generateChunk === 'function') {
        const gen = WORLDGEN.generateChunk(cx, cz);
        if (gen && gen.length) c.blocks = gen;
      }
      // 玩家改动覆盖生成结果
      const ov = this.overrides.get(k);
      if (ov && typeof c.set === 'function') {
        for (const [pos, id] of ov) {
          const [lx, y, lz] = pos.split(',').map(Number);
          c.set(lx, y, lz, id);
        }
      }

      // 从磁盘读回上次会话的改动。
      // 之前 saveBlockEdit 是只写不读：改动进了 IndexedDB 却从没被加载回来，
      // 重启后世界重新生成、玩家的建筑全丢，而出生点又按存档恢复，
      // 结果可能卡在原本是建筑的地方。
      if (typeof SAVE.loadEdits === 'function') {
        try {
          Promise.resolve(SAVE.loadEdits(cx, cz)).then(edits => {
            if (!edits || !edits.length) return;
            let stored = this.overrides.get(k);
            if (!stored) { stored = new Map(); this.overrides.set(k, stored); }
            for (const t of edits) {
              const tlx = t[0], ty = t[1], tlz = t[2], tid = t[3];
              stored.set(tlx + ',' + ty + ',' + tlz, tid);
              c.set(tlx, ty, tlz, tid);
            }
            // 改动可能影响光照和网格，重算后重建
            if (typeof LIGHT.computeChunkLight === 'function') {
              try { LIGHT.computeChunkLight(c, this); } catch (e) {}
            }
            c.dirty = true;
          }).catch(() => {});
        } catch (e) { /* 读档失败不该阻断生成 */ }
      }
      // 光照
      if (typeof LIGHT.computeChunkLight === 'function') {
        try { LIGHT.computeChunkLight(c, this); } catch (e) { console.warn('[engine] 光照计算失败', e); }
      }
      return c;
    },

    peek(cx, cz) { return this.chunks.get(chunkKey(cx, cz)); },

    getBlock(x, y, z) {
      if (y < 0) return BLOCKS.ID ? BLOCKS.ID.BEDROCK : 6;
      if (y >= CHUNK_Y) return 0;
      const cx = x >> 4, cz = z >> 4;
      const c = this.chunks.get(chunkKey(cx, cz));
      if (!c) return 0;                       // 未加载区块按空气处理，避免卡死主线程
      return c.get(x & 15, y, z & 15);
    },

    setBlock(x, y, z, id, opts) {
      if (y < 1 || y >= CHUNK_Y) return false;
      const cx = x >> 4, cz = z >> 4, lx = x & 15, lz = z & 15;
      const c = this.chunks.get(chunkKey(cx, cz));
      if (!c) return false;

      const old = c.get(lx, y, lz);
      if (old === id) return false;
      c.set(lx, y, lz, id);

      // 记录改动 → 存档
      const k = chunkKey(cx, cz);
      let ov = this.overrides.get(k);
      if (!ov) { ov = new Map(); this.overrides.set(k, ov); }
      ov.set(lx + ',' + y + ',' + lz, id);
      if (typeof SAVE.saveBlockEdit === 'function') {
        try { SAVE.saveBlockEdit(cx, cz, lx, y, lz, id); } catch (e) { /* 存档失败不该打断游戏 */ }
      }

      // 标记重建：本区块，以及方块正好在边界时的邻居
      this.markDirty(cx, cz);
      if (lx === 0) this.markDirty(cx - 1, cz);
      if (lx === 15) this.markDirty(cx + 1, cz);
      if (lz === 0) this.markDirty(cx, cz - 1);
      if (lz === 15) this.markDirty(cx, cz + 1);

      // 光照增量更新 —— 不是全世界重算
      if (!opts || !opts.skipLight) {
        if (typeof LIGHT.onBlockChanged === 'function') {
          try { LIGHT.onBlockChanged(x, y, z, old, id, this); }
          catch (e) { console.warn('[engine] 光照增量更新失败', e); }
        }
      }
      return true;
    },

    markDirty(cx, cz) {
      const c = this.peek(cx, cz);
      if (c) c.dirty = true;
    },

    // 供 mesher / 光照模块使用
    getSkyLight(x, y, z) {
      if (typeof LIGHT.getSky === 'function') {
        try { return LIGHT.getSky(x, y, z); } catch (e) { /* 未加载区块 */ }
      }
      return y >= SEA_LEVEL ? 15 : 0;
    },
    getBlockLightAt(x, y, z) {
      if (typeof LIGHT.getBlockLight === 'function') {
        try { return LIGHT.getBlockLight(x, y, z); } catch (e) { /* ignore */ }
      }
      return 0;
    },
    isLoaded(cx, cz) { return this.chunks.has(chunkKey(cx, cz)); },
  };

  // 光照模块需要反查世界。
  // VoxelLight 内部用的是模块私有的 world 变量，只有 _setWorld 能设置它；
  // 只挂 __voxelWorld 是没用的（该模块从不读这个全局），会导致 getSky 永远返回 15、
  // getBlockLight 永远返回 0 —— 跨区块的洞穴墙面会整片发亮。
  global.__voxelWorld = world;
  if (typeof LIGHT._setWorld === 'function') {
    try { LIGHT._setWorld(world); } catch (e) { console.warn('[engine] 光照世界绑定失败', e); }
  }

  /* ============================================================
   * 4. 区块网格
   * ============================================================ */
  const meshRoot = new THREE.Group();
  scene.add(meshRoot);

  const buildMeshFn = pick(CHUNKMOD, ['buildMesh', 'buildChunkMesh', 'mesh']);

  function rebuildChunk(c) {
    if (!c || !buildMeshFn) return;
    let geo;
    try {
      geo = buildMeshFn(c, world);
    } catch (e) {
      console.warn('[engine] 网格构建异常', c.cx, c.cz, e);
      c.dirty = false;
      return;
    }
    if (!geo) { c.dirty = false; return; }

    // 期望 {opaque, water, cross}；兼容只返回单个 geometry 的写法
    const parts = ('opaque' in geo || 'water' in geo || 'cross' in geo)
      ? geo
      : { opaque: geo };

    const slots = [
      ['mesh', parts.opaque, matOpaque],
      ['waterMesh', parts.water, matWater],
      ['crossMesh', parts.cross, matCross],
    ];
    for (const [prop, g, mat] of slots) {
      if (c[prop]) {
        meshRoot.remove(c[prop]);
        if (c[prop].geometry) c[prop].geometry.dispose();
        c[prop] = null;
      }
      if (g) {
        const m = new THREE.Mesh(g, mat);
        m.frustumCulled = true;
        c[prop] = m;
        meshRoot.add(m);
      }
    }
    c.dirty = false;
  }

  function disposeChunk(c) {
    for (const p of ['mesh', 'waterMesh', 'crossMesh']) {
      if (c[p]) {
        meshRoot.remove(c[p]);
        if (c[p].geometry) c[p].geometry.dispose();
        c[p] = null;
      }
    }
  }

  /* ============================================================
   * 5. 区块流式加载
   * ============================================================ */
  function streamChunks(budget) {
    const pcx = Math.floor(player.pos.x / CHUNK_X);
    const pcz = Math.floor(player.pos.z / CHUNK_Z);
    let built = 0;

    for (let r = 0; r <= RENDER_DIST && built < budget; r++) {
      for (let dx = -r; dx <= r && built < budget; dx++) {
        for (let dz = -r; dz <= r && built < budget; dz++) {
          if (Math.max(Math.abs(dx), Math.abs(dz)) !== r) continue;
          const c = world.chunk(pcx + dx, pcz + dz);
          if (c && c.dirty) { rebuildChunk(c); built++; }
        }
      }
    }
    return built;
  }

  function unloadFarChunks() {
    const pcx = Math.floor(player.pos.x / CHUNK_X);
    const pcz = Math.floor(player.pos.z / CHUNK_Z);
    for (const [k, c] of world.chunks) {
      if (Math.max(Math.abs(c.cx - pcx), Math.abs(c.cz - pcz)) > RENDER_DIST + 2) {
        disposeChunk(c);
        world.chunks.delete(k);
      }
    }
  }

  /* ============================================================
   * 6. 玩家
   * ============================================================ */
  const PlayerClass = PLAYERM.Player;
  const player = (typeof PlayerClass === 'function')
    ? new PlayerClass()
    : { pos: new THREE.Vector3(8, 70, 8), vel: new THREE.Vector3(), yaw: 0, pitch: 0,
        onGround: false, flying: false, sneaking: false, inWater: false, health: 20, air: 20 };
  player.pos = player.pos || new THREE.Vector3(8, 70, 8);

  // 落点：地表 +2
  function placeAtSurface() {
    if (typeof WORLDGEN.heightAt === 'function') {
      const h = WORLDGEN.heightAt(Math.floor(player.pos.x), Math.floor(player.pos.z));
      if (Number.isFinite(h)) player.pos.y = h + 2;
    }
  }
  placeAtSurface();
  if (typeof SAVE.loadPlayer === 'function') {
    try {
      Promise.resolve(SAVE.loadPlayer()).then(st => {
        if (!st) return;
        if (Array.isArray(st.pos)) player.pos.set(st.pos[0], st.pos[1], st.pos[2]);
        if (typeof st.yaw === 'number') player.yaw = st.yaw;
        if (typeof st.pitch === 'number') player.pitch = st.pitch;
        if (st.flying) player.flying = true;
      }).catch(() => {});
    } catch (e) { /* ignore */ }
  }

  /* ============================================================
   * 7. 输入
   * ============================================================ */
  const input = {
    forward: 0, back: 0, left: 0, right: 0,
    jump: false, sneak: false, sprint: false, up: false, down: false,
  };
  let locked = false;
  let mining = false;
  let placing = false;

  const overlay = document.getElementById('overlay');
  const loadingText = document.getElementById('loading-text');
  const debugEl = document.getElementById('debug');
  const crackEl = document.getElementById('crack');

  const canvas = renderer.domElement;
  canvas.addEventListener('click', () => {
    if (!locked) canvas.requestPointerLock();
  });
  overlay.addEventListener('click', () => {
    if (typeof SOUND.init === 'function') { try { SOUND.init(); } catch (e) {} }
    canvas.requestPointerLock();
  });

  document.addEventListener('pointerlockchange', () => {
    locked = document.pointerLockElement === canvas;
    overlay.classList.toggle('hide', locked);
    if (!locked) { mining = false; placing = false; }
  });

  document.addEventListener('mousemove', e => {
    if (!locked) return;
    player.yaw -= e.movementX * 0.0022;
    player.pitch -= e.movementY * 0.0022;
    const lim = Math.PI / 2 - 0.001;
    player.pitch = Math.max(-lim, Math.min(lim, player.pitch));
  });

  document.addEventListener('contextmenu', e => e.preventDefault());

  addEventListener('keydown', e => {
    switch (e.code) {
      case 'KeyW': case 'ArrowUp': input.forward = 1; break;
      case 'KeyS': case 'ArrowDown': input.back = 1; break;
      case 'KeyA': case 'ArrowLeft': input.left = 1; break;
      case 'KeyD': case 'ArrowRight': input.right = 1; break;
      case 'Space': input.jump = true; e.preventDefault(); break;
      case 'ShiftLeft': case 'ShiftRight': input.sprint = true; input.sneak = true; break;
      case 'KeyF': player.flying = !player.flying; break;
      case 'KeyE': toggleInventory(); break;
    }
    if (e.code.startsWith('Digit')) {
      const n = +e.code.slice(5);
      if (n >= 1 && n <= 9) selectHotbar(n - 1);
    }
  });

  addEventListener('keyup', e => {
    switch (e.code) {
      case 'KeyW': case 'ArrowUp': input.forward = 0; break;
      case 'KeyS': case 'ArrowDown': input.back = 0; break;
      case 'KeyA': case 'ArrowLeft': input.left = 0; break;
      case 'KeyD': case 'ArrowRight': input.right = 0; break;
      case 'Space': input.jump = false; break;
      case 'ShiftLeft': case 'ShiftRight': input.sprint = false; input.sneak = false; break;
    }
  });

  addEventListener('wheel', e => {
    if (locked) selectHotbar(hotbarIndex + (e.deltaY > 0 ? 1 : -1));
  }, { passive: true });

  canvas.addEventListener('mousedown', e => {
    if (!locked) return;
    if (e.button === 0) mining = true;
    else if (e.button === 2) placing = true;
    else if (e.button === 1) pickBlock();
  });
  addEventListener('mouseup', e => {
    if (e.button === 0) mining = false;
    if (e.button === 2) placing = false;
  });

  addEventListener('resize', () => {
    camera.aspect = innerWidth / innerHeight;
    camera.updateProjectionMatrix();
    renderer.setSize(innerWidth, innerHeight);
    BloomFX.setSize(innerWidth * renderer.getPixelRatio(), innerHeight * renderer.getPixelRatio());
  });

  /* ============================================================
   * 8. 背包 / 快捷栏 UI
   * ============================================================ */
  const InventoryClass = INV.Inventory;
  const inventory = (typeof InventoryClass === 'function')
    ? new InventoryClass()
    : null;

  let hotbarIndex = 0;
  const hotbarEl = document.getElementById('hotbar');

  // 默认给玩家一排方块，否则开局面朝空手没法试玩
  const STARTER = [2, 3, 4, 1, 12, 6, 9, 13, 27];  // 草/土/圆石/石/雪/基岩/木板/玻璃/荧石
  if (inventory && typeof inventory.add === 'function') {
    for (const id of STARTER) { try { inventory.add(id, 64); } catch (e) {} }
  }

  function tileCanvas(name, size) {
    const c = document.createElement('canvas');
    c.width = c.height = 16;
    const x = c.getContext('2d');
    const recipe = TEX.RECIPES && TEX.RECIPES[name];
    if (recipe) {
      for (let py = 0; py < 16; py++) for (let px = 0; px < 16; px++) {
        x.fillStyle = recipe(px, py);
        x.fillRect(px, py, 1, 1);
      }
    }
    const img = document.createElement('canvas');
    img.width = img.height = size || 32;
    const g = img.getContext('2d');
    g.imageSmoothingEnabled = false;
    g.drawImage(c, 0, 0, img.width, img.height);
    return img.toDataURL();
  }

  function blockIconURL(id) {
    const def = BLOCKS.DEF && BLOCKS.DEF[id];
    if (!def || !def.tiles) return null;
    return tileCanvas(def.tiles[2] || def.tiles[0], 32);
  }

  function buildHotbar() {
    hotbarEl.innerHTML = '';
    for (let i = 0; i < 9; i++) {
      const id = STARTER[i];
      const d = document.createElement('div');
      d.className = 'slot' + (i === hotbarIndex ? ' on' : '');
      const url = blockIconURL(id);
      const ic = document.createElement('div');
      ic.className = 'icon';
      if (url) ic.style.background = 'url(' + url + ') center/cover';
      else ic.style.background = '#888';
      d.appendChild(ic);
      const num = document.createElement('div');
      num.className = 'num'; num.textContent = (i + 1);
      d.appendChild(num);
      hotbarEl.appendChild(d);
    }
  }

  function selectHotbar(i) {
    hotbarIndex = ((i % 9) + 9) % 9;
    if (inventory && typeof inventory.selectHotbar === 'function') {
      try { inventory.selectHotbar(hotbarIndex); } catch (e) {}
    }
    [...hotbarEl.children].forEach((el, j) => el.classList.toggle('on', j === hotbarIndex));
  }

  function currentBlockId() { return STARTER[hotbarIndex]; }

  function toggleInventory() {
    if (!locked) return;
    document.exitPointerLock();
  }

  function pickBlock() {
    const hit = targetBlock();
    if (hit && typeof SOUND.play === 'function') { try { SOUND.play('pop', { volume: 0.4 }); } catch (e) {} }
  }

  buildHotbar();
  selectHotbar(0);

  /* ============================================================
   * 9. 拾取 / 挖掘 / 放置
   * ============================================================ */
  const raycastFn = pick(RAYCAST, ['raycast', 'cast', 'rayCast']);
  const BreakProgress = RAYCAST.BreakProgress;
  let breakProgress = (typeof BreakProgress === 'function') ? new BreakProgress() : null;
  let lastTargetKey = '';

  const _dir = new THREE.Vector3();

  function eyePos() {
    if (typeof player.getEyePosition === 'function') return player.getEyePosition();
    return new THREE.Vector3(player.pos.x, player.pos.y + 1.62, player.pos.z);
  }

  function targetBlock() {
    if (!raycastFn) return null;
    camera.getWorldDirection(_dir);
    try {
      return raycastFn(eyePos(), _dir, 5.0, world, false);
    } catch (e) {
      // 签名漂移时退化为 (origin, dir, dist, world)
      try { return raycastFn(eyePos(), _dir, 5.0, world); } catch (e2) { return null; }
    }
  }

  function soundFor(id, action) {
    const def = BLOCKS.DEF && BLOCKS.DEF[id];
    const cls = (def && def.sound) || 'stone';
    return action + '.' + cls;
  }

  function breakBlockAt(hit) {
    const id = world.getBlock(hit.x, hit.y, hit.z);
    if (!id) return;
    world.setBlock(hit.x, hit.y, hit.z, 0);
    if (typeof SOUND.play === 'function') {
      try { SOUND.play(soundFor(id, 'break'), { volume: 0.7 }); } catch (e) {}
    }
  }

  function placeBlockAt(hit) {
    const id = currentBlockId();
    const x = hit.x + (hit.nx || 0), y = hit.y + (hit.ny || 0), z = hit.z + (hit.nz || 0);
    if (typeof RAYCAST.canPlaceAt === 'function') {
      let ok = false;
      try { ok = RAYCAST.canPlaceAt(id, x, y, z, world, player); }
      catch (e) { ok = true; }        // 签名不符时放行，总比不能建造好
      if (!ok) return;
    }
    if (world.setBlock(x, y, z, id) && typeof SOUND.play === 'function') {
      try { SOUND.play(soundFor(id, 'place'), { volume: 0.6 }); } catch (e) {}
    }
  }

  /* ============================================================
   * 10. 昼夜
   * ============================================================ */
  let timeOfDay = 0.28;   // 0..1，0.25 = 清晨

  // 在关键帧之间线性插值，得到连续变化的日光/天空/雾色
  const _cA = new THREE.Color(), _cB = new THREE.Color();
  function sampleTimeKeys(t) {
    let a = TIME_KEYS[0], b = TIME_KEYS[TIME_KEYS.length - 1];
    for (let i = 0; i < TIME_KEYS.length - 1; i++) {
      if (t >= TIME_KEYS[i].t && t <= TIME_KEYS[i + 1].t) {
        a = TIME_KEYS[i]; b = TIME_KEYS[i + 1]; break;
      }
    }
    const span = (b.t - a.t) || 1;
    const k = Math.max(0, Math.min(1, (t - a.t) / span));
    _cA.setHex(a.sun); _cB.setHex(b.sun);
    const sunC = _cA.clone().lerp(_cB, k);
    _cA.setHex(a.sky); _cB.setHex(b.sky);
    const skyC = _cA.clone().lerp(_cB, k);
    _cA.setHex(a.fog); _cB.setHex(b.fog);
    const fogC = _cA.clone().lerp(_cB, k);
    const intensity = a.intensity + (b.intensity - a.intensity) * k;
    return { sun: sunC, sky: skyC, fog: fogC, intensity };
  }

  function updateSky() {
    const ang = timeOfDay * Math.PI * 2 - Math.PI / 2;
    const elev = Math.sin(ang);
    const keys = sampleTimeKeys(timeOfDay);

    // 太阳沿天球运动，日落后压在地平线下但保留一点环境光
    sun.position.set(Math.cos(ang) * 100, Math.max(-20, elev * 100), 40);
    sun.color.copy(keys.sun);
    sun.intensity = keys.intensity;
    hemi.intensity = 0.10 + keys.intensity * 0.40;

    scene.background.copy(keys.sky);
    if (scene.fog) scene.fog.color.copy(keys.fog);

    // 顶点色里的天光在网格构建时烘焙好了，昼夜变化靠材质色统一调制：
    // 用日光色乘上强度，夜晚整个世界随之变暗偏蓝。
    for (const m of WORLD_MATS) {
      m.color.copy(keys.sun).multiplyScalar(0.35 + keys.intensity * 0.65);
    }

    // 亮度系数：供后期曝光使用
    global.__daylight = Math.max(0, Math.min(1, (elev + 0.18) / 0.55));
    global.__skyKeys = keys;
  }

  /* ============================================================
   * 11. 生物
   * ============================================================ */
  let mobManager = null;
  if (typeof MOBS.MobManager === 'function') {
    try { mobManager = new MOBS.MobManager(); } catch (e) { console.warn('[engine] 生物管理器创建失败', e); }
  }
  const mobRoot = new THREE.Group();
  scene.add(mobRoot);
  const mobMeshes = new Map();

  function syncMobs() {
    if (!mobManager || !Array.isArray(mobManager.mobs)) return;
    const seen = new Set();
    for (const mob of mobManager.mobs) {
      if (!mob || !mob.pos) continue;
      seen.add(mob);
      let mesh = mobMeshes.get(mob);
      if (!mesh) {
        const w = (mob.width || (mob.type === 'pig' ? 0.9 : 0.6));
        const h = (mob.height || (mob.type === 'pig' ? 0.9 : 1.8));
        const color = mob.type === 'pig' ? 0xe0a0a0 : 0x4a7a4a;
        mesh = new THREE.Mesh(
          new THREE.BoxGeometry(w, h, w),
          new THREE.MeshLambertMaterial({ color })
        );
        mobMeshes.set(mob, mesh);
        mobRoot.add(mesh);
      }
      mesh.position.set(mob.pos.x, mob.pos.y + (mob.height || 1.8) / 2, mob.pos.z);
      mesh.rotation.y = mob.yaw || 0;
    }
    for (const [mob, mesh] of mobMeshes) {
      if (!seen.has(mob) || !mob.alive) {
        mobRoot.remove(mesh);
        mesh.geometry.dispose();
        mesh.material.dispose();
        mobMeshes.delete(mob);
      }
    }
  }

  /* ============================================================
   * 12. 主循环
   * ============================================================ */
  let prev = performance.now();
  let fps = 60, frame = 0, hudTimer = 0, saveTimer = 0, unloadTimer = 0;

  function updatePlayer(dt) {
    if (typeof player.update === 'function') {
      try {
        player.update(dt, input, world);
        return;
      } catch (e) { /* 落到下面的兜底 */ }
    }
    // 兜底：模块缺失时仍能走动，便于定位问题
    const sin = Math.sin(player.yaw), cos = Math.cos(player.yaw);
    const speed = (input.sprint ? 7 : 4.5) * (player.flying ? 2.5 : 1);
    const fx = -sin, fz = -cos, rx = cos, rz = -sin;
    let mx = fx * (input.forward - input.back) + rx * (input.right - input.left);
    let mz = fz * (input.forward - input.back) + rz * (input.right - input.left);
    const len = Math.hypot(mx, mz) || 1;
    player.pos.x += (mx / len) * speed * dt * (len > 0.01 ? 1 : 0);
    player.pos.z += (mz / len) * speed * dt * (len > 0.01 ? 1 : 0);
  }

  function tick() {
    requestAnimationFrame(tick);
    const now = performance.now();
    let dt = (now - prev) / 1000;
    prev = now;
    if (dt > 0.1) dt = 0.1;             // 卡顿后别让物理一次跳太远
    fps = fps * 0.92 + (1 / Math.max(dt, 1e-4)) * 0.08;
    frame++;

    // 输入 → 物理
    updatePlayer(dt);

    // 掉出世界兜底
    if (player.pos.y < -10) {
      player.pos.y = 100;
      player.vel && (player.vel.y = 0);
    }

    // 相机
    const eye = eyePos();
    camera.position.set(eye.x, eye.y, eye.z);
    camera.rotation.set(player.pitch, player.yaw, 0);

    // 区块流式
    const budget = frame < 120 ? REMESH_BUDGET_STARTUP : REMESH_BUDGET_STEADY;
    streamChunks(budget);
    if (++unloadTimer % 90 === 0) unloadFarChunks();

    // 昼夜
    timeOfDay = (timeOfDay + dt / DAY_LENGTH) % 1;
    updateSky();

    // 挖掘 / 放置
    const hit = targetBlock();
    if (hit) {
      highlight.visible = true;
      highlight.position.set(hit.x + 0.5, hit.y + 0.5, hit.z + 0.5);

      const key = hit.x + ',' + hit.y + ',' + hit.z;
      if (key !== lastTargetKey) {
        lastTargetKey = key;
        if (breakProgress && typeof breakProgress.reset === 'function') breakProgress.reset();
      }

      if (mining) {
        let done = false;
        if (breakProgress) {
          try {
            breakProgress.update(dt, hit.block);
            done = typeof breakProgress.isDone === 'function' && breakProgress.isDone();
            const st = typeof breakProgress.stage === 'function' ? breakProgress.stage() : 0;
            crackEl.style.display = st > 0 ? 'block' : 'none';
            if (st > 0) crackEl.style.background = crackPattern(st);
          } catch (e) {
            done = true;    // 挖掘逻辑异常时直接破坏，别卡住
          }
        } else {
          done = true;
        }
        if (done) {
          breakBlockAt(hit);
          if (breakProgress && typeof breakProgress.reset === 'function') breakProgress.reset();
          crackEl.style.display = 'none';
        }
      } else {
        crackEl.style.display = 'none';
        if (breakProgress && typeof breakProgress.reset === 'function') breakProgress.reset();
      }

      if (placing) {
        placeBlockAt(hit);
        placing = false;                 // 按住不连发，一次点击放一块
      }
    } else {
      highlight.visible = false;
      crackEl.style.display = 'none';
    }

    // 生物
    if (mobManager && typeof mobManager.update === 'function') {
      try {
        mobManager.update(dt, world, player);
        if (typeof mobManager.spawn === 'function' && frame % 120 === 0) {
          mobManager.spawn(player.pos, world);
        }
        if (typeof mobManager.despawn === 'function' && frame % 180 === 0) {
          mobManager.despawn(player.pos, world);
        }
      } catch (e) { /* 生物更新失败不该拖垮整个游戏 */ }
    }
    syncMobs();

    // 音频听者跟随
    if (typeof SOUND.setListener === 'function') {
      try { SOUND.setListener(eye.x, eye.y, eye.z); } catch (e) {}
    }

    // 周期性存档
    if (++saveTimer % 600 === 0 && typeof SAVE.savePlayer === 'function') {
      try {
        SAVE.savePlayer({
          pos: [player.pos.x, player.pos.y, player.pos.z],
          yaw: player.yaw, pitch: player.pitch, flying: player.flying,
        });
      } catch (e) {}
    }

    // HUD
    if (now - hudTimer > 200) {
      hudTimer = now;
      const p = player.pos;
      debugEl.textContent =
        'VoxelCraft  ' + fps.toFixed(0) + ' fps\n' +
        'XYZ ' + p.x.toFixed(1) + ' / ' + p.y.toFixed(1) + ' / ' + p.z.toFixed(1) + '\n' +
        '区块 ' + world.chunks.size + '   模式 ' + (player.flying ? '飞行' : '生存') +
        (player.inWater ? '   游泳' : '') + '\n' +
        '时间 ' + (timeOfDay * 24).toFixed(1) + 'h   生物 ' + (mobManager && mobManager.mobs ? mobManager.mobs.length : 0);
    }

    // 后处理合成（Bloom + ACES 色调映射）；失败则退回直接渲染
    try {
      BloomFX.render(renderer, scene, camera);
    } catch (e) {
      if (!boot._bloomWarned) { boot._bloomWarned = true; console.warn('[engine] Bloom 渲染失败，已退回直出', e); }
      renderer.setRenderTarget(null);
      renderer.render(scene, camera);
    }
  }

  // 十级裂纹覆盖：用噪声纹理当破坏进度，不引入外部图片
  let crackCache = {};
  function crackPattern(stage) {
    if (crackCache[stage]) return crackCache[stage];
    const size = 16;
    const c = document.createElement('canvas');
    c.width = c.height = size;
    const x = c.getContext('2d');
    x.clearRect(0, 0, size, size);
    const density = stage / 9;
    const cx = size / 2, cy = size / 2;
    for (let i = 0; i < 4 + stage * 2; i++) {
      const a = (i / (4 + stage * 2)) * Math.PI * 2 + stage;
      x.strokeStyle = 'rgba(0,0,0,' + (0.35 + density * 0.45) + ')';
      x.lineWidth = 1;
      x.beginPath();
      x.moveTo(cx, cy);
      let px = cx, py = cy;
      const len = 2 + density * 6;
      for (let s = 0; s < 3; s++) {
        px += Math.cos(a + s * 0.4) * len / 3;
        py += Math.sin(a + s * 0.4) * len / 3;
        x.lineTo(px, py);
      }
      x.stroke();
    }
    const url = 'url(' + c.toDataURL() + ')';
    crackCache[stage] = url;
    return url;
  }

  /* ============================================================
   * 13. 启动
   * ============================================================ */
  function boot() {
    const missing = [];
    // 后处理渲染目标的尺寸必须与画布一致，否则 Bloom 会错位
    BloomFX.setSize(innerWidth * renderer.getPixelRatio(), innerHeight * renderer.getPixelRatio());
    if (!atlas) missing.push('贴图图集');
    if (!buildMeshFn) missing.push('区块网格 (VoxelChunk)');
    if (!raycastFn) missing.push('射线拾取 (VoxelRaycast)');
    if (typeof PlayerClass !== 'function') missing.push('玩家物理 (VoxelPlayer)');
    if (missing.length) {
      loadingText.style.color = '#ff9c6b';
      loadingText.textContent = '降级运行，缺失: ' + missing.join('、');
      console.warn('[engine] 缺失模块:', missing.join(', '));
    } else {
      loadingText.textContent = '就绪 · 渲染距离 ' + RENDER_DIST + ' 区块';
    }
    tick();
  }

  global.VoxelEngine = { scene, camera, renderer, world, player, inventory, atlas };
  boot();

})(window);
