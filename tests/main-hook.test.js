'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const nativeDict = require('../dict/native-menu.json');
const { createNativeTranslator, installMainHook } = require('../src/main-hook');

/**
 * 极简 Mock Electron 环境（精准模拟 Antigravity 的 Menu / Tray / dialog 行为）。
 */
function createMockElectron() {
  let activeOsMenu = null;
  const popupCalls = [];
  const closePopupCalls = [];
  const dialogCalls = [];
  const trayMenus = [];

  class MockMenuItem {
    constructor(opts) {
      Object.assign(this, {
        enabled: true,
        visible: true,
        type: opts.submenu ? 'submenu' : opts.type || 'normal',
      }, opts);
      if (Array.isArray(opts.submenu)) {
        this.submenu = MockMenu.buildFromTemplate(opts.submenu);
      }
    }
  }

  class MockMenu {
    constructor(items = []) {
      this.items = items;
    }
    insert(pos, item) {
      this.items.splice(pos, 0, item);
    }
    getMenuItemById(id) {
      for (const item of this.items) {
        if (item.id === id) return item;
        if (item.submenu) {
          const nested = item.submenu.getMenuItemById(id);
          if (nested) return nested;
        }
      }
      return null;
    }
    popup(options) {
      popupCalls.push({ menu: this, options });
    }
    closePopup(browserWindow) {
      closePopupCalls.push({ menu: this, browserWindow });
    }
    static buildFromTemplate(template) {
      return new MockMenu(template.map((t) => new MockMenuItem(t)));
    }
    static setApplicationMenu(menu) {
      activeOsMenu = menu;
    }
    static getApplicationMenu() {
      return activeOsMenu;
    }
  }

  class MockTray {
    setContextMenu(menu) {
      trayMenus.push(menu);
    }
  }

  const dialog = {
    showMessageBox(arg1, arg2) {
      const opts = arg2 !== undefined ? arg2 : arg1;
      dialogCalls.push({ kind: 'async', hasWin: arg2 !== undefined, opts });
      return Promise.resolve({ response: 0, checkboxChecked: false });
    },
    showMessageBoxSync(arg1, arg2) {
      const opts = arg2 !== undefined ? arg2 : arg1;
      dialogCalls.push({ kind: 'sync', hasWin: arg2 !== undefined, opts });
      return 0;
    },
    showOpenDialog(arg1, arg2) {
      const opts = arg2 !== undefined ? arg2 : arg1;
      dialogCalls.push({ kind: 'open', hasWin: arg2 !== undefined, opts });
      return Promise.resolve({ canceled: false, filePaths: ['C:\\demo'] });
    },
  };

  return {
    electron: { Menu: MockMenu, MenuItem: MockMenuItem, Tray: MockTray, dialog },
    getActiveOsMenu: () => activeOsMenu,
    popupCalls,
    closePopupCalls,
    dialogCalls,
    trayMenus,
  };
}

test('Translator translates standard labels, Windows mnemonics (&File), and patterns while preserving unknown names', () => {
  const t = createNativeTranslator(nativeDict);
  assert.equal(t.translateMenuLabel('&File'), '文件');
  assert.equal(t.translateMenuLabel('New Window'), '新建窗口');
  assert.equal(t.translateMenuLabel('3 agents running'), '3 个智能体运行中');
  assert.equal(t.translateMenuLabel('1 agent running'), '1 个智能体运行中');
  assert.equal(t.translateMenuLabel('Open Antigravity'), '打开 Antigravity');
  // 专有 WSL 发行版名称必须原样保留
  assert.equal(t.translateMenuLabel('Ubuntu-22.04'), 'Ubuntu-22.04');
});

test('Application menu hook keeps English lookups working for async WSL insertion and View zoom, while displaying Chinese to OS', () => {
  const env = createMockElectron();
  const { Menu, MenuItem } = env.electron;

  // 先建立 Electron 默认英文菜单
  const defaultMenu = Menu.buildFromTemplate([
    { label: 'File', submenu: [{ label: 'Quit', role: 'quit' }] },
    { label: 'Edit', submenu: [{ label: 'Copy', role: 'copy' }, { label: 'Paste', role: 'paste' }] },
    {
      label: 'View',
      submenu: [
        { label: 'Reload', role: 'reload' },
        { label: 'Actual Size', role: 'resetzoom' },
        { label: 'Zoom In', role: 'zoomin' },
      ],
    },
    { label: 'Help', submenu: [] },
  ]);
  Menu.setApplicationMenu(defaultMenu);

  // 安装我们的无侵入主进程钩子
  installMainHook(env.electron, nativeDict);

  // 模拟 Antigravity 的 setupApplicationMenu()
  const appMenu = Menu.getApplicationMenu();
  const fileMenu = appMenu.items.find((i) => i.label === 'File');
  assert.ok(fileMenu, 'File menu lookup must still succeed in English');
  fileMenu.submenu.insert(0, new MenuItem({ label: 'New Window', accelerator: 'CmdOrCtrl+Shift+N' }));

  const helpMenu = appMenu.items.find((i) => i.label === 'Help');
  helpMenu.submenu.insert(0, new MenuItem({ label: 'Docs' }));
  Menu.setApplicationMenu(appMenu);

  // 验证提交给操作系统的菜单是全中文的，且保留了原生 role
  let osMenu = env.getActiveOsMenu();
  assert.deepEqual(
    osMenu.items.map((i) => i.label),
    ['文件', '编辑', '视图', '帮助']
  );
  assert.deepEqual(
    osMenu.items[0].submenu.items.map((i) => i.label),
    ['新建窗口', '退出']
  );
  assert.equal(osMenu.items[1].submenu.items[0].role, 'copy');
  assert.equal(osMenu.items[1].submenu.items[0].label, '复制');

  // 模拟 500ms 后异步插入 WSL 菜单（依赖原 appMenu 上的 label === 'File'！）
  const fileMenuLater = appMenu.items.find((i) => i.label === 'File');
  assert.ok(fileMenuLater, 'Async addWslConnectMenu lookup must still find File');
  fileMenuLater.submenu.insert(
    1,
    new MenuItem({
      label: 'Connect to WSL',
      submenu: [{ label: 'Ubuntu-22.04', type: 'checkbox', checked: false }],
    })
  );
  Menu.setApplicationMenu(appMenu);

  osMenu = env.getActiveOsMenu();
  assert.equal(osMenu.items[0].submenu.items[1].label, '连接到 WSL');
  assert.equal(osMenu.items[0].submenu.items[1].submenu.items[0].label, 'Ubuntu-22.04');
});

test('macOS check-for-updates click handler still receives original English label and syncs dynamic updates', () => {
  const env = createMockElectron();
  const { Menu, MenuItem } = env.electron;
  installMainHook(env.electron, nativeDict);

  let clickedLabel = null;
  const appMenu = Menu.buildFromTemplate([
    {
      label: 'Antigravity',
      submenu: [
        {
          id: 'check-for-updates',
          label: 'Check for Updates',
          click(menuItem) {
            clickedLabel = menuItem.label;
          },
        },
      ],
    },
  ]);
  Menu.setApplicationMenu(appMenu);

  const osItem = env.getActiveOsMenu().getMenuItemById('check-for-updates');
  assert.equal(osItem.label, '检查更新');
  // 触发点击，验证回调拿到的是原英文 'Check for Updates'
  osItem.click(osItem);
  assert.equal(clickedLabel, 'Check for Updates');

  // 模拟 updater.js 动态改写原菜单 label
  const rawItem = Menu.getApplicationMenu().getMenuItemById('check-for-updates');
  rawItem.label = 'Downloading Update...';
  assert.equal(osItem.label, '正在下载更新...');
});

test('Tray hook translates initial menu, dynamic agent count updates, and async WSL items', () => {
  const env = createMockElectron();
  const { Menu, Tray } = env.electron;
  installMainHook(env.electron, nativeDict);

  const tray = new Tray();
  const ctxMenu = Menu.buildFromTemplate([
    { id: 'running-agents', label: 'No agents running', enabled: false },
    { type: 'separator' },
    { label: 'Open Antigravity' },
    { label: 'Quit' },
  ]);
  tray.setContextMenu(ctxMenu);

  assert.deepEqual(
    env.trayMenus[0].items.map((i) => i.label || i.type),
    ['暂无智能体运行', 'separator', '打开 Antigravity', '退出']
  );

  // 模拟 updateTrayAgentCount(4)
  ctxMenu.items[0].label = '4 agents running';
  tray.setContextMenu(ctxMenu);
  assert.equal(env.trayMenus[1].items[0].label, '4 个智能体运行中');
});

test('Dynamic context menu popup translates cleanly without infinite recursion', () => {
  const env = createMockElectron();
  const { Menu } = env.electron;
  installMainHook(env.electron, nativeDict);

  const ctx = Menu.buildFromTemplate([
    { role: 'cut' },
    { role: 'copy' },
    { role: 'paste' },
    { role: 'selectAll' },
    { label: 'Quote' },
    { label: 'Side Question' },
    { label: 'Connection info…' },
    { label: 'Inspect Element' },
  ]);
  ctx.popup({ x: 10, y: 20 });

  assert.equal(env.popupCalls.length, 1);
  assert.deepEqual(
    env.popupCalls[0].menu.items.map((i) => i.label),
    ['剪切', '复制', '粘贴', '全选', '引用', '旁白追问', '连接信息…', '检查元素']
  );

  // closePopup 转发到实际弹出的汉化菜单实例
  ctx.closePopup({ id: 'win-1' });
  assert.equal(env.closePopupCalls.length, 1);
  assert.equal(env.closePopupCalls[0].menu, env.popupCalls[0].menu);
});

test('Dialog hook translates info dialogs, enforces bilingual safety on Confirm Quit, and preserves button count & order', async () => {
  const env = createMockElectron();
  const { dialog } = env.electron;
  installMainHook(env.electron, nativeDict);

  // 1) 普通信息提示框（1 参数签名）
  const infoOpts = {
    title: 'Check for Updates',
    message: 'No updates available',
    buttons: ['OK'],
  };
  await dialog.showMessageBox(infoOpts);
  // 确认未篡改调用方原始对象
  assert.equal(infoOpts.title, 'Check for Updates');
  assert.equal(env.dialogCalls[0].opts.title, '检查更新');
  assert.equal(env.dialogCalls[0].opts.message, '当前已是最新版本，暂无可用更新。');
  assert.deepEqual(env.dialogCalls[0].opts.buttons, ['确定']);

  // 2) 退出确认弹窗（2 参数签名，强制中英双语对照 + 按钮顺序严格 1:1）
  const quitOpts = {
    title: 'Confirm Quit',
    message: 'Are you sure you want to quit?',
    detail: 'There may be agents or background tasks running.',
    buttons: ['Cancel', 'Quit'],
  };
  dialog.showMessageBoxSync({ mockWindow: true }, quitOpts);
  assert.equal(env.dialogCalls[1].hasWin, true);
  assert.equal(env.dialogCalls[1].opts.title, '确认退出 (Confirm Quit)');
  assert.match(env.dialogCalls[1].opts.message, /Are you sure you want to quit\?/);
  assert.deepEqual(env.dialogCalls[1].opts.buttons, ['取消 (Cancel)', '退出 (Quit)']);

  // 3) 文件选择弹窗仅翻译 title/buttonLabel，绝不触碰 defaultPath
  await dialog.showOpenDialog({
    title: 'Select Workspace Folder',
    buttonLabel: 'Open',
    defaultPath: 'C:\\Users\\Demo\\Projects',
  });
  assert.equal(env.dialogCalls[2].opts.title, '选择工作区文件夹');
  assert.equal(env.dialogCalls[2].opts.buttonLabel, '打开');
  assert.equal(env.dialogCalls[2].opts.defaultPath, 'C:\\Users\\Demo\\Projects');
});
