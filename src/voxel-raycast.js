// VoxelCraft — 体素射线 DDA + 挖掘/放置逻辑
// 挂在 window.VoxelRaycast 上。纯逻辑。
(function (global) {
  'use strict';

  const BLK = global.VoxelBlocks || {
    isSolid: (id) => id !== 0 && id !== 15,
    isCross: () => false,
    hardnessOf: () => 1,
    ID: { AIR: 0, WATER: 15, BEDROCK: 6 },
  };

  /* ============================================================
   * DDA 射线投射
   * ============================================================ */
  function raycast(origin, dir, maxDist, world, includeWater) {
    let x = Math.floor(origin.x);
    let y = Math.floor(origin.y);
    let z = Math.floor(origin.z);

    const stepX = dir.x > 0 ? 1 : (dir.x < 0 ? -1 : 0);
    const stepY = dir.y > 0 ? 1 : (dir.y < 0 ? -1 : 0);
    const stepZ = dir.z > 0 ? 1 : (dir.z < 0 ? -1 : 0);

    const tDeltaX = stepX !== 0 ? Math.abs(1 / dir.x) : Infinity;
    const tDeltaY = stepY !== 0 ? Math.abs(1 / dir.y) : Infinity;
    const tDeltaZ = stepZ !== 0 ? Math.abs(1 / dir.z) : Infinity;

    let tMaxX = stepX > 0 ? ((x + 1) - origin.x) / dir.x : (stepX < 0 ? (x - origin.x) / dir.x : Infinity);
    let tMaxY = stepY > 0 ? ((y + 1) - origin.y) / dir.y : (stepY < 0 ? (y - origin.y) / dir.y : Infinity);
    let tMaxZ = stepZ > 0 ? ((z + 1) - origin.z) / dir.z : (stepZ < 0 ? (z - origin.z) / dir.z : Infinity);

    let nx = 0, ny = 0, nz = 0;
    let dist = 0;

    for (let i = 0; i < 200; i++) {
      if (dist > maxDist) break;

      const id = world.getBlock(x, y, z);
      if (BLK.isCross(id)) {
        // 十字植物不可拾取
      } else if (id === BLK.ID.WATER && !includeWater) {
        // 水默认穿透
      } else if (id !== BLK.ID.AIR) {
        return { x, y, z, nx, ny, nz, block: id };
      }

      if (tMaxX < tMaxY && tMaxX < tMaxZ) {
        x += stepX; tMaxX += tDeltaX; dist = tMaxX;
        nx = -stepX; ny = 0; nz = 0;
      } else if (tMaxY < tMaxZ) {
        y += stepY; tMaxY += tDeltaY; dist = tMaxY;
        nx = 0; ny = -stepY; nz = 0;
      } else {
        z += stepZ; tMaxZ += tDeltaZ; dist = tMaxZ;
        nx = 0; ny = 0; nz = -stepZ;
      }
    }
    return null;
  }

  /* ============================================================
   * 挖掘进度
   * ============================================================ */
  class BreakProgress {
    constructor() {
      this.progress = 0;
      this.targetId = null;
    }

    update(dt, blockId) {
      if (blockId !== this.targetId) this.reset();
      this.targetId = blockId;

      const hardness = BLK.hardnessOf(blockId);
      if (hardness === Infinity) return;  // 基岩
      if (hardness === 0) {
        this.progress = 1;
        return;
      }

      this.progress += dt / hardness;
      if (this.progress > 1) this.progress = 1;
    }

    isDone() {
      return this.progress >= 1;
    }

    stage() {
      return Math.floor(this.progress * 10);
    }

    reset() {
      this.progress = 0;
      this.targetId = null;
    }
  }

  /* ============================================================
   * 放置检查
   * ============================================================ */
  function canPlaceAt(id, x, y, z, world, player) {
    if (y < 0 || y >= 128) return false;

    const target = world.getBlock(x, y, z);
    if (target !== BLK.ID.AIR && target !== BLK.ID.WATER) return false;

    // 十字植物需要固体地面
    if (BLK.isCross(id)) {
      const below = world.getBlock(x, y - 1, z);
      if (!BLK.isSolid(below)) return false;
    }

    // AABB 碰撞检测
    const px = player.pos.x, py = player.pos.y, pz = player.pos.z;
    const W = player.WIDTH || 0.3, H = player.HEIGHT || 1.8;

    const dx = Math.abs(px - (x + 0.5));
    const dz = Math.abs(pz - (z + 0.5));
    if (dx < W + 0.5 && dz < W + 0.5 && py < y + 1 && py + H > y) {
      return false;
    }

    return true;
  }

  global.VoxelRaycast = {
    raycast,
    BreakProgress,
    canPlaceAt,
  };
})(window);
