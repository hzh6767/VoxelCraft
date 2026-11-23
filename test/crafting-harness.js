'use strict';
const assert = require('node:assert/strict');
global.window = {};
require('../src/voxel-blocks.js');
require('../src/voxel-inventory.js');

const { OAK_LOG, OAK_PLANKS, SAND, GLASS, SANDSTONE } = window.VoxelBlocks.ID;
const { matchRecipe } = window.VoxelInventory;
assert.deepEqual(matchRecipe([0, OAK_LOG, 0, 0], 2), { id: OAK_PLANKS, count: 4 });
assert.equal(matchRecipe([OAK_LOG, 0, OAK_LOG, 0], 2), null);
assert.equal(matchRecipe([OAK_LOG, 0, SAND, 0], 2), null);
assert.deepEqual(matchRecipe([0, 0, SAND, 0], 2), { id: GLASS, count: 1 });
assert.deepEqual(matchRecipe([SAND, SAND, SAND, SAND], 2), { id: SANDSTONE, count: 4 });
console.log('Crafting ingredient checks passed');
