// VoxelCraft — Electron shell。
// 只负责开窗口、加载本地渲染进程、把安全策略收紧到游戏真正需要的最小面。
// 所有游戏逻辑都在 src/ 里，外壳不碰。
const { app, BrowserWindow, Menu } = require('electron');
const path = require('path');

// 游戏不需要任何硬件加速之外的特权；关掉 Node 注入，页面只能拿到纯 Web API。
function createWindow() {
  const win = new BrowserWindow({
    width: 1280,
    height: 800,
    minWidth: 854,
    minHeight: 480,
    backgroundColor: '#9fd0ff',
    title: 'VoxelCraft',
    show: false,
    autoHideMenuBar: true,
    webPreferences: {
      nodeIntegration: false,
      contextIsolation: true,
      sandbox: true,
      // 页面用 file:// 加载本地 three.js，不需要远程内容
      webSecurity: true,
      backgroundThrottling: false,
    },
  });

  // 去掉菜单栏：游戏窗口不该有 File/Edit/View
  Menu.setApplicationMenu(null);

  win.loadFile(path.join(__dirname, 'src', 'index.html'));

  // 先隐藏再显示，避免白屏闪一下
  win.once('ready-to-show', () => {
    win.show();
    win.focus();
  });

  // F11 全屏 / Esc 退出全屏由页面自己管，这里只兜底 F11
  win.webContents.on('before-input-event', (event, input) => {
    if (input.type === 'keyDown' && input.key === 'F11') {
      win.setFullScreen(!win.isFullScreen());
      event.preventDefault();
    }
  });

  return win;
}

// 单实例：游戏存档在 userData，双开会让两边同时写同一份世界
const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
} else {
  app.on('second-instance', () => {
    const [win] = BrowserWindow.getAllWindows();
    if (win) {
      if (win.isMinimized()) win.restore();
      win.focus();
    }
  });

  app.whenReady().then(() => {
    createWindow();
    app.on('activate', () => {
      if (BrowserWindow.getAllWindows().length === 0) createWindow();
    });
  });

  app.on('window-all-closed', () => {
    app.quit();
  });
}
