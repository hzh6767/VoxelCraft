// VoxelCraft — 世界存档
// 挂在 window.VoxelSave 上。
// Electron 渲染进程是沙盒化的，无 Node API 访问权限，存档用 IndexedDB + localStorage。
(function (global) {
  'use strict';

  let db = null;
  let dbReady = null;        // Promise<IDBDatabase|null>，IndexedDB 就绪后 resolve
  let inMemory = new Map();  // 降级方案
  let persistent = false;

  // IndexedDB 包装
  function openDB() {
    return new Promise((resolve, reject) => {
      if (!global.indexedDB) {
        console.warn('[VoxelSave] IndexedDB 不可用，降级为内存模式');
        resolve(null);
        return;
      }

      const req = global.indexedDB.open('VoxelCraft', 1);
      req.onerror = () => {
        console.warn('[VoxelSave] IndexedDB 打开失败，降级为内存模式');
        resolve(null);
      };
      req.onsuccess = () => {
        persistent = true;
        resolve(req.result);
      };
      req.onupgradeneeded = (e) => {
        const d = e.target.result;
        if (!d.objectStoreNames.contains('chunks')) {
          d.createObjectStore('chunks', { keyPath: 'key' });
        }
      };
    });
  }

  dbReady = openDB().then(d => { db = d; return d; });

  function writeEditToDb(d, key, lx, y, lz, id) {
    if (!d) {
      const rec = inMemory.get(key) || [];
      rec.push([lx, y, lz, id]);
      inMemory.set(key, rec);
      return;
    }
    const tx = d.transaction(['chunks'], 'readwrite');
    const store = tx.objectStore('chunks');
    const req = store.get(key);
    req.onsuccess = () => {
      const rec = req.result || { key, edits: [] };
      rec.edits.push([lx, y, lz, id]);
      store.put(rec);
    };
  }

  function saveBlockEdit(cx, cz, lx, y, lz, id) {
    const key = cx + ',' + cz;
    // IndexedDB 打开是异步的。若在它 resolve 之前就把改动写进内存降级表，
    // 这些改动永远进不了数据库（重启即丢）。所以未就绪时要等 dbReady 再写。
    if (db) writeEditToDb(db, key, lx, y, lz, id);
    else if (dbReady) dbReady.then(d => writeEditToDb(d, key, lx, y, lz, id));
    else writeEditToDb(null, key, lx, y, lz, id);
  }

  function readEditsFromDb(d, key) {
    if (!d) return Promise.resolve(inMemory.get(key) || []);
    return new Promise((resolve) => {
      const tx = d.transaction(['chunks'], 'readonly');
      const req = tx.objectStore('chunks').get(key);
      req.onsuccess = () => {
        resolve((req.result && req.result.edits) || []);
      };
      req.onerror = () => resolve([]);
    });
  }

  function loadEdits(cx, cz) {
    const key = cx + ',' + cz;
    // 同 saveBlockEdit：未就绪时先等 IndexedDB 打开，
    // 否则会在数据库为空的内存表里读到空，开局附近的存档改动会整片丢失。
    if (db) return readEditsFromDb(db, key);
    if (dbReady) return dbReady.then(d => readEditsFromDb(d, key));
    return readEditsFromDb(null, key);
  }

  function savePlayer(state) {
    try {
      global.localStorage.setItem('voxelcraft:player', JSON.stringify(state));
    } catch (e) {
      console.warn('[VoxelSave] localStorage 写入失败', e);
    }
  }

  function loadPlayer() {
    try {
      const s = global.localStorage.getItem('voxelcraft:player');
      return Promise.resolve(s ? JSON.parse(s) : null);
    } catch (e) {
      return Promise.resolve(null);
    }
  }

  function clearWorld() {
    inMemory.clear();
    const clearDb = (d) => {
      if (!d) return;
      const tx = d.transaction(['chunks'], 'readwrite');
      tx.objectStore('chunks').clear();
    };
    if (db) clearDb(db);
    else if (dbReady) dbReady.then(clearDb);
    try {
      global.localStorage.removeItem('voxelcraft:player');
    } catch (e) {}
  }

  function isPersistent() {
    return persistent;
  }

  function exportWorld() {
    const chunks = {};
    if (db) {
      // 同步导出不支持 IndexedDB，返回占位符
      return { chunks: {}, note: '使用 IndexedDB 时需异步导出' };
    }
    for (const [key, edits] of inMemory) {
      chunks[key] = edits;
    }
    const player = global.localStorage.getItem('voxelcraft:player');
    return { chunks, player: player ? JSON.parse(player) : null };
  }

  function importWorld(obj) {
    if (!obj) return;
    inMemory.clear();
    if (obj.chunks) {
      for (const key in obj.chunks) {
        inMemory.set(key, obj.chunks[key]);
      }
    }
    if (obj.player) {
      savePlayer(obj.player);
    }
  }

  global.VoxelSave = {
    saveBlockEdit,
    loadEdits,
    savePlayer,
    loadPlayer,
    clearWorld,
    isPersistent,
    exportWorld,
    importWorld,
  };
})(window);
