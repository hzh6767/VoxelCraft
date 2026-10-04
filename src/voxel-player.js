// VoxelCraft — 玩家控制器 + AABB 物理
// 挂在 window.VoxelPlayer 上。纯逻辑，不涉及渲染和输入监听。
(function (global) {
  'use strict';

  const BLK = global.VoxelBlocks || { isSolid: (id) => id !== 0 && id !== 15, ID: { WATER: 15 } };
  const WATER = BLK.ID.WATER;

  class Player {
    constructor() {
      this.pos = new (global.THREE ? global.THREE.Vector3 : Object)();
      this.pos.x = 8; this.pos.y = 70; this.pos.z = 8;

      this.vel = new (global.THREE ? global.THREE.Vector3 : Object)();
      this.vel.x = 0; this.vel.y = 0; this.vel.z = 0;

      this.yaw = 0;
      this.pitch = 0;
      this.onGround = false;
      this.flying = false;
      this.sneaking = false;
      this.inWater = false;
      this.health = 20;
      this.air = 20;

      this.WIDTH = 0.3;   // 半宽
      this.HEIGHT = 1.8;
      this.EYE = 1.62;

      this.fallApex = this.pos.y;
    }

    update(dt, input, world) {
      const GRAVITY = 32;
      const JUMP_VEL = 8.6;
      const WALK = 4.3;
      const SPRINT = 5.6;
      const SNEAK = 1.3;
      const FLY_H = 10.9;
      const FLY_V = 7;
      const TERMINAL = -60;

      // 检测是否在水中
      this.inWater = false;
      for (let dy = 0; dy < this.HEIGHT; dy += 0.5) {
        const id = world.getBlock(Math.floor(this.pos.x), Math.floor(this.pos.y + dy), Math.floor(this.pos.z));
        if (id === WATER) {
          this.inWater = true;
          break;
        }
      }

      // 输入方向
      const fwd = (input.forward || 0) - (input.back || 0);
      const side = (input.right || 0) - (input.left || 0);

      let speed;
      if (this.flying) {
        speed = input.sprint ? 21 : FLY_H;
        this.vel.y = 0;
        if (input.jump) this.vel.y = FLY_V;
        if (input.sneak) this.vel.y = -FLY_V;
      } else {
        speed = input.sneak ? SNEAK : (input.sprint ? SPRINT : WALK);
        if (this.inWater) speed *= 0.5;

        // 重力
        this.vel.y -= GRAVITY * dt;
        if (this.vel.y < TERMINAL) this.vel.y = TERMINAL;

        // 跳跃 / 浮力
        if (input.jump) {
          if (this.onGround) this.vel.y = JUMP_VEL;
          else if (this.inWater) this.vel.y += GRAVITY * dt * 0.4;  // 浮力
        }

        // 水阻
        if (this.inWater) {
          this.vel.y *= 0.85;
        }
      }

      // 运动方向
      const sin = Math.sin(this.yaw), cos = Math.cos(this.yaw);
      const fx = -sin, fz = -cos;
      const rx = cos, rz = -sin;

      let mx = fx * fwd + rx * side;
      let mz = fz * fwd + rz * side;
      const len = Math.hypot(mx, mz) || 1;
      mx = (mx / len) * speed;
      mz = (mz / len) * speed;

      // 应用横向速度
      this.vel.x = mx;
      this.vel.z = mz;

      // 分轴碰撞
      this.moveAxis('y', this.vel.y * dt, world);
      this.moveAxis('x', this.vel.x * dt, world);
      this.moveAxis('z', this.vel.z * dt, world);

      // 掉落伤害
      if (!this.flying && !this.inWater) {
        if (this.vel.y > 0) this.fallApex = Math.max(this.fallApex, this.pos.y);
        if (this.onGround && this.fallApex - this.pos.y > 3) {
          const damage = Math.floor(this.fallApex - this.pos.y - 3);
          this.health -= damage;
          this.fallApex = this.pos.y;
        }
      } else {
        this.fallApex = this.pos.y;
      }

      // 掉出世界
      if (this.pos.y < -10) {
        this.pos.y = 100;
        this.vel.y = 0;
      }
    }

    moveAxis(axis, amount, world) {
      if (Math.abs(amount) < 0.001) {
        if (axis === 'y') this.onGround = false;
        return;
      }

      const step = amount > 0 ? 0.05 : -0.05;
      let remaining = amount;

      while (Math.abs(remaining) > 0.001) {
        const move = Math.abs(remaining) < Math.abs(step) ? remaining : step;
        this.pos[axis] += move;

        if (this.collides(world)) {
          this.pos[axis] -= move;

          // Step-up: 尝试台阶上移
          if (axis !== 'y' && !this.flying) {
            const oldY = this.pos.y;
            this.pos.y += 1.0;
            if (!this.collides(world)) {
              // 成功踩上
              remaining = 0;
              break;
            }
            this.pos.y = oldY;
          }

          if (axis === 'y') {
            if (this.vel.y < 0) this.onGround = true;
            this.vel.y = 0;
          }
          break;
        }
        remaining -= move;
      }

      if (axis === 'y' && remaining !== 0) this.onGround = false;
    }

    collides(world) {
      const W = this.WIDTH, H = this.HEIGHT;
      const x = this.pos.x, y = this.pos.y, z = this.pos.z;

      const x0 = Math.floor(x - W), x1 = Math.floor(x + W);
      const y0 = Math.floor(y), y1 = Math.floor(y + H - 0.01);
      const z0 = Math.floor(z - W), z1 = Math.floor(z + W);

      for (let bx = x0; bx <= x1; bx++) {
        for (let by = y0; by <= y1; by++) {
          for (let bz = z0; bz <= z1; bz++) {
            const id = world.getBlock(bx, by, bz);
            if (BLK.isSolid(id)) return true;
          }
        }
      }
      return false;
    }

    getEyePosition() {
      if (global.THREE && global.THREE.Vector3) {
        return new global.THREE.Vector3(this.pos.x, this.pos.y + this.EYE, this.pos.z);
      }
      return { x: this.pos.x, y: this.pos.y + this.EYE, z: this.pos.z };
    }

    getForward() {
      const sin = Math.sin(this.yaw), cos = Math.cos(this.yaw);
      const cosPitch = Math.cos(this.pitch), sinPitch = Math.sin(this.pitch);
      if (global.THREE && global.THREE.Vector3) {
        return new global.THREE.Vector3(-sin * cosPitch, sinPitch, -cos * cosPitch);
      }
      return { x: -sin * cosPitch, y: sinPitch, z: -cos * cosPitch };
    }
  }

  global.VoxelPlayer = { Player };
})(window);
