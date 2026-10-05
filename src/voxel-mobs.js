// VoxelCraft — 生物 AI + 管理器
// 挂在 window.VoxelMobs 上。纯逻辑，引擎读取状态并渲染成方块。
(function (global) {
  'use strict';

  const BLK = global.VoxelBlocks || { isSolid: (id) => id !== 0 && id !== 15, ID: { WATER: 15 } };
  const V3 = global.THREE && global.THREE.Vector3 ? global.THREE.Vector3 : class { constructor(x, y, z) { this.x = x || 0; this.y = y || 0; this.z = z || 0; } };

  const TYPES = {
    pig: { passive: true, width: 0.9, height: 0.9, health: 10, speed: 2.0 },
    zombie: { hostile: true, width: 0.6, height: 1.8, health: 20, speed: 2.4, damage: 2, cooldown: 1.0, range: 1.6 },
  };

  class Mob {
    constructor(type, pos) {
      this.type = type;
      const cfg = TYPES[type];
      this.pos = new V3(pos.x, pos.y, pos.z);
      this.vel = new V3();
      this.yaw = Math.random() * Math.PI * 2;
      this.health = cfg.health;
      this.alive = true;
      this.onGround = false;
      this.width = cfg.width;
      this.height = cfg.height;

      this.aiTimer = 0;
      this.aiTarget = null;
      this.attackCooldown = 0;
      this.path = null;
    }

    update(dt, world, player) {
      if (!this.alive) return;

      const cfg = TYPES[this.type];
      const GRAVITY = 32;
      const TERMINAL = -60;

      // 重力
      this.vel.y -= GRAVITY * dt;
      if (this.vel.y < TERMINAL) this.vel.y = TERMINAL;

      // AI
      this.aiTimer += dt;
      if (cfg.passive) {
        this.updatePassiveAI(dt, world);
      } else if (cfg.hostile) {
        this.updateHostileAI(dt, world, player);
      }

      // 碰撞分轴
      this.moveAxis('y', this.vel.y * dt, world);
      this.moveAxis('x', this.vel.x * dt, world);
      this.moveAxis('z', this.vel.z * dt, world);

      // 掉出世界
      if (this.pos.y < -10) this.alive = false;
    }

    updatePassiveAI(dt, world) {
      const cfg = TYPES[this.type];
      if (this.aiTimer > 3 + Math.random() * 3) {
        this.aiTimer = 0;
        this.yaw = Math.random() * Math.PI * 2;
      }

      const sin = Math.sin(this.yaw), cos = Math.cos(this.yaw);
      const ahead = world.getBlock(Math.floor(this.pos.x - sin), Math.floor(this.pos.y - 1), Math.floor(this.pos.z - cos));
      if (!BLK.isSolid(ahead)) {
        // 前方是悬崖，转向
        this.yaw += Math.PI * 0.5;
      } else {
        this.vel.x = -sin * cfg.speed;
        this.vel.z = -cos * cfg.speed;
      }
    }

    updateHostileAI(dt, world, player) {
      const cfg = TYPES[this.type];
      this.attackCooldown -= dt;

      const dx = player.pos.x - this.pos.x;
      const dy = player.pos.y - this.pos.y;
      const dz = player.pos.z - this.pos.z;
      const dist = Math.hypot(dx, dy, dz);
      const distXZ = Math.hypot(dx, dz);

      if (dist < 24 && Math.abs(dy) < 6) {
        // 追击
        if (distXZ < cfg.range && this.attackCooldown <= 0) {
          // 攻击
          player.health -= cfg.damage;
          this.attackCooldown = cfg.cooldown;
        } else {
          // 朝玩家移动
          this.yaw = Math.atan2(-dx, -dz);
          const sin = Math.sin(this.yaw), cos = Math.cos(this.yaw);
          this.vel.x = -sin * cfg.speed;
          this.vel.z = -cos * cfg.speed;
        }
      } else {
        // 闲逛
        if (this.aiTimer > 2) {
          this.aiTimer = 0;
          this.yaw = Math.random() * Math.PI * 2;
        }
        const sin = Math.sin(this.yaw), cos = Math.cos(this.yaw);
        this.vel.x = -sin * cfg.speed * 0.3;
        this.vel.z = -cos * cfg.speed * 0.3;
      }
    }

    moveAxis(axis, amount, world) {
      if (axis === 'y') this.onGround = false;

      if (Math.abs(amount) < 0.001) return;

      const step = amount > 0 ? 0.05 : -0.05;
      let remaining = amount;

      while (Math.abs(remaining) > 0.001) {
        const move = Math.abs(remaining) < Math.abs(step) ? remaining : step;
        this.pos[axis] += move;

        if (this.collides(world)) {
          this.pos[axis] -= move;
          if (axis === 'y') {
            // 同 voxel-player.js 的修正：先清零、只在向下被挡住时置真，
            // 不能再用 "remaining !== 0 就清掉"（碰撞分支必然 break，remaining 恒非零）。
            if (this.vel.y <= 0) this.onGround = true;
            this.vel.y = 0;
          }
          break;
        }
        remaining -= move;
      }
    }

    collides(world) {
      const W = this.width / 2, H = this.height;
      const x0 = Math.floor(this.pos.x - W), x1 = Math.floor(this.pos.x + W);
      const y0 = Math.floor(this.pos.y), y1 = Math.floor(this.pos.y + H - 0.01);
      const z0 = Math.floor(this.pos.z - W), z1 = Math.floor(this.pos.z + W);

      for (let bx = x0; bx <= x1; bx++) {
        for (let by = y0; by <= y1; by++) {
          for (let bz = z0; bz <= z1; bz++) {
            if (BLK.isSolid(world.getBlock(bx, by, bz))) return true;
          }
        }
      }
      return false;
    }

    damage(n) {
      this.health -= n;
      if (this.health <= 0) this.alive = false;
    }
  }

  class MobManager {
    constructor() {
      this.mobs = [];
    }

    update(dt, world, player) {
      for (const mob of this.mobs) {
        mob.update(dt, world, player);
      }
      this.mobs = this.mobs.filter(m => m.alive);
    }

    spawn(playerPos, world) {
      if (this.mobs.length >= 20) return;

      // 随机位置，远离玩家
      for (let tries = 0; tries < 5; tries++) {
        const angle = Math.random() * Math.PI * 2;
        const dist = 16 + Math.random() * 16;
        const x = playerPos.x + Math.cos(angle) * dist;
        const z = playerPos.z + Math.sin(angle) * dist;
        const y = 64;  // 简化：固定高度

        const id = world.getBlock(Math.floor(x), Math.floor(y), Math.floor(z));
        if (id === 2 || id === 3) {  // 草地或泥土
          const type = Math.random() > 0.3 ? 'pig' : 'zombie';
          this.mobs.push(new Mob(type, { x, y: y + 1, z }));
          break;
        }
      }
    }

    despawn(farFrom) {
      this.mobs = this.mobs.filter(m => {
        const dx = m.pos.x - farFrom.x, dz = m.pos.z - farFrom.z;
        return Math.hypot(dx, dz) < 72;
      });
    }
  }

  global.VoxelMobs = { Mob, MobManager, TYPES };
})(window);
