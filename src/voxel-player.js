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

      // null = "还没记录本段坠落的起点"。绝不能预设成出生高度：
      // engine 构造完玩家后会把 pos 挪到地表（约 60 格），而 70 这个陈旧值
      // 会让玩家开局第一次落地就被判成从 70 格摔下，白掉 7 点血。
      this.fallApex = null;
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
          // 浮力必须严格大于重力，否则按住空格仍然只会一直下沉。
          // 之前是 0.4×重力，净效果 -0.6×重力，游泳上浮不可能。
          else if (this.inWater) this.vel.y += GRAVITY * dt * 1.25;
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

      // 分轴碰撞。每帧重置台阶标记：x 和 z 走同一条 moveAxis，
      // 不限制的话一次移动能借两轴上 2 格。
      this._steppedThisFrame = false;
      this.moveAxis('y', this.vel.y * dt, world);
      this.moveAxis('x', this.vel.x * dt, world);
      this.moveAxis('z', this.vel.z * dt, world);

      // 掉落伤害
      if (!this.flying && !this.inWater) {
        if (this.fallApex === null) this.fallApex = this.pos.y;
        if (this.vel.y > 0) this.fallApex = Math.max(this.fallApex, this.pos.y);
        if (this.onGround) {
          // 站定 = 这一段落到底，先结算伤害，再把顶点无条件同步到脚下。
          // 原来只在"确实要扣血"的分支里同步，于是顶点会一直停在历史最高点：
          // 出生时构造函数把它设成 70，而实际出生高度是地表（约 60），
          // 玩家一落地就被判定"从 70 格摔下来"，凭空掉 7 点血；
          // 从高处落地后走平地也会持续掉血。这是必须无条件重置的原因。
          if (this.fallApex - this.pos.y > 3) {
            const damage = Math.floor(this.fallApex - this.pos.y - 3);
            this.health -= damage;
          }
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
      // 早退必须在清 onGround 之前：站着不动时每帧重力位移是 32*dt*dt，
      // 在 >179Hz 的显示器上会小于 0.001 而直接从这一行返回，
      // 若先清了 onGround 就再也置不回来 —— 高刷屏上完全无法起跳。
      if (Math.abs(amount) < 0.001) return;
      if (axis === 'y') this.onGround = false;

      const step = amount > 0 ? 0.05 : -0.05;
      let remaining = amount;

      while (Math.abs(remaining) > 0.001) {
        const move = Math.abs(remaining) < Math.abs(step) ? remaining : step;
        this.pos[axis] += move;

        if (this.collides(world)) {
          this.pos[axis] -= move;

          // 自动上台阶。四个条件缺一不可：
          //   1. 横向移动、人确实站在实地上 —— 少了这条，坠落时每帧都会往上蹭一格，
          //      贴着墙往下掉反而会爬到墙顶，表现为"瞬移上去很多格"。
          //   2. 每帧只上 1 次（_steppedThisFrame），否则 x 和 z 两轴会各上 1 格。
          //   3. 抬升高度固定为脚下格的顶面 + 1，也就是只上得去 1 格。
          //   4. 抬升之后必须真的能往前挪出去 —— 这条最关键：少了它，
          //      人物贴在任何高度的墙面上都会逐帧各升 1 格（60 格/秒），
          //      看起来就是瞬移爬到墙顶。有了它，2 格及更高的墙在抬升后依然撞墙，
          //      整个上台阶动作被否决；只有真正的 1 格台阶能过。
          if (axis !== 'y' && !this.flying && this.onGround && !this._steppedThisFrame) {
            const oldY = this.pos.y;
            this.pos.y = Math.floor(this.pos.y + 1e-3) + 1;
            if (!this.collides(world)) {
              this.pos[axis] += move;                  // 补上刚被回退的横向位移
              if (!this.collides(world)) {
                this._steppedThisFrame = true;
                remaining -= move;                     // 正常消耗掉这一步，继续往前走
                continue;
              }
              this.pos[axis] -= move;
            }
            this.pos.y = oldY;
          }

          if (axis === 'y') {
            // 向下被挡住 = 站在地面上。
            // 这里绝不能在函数末尾再说 "remaining !== 0 就清掉 onGround"：
            // 碰撞分支是 break 出去的，remaining 必然非零，那样等于永远站不住，
            // 跳跃和坠落伤害都会失效。
            if (this.vel.y <= 0) this.onGround = true;
            this.vel.y = 0;
          }
          break;
        }
        remaining -= move;
      }
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
