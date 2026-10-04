// VoxelCraft — 背包 + 合成
// 挂在 window.VoxelInventory 上。纯数据，不涉及 UI 渲染。
(function (global) {
  'use strict';

  const B = (global.VoxelBlocks && global.VoxelBlocks.ID) || {};

  class Inventory {
    constructor() {
      this.slots = Array(36).fill(null);  // 0..8 hotbar, 9..35 main
      this.selected = 0;
    }

    add(id, count) {
      let leftover = count;
      // 先堆叠到现有的部分栈
      for (let i = 0; i < this.slots.length && leftover > 0; i++) {
        const slot = this.slots[i];
        if (slot && slot.id === id && slot.count < 64) {
          const add = Math.min(leftover, 64 - slot.count);
          slot.count += add;
          leftover -= add;
        }
      }
      // 再占用空槽
      for (let i = 0; i < this.slots.length && leftover > 0; i++) {
        if (!this.slots[i]) {
          const add = Math.min(leftover, 64);
          this.slots[i] = { id, count: add };
          leftover -= add;
        }
      }
      return leftover;
    }

    removeOne(i) {
      if (!this.slots[i]) return null;
      const slot = this.slots[i];
      slot.count--;
      if (slot.count <= 0) {
        this.slots[i] = null;
      }
      return slot.id;
    }

    swap(a, b) {
      const t = this.slots[a];
      this.slots[a] = this.slots[b];
      this.slots[b] = t;
    }

    selectHotbar(i) {
      this.selected = ((i % 9) + 9) % 9;
    }

    getSelected() {
      return this.slots[this.selected];
    }

    countOf(id) {
      let n = 0;
      for (const slot of this.slots) {
        if (slot && slot.id === id) n += slot.count;
      }
      return n;
    }
  }

  /* ============================================================
   * 合成配方
   * ============================================================ */
  const RECIPES = [
    // 木板系列
    { input: [[B.OAK_LOG]], output: { id: B.OAK_PLANKS, count: 4 }, shapeless: true },
    { input: [[B.SPRUCE_LOG]], output: { id: B.SPRUCE_PLANKS, count: 4 }, shapeless: true },
    { input: [[B.BIRCH_LOG]], output: { id: B.OAK_PLANKS, count: 4 }, shapeless: true },

    // 工作台
    { input: [[B.OAK_PLANKS, B.OAK_PLANKS], [B.OAK_PLANKS, B.OAK_PLANKS]], output: { id: B.CRAFTING_TABLE, count: 1 } },

    // 建材
    { input: [[B.STONE, B.STONE], [B.STONE, B.STONE]], output: { id: B.STONE_BRICKS, count: 4 } },
    { input: [[B.CLAY, B.CLAY], [B.CLAY, B.CLAY]], output: { id: B.BRICKS, count: 4 } },
    { input: [[B.SAND, B.SAND], [B.SAND, B.SAND]], output: { id: B.SANDSTONE, count: 4 } },

    // 简化合成
    { input: [[B.SAND]], output: { id: B.GLASS, count: 1 }, shapeless: true },
    { input: [[B.COBBLESTONE]], output: { id: B.STONE, count: 1 }, shapeless: true },
    { input: [[B.ICE]], output: { id: B.SNOW, count: 4 }, shapeless: true },
    { input: [[B.GOLD_ORE, B.GOLD_ORE], [B.GOLD_ORE, B.GOLD_ORE]], output: { id: B.GLOWSTONE, count: 1 } },
  ];

  function matchRecipe(gridArray, size) {
    for (const recipe of RECIPES) {
      if (recipe.shapeless) {
        const needed = {};
        for (const row of recipe.input) {
          for (const id of row) {
            if (id) needed[id] = (needed[id] || 0) + 1;
          }
        }
        const have = {};
        for (const id of gridArray) {
          if (id) have[id] = (have[id] || 0) + 1;
        }
        let match = true;
        for (const id in needed) {
          if ((have[id] || 0) < needed[id]) { match = false; break; }
        }
        for (const id in have) {
          if (!needed[id]) { match = false; break; }
        }
        if (match) return recipe.output;
      } else {
        // 形状匹配
        const rh = recipe.input.length, rw = recipe.input[0].length;
        if (rh > size || rw > size) continue;

        for (let dy = 0; dy <= size - rh; dy++) {
          for (let dx = 0; dx <= size - rw; dx++) {
            let match = true;
            for (let ry = 0; ry < rh; ry++) {
              for (let rx = 0; rx < rw; rx++) {
                const expected = recipe.input[ry][rx] || 0;
                const actual = gridArray[(dy + ry) * size + (dx + rx)] || 0;
                if (expected !== actual) { match = false; break; }
              }
              if (!match) break;
            }
            if (match) {
              // 确保周围是空的
              let clean = true;
              for (let gy = 0; gy < size; gy++) {
                for (let gx = 0; gx < size; gx++) {
                  if (gy >= dy && gy < dy + rh && gx >= dx && gx < dx + rw) continue;
                  if (gridArray[gy * size + gx]) { clean = false; break; }
                }
                if (!clean) break;
              }
              if (clean) return recipe.output;
            }
          }
        }
      }
    }
    return null;
  }

  global.VoxelInventory = { Inventory, RECIPES, matchRecipe };
})(window);
