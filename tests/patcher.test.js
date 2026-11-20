'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const asar = require('../tools/asar-lite');
const patcher = require('../tools/patcher');

function createMockAntigravity(extraFiles = {}, version = '2.33.0') {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nawe-patcher-test-'));
  const resources = path.join(root, 'resources');
  fs.mkdirSync(resources, { recursive: true });
  fs.writeFileSync(path.join(root, 'version'), '44.9.1', 'utf8');
  fs.writeFileSync(path.join(root, 'Antigravity.exe'), 'mock-exe', 'utf8');

  const asarPath = path.join(resources, 'app.asar');
  asar.createAsarFromMap(
    {
      'package.json': JSON.stringify({ name: 'antigravity', version }),
      'dist/main.js': 'const { app } = require("electron");\nconsole.log("main");',
      'dist/preload.js': 'console.log("preload");',
      'dist/menu.js': 'exports.setupApplicationMenu = () => {};',
      'dist/tray.js': 'exports.createTray = () => {};',
      ...extraFiles,
    },
    asarPath
  );

  return {
    root,
    asarPath,
    install: patcher.detectAntigravityInstall(root),
    cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
  };
}

test('Full lifecycle: clean backup -> patch -> idempotent re-patch -> lossless restore', () => {
  const mock = createMockAntigravity();
  try {
    const origHash = asar.sha256File(mock.asarPath);
    const noRunning = () => false;

    // 1. 首次打补丁
    const r1 = patcher.applyPatch(
      mock.install,
      { 'dist/preload.js': 'console.log("preload");\n// nawe v1' },
      { patchVersion: '0.1.0', isProcessRunning: noRunning }
    );
    assert.equal(r1.ok, true);
    assert.equal(r1.mode, 'immediate');
    assert.equal(r1.backupCreated, true);
    assert.equal(r1.originalHash, origHash);
    assert.notEqual(asar.sha256File(mock.asarPath), origHash);
    assert.equal(patcher.inspectAsarState(mock.asarPath).state, 'patched-by-nawe');

    // 2. 重复运行补丁：绝不覆盖原版备份，始终基于干净原版重建
    const r2 = patcher.applyPatch(
      mock.install,
      { 'dist/preload.js': 'console.log("preload");\n// nawe v2' },
      { patchVersion: '0.2.0', isProcessRunning: noRunning }
    );
    assert.equal(r2.backupCreated, false);
    assert.equal(r2.originalHash, origHash);
    const preloadAfterV2 = asar.readFileText(mock.asarPath, 'dist/preload.js');
    assert.ok(preloadAfterV2.includes('// nawe v2'));
    assert.ok(!preloadAfterV2.includes('// nawe v1'), '重复打补丁不应叠加旧补丁');

    // 3. 一键无损还原：字节级精确恢复到官方原版 SHA-256
    const rr = patcher.restoreOriginal(mock.install, { isProcessRunning: noRunning });
    assert.equal(rr.ok, true);
    assert.equal(rr.mode, 'immediate');
    assert.equal(asar.sha256File(mock.asarPath), origHash);
    assert.equal(patcher.inspectAsarState(mock.asarPath).state, 'clean-official');

    // 4. 再次还原应为无操作 no-op
    const rr2 = patcher.restoreOriginal(mock.install, { isProcessRunning: noRunning });
    assert.equal(rr2.alreadyOriginal, true);
  } finally {
    mock.cleanup();
  }
});

test('Official auto-update detection archives new clean version without destroying older backup', () => {
  const mock = createMockAntigravity();
  try {
    const noRunning = () => false;
    const v1Hash = asar.sha256File(mock.asarPath);

    patcher.applyPatch(
      mock.install,
      { 'dist/preload.js': 'console.log("preload");\n// patched' },
      { isProcessRunning: noRunning }
    );

    // 模拟官方自动更新覆盖为新版干净英文 app.asar
    asar.createAsarFromMap(
      {
        'package.json': JSON.stringify({ name: 'antigravity', version: '2.34.0' }),
        'dist/main.js': 'console.log("new official v2.34.0");',
        'dist/preload.js': 'console.log("new preload");',
        'dist/menu.js': 'exports.setupApplicationMenu = () => {};',
        'dist/tray.js': 'exports.createTray = () => {};',
      },
      mock.asarPath
    );
    const v2Hash = asar.sha256File(mock.asarPath);
    assert.notEqual(v2Hash, v1Hash);

    const refreshedInstall = patcher.detectAntigravityInstall(mock.root);
    const r = patcher.applyPatch(
      refreshedInstall,
      { 'dist/preload.js': 'console.log("new preload");\n// nawe on 2.34' },
      { isProcessRunning: noRunning }
    );
    assert.equal(r.backupCreated, true);
    assert.equal(r.originalHash, v2Hash);

    // 验证两份官方原版备份均被保留且互不覆盖
    const bakFiles = fs.readdirSync(refreshedInstall.backupDir).filter((f) => f.endsWith('.orig.bak'));
    assert.equal(bakFiles.length, 2);
  } finally {
    mock.cleanup();
  }
});

test('Third-party contaminated app.asar is refused as clean original base', () => {
  const mock = createMockAntigravity({
    'dist/preload.js': 'const DOM_TRANSLATOR_INJECTION = "汉化";',
  });
  try {
    const state = patcher.inspectAsarState(mock.asarPath);
    assert.equal(state.state, 'modified-by-other');
    assert.throws(
      () => patcher.ensureCleanBackup(mock.install),
      /已被其他第三方工具修改/
    );
  } finally {
    mock.cleanup();
  }
});

test('Running/locked client triggers two-stage safe staging without mutating live app.asar', () => {
  const mock = createMockAntigravity();
  try {
    const origHash = asar.sha256File(mock.asarPath);
    const r = patcher.applyPatch(
      mock.install,
      { 'dist/preload.js': 'console.log("staged");' },
      { simulateLocked: true, launchSwapOnLock: false }
    );
    assert.equal(r.ok, true);
    assert.equal(r.applied, false);
    assert.equal(r.mode, 'staged-pending-restart');
    // 正在运行的 app.asar 毫发无损
    assert.equal(asar.sha256File(mock.asarPath), origHash);
    // staged 包已完整通过 SHA-256 校验
    assert.equal(fs.existsSync(r.stagedFile), true);
    assert.equal(asar.verifyAsar(r.stagedFile, { checkIntegrity: true }).ok, true);
    if (process.platform === 'win32') {
      assert.equal(fs.existsSync(r.swapScriptPath), true);
    }
  } finally {
    mock.cleanup();
  }
});

test('Corrupted backup aborts restore and protects live app.asar', () => {
  const mock = createMockAntigravity();
  try {
    const noRunning = () => false;
    const r = patcher.applyPatch(
      mock.install,
      { 'dist/preload.js': 'console.log("patched");' },
      { isProcessRunning: noRunning }
    );
    const patchedHash = asar.sha256File(mock.asarPath);

    // 破坏原版备份文件
    fs.appendFileSync(r.backupFile, 'corrupted');

    assert.throws(
      () => patcher.restoreOriginal(mock.install, { isProcessRunning: noRunning }),
      /SHA-256 校验未通过/
    );
    assert.equal(asar.sha256File(mock.asarPath), patchedHash);
  } finally {
    mock.cleanup();
  }
});
