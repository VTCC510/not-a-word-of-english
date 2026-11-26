'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const nativeDict = require('../dict/native-menu.json');
const {
  createNativeTranslator,
  createElectronProxy,
  installModuleLoadHook,
  installMainHook,
} = require('../src/main-hook');

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

test('In-app pending-swap watcher pops up native restart confirmation once, deletes signal file, and triggers swap', async () => {
  const fs = require('node:fs');
  const os = require('node:os');
  const path = require('node:path');

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nawe-watcher-test-'));
  try {
    const stagedFile = path.join(tmpDir, 'app.asar.staged');
    const pendingSwapPath = path.join(tmpDir, 'pending-swap.json');
    fs.writeFileSync(stagedFile, 'mock-asar', 'utf8');
    fs.writeFileSync(
      pendingSwapPath,
      JSON.stringify({
        id: 'swap-req-1',
        mode: 'prompt',
        patchVersion: '1.0.5',
        actionLabel: '汉化补丁替换',
        stagedFile,
        createdAt: new Date().toISOString(),
      }),
      'utf8'
    );

    const env = createMockElectron();
    const triggered = [];
    const hookRes = installMainHook(env.electron, nativeDict, {
      pendingSwapPath,
      pollIntervalMs: 60000,
      triggerSwapFn: (info) => triggered.push(info),
    });

    assert.equal(hookRes.installed, true);
    assert.equal(hookRes.swapWatcher.active, true);

    await hookRes.swapWatcher.checkOnce();
    hookRes.swapWatcher.stop();

    assert.equal(fs.existsSync(pendingSwapPath), false, '信号文件应立即消费并删除');
    assert.equal(env.dialogCalls.length, 1);
    assert.deepEqual(env.dialogCalls[0].opts.buttons, ['立即重启生效', '稍后手动重启']);
    assert.equal(triggered.length, 1);
    assert.equal(triggered[0].id, 'swap-req-1');

    // 二次轮询应为无操作，绝不重复弹窗
    await hookRes.swapWatcher.checkOnce();
    assert.equal(env.dialogCalls.length, 1);
    assert.equal(triggered.length, 1);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('Native menu and dialog translator tolerates ellipsis, curly quotes, casing, and trailing punctuation drift', () => {
  const t = createNativeTranslator(nativeDict);
  assert.equal(t.translateMenuLabel('New Window...'), '新建窗口...');
  assert.equal(t.translateMenuLabel('Downloading Update\u2026'), '正在下载更新...');
  assert.equal(t.translateMenuLabel('check for updates:'), '检查更新：');
  assert.equal(
    t.translateDialogText('There may be agents\u00a0or\nbackground tasks running.'),
    '当前可能仍有智能体或后台任务正在运行。\n(There may be agents or background tasks running.)'
  );
  const translatedQuit = t.translateDialogOptions({
    title: 'CONFIRM QUIT',
    message: 'Are you sure you want to quit?',
    buttons: ['cancel', 'Quit'],
  });
  assert.equal(translatedQuit.title, '确认退出 (Confirm Quit)');
  assert.deepEqual(translatedQuit.buttons, ['取消 (Cancel)', '退出 (Quit)']);
});

test('Native Electron right-click context menus translate submenus and keep bilingual safety items', () => {
  const env = createMockElectron();
  installMainHook(env.electron, nativeDict);

  const ctxMenu = env.electron.Menu.buildFromTemplate([
    { label: 'Open In', submenu: [{ label: 'Open in Side Panel' }, { label: 'Side Panel (Default)' }] },
    { label: 'Close Tabs to the Right' },
    { label: 'Fork', submenu: [{ label: 'Fork in Current Workspace' }, { label: 'Fork in New Workspace' }] },
    { label: 'Undo to Here' },
    { label: 'Delete Project' },
    { label: 'Delete Permanently' },
  ]);
  ctxMenu.popup({});

  assert.equal(env.popupCalls.length, 1);
  assert.equal(ctxMenu.items[0].label, '打开方式');
  const shown = env.popupCalls[0].menu;
  assert.equal(shown, ctxMenu);
  assert.equal(shown.items[0].label, '打开方式');
  assert.equal(shown.items[0].submenu.items[0].label, '在侧边面板中打开');
  assert.equal(shown.items[0].submenu.items[1].label, '侧边面板（默认）');
  assert.equal(shown.items[1].label, '关闭右侧标签页');
  assert.equal(shown.items[2].label, '分支对话');
  assert.equal(shown.items[2].submenu.items[0].label, '在当前工作区中派生');
  assert.equal(shown.items[2].submenu.items[1].label, '在新工作区中派生');
  assert.equal(shown.items[3].label, '回滚到此处 (Undo to Here)');
  assert.equal(shown.items[4].label, '删除项目 (Delete Project)');
  assert.equal(shown.items[5].label, '永久删除 (Delete Permanently)');
});

test('IPC window:show-context-menu translates nested menus while preserving ids, and skips duplicate popup rebuilds', async () => {
  const handlers = new Map();
  const appListeners = new Map();
  const env = createMockElectron();
  env.electron.ipcMain = {
    handle(channel, fn) {
      handlers.set(channel, fn);
    },
  };
  env.electron.app = {
    on(event, fn) {
      if (!appListeners.has(event)) appListeners.set(event, []);
      appListeners.get(event).push(fn);
    },
  };

  installMainHook(env.electron, nativeDict, {
    sidecarPayloadSource: '/* [NAWE-PRELOAD-ENGINE-BEGIN] */window.__naweInjected=1;/* [NAWE-PRELOAD-ENGINE-END] */',
  });

  let receivedItems = null;
  env.electron.ipcMain.handle('window:show-context-menu', async (_event, items) => {
    receivedItems = items;
    const menu = env.electron.Menu.buildFromTemplate(items);
    menu.popup({});
    return 'conv-rename';
  });

  const handler = handlers.get('window:show-context-menu');
  const rawConvItems = [
    { id: 'conv-rename', label: 'Rename' },
    { id: 'conv-pin', label: 'Pin' },
    { id: 'conv-unread', label: 'Mark Unread' },
    {
      id: 'conv-copy',
      type: 'submenu',
      label: 'Copy',
      submenu: [
        { id: 'copy-0', label: 'Conversation Name' },
        { id: 'copy-1', label: 'Conversation ID' },
        { id: 'copy-2', label: 'Workspace Name' },
        { id: 'copy-3', label: 'Project Name' },
      ],
    },
    {
      id: 'conv-split',
      type: 'submenu',
      label: 'Split',
      submenu: [
        { id: 'split-0', label: 'Split Right' },
        { id: 'split-1', label: 'Split Down' },
        { id: 'split-2', label: 'Replace with New' },
        { id: 'split-3', label: 'Remove from Split' },
      ],
    },
    { id: 'conv-archive', label: 'Archive' },
    { id: 'conv-delete', label: 'Delete' },
    { id: 'proj-copy', label: 'Copy Project Name' },
    { id: 'proj-settings', label: 'Project Settings' },
    { id: 'proj-delete', label: 'Delete Project' },
  ];

  const retId = await handler({}, rawConvItems);
  assert.equal(retId, 'conv-rename');
  assert.equal(rawConvItems[0].label, 'Rename');
  assert.equal(receivedItems[0].id, 'conv-rename');
  assert.equal(receivedItems[0].label, '重命名');
  assert.equal(receivedItems[1].label, '置顶');
  assert.equal(receivedItems[2].label, '标为未读');
  assert.equal(receivedItems[3].label, '复制');
  assert.deepEqual(
    receivedItems[3].submenu.map((i) => [i.id, i.label]),
    [
      ['copy-0', '对话名称'],
      ['copy-1', '对话 ID'],
      ['copy-2', '工作区名称'],
      ['copy-3', '项目名称'],
    ]
  );
  assert.equal(receivedItems[4].label, '拆分视图');
  assert.deepEqual(
    receivedItems[4].submenu.map((i) => [i.id, i.label]),
    [
      ['split-0', '向右拆分'],
      ['split-1', '向下拆分'],
      ['split-2', '替换为新对话'],
      ['split-3', '移出拆分视图'],
    ]
  );
  assert.equal(receivedItems[5].label, '归档');
  assert.equal(receivedItems[6].label, '删除');
  assert.equal(receivedItems[7].label, '复制项目名称');
  assert.equal(receivedItems[8].label, '项目设置');
  assert.equal(receivedItems[9].label, '删除项目 (Delete Project)');

  // 已经通过 IPC 翻译好的菜单在 popup 时保持原实例（不重复克隆），维持 activeContextMenu 身份一致
  assert.equal(env.popupCalls.length, 1);
  assert.equal(env.popupCalls[0].menu.items[0].label, '重命名');

  // plugin:// sidecar 注入严格隔离非 plugin:// 页面
  const wcListeners = new Map();
  const mockContents = {
    on(ev, fn) {
      wcListeners.set(ev, fn);
    },
  };
  for (const fn of appListeners.get('web-contents-created') || []) {
    fn({}, mockContents);
  }
  const executed = [];
  const finishLoad = wcListeners.get('did-frame-finish-load');
  assert.ok(finishLoad);

  finishLoad({
    frame: {
      url: 'plugin://swarm-board/index.html',
      executeJavaScript(code) {
        executed.push(code);
        return Promise.resolve();
      },
    },
  });
  finishLoad({
    frame: {
      url: 'https://example.com/',
      executeJavaScript(code) {
        executed.push(code);
        return Promise.resolve();
      },
    },
  });
  finishLoad({
    frame: {
      url: 'http://127.0.0.1:9999/',
      executeJavaScript(code) {
        executed.push(code);
        return Promise.resolve();
      },
    },
  });

  assert.equal(executed.length, 1);
  assert.match(executed[0], /__naweInjected=1/);
});

test('Menu.buildFromTemplate translates context menus and isolates frozen Menu.prototype.popup / ipcMain.handle', async () => {
  const handlers = new Map();
  const appListeners = new Map();
  const env = createMockElectron();
  Object.defineProperty(env.electron.Menu.prototype, 'popup', {
    value: env.electron.Menu.prototype.popup,
    writable: false,
    configurable: false,
  });
  env.electron.ipcMain = {};
  Object.defineProperty(env.electron.ipcMain, 'handle', {
    value(channel, fn) {
      handlers.set(channel, fn);
    },
    writable: false,
    configurable: false,
  });
  env.electron.app = {
    on(event, fn) {
      if (!appListeners.has(event)) appListeners.set(event, []);
      appListeners.get(event).push(fn);
    },
  };

  const res = installMainHook(env.electron, nativeDict, {
    sidecarPayloadSource: '/* [NAWE-PRELOAD-ENGINE-BEGIN] */window.__naweIsolated=1;/* [NAWE-PRELOAD-ENGINE-END] */',
  });
  assert.equal(res.installed, true);

  const built = env.electron.Menu.buildFromTemplate([
    { id: 'rename', label: 'Rename' },
    { id: 'unpin', label: 'Unpin' },
    { id: 'mark-read', label: 'Mark Unread' },
    {
      id: 'copy',
      type: 'submenu',
      label: 'Copy',
      submenu: [
        { id: 'copy-0', label: 'Conversation Name' },
        { id: 'copy-1', label: 'Conversation ID' },
        { id: 'copy-2', label: 'Workspace Name' },
        { id: 'copy-3', label: 'Project Name' },
      ],
    },
    {
      id: 'split',
      type: 'submenu',
      label: 'Split',
      submenu: [
        { id: 'split-0', label: 'Split Right' },
        { id: 'split-1', label: 'Split Down' },
        { id: 'split-2', label: 'Replace with New' },
        { id: 'split-3', label: 'Remove from Split' },
      ],
    },
    { id: 'archive', label: 'Archive' },
    { id: 'delete', label: 'Delete' },
    { id: 'copy-proj', label: 'Copy Project Name' },
    { id: 'proj-settings', label: 'Project Settings' },
    { id: 'proj-delete', label: 'Delete Project' },
  ]);

  built.popup({});
  assert.equal(env.popupCalls.length, 1);
  const shown = env.popupCalls[0].menu;
  assert.equal(shown, built);
  assert.deepEqual(
    shown.items.map((i) => [i.id, i.label]),
    [
      ['rename', '重命名'],
      ['unpin', '取消置顶'],
      ['mark-read', '标为未读'],
      ['copy', '复制'],
      ['split', '拆分视图'],
      ['archive', '归档'],
      ['delete', '删除'],
      ['copy-proj', '复制项目名称'],
      ['proj-settings', '项目设置'],
      ['proj-delete', '删除项目 (Delete Project)'],
    ]
  );
  assert.deepEqual(
    shown.items[3].submenu.items.map((i) => i.label),
    ['对话名称', '对话 ID', '工作区名称', '项目名称']
  );
  assert.deepEqual(
    shown.items[4].submenu.items.map((i) => i.label),
    ['向右拆分', '向下拆分', '替换为新对话', '移出拆分视图']
  );

  // dialog 与 plugin:// 注入在 Menu.prototype.popup 不可写时依然全部可用
  await env.electron.dialog.showMessageBox({ title: 'Check for Updates', buttons: ['OK'] });
  assert.equal(env.dialogCalls[0].opts.title, '检查更新');
  assert.equal((appListeners.get('web-contents-created') || []).length, 1);
});

test('installModuleLoadHook + createElectronProxy handles completely frozen non-configurable Electron exports', async () => {
  const env = createMockElectron();
  const handlers = new Map();
  const frozenMenu = env.electron.Menu;
  Object.defineProperty(frozenMenu, 'buildFromTemplate', {
    value: frozenMenu.buildFromTemplate,
    writable: false,
    configurable: false,
  });
  Object.defineProperty(frozenMenu.prototype, 'popup', {
    value: frozenMenu.prototype.popup,
    writable: false,
    configurable: false,
  });
  Object.freeze(frozenMenu);

  const frozenIpc = Object.freeze({
    handle(channel, fn) {
      handlers.set(channel, fn);
    },
  });
  const frozenDialog = Object.freeze(env.electron.dialog);
  const frozenTray = Object.freeze(env.electron.Tray);
  const frozenApp = Object.freeze({ on() {} });

  const realElectron = {};
  Object.defineProperties(realElectron, {
    Menu: { get: () => frozenMenu, enumerable: true, configurable: false },
    ipcMain: { get: () => frozenIpc, enumerable: true, configurable: false },
    dialog: { get: () => frozenDialog, enumerable: true, configurable: false },
    Tray: { get: () => frozenTray, enumerable: true, configurable: false },
    app: { get: () => frozenApp, enumerable: true, configurable: false },
  });
  Object.freeze(realElectron);

  const mockModule = {
    _load(request) {
      if (request === 'electron') return realElectron;
      return null;
    },
  };
  const hookRes = installModuleLoadHook(mockModule, nativeDict);
  assert.equal(hookRes.installed, true);

  // 模拟 dist/ipcHandlers.js 与 dist/main.js 的 require('electron') 及 __importStar 解构
  const proxiedElectron = mockModule._load('electron');
  assert.doesNotThrow(() => {
    for (const k of Object.keys(proxiedElectron)) void proxiedElectron[k];
  });

  proxiedElectron.ipcMain.handle('window:show-context-menu', async (_event, items) => {
    const template = items.map((i) => ({ ...i }));
    const m = proxiedElectron.Menu.buildFromTemplate(template);
    m.popup({});
    return items[0].id;
  });

  const handler = handlers.get('window:show-context-menu');
  const resId = await handler({}, [
    { id: 'sort-lbl', label: 'Sort By' },
    { id: 'sort-upd', label: 'Last Updated' },
    { id: 'sort-prm', label: 'Last Prompt' },
    { id: 'sort-cst', label: 'Custom Order' },
    { id: 'proj-exp', label: 'Show in File Explorer' },
    { id: 'proj-del', label: 'Delete Project' },
    { id: 'conv-unpin', label: 'Unpin' },
    { id: 'msg-good', label: 'Good Response' },
  ]);
  assert.equal(resId, 'sort-lbl');
  assert.deepEqual(
    env.popupCalls[0].menu.items.map((i) => i.label),
    [
      '排序方式',
      '最近更新',
      '最近提问',
      '自定义顺序',
      '在文件资源管理器中显示',
      '删除项目 (Delete Project)',
      '取消置顶',
      '回答不错',
    ]
  );

  // Tray 通过构造器代理也能拦截动态智能体计数
  const tray = new proxiedElectron.Tray();
  const trayMenu = proxiedElectron.Menu.buildFromTemplate([{ label: 'No agents running' }]);
  trayMenu.items[0].label = '2 agents running';
  tray.setContextMenu(trayMenu);
  assert.equal(env.trayMenus[0].items[0].label, '2 个智能体运行中');

  // 对话框也能在冻结对象下正常工作
  await proxiedElectron.dialog.showMessageBox({ title: 'Check for Updates', buttons: ['OK'] });
  assert.equal(env.dialogCalls[0].opts.title, '检查更新');
  assert.equal(createElectronProxy(realElectron, nativeDict), proxiedElectron);
});

test('updater:quit-and-install and updater:apply trigger detached post-update auto-heal watcher in both hook and proxy modes', async () => {
  const fs = require('node:fs');
  const path = require('node:path');
  const os = require('node:os');

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nawe-mh-upd-'));
  try {
    const fakeAutoHeal = path.join(tmpDir, 'auto-heal.js');
    fs.writeFileSync(fakeAutoHeal, '// stub\n', 'utf8');
    const stateFile = path.join(tmpDir, '.nawe-auto-heal.json');
    fs.writeFileSync(
      stateFile,
      JSON.stringify({
        enabled: true,
        nodeExecPath: process.execPath,
        autoHealPath: fakeAutoHeal,
      }),
      'utf8'
    );

    const spawned = [];
    const mockSpawn = (cmd, args, opts) => {
      spawned.push({ cmd, args, opts });
      return { unref() {} };
    };

    // 1. installMainHook 模式
    const handlersA = new Map();
    const envA = createMockElectron();
    envA.electron.ipcMain = {
      handle(ch, fn) {
        handlersA.set(ch, fn);
      },
    };
    installMainHook(envA.electron, nativeDict, {
      autoHealStatePath: stateFile,
      spawnFn: mockSpawn,
    });
    envA.electron.ipcMain.handle('updater:quit-and-install', () => 'quit-ok');
    const resA = handlersA.get('updater:quit-and-install')({});
    assert.equal(resA, 'quit-ok');

    // 2. createElectronProxy 模式
    const handlersB = new Map();
    const envB = createMockElectron();
    envB.electron.ipcMain = {
      handle(ch, fn) {
        handlersB.set(ch, fn);
      },
    };
    const proxyB = createElectronProxy(envB.electron, nativeDict, {
      noCache: true,
      autoHealStatePath: stateFile,
      spawnFn: mockSpawn,
    });
    proxyB.ipcMain.handle('updater:apply', () => 'apply-ok');
    const resB = handlersB.get('updater:apply')({});
    assert.equal(resB, 'apply-ok');

    assert.equal(spawned.length, 2);
    for (const call of spawned) {
      assert.equal(call.cmd, process.execPath);
      assert.deepEqual(call.args, [fakeAutoHeal, '--post-update-watch']);
      assert.equal(call.opts.detached, true);
      assert.equal(call.opts.cwd, os.tmpdir());
    }
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

