'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');

const asar = require('../tools/asar-lite');
const patcher = require('../tools/patcher');
const builder = require('../tools/build-payload');
const autoHeal = require('../tools/auto-heal');

function createMockAntigravity(version = '2.35.2') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nawe-ah-app-'));
  const resources = path.join(root, 'resources');
  fs.mkdirSync(resources, { recursive: true });
  fs.writeFileSync(path.join(root, 'version'), '44.9.1', 'utf8');
  fs.writeFileSync(path.join(root, 'Antigravity.exe'), 'mock-exe', 'utf8');

  const asarPath = path.join(resources, 'app.asar');
  asar.createAsarFromMap(
    {
      'package.json': JSON.stringify({ name: 'antigravity', version }),
      'dist/main.js': '"use strict";\nconst { app } = require("electron");\nconsole.log("main");\n',
      'dist/preload.js': 'const invoke = () => {};\ninvoke("window:show-context-menu", items);\n',
      'dist/remote/sshPromptPreload.js': 'console.log("sshPromptPreload");\n',
    },
    asarPath
  );

  return {
    root,
    resources,
    asarPath,
    install: patcher.detectAntigravityInstall(root),
    cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
  };
}

function overwriteWithCleanOfficialAsar(mock, newVersion = '2.36.0') {
  // 模拟官方 NSIS 更新：清空 resources/.nawe-backups 并写入新版纯净 app.asar
  fs.rmSync(mock.install.backupDir, { recursive: true, force: true });
  asar.createAsarFromMap(
    {
      'package.json': JSON.stringify({ name: 'antigravity', version: newVersion }),
      'dist/main.js': '"use strict";\nconst { app } = require("electron");\nconsole.log("new main");\n',
      'dist/preload.js': 'const invoke = () => {};\ninvoke("window:show-context-menu", items);\n',
      'dist/remote/sshPromptPreload.js': 'console.log("new sshPromptPreload");\n',
    },
    mock.asarPath
  );
}

test('enableAutoHeal merges hooks.json without clobbering user hooks and disableAutoHeal restores cleanly', () => {
  const mock = createMockAntigravity('2.35.2');
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nawe-ah-cfg-'));
  try {
    const hooksFile = path.join(configDir, autoHeal.HOOKS_FILE_NAME);
    const existingHooks = {
      'user-custom-hook': {
        SessionStart: [{ type: 'command', command: 'echo hello', timeout: 5 }],
      },
    };
    fs.writeFileSync(hooksFile, JSON.stringify(existingHooks, null, 2), 'utf8');

    const repoDir = path.resolve(__dirname, '..');
    const enRes = autoHeal.enableAutoHeal({
      repoDir,
      installInfo: mock.install,
      nodeExecPath: process.execPath,
      configDir,
      platform: 'win32',
    });

    assert.equal(enRes.enabled, true);
    assert.ok(enRes.command.startsWith('call "'));
    assert.ok(fs.existsSync(enRes.stateFile));

    const hooksAfter = JSON.parse(fs.readFileSync(hooksFile, 'utf8'));
    assert.deepEqual(hooksAfter['user-custom-hook'], existingHooks['user-custom-hook']);
    assert.ok(Array.isArray(hooksAfter[autoHeal.HOOK_GROUP_KEY].SessionStart));
    assert.equal(hooksAfter[autoHeal.HOOK_GROUP_KEY].SessionStart[0].type, 'command');
    assert.ok(Array.isArray(hooksAfter[autoHeal.HOOK_GROUP_KEY].PreInvocation));
    assert.equal(hooksAfter[autoHeal.HOOK_GROUP_KEY].PreInvocation[0].type, 'command');

    const status = autoHeal.getAutoHealStatus({ configDir });
    assert.equal(status.enabled, true);
    assert.equal(status.hookRegistered, true);

    autoHeal.disableAutoHeal({ configDir });
    const statusAfter = autoHeal.getAutoHealStatus({ configDir });
    assert.equal(statusAfter.enabled, false);
    assert.equal(statusAfter.hookRegistered, false);
    assert.equal(fs.existsSync(enRes.stateFile), false);
    const remainingHooks = JSON.parse(fs.readFileSync(hooksFile, 'utf8'));
    assert.deepEqual(remainingHooks, existingHooks);
  } finally {
    mock.cleanup();
    fs.rmSync(configDir, { recursive: true, force: true });
  }
});

test('runSessionStartCheck returns {} fast when patched, and auto-heals after simulated client update (immediate & staged)', () => {
  const mock = createMockAntigravity('2.35.2');
  const configDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nawe-ah-cfg-'));
  const repoDir = path.resolve(__dirname, '..');
  const noRunning = () => false;

  try {
    // 1. 先打上 2.35.2 汉化补丁并开启自愈守护
    const mods1 = builder.buildModifications(mock.asarPath, { version: '1.0.8' });
    const p1 = patcher.applyPatch(mock.install, mods1, {
      patchVersion: '1.0.8',
      isProcessRunning: noRunning,
    });
    assert.equal(p1.mode, 'immediate');

    autoHeal.enableAutoHeal({
      repoDir,
      installInfo: mock.install,
      nodeExecPath: process.execPath,
      configDir,
    });

    // 2. 已汉化状态下，SessionStart 极速返回 {}
    const fastRes = autoHeal.runSessionStartCheck({ configDir, spawnPrompt: false });
    assert.deepEqual(fastRes, {});

    // 3. 模拟官方更新覆盖到 2.36.0 且文件未锁 -> 自动创建新备份 + 立即重新应用汉化 + 注入成功提示
    overwriteWithCleanOfficialAsar(mock, '2.36.0');
    assert.equal(patcher.inspectAsarState(mock.asarPath).state, 'clean-official');

    const healedImm = autoHeal.runSessionStartCheck({
      configDir,
      spawnPrompt: false,
      isProcessRunning: noRunning,
    });
    assert.equal(patcher.inspectAsarState(mock.asarPath).state, 'patched-by-nawe');
    assert.ok(Array.isArray(healedImm.injectSteps));
    assert.equal(healedImm.injectSteps.length, 1);
    assert.match(healedImm.injectSteps[0].systemMessage.metadata.user_markdown, /2\.36\.0/);
    assert.match(healedImm.injectSteps[0].systemMessage.systemMessage, /automatically restored/i);

    // 恢复后再次触发 SessionStart 又回到极速 {}
    assert.deepEqual(autoHeal.runSessionStartCheck({ configDir, spawnPrompt: false }), {});

    // 4. 模拟客户端正在运行被锁定更新到 2.36.1 -> 自动创建新备份 + 生成 app.asar.staged + 注入【确定】弹窗提示
    overwriteWithCleanOfficialAsar(mock, '2.36.1');
    const healedStaged = autoHeal.runSessionStartCheck({
      configDir,
      spawnPrompt: false,
      simulateLocked: true,
    });
    const stagedPath = path.join(mock.install.backupDir, patcher.STAGED_ASAR_NAME);
    assert.equal(fs.existsSync(stagedPath), true);
    assert.equal(patcher.inspectAsarState(stagedPath).state, 'patched-by-nawe');
    assert.ok(Array.isArray(healedStaged.injectSteps));
    assert.match(healedStaged.injectSteps[0].systemMessage.metadata.user_markdown, /2\.36\.1/);
    assert.match(healedStaged.injectSteps[0].systemMessage.metadata.user_markdown, /确定/);
    assert.match(healedStaged.injectSteps[0].systemMessage.systemMessage, /staged/i);
  } finally {
    mock.cleanup();
    fs.rmSync(configDir, { recursive: true, force: true });
  }
});
