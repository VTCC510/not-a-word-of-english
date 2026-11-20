'use strict';

/**
 * tools/patcher.js
 * Antigravity 路径探测、SHA-256 防误覆盖备份、两段式热换包与一键无损还原核心控制器。
 *
 * 安全铁律：
 * 1. 独立备份目录：resources/.nawe-backups/，绝不与第三方工具备份混用。
 * 2. 原版备份不可覆写：按 SHA-256 指纹归档官方原版；重复运行补丁时始终以已校验的原版为基底，
 *    绝不把已汉化版误当成原版覆盖备份。
 * 3. 防污染检测：若检测到 app.asar 已被其他第三方汉化修改过，拒绝将其视为官方原版并给出清晰提示。
 * 4. 两段式原子换包：先在备份目录生成 app.asar.staged 并全量校验，再原子替换；
 *    若 Antigravity 正在运行导致文件被锁定，生成独立可审计的脱离换包脚本，等软件退出后自动替换重启。
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { execFileSync, spawn } = require('child_process');
const asar = require('./asar-lite');

const BACKUP_DIR_NAME = '.nawe-backups';
const MANIFEST_NAME = 'manifest.json';
const META_ENTRY_PATH = '.nawe-meta.json';
const STAGED_ASAR_NAME = 'app.asar.staged';
const SWAP_SCRIPT_NAME = 'apply-nawe-swap.cmd';

const THIRD_PARTY_MARKERS = [
  'DOM_TRANSLATOR_INJECTION',
  'CORE_WORDS_UNION_REGEX',
  'data-ag-localization-skip',
];

/**
 * 解析并定位 Antigravity 安装目录与关键文件路径。
 */
function resolveInstallFromInput(inputPath) {
  if (!inputPath) return null;
  const resolved = path.resolve(inputPath);
  if (!fs.existsSync(resolved)) return null;

  const stat = fs.statSync(resolved);
  // 1) 直接传入 app.asar
  if (stat.isFile() && path.basename(resolved).toLowerCase() === 'app.asar') {
    const resourcesDir = path.dirname(resolved);
    const installDir = path.dirname(resourcesDir);
    return buildInstallInfo(installDir, resourcesDir, resolved);
  }
  // 2) 传入 Antigravity.exe
  if (stat.isFile() && path.basename(resolved).toLowerCase().endsWith('.exe')) {
    const installDir = path.dirname(resolved);
    const asarPath = path.join(installDir, 'resources', 'app.asar');
    if (fs.existsSync(asarPath)) {
      return buildInstallInfo(installDir, path.join(installDir, 'resources'), asarPath);
    }
  }
  // 3) 传入安装根目录或 resources 目录或 macOS .app 目录
  if (stat.isDirectory()) {
    const candidates = [
      path.join(resolved, 'resources', 'app.asar'),
      path.join(resolved, 'app.asar'),
      path.join(resolved, 'Contents', 'Resources', 'app.asar'),
    ];
    for (const candidate of candidates) {
      if (fs.existsSync(candidate)) {
        const resourcesDir = path.dirname(candidate);
        const installDir =
          path.basename(resourcesDir).toLowerCase() === 'resources'
            ? path.dirname(resourcesDir)
            : resolved;
        return buildInstallInfo(installDir, resourcesDir, candidate);
      }
    }
  }
  return null;
}

function buildInstallInfo(installDir, resourcesDir, asarPath) {
  const exePath =
    process.platform === 'win32'
      ? path.join(installDir, 'Antigravity.exe')
      : process.platform === 'darwin'
        ? path.join(installDir, 'MacOS', 'Antigravity')
        : path.join(installDir, 'antigravity');

  const versionFile = path.join(installDir, 'version');
  const runtimeVersion = fs.existsSync(versionFile)
    ? fs.readFileSync(versionFile, 'utf8').trim()
    : null;

  let appVersion = null;
  try {
    const pkgText = asar.readFileText(asarPath, 'package.json');
    if (pkgText) {
      appVersion = JSON.parse(pkgText).version || null;
    }
  } catch (_) {}

  return {
    platform: process.platform,
    installDir,
    resourcesDir,
    asarPath,
    exePath: fs.existsSync(exePath) ? exePath : null,
    backupDir: path.join(resourcesDir, BACKUP_DIR_NAME),
    manifestPath: path.join(resourcesDir, BACKUP_DIR_NAME, MANIFEST_NAME),
    runtimeVersion,
    appVersion,
  };
}

/**
 * 自动探测本机 Antigravity 安装位置（优先 Windows，预留 macOS 路径）。
 */
function detectAntigravityInstall(customPath) {
  if (customPath) {
    const found = resolveInstallFromInput(customPath);
    if (!found) {
      throw new Error(`在指定路径未找到有效的 Antigravity (resources/app.asar): ${customPath}`);
    }
    return found;
  }

  const candidates = [];
  if (process.platform === 'win32') {
    const localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
    const programFiles = process.env.ProgramFiles || 'C:\\Program Files';
    const programFilesX86 = process.env['ProgramFiles(x86)'] || 'C:\\Program Files (x86)';
    candidates.push(
      path.join(localAppData, 'Programs', 'antigravity'),
      path.join(localAppData, 'Programs', 'Antigravity'),
      path.join(programFiles, 'Antigravity'),
      path.join(programFilesX86, 'Antigravity')
    );
  } else if (process.platform === 'darwin') {
    candidates.push(
      '/Applications/Antigravity.app',
      path.join(os.homedir(), 'Applications', 'Antigravity.app')
    );
  } else {
    candidates.push('/opt/Antigravity', '/usr/lib/antigravity');
  }

  for (const dir of candidates) {
    const found = resolveInstallFromInput(dir);
    if (found) return found;
  }

  throw new Error(
    '未在默认安装目录探测到 Antigravity，请通过 --path 参数指定 Antigravity.exe 或安装目录路径。'
  );
}

/**
 * 深度体检当前 app.asar 的状态：官方纯净版 / 本项目汉化版 / 其他第三方修改版。
 */
function inspectAsarState(asarPath) {
  const hash = asar.sha256File(asarPath);
  const size = fs.statSync(asarPath).size;

  let naweMeta = null;
  const metaText = asar.readFileText(asarPath, META_ENTRY_PATH);
  if (metaText) {
    try {
      naweMeta = JSON.parse(metaText);
    } catch (_) {
      naweMeta = { parseError: true };
    }
  }

  // 检查是否含有第三方汉化痕迹（仅在无 .nawe-meta.json 时做检查）
  const thirdPartySignals = [];
  if (!naweMeta) {
    const probeFiles = ['dist/preload.js', 'dist/main.js', 'dist/menu.js', 'dist/tray.js'];
    for (const rel of probeFiles) {
      const txt = asar.readFileText(asarPath, rel);
      if (!txt) continue;
      for (const marker of THIRD_PARTY_MARKERS) {
        if (txt.includes(marker)) {
          thirdPartySignals.push(`${rel} 包含第三方补丁特征 (${marker})`);
        }
      }
      if (/[\u4e00-\u9fa5]/.test(txt)) {
        thirdPartySignals.push(`${rel} 包含中文字符（疑似已被其他工具修改）`);
      }
    }
  }

  let state = 'clean-official';
  if (naweMeta) {
    state = 'patched-by-nawe';
  } else if (thirdPartySignals.length > 0) {
    state = 'modified-by-other';
  }

  return {
    asarPath,
    hash,
    size,
    state,
    naweMeta,
    thirdPartySignals,
  };
}

function readManifest(manifestPath) {
  if (!fs.existsSync(manifestPath)) return null;
  try {
    return JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  } catch (err) {
    throw new Error(`备份清单文件损坏 (${manifestPath}): ${err.message}`);
  }
}

function writeManifest(manifestPath, data) {
  fs.mkdirSync(path.dirname(manifestPath), { recursive: true });
  const tmp = `${manifestPath}.tmp.${process.pid}`;
  fs.writeFileSync(tmp, JSON.stringify(data, null, 2) + '\n', 'utf8');
  fs.renameSync(tmp, manifestPath);
}

/**
 * 确保存在经 SHA-256 校验的官方原版备份，并返回本次打补丁应当使用的“纯净源 ASAR 路径”。
 *
 * 绝不允许用已汉化版覆盖原版备份！
 */
function ensureCleanBackup(installInfo, { allowThirdPartyBase = false } = {}) {
  const current = inspectAsarState(installInfo.asarPath);
  const existingManifest = readManifest(installInfo.manifestPath);

  // 情况 1：当前 app.asar 是本项目已经汉化过的版本 -> 复用已有官方原版备份作为基底
  if (current.state === 'patched-by-nawe') {
    if (!existingManifest || !existingManifest.originalBackupFile || !fs.existsSync(existingManifest.originalBackupFile)) {
      throw new Error(
        '当前 app.asar 已是本工具汉化版，但找不到对应的原版备份文件，无法安全重打补丁。请先重装官方原版 Antigravity。'
      );
    }
    const backupHash = asar.sha256File(existingManifest.originalBackupFile);
    if (backupHash !== existingManifest.originalHash) {
      throw new Error(
        `原版备份校验失败（SHA-256 不匹配）！为保障安全已中止操作。备份路径: ${existingManifest.originalBackupFile}`
      );
    }
    return {
      sourceAsarPath: existingManifest.originalBackupFile,
      originalHash: existingManifest.originalHash,
      manifest: existingManifest,
      backupCreated: false,
      currentState: current,
    };
  }

  // 情况 2：当前 app.asar 被其他第三方工具修改过
  if (current.state === 'modified-by-other' && !allowThirdPartyBase) {
    const details = current.thirdPartySignals.slice(0, 4).join('；');
    throw new Error(
      `检测到当前 app.asar 已被其他第三方工具修改，为避免覆盖原版或叠加冲突已中止操作。\n` +
        `检测依据: ${details}\n` +
        `建议：先用原工具还原为官方英文原版（或重新安装官方 Antigravity），再运行本工具。`
    );
  }

  // 情况 3：当前 app.asar 是纯净官方原版（首次安装，或官方刚刚自动更新到了新版）
  fs.mkdirSync(installInfo.backupDir, { recursive: true });
  const shortHash = current.hash.slice(0, 12);
  const backupFileName = `app.asar.${shortHash}.orig.bak`;
  const backupFilePath = path.join(installInfo.backupDir, backupFileName);

  let backupCreated = false;
  if (!fs.existsSync(backupFilePath)) {
    // 原子复制原版到不可变备份路径
    const tmpBak = `${backupFilePath}.tmp.${process.pid}`;
    fs.copyFileSync(installInfo.asarPath, tmpBak);
    const copiedHash = asar.sha256File(tmpBak);
    if (copiedHash !== current.hash) {
      try { fs.unlinkSync(tmpBak); } catch (_) {}
      throw new Error('复制原版备份时发生校验不一致，已自动中止。');
    }
    fs.renameSync(tmpBak, backupFilePath);
    backupCreated = true;
  } else {
    // 校验已存在的同哈希备份是否完整
    const verifiedHash = asar.sha256File(backupFilePath);
    if (verifiedHash !== current.hash) {
      throw new Error(`已有原版备份文件完整性异常: ${backupFilePath}`);
    }
  }

  const now = new Date().toISOString();
  const history = Array.isArray(existingManifest?.history) ? [...existingManifest.history] : [];
  if (backupCreated || !existingManifest || existingManifest.originalHash !== current.hash) {
    history.push({
      event: existingManifest ? 'official-update-backup' : 'initial-clean-backup',
      appVersion: installInfo.appVersion,
      runtimeVersion: installInfo.runtimeVersion,
      originalHash: current.hash,
      backupFile: backupFilePath,
      cleanOriginal: current.state === 'clean-official',
      at: now,
    });
  }

  const nextManifest = {
    schemaVersion: 1,
    project: 'not-a-word-of-english',
    asarPath: installInfo.asarPath,
    appVersion: installInfo.appVersion,
    runtimeVersion: installInfo.runtimeVersion,
    originalHash: current.hash,
    originalBackupFile: backupFilePath,
    cleanOriginal: current.state === 'clean-official',
    updatedAt: now,
    history,
  };
  writeManifest(installInfo.manifestPath, nextManifest);

  return {
    sourceAsarPath: backupFilePath,
    originalHash: current.hash,
    manifest: nextManifest,
    backupCreated,
    currentState: current,
  };
}

/**
 * 检测 Antigravity 客户端进程是否正在运行（Windows 使用原生 tasklist，无需 PowerShell）。
 * 返回值：true（运行中）/ false（未运行）/ null（当前受限环境无法查询系统进程列表）。
 */
function isAntigravityRunning() {
  if (process.platform === 'win32') {
    try {
      const output = execFileSync(
        'tasklist',
        ['/FI', 'IMAGENAME eq Antigravity.exe', '/FO', 'CSV', '/NH'],
        { encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] }
      );
      return /"Antigravity\.exe"/i.test(output);
    } catch (_) {
      return null;
    }
  }
  if (process.platform === 'darwin' || process.platform === 'linux') {
    try {
      execFileSync('pgrep', ['-x', 'Antigravity'], { stdio: 'ignore' });
      return true;
    } catch (err) {
      return err && err.status === 1 ? false : null;
    }
  }
  return null;
}

/**
 * 探测目标 app.asar 当前是否可被独占写入（判断是否被运行中的进程锁住）。
 */
function isFileLocked(filePath) {
  try {
    const fd = fs.openSync(filePath, 'r+');
    fs.closeSync(fd);
    return false;
  } catch (err) {
    if (err && (err.code === 'EBUSY' || err.code === 'EPERM' || err.code === 'EACCES')) {
      return true;
    }
    return false;
  }
}

/**
 * 在 Windows 上生成极简、透明、可审计的独立脱离换包脚本。
 * 该脚本在 Antigravity 完全退出释放文件锁后，自动校验并原子替换 app.asar，随后重新启动 Antigravity。
 */
function createWindowsSwapScript({
  scriptPath,
  stagedFile,
  targetAsar,
  backupFile,
  exePath,
  actionLabel,
  autoRestart = true,
}) {
  const esc = (s) => String(s).replace(/"/g, '');
  const lines = [
    '@echo off',
    'chcp 65001 >nul',
    'setlocal EnableExtensions',
    `echo [not-a-word-of-english] 正在等待 Antigravity 完全退出以执行${actionLabel}...`,
    'set /a RETRIES=0',
    ':WAIT_LOOP',
    'tasklist /FI "IMAGENAME eq Antigravity.exe" /FO CSV /NH 2>nul | find /I "Antigravity.exe" >nul',
    'if %ERRORLEVEL%==0 (',
    '  set /a RETRIES+=1',
    '  if %RETRIES% GEQ 120 (',
    '    echo [错误] 等待 Antigravity 退出超时（120秒），已安全取消替换，原文件未被改动。',
    '    pause',
    '    exit /b 1',
    '  )',
    '  timeout /t 1 /nobreak >nul',
    '  goto WAIT_LOOP',
    ')',
    'timeout /t 1 /nobreak >nul',
    `if not exist "${esc(stagedFile)}" (`,
    '  echo [错误] 找不到已准备好的目标文件，操作中止。',
    '  pause',
    '  exit /b 1',
    ')',
    `move /Y "${esc(stagedFile)}" "${esc(targetAsar)}" >nul`,
    'if %ERRORLEVEL% NEQ 0 (',
    '  echo [错误] 替换 app.asar 失败，正在尝试确保原版完好...',
    `  if not exist "${esc(targetAsar)}" copy /Y "${esc(backupFile)}" "${esc(targetAsar)}" >nul`,
    '  pause',
    '  exit /b 1',
    ')',
    `echo [not-a-word-of-english] ${actionLabel}已安全完成！`,
  ];

  if (autoRestart && exePath) {
    lines.push(`start "" "${esc(exePath)}"`);
  }
  lines.push('endlocal');
  lines.push('del "%~f0" >nul 2>&1');

  fs.writeFileSync(scriptPath, lines.join('\r\n') + '\r\n', 'utf8');
  return scriptPath;
}

/**
 * 原子将准备好的 stagedFile 替换到 targetAsar；如果文件被锁定则进入两段式热换包。
 */
function commitAsarSwap(installInfo, stagedFile, {
  backupFile,
  actionLabel,
  launchSwapOnLock = false,
  autoRestart = true,
  simulateLocked = false,
  isProcessRunning = isAntigravityRunning,
} = {}) {
  const running = simulateLocked || isProcessRunning() === true || isFileLocked(installInfo.asarPath);

  if (!running) {
    const rollbackTmp = `${installInfo.asarPath}.prev.${process.pid}`;
    try {
      // 先把旧 app.asar 临时挪走，再把新 staged 原子挪入，失败时立刻回滚
      fs.renameSync(installInfo.asarPath, rollbackTmp);
      try {
        fs.renameSync(stagedFile, installInfo.asarPath);
      } catch (swapErr) {
        try { fs.renameSync(rollbackTmp, installInfo.asarPath); } catch (_) {}
        throw swapErr;
      }
      try { fs.unlinkSync(rollbackTmp); } catch (_) {}
      return {
        applied: true,
        mode: 'immediate',
        asarPath: installInfo.asarPath,
      };
    } catch (err) {
      if (!fs.existsSync(installInfo.asarPath) && backupFile && fs.existsSync(backupFile)) {
        fs.copyFileSync(backupFile, installInfo.asarPath);
      }
      throw err;
    }
  }

  // 软件正在运行（文件锁定）：保留 staged 文件并生成安全脱离换包脚本
  const swapScriptPath = path.join(installInfo.backupDir, SWAP_SCRIPT_NAME);
  if (process.platform === 'win32') {
    createWindowsSwapScript({
      scriptPath: swapScriptPath,
      stagedFile,
      targetAsar: installInfo.asarPath,
      backupFile,
      exePath: installInfo.exePath,
      actionLabel,
      autoRestart,
    });

    if (launchSwapOnLock) {
      const child = spawn('cmd.exe', ['/c', 'start', '"not-a-word-of-english 换包助手"', swapScriptPath], {
        detached: true,
        stdio: 'ignore',
        windowsHide: false,
      });
      child.unref();
    }
  }

  return {
    applied: false,
    mode: 'staged-pending-restart',
    stagedFile,
    swapScriptPath: process.platform === 'win32' ? swapScriptPath : null,
  };
}

/**
 * 执行补丁安装（接收外部生成的 modifications Map）。
 */
function applyPatch(installInfo, modifications, options = {}) {
  const {
    patchVersion = '0.1.0',
    dryRun = false,
    allowThirdPartyBase = false,
    launchSwapOnLock = false,
    autoRestart = true,
    simulateLocked = false,
    isProcessRunning = isAntigravityRunning,
  } = options;

  const backupInfo = ensureCleanBackup(installInfo, { allowThirdPartyBase });

  const modMap = new Map(modifications instanceof Map ? modifications : Object.entries(modifications));
  const metaPayload = {
    project: 'not-a-word-of-english',
    patchVersion,
    baseOriginalHash: backupInfo.originalHash,
    appVersion: installInfo.appVersion,
    patchedAt: new Date().toISOString(),
    modifiedFiles: [...modMap.keys()].sort(),
  };
  modMap.set(META_ENTRY_PATH, JSON.stringify(metaPayload, null, 2) + '\n');

  const stagedPath = path.join(installInfo.backupDir, STAGED_ASAR_NAME);
  const packResult = asar.patchAsar(backupInfo.sourceAsarPath, stagedPath, modMap);

  if (dryRun) {
    return {
      ok: true,
      dryRun: true,
      mode: 'dry-run',
      stagedFile: stagedPath,
      stagedHash: packResult.sha256,
      originalHash: backupInfo.originalHash,
      backupFile: backupInfo.sourceAsarPath,
      backupCreated: backupInfo.backupCreated,
      modifiedFiles: metaPayload.modifiedFiles,
    };
  }

  const swapResult = commitAsarSwap(installInfo, stagedPath, {
    backupFile: backupInfo.sourceAsarPath,
    actionLabel: '汉化补丁替换',
    launchSwapOnLock,
    autoRestart,
    simulateLocked,
    isProcessRunning,
  });

  const manifest = readManifest(installInfo.manifestPath) || backupInfo.manifest;
  manifest.lastPatchedHash = packResult.sha256;
  manifest.lastPatchedAt = metaPayload.patchedAt;
  manifest.patchVersion = patchVersion;
  writeManifest(installInfo.manifestPath, manifest);

  return {
    ok: true,
    dryRun: false,
    ...swapResult,
    stagedHash: packResult.sha256,
    originalHash: backupInfo.originalHash,
    backupFile: backupInfo.sourceAsarPath,
    backupCreated: backupInfo.backupCreated,
    modifiedFiles: metaPayload.modifiedFiles,
  };
}

/**
 * 一键无损还原为官方英文原版。
 */
function restoreOriginal(installInfo, options = {}) {
  const {
    launchSwapOnLock = false,
    autoRestart = true,
    simulateLocked = false,
    isProcessRunning = isAntigravityRunning,
  } = options;

  const manifest = readManifest(installInfo.manifestPath);
  if (!manifest || !manifest.originalBackupFile || !fs.existsSync(manifest.originalBackupFile)) {
    throw new Error(
      `未找到本工具创建的原版备份清单（${installInfo.manifestPath}）。如果你尚未运行过本工具，当前可能已是原版。`
    );
  }

  const backupHash = asar.sha256File(manifest.originalBackupFile);
  if (backupHash !== manifest.originalHash) {
    throw new Error(
      `备份文件 SHA-256 校验未通过（期望 ${manifest.originalHash}，实际 ${backupHash}），已中止还原以防损坏！`
    );
  }

  // 对备份文件再做一次完整 ASAR 结构校验
  asar.verifyAsar(manifest.originalBackupFile, { checkIntegrity: true });

  const currentHash = asar.sha256File(installInfo.asarPath);
  if (currentHash === manifest.originalHash) {
    return {
      ok: true,
      alreadyOriginal: true,
      mode: 'no-op',
      originalHash: manifest.originalHash,
    };
  }

  // 先把已校验的原版复制到 staged 文件（永不移动/销毁原版备份文件本身！）
  const stagedRestorePath = path.join(installInfo.backupDir, STAGED_ASAR_NAME);
  fs.copyFileSync(manifest.originalBackupFile, stagedRestorePath);

  const swapResult = commitAsarSwap(installInfo, stagedRestorePath, {
    backupFile: manifest.originalBackupFile,
    actionLabel: '官方原版还原',
    launchSwapOnLock,
    autoRestart,
    simulateLocked,
    isProcessRunning,
  });

  manifest.lastRestoredAt = new Date().toISOString();
  writeManifest(installInfo.manifestPath, manifest);

  return {
    ok: true,
    alreadyOriginal: false,
    ...swapResult,
    originalHash: manifest.originalHash,
    backupFile: manifest.originalBackupFile,
  };
}

/**
 * 汇总当前安装状态报告（纯只读）。
 */
function getStatusReport(customPath) {
  const install = detectAntigravityInstall(customPath);
  const current = inspectAsarState(install.asarPath);
  const manifest = readManifest(install.manifestPath);
  let backupHealthy = false;
  if (manifest && manifest.originalBackupFile && fs.existsSync(manifest.originalBackupFile)) {
    try {
      backupHealthy = asar.sha256File(manifest.originalBackupFile) === manifest.originalHash;
    } catch (_) {
      backupHealthy = false;
    }
  }

  return {
    install,
    current,
    manifest,
    backupHealthy,
    running: isAntigravityRunning(),
  };
}

module.exports = {
  BACKUP_DIR_NAME,
  MANIFEST_NAME,
  META_ENTRY_PATH,
  STAGED_ASAR_NAME,
  SWAP_SCRIPT_NAME,
  resolveInstallFromInput,
  detectAntigravityInstall,
  inspectAsarState,
  ensureCleanBackup,
  isAntigravityRunning,
  isFileLocked,
  applyPatch,
  restoreOriginal,
  getStatusReport,
};
