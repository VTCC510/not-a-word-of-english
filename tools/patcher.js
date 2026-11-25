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
const PENDING_SWAP_NAME = 'pending-swap.json';

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

function encodePowerShellScript(lines) {
  return Buffer.from(lines.join('\n'), 'utf16le').toString('base64');
}

function compareSemver(a, b) {
  const parse = (v) =>
    String(v || '0.0.0')
      .replace(/^v/i, '')
      .split('.')
      .slice(0, 3)
      .map((n) => parseInt(n, 10) || 0);
  const pa = parse(a);
  const pb = parse(b);
  for (let i = 0; i < 3; i++) {
    if ((pa[i] || 0) !== (pb[i] || 0)) {
      return (pa[i] || 0) > (pb[i] || 0) ? 1 : -1;
    }
  }
  return 0;
}

/**
 * 判断当前正在运行的 app.asar 是否已内置 v1.0.5+ 主进程热更新监听器。
 */
function hasInAppSwapWatcher(asarPath) {
  try {
    const info = inspectAsarState(asarPath);
    if (info.state !== 'patched-by-nawe' || !info.naweMeta) return false;
    return compareSemver(info.naweMeta.patchVersion, '1.0.5') >= 0;
  } catch (_) {
    return false;
  }
}

/**
 * 在 Windows 上生成透明、可审计的独立脱离换包脚本。
 * 无论通过应用内提示触发、启动批处理触发还是直接双击，都会自动平滑退出并清理后台驻留
 * Antigravity 进程（不使用 /T 以免误伤自身），等待锁释放后原子替换并重新启动。
 */
function createWindowsSwapScript({
  scriptPath,
  stagedFile,
  targetAsar,
  backupFile,
  exePath,
  actionLabel,
  pendingSwapPath = null,
  autoRestart = true,
}) {
  const esc = (s) => String(s).replace(/"/g, '');
  const promptB64 = encodePowerShellScript([
    '$ws = New-Object -ComObject WScript.Shell',
    `$msg = 'not-a-word-of-english 补丁包已通过 SHA-256 安全校验，准备执行${actionLabel}。' + [Environment]::NewLine + [Environment]::NewLine + '点击【确定】将自动关闭所有前后台 Antigravity 进程、完成替换并立即重启客户端（全程约 3 秒）。' + [Environment]::NewLine + '如需稍后操作，请点击【取消】。'`,
    `$title = 'Antigravity 汉化助手 (${actionLabel})'`,
    '$r = $ws.Popup($msg, 0, $title, 0x41041)',
    'if ($r -eq 1) { exit 0 } else { exit 1 }',
  ]);
  const errorB64 = encodePowerShellScript([
    '$ws = New-Object -ComObject WScript.Shell',
    `$msg = '${actionLabel}未能完成，已确保 Antigravity 原文件未被破坏。请关闭所有相关窗口后重新运行汉化命令或双击启动脚本重试。'`,
    `$title = 'Antigravity 汉化助手 - 操作未完成'`,
    '$ws.Popup($msg, 0, $title, 0x41030) | Out-Null',
  ]);

  const lines = [
    '@echo off',
    'chcp 65001 >nul',
    'setlocal EnableExtensions',
    'if /I not "%~1"=="--prompt" goto DO_SWAP',
    'rem Prompt dialog (WScript.Shell.Popup 0x41041)',
    `powershell -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -EncodedCommand ${promptB64}`,
    'if %ERRORLEVEL% NEQ 0 exit /b 0',
    '',
    ':DO_SWAP',
    'echo [not-a-word-of-english] Preparing to apply update...',
  ];

  if (pendingSwapPath) {
    lines.push(`if exist "${esc(pendingSwapPath)}" del /F /Q "${esc(pendingSwapPath)}" >nul 2>&1`);
  }

  lines.push(
    'timeout /t 1 /nobreak >nul',
    'taskkill /IM "Antigravity.exe" >nul 2>&1',
    'timeout /t 1 /nobreak >nul',
    'tasklist /FI "IMAGENAME eq Antigravity.exe" /FO CSV /NH 2>nul | find /I "Antigravity.exe" >nul',
    'if %ERRORLEVEL%==0 (',
    '  echo [not-a-word-of-english] Closing background Antigravity processes...',
    '  taskkill /F /IM "Antigravity.exe" >nul 2>&1',
    ')',
    'set /a RETRIES=0',
    ':WAIT_LOOP',
    'tasklist /FI "IMAGENAME eq Antigravity.exe" /FO CSV /NH 2>nul | find /I "Antigravity.exe" >nul',
    'if %ERRORLEVEL% NEQ 0 goto WAIT_DONE',
    'set /a RETRIES+=1',
    'if %RETRIES% GEQ 20 goto WAIT_TIMEOUT',
    'timeout /t 1 /nobreak >nul',
    'goto WAIT_LOOP',
    '',
    ':WAIT_TIMEOUT',
    'echo [ERROR] Some Antigravity processes did not exit. Swap cancelled safely.',
    'goto SWAP_FAIL',
    '',
    ':WAIT_DONE',
    'timeout /t 1 /nobreak >nul',
    `if exist "${esc(stagedFile)}" goto DO_MOVE`,
    'echo [ERROR] Staged package not found. Operation aborted.',
    'goto SWAP_FAIL',
    '',
    ':DO_MOVE',
    'set /a MOVE_TRIES=0',
    ':MOVE_LOOP',
    `move /Y "${esc(stagedFile)}" "${esc(targetAsar)}" >nul 2>&1`,
    'if %ERRORLEVEL%==0 goto MOVE_OK',
    'set /a MOVE_TRIES+=1',
    'if %MOVE_TRIES% GEQ 15 goto MOVE_FAIL',
    'timeout /t 1 /nobreak >nul',
    'goto MOVE_LOOP',
    '',
    ':MOVE_FAIL',
    'echo [ERROR] Failed to replace app.asar. Verifying original backup...',
    `if not exist "${esc(targetAsar)}" copy /Y "${esc(backupFile)}" "${esc(targetAsar)}" >nul`,
    'goto SWAP_FAIL',
    '',
    ':SWAP_FAIL',
    'if /I "%~1"=="--prompt" (',
    `  powershell -NoProfile -ExecutionPolicy Bypass -WindowStyle Hidden -EncodedCommand ${errorB64}`,
    '  exit /b 1',
    ')',
    'pause',
    'exit /b 1',
    '',
    ':MOVE_OK',
    'echo [not-a-word-of-english] Swap completed safely! Relaunching Antigravity...'
  );

  if (autoRestart && exePath) {
    lines.push(`start "" "${esc(exePath)}"`);
  }
  lines.push('endlocal');
  lines.push('del "%~f0" >nul 2>&1');

  fs.writeFileSync(scriptPath, lines.join('\r\n') + '\r\n', 'utf8');
  return scriptPath;
}

function writePendingSwapSignal(backupDir, payload) {
  fs.mkdirSync(backupDir, { recursive: true });
  const signalPath = path.join(backupDir, PENDING_SWAP_NAME);
  const tmpPath = `${signalPath}.tmp.${process.pid}`;
  fs.writeFileSync(tmpPath, JSON.stringify(payload, null, 2) + '\n', 'utf8');
  fs.renameSync(tmpPath, signalPath);
  return signalPath;
}

function normalizeSwapLaunchMode(swapLaunchMode, launchSwapOnLock) {
  if (swapLaunchMode === 'prompt' || swapLaunchMode === 'auto' || swapLaunchMode === 'none') {
    return swapLaunchMode;
  }
  return launchSwapOnLock ? 'auto' : 'none';
}

/**
 * 原子将准备好的 stagedFile 替换到 targetAsar；如果文件被锁定则进入两段式热换包。
 */
function commitAsarSwap(installInfo, stagedFile, {
  backupFile,
  actionLabel,
  patchVersion = null,
  launchSwapOnLock = false,
  swapLaunchMode,
  autoRestart = true,
  inAppWatcherActive = false,
  allowExternalSpawn = false,
  simulateLocked = false,
  isProcessRunning = isAntigravityRunning,
} = {}) {
  const effectiveLaunchMode = normalizeSwapLaunchMode(swapLaunchMode, launchSwapOnLock);
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
        deliveryMethod: 'immediate',
        asarPath: installInfo.asarPath,
      };
    } catch (err) {
      if (!fs.existsSync(installInfo.asarPath) && backupFile && fs.existsSync(backupFile)) {
        fs.copyFileSync(backupFile, installInfo.asarPath);
      }
      throw err;
    }
  }

  // 软件正在运行（文件锁定）：保留 staged 文件并生成脱离换包脚本 + 写入应用内信号文件
  const swapScriptPath = path.join(installInfo.backupDir, SWAP_SCRIPT_NAME);
  const pendingSwapPath = path.join(installInfo.backupDir, PENDING_SWAP_NAME);
  let deliveryMethod = effectiveLaunchMode === 'none' ? 'staged-only' : 'bat-one-step';
  let helperLaunched = false;

  if (process.platform === 'win32') {
    createWindowsSwapScript({
      scriptPath: swapScriptPath,
      stagedFile,
      targetAsar: installInfo.asarPath,
      backupFile,
      exePath: installInfo.exePath,
      actionLabel,
      pendingSwapPath,
      autoRestart,
    });
  }

  if (effectiveLaunchMode !== 'none') {
    writePendingSwapSignal(installInfo.backupDir, {
      id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      mode: effectiveLaunchMode,
      patchVersion,
      actionLabel,
      stagedFile,
      swapScriptPath: process.platform === 'win32' ? swapScriptPath : null,
      targetAsar: installInfo.asarPath,
      backupFile,
      exePath: installInfo.exePath,
      createdAt: new Date().toISOString(),
    });

    if (inAppWatcherActive) {
      deliveryMethod = 'in-app-dialog';
      helperLaunched = true;
    } else if (allowExternalSpawn && process.platform === 'win32') {
      const child = spawn('cmd.exe', ['/c', 'start', '""', '/min', swapScriptPath, '--auto'], {
        detached: true,
        stdio: 'ignore',
        windowsHide: true,
      });
      child.unref();
      deliveryMethod = 'external-auto';
      helperLaunched = true;
    } else {
      deliveryMethod = 'bat-one-step';
      helperLaunched = false;
    }
  }

  return {
    applied: false,
    mode: 'staged-pending-restart',
    stagedFile,
    pendingSwapPath,
    swapScriptPath: process.platform === 'win32' ? swapScriptPath : null,
    swapLaunchMode: effectiveLaunchMode,
    deliveryMethod,
    helperLaunched,
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
    swapLaunchMode,
    autoRestart = true,
    allowExternalSpawn = false,
    simulateLocked = false,
    isProcessRunning = isAntigravityRunning,
  } = options;

  const inAppWatcherActive = !simulateLocked && hasInAppSwapWatcher(installInfo.asarPath);
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
    patchVersion,
    launchSwapOnLock,
    swapLaunchMode,
    autoRestart,
    inAppWatcherActive,
    allowExternalSpawn,
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
 * 校验并应用已经暂存就绪的 app.asar.staged（供 `node cli.js apply` 一键触发）。
 */
function applyPendingStaged(installInfo, options = {}) {
  const {
    swapLaunchMode = 'prompt',
    autoRestart = true,
    allowExternalSpawn = false,
    simulateLocked = false,
    isProcessRunning = isAntigravityRunning,
  } = options;

  const stagedPath = path.join(installInfo.backupDir, STAGED_ASAR_NAME);
  if (!fs.existsSync(stagedPath)) {
    throw new Error('未找到已暂存的补丁包（app.asar.staged），请先运行 node cli.js install --apply。');
  }

  asar.verifyAsar(stagedPath, { checkIntegrity: true });

  const inAppWatcherActive = !simulateLocked && hasInAppSwapWatcher(installInfo.asarPath);
  const manifest = readManifest(installInfo.manifestPath);
  const backupFile = manifest && manifest.originalBackupFile ? manifest.originalBackupFile : null;
  const metaText = asar.readFileText(stagedPath, META_ENTRY_PATH);
  let patchVersion = null;
  if (metaText) {
    try {
      patchVersion = JSON.parse(metaText).patchVersion || null;
    } catch (_) {}
  }
  const actionLabel = metaText ? '汉化补丁替换' : '官方原版还原';

  const swapResult = commitAsarSwap(installInfo, stagedPath, {
    backupFile,
    actionLabel,
    patchVersion,
    swapLaunchMode,
    autoRestart,
    inAppWatcherActive,
    allowExternalSpawn,
    simulateLocked,
    isProcessRunning,
  });

  return {
    ok: true,
    actionLabel,
    ...swapResult,
  };
}

/**
 * 由「启动汉化工具.bat」调用：消费刚刚暂存的 pending-swap.json 信号并一键完成退后台、换包与重启。
 */
function consumePendingSwapFromBat(customPath) {
  const install = detectAntigravityInstall(customPath);
  const pendingSwapPath = path.join(install.backupDir, PENDING_SWAP_NAME);
  const stagedPath = path.join(install.backupDir, STAGED_ASAR_NAME);
  if (!fs.existsSync(pendingSwapPath) || !fs.existsSync(stagedPath)) {
    return { consumed: false };
  }

  let info;
  try {
    info = JSON.parse(fs.readFileSync(pendingSwapPath, 'utf8'));
  } catch (_) {
    return { consumed: false };
  }

  const createdMs = info && info.createdAt ? Date.parse(info.createdAt) : NaN;
  const expired = !Number.isNaN(createdMs) && Date.now() - createdMs > 30 * 60 * 1000;
  if (!info || expired) {
    try { fs.unlinkSync(pendingSwapPath); } catch (_) {}
    return { consumed: false };
  }

  try {
    asar.verifyAsar(stagedPath, { checkIntegrity: true });
  } catch (_) {
    return { consumed: false };
  }

  try { fs.unlinkSync(pendingSwapPath); } catch (_) {}

  const manifest = readManifest(install.manifestPath);
  const backupFile = info.backupFile || (manifest && manifest.originalBackupFile) || null;
  const actionLabel = info.actionLabel || '汉化补丁替换';
  const swapScriptPath = path.join(install.backupDir, SWAP_SCRIPT_NAME);

  const running = isAntigravityRunning() === true || isFileLocked(install.asarPath);
  if (!running) {
    const swapRes = commitAsarSwap(install, stagedPath, {
      backupFile,
      actionLabel,
      swapLaunchMode: 'none',
    });
    try {
      if (fs.existsSync(swapScriptPath)) fs.unlinkSync(swapScriptPath);
    } catch (_) {}
    if (swapRes.applied && info.exePath && fs.existsSync(info.exePath)) {
      const child = spawn(info.exePath, [], {
        detached: true,
        stdio: 'ignore',
      });
      child.unref();
    }
    return { consumed: true, immediate: Boolean(swapRes.applied), info };
  }

  if (process.platform === 'win32') {
    createWindowsSwapScript({
      scriptPath: swapScriptPath,
      stagedFile: stagedPath,
      targetAsar: install.asarPath,
      backupFile,
      exePath: install.exePath,
      actionLabel,
      pendingSwapPath,
      autoRestart: true,
    });
    const child = spawn('cmd.exe', ['/c', 'start', '""', '/min', swapScriptPath, '--auto'], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    });
    child.unref();
  }

  return { consumed: true, immediate: false, info };
}

/**
 * 一键无损还原为官方英文原版。
 */
function restoreOriginal(installInfo, options = {}) {
  const {
    launchSwapOnLock = false,
    swapLaunchMode,
    autoRestart = true,
    allowExternalSpawn = false,
    simulateLocked = false,
    isProcessRunning = isAntigravityRunning,
  } = options;

  const inAppWatcherActive = !simulateLocked && hasInAppSwapWatcher(installInfo.asarPath);

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
    swapLaunchMode,
    autoRestart,
    inAppWatcherActive,
    allowExternalSpawn,
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
  PENDING_SWAP_NAME,
  compareSemver,
  hasInAppSwapWatcher,
  consumePendingSwapFromBat,
  resolveInstallFromInput,
  detectAntigravityInstall,
  inspectAsarState,
  ensureCleanBackup,
  isAntigravityRunning,
  isFileLocked,
  applyPatch,
  applyPendingStaged,
  restoreOriginal,
  getStatusReport,
};
