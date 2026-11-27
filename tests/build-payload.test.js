'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const vm = require('node:vm');
const asar = require('../tools/asar-lite');
const patcher = require('../tools/patcher');
const builder = require('../tools/build-payload');

test('All modular dictionaries pass strict security, zero-overlap, and regex audit', () => {
  const audit = builder.runFullAudit();
  assert.equal(audit.ok, true);
  assert.ok(audit.counts.nativeMenuLabels > 40);
  assert.ok(audit.counts.highRiskExact > 60);
  assert.ok(audit.counts.uiStaticExact > 400);
  assert.ok(audit.counts.uiPatterns >= 50);
  assert.equal(audit.overlapWithHighRisk.length, 0, 'ui-static.json must not duplicate high-risk-bilingual keys');
});

test('Generated main-hook and self-contained preload payloads parse cleanly without require() in preload', () => {
  const dicts = builder.loadAndValidateDictionaries();
  const mainHookSrc = builder.buildMainHookModuleSource(dicts);
  const preloadSrc = builder.buildPreloadInjectionSource(dicts, { version: '1.0.0' });
  const framePreloadSrc = builder.buildFramePreloadSource(preloadSrc);

  assert.doesNotThrow(() => new vm.Script(mainHookSrc, { filename: 'dist/nawe-main-hook.js' }));
  assert.doesNotThrow(() => new vm.Script(preloadSrc, { filename: 'dist/preload.js' }));
  assert.doesNotThrow(() => new vm.Script(framePreloadSrc, { filename: 'dist/nawe-frame-preload.js' }));
  assert.ok(!/\brequire\s*\(/.test(preloadSrc), 'Preload injection must not call require()');
  assert.ok(!/\brequire\s*\(/.test(framePreloadSrc), 'Frame preload must not call require()');
  assert.match(framePreloadSrc, /window\.top !== window/);
  assert.match(framePreloadSrc, /plugin:/);
  assert.match(mainHookSrc, /installModuleLoadHook/);

  const rawPreload = 'showContextMenu: (items) => electron_1.ipcRenderer.invoke(\'window:show-context-menu\', items),';
  const patchedPreload = builder.patchPreloadJsSource(rawPreload, '\n// payload\n');
  assert.match(patchedPreload, /__naweTranslateContextMenuItems\(items\)/);
  assert.doesNotThrow(() => new vm.Script('const e = { showContextMenu: (items) => Promise.resolve(items) };'));
});

test('End-to-end buildModifications + patcher dry-run packs and verifies cleanly on mock Antigravity', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'nawe-e2e-build-'));
  try {
    const resources = path.join(root, 'resources');
    fs.mkdirSync(resources, { recursive: true });
    fs.writeFileSync(path.join(root, 'version'), '44.9.1', 'utf8');
    const asarPath = path.join(resources, 'app.asar');

    asar.createAsarFromMap(
      {
        'package.json': JSON.stringify({ name: 'antigravity', version: '2.33.0' }),
        'dist/main.js': '"use strict";\nconst electron = require("electron");\n',
        'dist/preload.js': '"use strict";\n// original preload\n',
        'dist/ideInstall/wizardPreload.js': '"use strict";\n// original wizard preload\n',
      },
      asarPath
    );

    const install = patcher.detectAntigravityInstall(root);
    const origHash = asar.sha256File(asarPath);
    const backup = patcher.ensureCleanBackup(install);
    const mods = builder.buildModifications(backup.sourceAsarPath, { version: '1.0.0' });

    const res = patcher.applyPatch(install, mods, { patchVersion: '1.0.0', dryRun: true });
    assert.equal(res.ok, true);
    assert.equal(res.dryRun, true);
    assert.equal(asar.sha256File(asarPath), origHash, 'dry-run must never modify live app.asar');
    assert.equal(asar.verifyAsar(res.stagedFile, { checkIntegrity: true }).ok, true);
    assert.ok(asar.readFileText(res.stagedFile, 'dist/nawe-main-hook.js'));
    assert.match(asar.readFileText(res.stagedFile, 'dist/main.js'), /NAWE-MAIN-HOOK-BEGIN/);
    assert.match(asar.readFileText(res.stagedFile, 'dist/preload.js'), /NAWE-PRELOAD-ENGINE-BEGIN/);
    const framePreload = asar.readFileText(res.stagedFile, 'dist/nawe-frame-preload.js');
    assert.match(framePreload, /NAWE-FRAME-PRELOAD-BEGIN/);
    assert.match(framePreload, /NAWE-PRELOAD-ENGINE-BEGIN/);
    assert.match(
      asar.readFileText(res.stagedFile, 'dist/ideInstall/wizardPreload.js'),
      /NAWE-PRELOAD-ENGINE-BEGIN/
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
