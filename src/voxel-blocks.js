/* VoxelCraft — block registry (single source of truth)
 * Plain <script>, attaches exactly one global: window.VoxelBlocks
 * No modules, no network. Tile names MUST exist in window.VoxelTextures.DEFAULT_ORDER.
 *
 * tiles array order is [+x, -x, +y, -y, +z, -z]
 * DEF keys are the numeric block ids; ids are fixed by the project contract.
 */
(function (global) {
  "use strict";

  /* ---- Block ids (do not renumber) ---- */
  var ID = {
    AIR: 0,
    STONE: 1,
    GRASS: 2,
    DIRT: 3,
    COBBLESTONE: 4,
    MOSSY_COBBLE: 5,
    BEDROCK: 6,
    OAK_LOG: 7,
    OAK_LEAVES: 8,
    OAK_PLANKS: 9,
    SPRUCE_LOG: 10,
    SPRUCE_LEAVES: 11,
    SNOW: 12,
    GLASS: 13,
    ICE: 14,
    WATER: 15,
    SAND: 16,
    GRAVEL: 17,
    SNOW_GRASS: 18,
    COAL_ORE: 19,
    IRON_ORE: 20,
    GOLD_ORE: 21,
    DIAMOND_ORE: 22,
    REDSTONE_ORE: 23,
    LAPIS_ORE: 24,
    BRICKS: 25,
    STONE_BRICKS: 26,
    GLOWSTONE: 27,
    OBSIDIAN: 28,
    CRAFTING_TABLE: 29,
    EMERALD_ORE: 30,
    TALL_GRASS: 31,
    FLOWER_RED: 32,
    FLOWER_YELLOW: 33,
    SUGAR_CANE: 34,
    SANDSTONE: 35,
    BIRCH_LOG: 36,
    SPRUCE_PLANKS: 37,
    CLAY: 38,
    PUMPKIN: 39
  };

  /* Handy shorthands for the six faces. */
  function all(t) { return [t, t, t, t, t, t]; }
  /* column(t): same tile on all four vertical sides. */
  function column(t) { return [t, t, t, t, t, t]; }
  /* pillared(side, top): sides = side, +y/-y = top. */
  function pillared(side, top) { return [side, side, top, top, side, side]; }

  var DEF = {};

  function def(id, name, tiles, o) {
    o = o || {};
    DEF[id] = {
      id: id,
      name: name,
      tiles: tiles,
      opaque: o.opaque === undefined ? true : !!o.opaque,
      hardness: o.hardness === undefined ? 1 : o.hardness,
      tool: o.tool || "none",
      cross: !!o.cross,
      sound: o.sound || "stone"
    };
    return DEF[id];
  }

  /* ---- Non-solid / special ---- */
  def(ID.AIR, "air", [null, null, null, null, null, null],
    { opaque: false, hardness: 0, tool: "none", cross: false, sound: "none" });

  /* ---- Stone family ---- */
  def(ID.STONE, "stone", all("stone"),
    { opaque: true, hardness: 1.5, tool: "pickaxe", sound: "stone" });
  def(ID.COBBLESTONE, "cobblestone", all("cobblestone"),
    { opaque: true, hardness: 2.0, tool: "pickaxe", sound: "stone" });
  def(ID.MOSSY_COBBLE, "mossy_cobblestone", all("mossy_cobblestone"),
    { opaque: true, hardness: 2.0, tool: "pickaxe", sound: "stone" });
  def(ID.BEDROCK, "bedrock", all("bedrock"),
    { opaque: true, hardness: Infinity, tool: "none", sound: "stone" });
  def(ID.OBSIDIAN, "obsidian", all("obsidian"),
    { opaque: true, hardness: 50, tool: "pickaxe", sound: "stone" });
  def(ID.STONE_BRICKS, "stone_bricks", all("stone_bricks"),
    { opaque: true, hardness: 1.5, tool: "pickaxe", sound: "stone" });
  def(ID.BRICKS, "bricks", all("bricks"),
    { opaque: true, hardness: 2.0, tool: "pickaxe", sound: "stone" });
  def(ID.SANDSTONE, "sandstone", pillared("sandstone_side", "sandstone_top"),
    { opaque: true, hardness: 0.8, tool: "pickaxe", sound: "stone" });
  def(ID.GLOWSTONE, "glowstone", all("glowstone"),
    { opaque: true, hardness: 0.3, tool: "none", sound: "glass" });

  /* ---- Ores (all stone sound + pickaxe, hardness 3.0) ---- */
  def(ID.COAL_ORE, "coal_ore", all("coal_ore"),
    { opaque: true, hardness: 3.0, tool: "pickaxe", sound: "stone" });
  def(ID.IRON_ORE, "iron_ore", all("iron_ore"),
    { opaque: true, hardness: 3.0, tool: "pickaxe", sound: "stone" });
  def(ID.GOLD_ORE, "gold_ore", all("gold_ore"),
    { opaque: true, hardness: 3.0, tool: "pickaxe", sound: "stone" });
  def(ID.DIAMOND_ORE, "diamond_ore", all("diamond_ore"),
    { opaque: true, hardness: 3.0, tool: "pickaxe", sound: "stone" });
  def(ID.REDSTONE_ORE, "redstone_ore", all("redstone_ore"),
    { opaque: true, hardness: 3.0, tool: "pickaxe", sound: "stone" });
  def(ID.LAPIS_ORE, "lapis_ore", all("lapis_ore"),
    { opaque: true, hardness: 3.0, tool: "pickaxe", sound: "stone" });
  def(ID.EMERALD_ORE, "emerald_ore", all("emerald_ore"),
    { opaque: true, hardness: 3.0, tool: "pickaxe", sound: "stone" });

  /* ---- Soils / soft ground ---- */
  def(ID.DIRT, "dirt", all("dirt"),
    { opaque: true, hardness: 0.5, tool: "shovel", sound: "dirt" });
  def(ID.GRASS, "grass", [ "grass_side", "grass_side", "grass_top", "dirt", "grass_side", "grass_side" ],
    { opaque: true, hardness: 0.6, tool: "shovel", sound: "grass" });
  def(ID.SNOW_GRASS, "snow_grass", [ "grass_side", "grass_side", "grass_top_snow", "dirt", "grass_side", "grass_side" ],
    { opaque: true, hardness: 0.6, tool: "shovel", sound: "grass" });
  def(ID.SAND, "sand", all("sand"),
    { opaque: true, hardness: 0.5, tool: "shovel", sound: "sand" });
  def(ID.GRAVEL, "gravel", all("gravel"),
    { opaque: true, hardness: 0.6, tool: "shovel", sound: "sand" });
  def(ID.CLAY, "clay", all("clay"),
    { opaque: true, hardness: 0.6, tool: "shovel", sound: "dirt" });
  def(ID.SNOW, "snow", all("snow"),
    { opaque: true, hardness: 0.2, tool: "shovel", sound: "sand" });

  /* ---- Wood ---- */
  def(ID.OAK_LOG, "oak_log", pillared("oak_log_side", "oak_log_top"),
    { opaque: true, hardness: 2.0, tool: "axe", sound: "wood" });
  def(ID.SPRUCE_LOG, "spruce_log", pillared("spruce_log_side", "oak_log_top"),
    { opaque: true, hardness: 2.0, tool: "axe", sound: "wood" });
  def(ID.BIRCH_LOG, "birch_log", pillared("birch_log_side", "oak_log_top"),
    { opaque: true, hardness: 2.0, tool: "axe", sound: "wood" });
  def(ID.OAK_PLANKS, "oak_planks", all("oak_planks"),
    { opaque: true, hardness: 2.0, tool: "axe", sound: "wood" });
  def(ID.SPRUCE_PLANKS, "spruce_planks", all("spruce_planks"),
    { opaque: true, hardness: 2.0, tool: "axe", sound: "wood" });
  def(ID.CRAFTING_TABLE, "crafting_table",
    [ "oak_planks", "oak_planks", "crafting_top", "oak_planks", "oak_planks", "oak_planks" ],
    { opaque: true, hardness: 2.5, tool: "axe", sound: "wood" });

  /* ---- Leaves (solid to stand on, but not opaque) ---- */
  def(ID.OAK_LEAVES, "oak_leaves", all("oak_leaves"),
    { opaque: false, hardness: 0.2, tool: "none", sound: "grass" });
  def(ID.SPRUCE_LEAVES, "spruce_leaves", all("spruce_leaves"),
    { opaque: false, hardness: 0.2, tool: "none", sound: "grass" });

  /* ---- Translucent / transparent (still solid unless noted) ---- */
  def(ID.GLASS, "glass", all("glass"),
    { opaque: false, hardness: 0.3, tool: "none", sound: "glass" });
  def(ID.ICE, "ice", all("ice"),
    { opaque: false, hardness: 0.5, tool: "pickaxe", sound: "glass" });
  def(ID.WATER, "water", all("water"),
    { opaque: false, hardness: 100, tool: "none", sound: "none" });

  /* ---- Cross-shaped plants (never solid, never opaque) ---- */
  def(ID.TALL_GRASS, "tall_grass", all("tall_grass"),
    { opaque: false, hardness: 0, tool: "none", cross: true, sound: "grass" });
  def(ID.FLOWER_RED, "flower_red", all("flower_red"),
    { opaque: false, hardness: 0, tool: "none", cross: true, sound: "grass" });
  def(ID.FLOWER_YELLOW, "flower_yellow", all("flower_yellow"),
    { opaque: false, hardness: 0, tool: "none", cross: true, sound: "grass" });
  def(ID.SUGAR_CANE, "sugar_cane", all("sugar_cane"),
    { opaque: false, hardness: 0, tool: "none", cross: true, sound: "grass" });

  /* ---- Misc full blocks ---- */
  def(ID.PUMPKIN, "pumpkin", all("pumpkin_side"),
    { opaque: true, hardness: 1.0, tool: "axe", sound: "wood" });

  /* ---- Name -> id lookup (built from DEF, so it can never drift) ---- */
  var ID_BY_NAME = {};
  for (var k in DEF) {
    if (Object.prototype.hasOwnProperty.call(DEF, k)) ID_BY_NAME[DEF[k].name] = DEF[k].id;
  }

  /* ---- Flat, de-duplicated list of every tile name referenced above.
   * Order = first appearance. AIR contributes nothing (all faces null).
   * This is what the atlas builder should be fed. ---- */
  var TILE_NAMES = (function () {
    var seen = {}, out = [];
    for (var id = 0; id < 256; id++) {
      var d = DEF[id];
      if (!d) continue;
      var t = d.tiles;
      for (var i = 0; i < t.length; i++) {
        var n = t[i];
        if (!n || seen[n]) continue;
        seen[n] = 1;
        out.push(n);
      }
    }
    return out;
  })();

  /* ---- Queries. Unknown ids fall back to "solid opaque stone",
   * so a bad id can never punch a hole in the world mesh. ---- */
  function defOf(id) { return DEF[id]; }

  function isOpaque(id) {
    var d = DEF[id];
    return d ? d.opaque : true;
  }

  function isCross(id) {
    var d = DEF[id];
    return d ? d.cross : false;
  }

  /* Transparent = the mesher must not cull neighbour faces against it. */
  function isTransparent(id) {
    if (id === ID.AIR) return true;
    return !isOpaque(id);
  }

  function isSolid(id) {
    if (id === ID.AIR || id === ID.WATER) return false;
    var d = DEF[id];
    if (!d) return true;
    if (d.cross) return false;
    return true;
  }

  function hardnessOf(id) {
    var d = DEF[id];
    return d ? d.hardness : 1;
  }

  function nameOf(id) {
    var d = DEF[id];
    return d ? d.name : "unknown";
  }

  global.VoxelBlocks = {
    ID: ID,
    DEF: DEF,
    TILE_NAMES: TILE_NAMES,
    ID_BY_NAME: ID_BY_NAME,
    isOpaque: isOpaque,
    isCross: isCross,
    isTransparent: isTransparent,
    isSolid: isSolid,
    def: defOf,
    hardnessOf: hardnessOf,
    nameOf: nameOf
  };
})(window);
