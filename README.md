# VoxelCraft

一个离线运行的体素沙盒游戏，用 Electron + three.js 构建。

**所有贴图、音效、地形都在运行时程序化生成**，不包含任何第三方美术资源。

---

## 直接运行

从 [Releases](../../releases) 下载 `VoxelCraft.exe`，双击即可。无需安装 Node 或任何依赖。

## 从源码运行

```bash
npm install
npm start
```

## 打包为 exe

```bash
npm run dist
```

产物在 `dist/`：便携版 `VoxelCraft <version>.exe` 和安装版 `VoxelCraft Setup <version>.exe`。

---

## 操作

| 按键 | 功能 |
|---|---|
| `W` `A` `S` `D` | 移动 |
| `空格` | 跳跃 / 游泳时上浮 |
| `Shift` | 潜行 / 加速 |
| `鼠标左键` | 挖掘 |
| `鼠标右键` | 放置 |
| `鼠标中键` | 取方块 |
| `1`–`9` / `滚轮` | 切换手持方块 |
| `F` | 切换飞行 |
| `F11` | 全屏 |
| `ESC` | 释放鼠标 / 暂停 |

---

## 特性

**世界**
- 无限地形，按玩家位置流式加载区块（渲染距离 8 区块）
- 6 种生物群系：海洋、平原、沙漠、森林、雪原、丘陵
- 3D 噪声洞穴、按深度分带的矿脉（煤/铁/金/红石/青金石/钻石/绿宝石）
- 树木、草、花、水边甘蔗；世界高度 128，海平面 56

**渲染**
- 逐顶点环境光遮蔽（smooth lighting），带四顶点翻转以消除对角接缝
- 16 档 AO 亮度曲线，避免暗部色带
- 天光 + 方块光双通道光照，荧石发光
- 昼夜循环，六个色温关键帧（黎明橙红 → 正午纯白 → 黄昏深蓝 → 深夜冷蓝）
- Bloom 后处理 + ACES 色调映射（自实现，不依赖 three.js examples）
- 独立的透明通道：水、玻璃、十字形植物

**玩法**
- AABB 分轴碰撞、自动上台阶、游泳浮力、坠落伤害
- 基于硬度的挖掘进度与十级裂纹反馈
- 36 格背包、快捷栏、2×2/3×3 合成
- 被动生物（猪）与敌对生物（僵尸），AABB 碰撞与追击 AI
- 存档：IndexedDB 记录玩家改动，localStorage 记录玩家状态

**音频**
- 全部由 WebAudio 合成：脚步声、破坏声、放置声、受伤声、水花声，按材质区分音色

---

## 项目结构

```
main.js                  Electron 外壳：建窗、单实例锁、F11
src/index.html           页面与模块加载顺序
src/textures.js          程序化贴图图集
src/voxel-blocks.js      方块注册表（40 种）
src/voxel-worldgen.js    地形生成（确定性）
src/voxel-chunk.js       区块存储 + AO 网格构建
src/voxel-light.js       天光 / 方块光传播
src/voxel-player.js      玩家物理
src/voxel-raycast.js     DDA 射线拾取 + 挖掘/放置规则
src/voxel-inventory.js   背包 + 合成
src/voxel-mobs.js        生物 AI
src/voxel-sound.js       WebAudio 音效合成
src/voxel-save.js        存档
src/engine.js            粘合层：场景、装配、主循环、后处理、UI
```

每个模块是一个普通 `<script>`，只挂一个全局，互不引用内部实现。

---

## 设计约束

- **完全离线**：three.js 是本地副本，运行时不联网
- **确定性地形**：同一个区块坐标永远生成逐字节相同的结果（区块随玩家走动惰性生成，不能前后不一致）
- **增量光照**：改一个方块只做局部 BFS 增删，不重算整个世界
- **预算化重建**：每帧最多重建 2 个区块（开场 12 个），避免卡顿

---

## 授权与素材说明

代码以 MIT 授权发布。

贴图与音效均为**程序化生成**（canvas 逐像素绘制 / WebAudio 合成），未使用 Minecraft 或任何其他游戏的素材。
本项目在视觉语言上参考了体素沙盒游戏这一类型，但所有资源都是原创生成的，不包含任何受版权保护的第三方内容。
