'use strict';

/**
 * tools/auto-heal.js
 * 「一点英语都不会」客户端更新自愈守护模块（零外部依赖）。
 *
 * 解决思路：
 *   Windows 版 Antigravity 每次通过 NSIS 安装器更新时都会重写安装目录下的 resources/app.asar
 *   并清空 resources/.nawe-backups，导致汉化失效；而 ~/.gemini/config/ 属于 Antigravity 官方
 *   用户级持久配置目录，不会被客户端升级覆盖。
 *
 *   本模块提供双层自愈保障：
 *   1. --post-update-watch：由主进程在收到 `updater:quit-and-install` / `updater:apply` 时
 *      脱离安装目录（cwd = os.tmpdir()）后台拉起，等待新版 app.asar 落盘后自动完成原版备份与重打补丁；
 *   2. --session-start：注册到 ~/.gemini/config/hooks.json 的官方 SessionStart 钩子。
 *      正常已汉化时在数毫秒内快速放行 `{}`；一旦检测到客户端刚更新恢复为官方英文原版，立即自动
 *      备份新版、暂存汉化补丁、弹出桌面【确定】一键重启框，并向新对话注入提示卡片。
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const { spawn } = require('child_process');
const asar = require('./asar-lite');
const patcher = require('./patcher');
const builder = require('./build-payload');
const pkg = require('../package.json');

const HOOK_GROUP_KEY = 'not-a-word-of-english';
const STATE_FILE_NAME = '.nawe-auto-heal.json';
const HOOKS_FILE_NAME = 'hooks.json';

function resolveConfigDir(customConfigDir) {
  return customConfigDir || path.join(os.homedir(), '.gemini', 'config');
}

function buildHookCommand(nodeExecPath, autoHealPath, platform = process.platform) {
  if (platform === 'win32') {
    return `call "${nodeExecPath}" "${autoHealPath}" --session-start`;
  }
  return `"${nodeExecPath}" "${autoHealPath}" --session-start`;
}

function writeJsonAtomic(filePath, data) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const tmpPath = `${filePath}.tmp.${process.pid}`;
  fs.writeFileSync(tmpPath, JSON.stringify(data, null, 2) + '\n', 'utf8');
  fs.renameSync(tmpPath, filePath);
}

function readJsonSafe(filePath) {
  if (!fs.existsSync(filePath)) return null;
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (_) {
    return null;
  }
}

function readHooksFileForMerge(hooksFile) {
  if (!fs.existsSync(hooksFile)) return {};
  const raw = fs.readFileSync(hooksFile, 'utf8');
  if (!raw.trim()) return {};
  try {
    const parsed = JSON.parse(raw);
    if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) {
      return parsed;
    }
  } catch (_) {}
  try {
    fs.copyFileSync(hooksFile, `${hooksFile}.bak`);
  } catch (_) {}
  return {};
}

function enableAutoHeal({
  repoDir,
  installInfo,
  nodeExecPath = process.execPath,
  configDir,
  platform = process.platform,
} = {}) {
  const resolvedRepoDir = repoDir || path.resolve(__dirname, '..');
  const resolvedConfigDir = resolveConfigDir(configDir);
  const stateFile = path.join(resolvedConfigDir, STATE_FILE_NAME);
  const hooksFile = path.join(resolvedConfigDir, HOOKS_FILE_NAME);
  const autoHealPath = path.join(resolvedRepoDir, 'tools', 'auto-heal.js');
  const cliPath = path.join(resolvedRepoDir, 'cli.js');

  const prevState = readJsonSafe(stateFile);
  const statePayload = {
    enabled: true,
    version: pkg.version,
    repoDir: resolvedRepoDir,
    cliPath,
    autoHealPath,
    nodeExecPath,
    installDir: installInfo && installInfo.installDir ? installInfo.installDir : null,
    asarPath: installInfo && installInfo.asarPath ? installInfo.asarPath : null,
    exePath: installInfo && installInfo.exePath ? installInfo.exePath : null,
    lastPromptAt: prevState && prevState.lastPromptAt ? prevState.lastPromptAt : null,
    lastHealedVersion: prevState && prevState.lastHealedVersion ? prevState.lastHealedVersion : null,
    lastHealedAt: prevState && prevState.lastHealedAt ? prevState.lastHealedAt : null,
    updatedAt: new Date().toISOString(),
  };

  writeJsonAtomic(stateFile, statePayload);

  const hooksObj = readHooksFileForMerge(hooksFile);
  const command = buildHookCommand(nodeExecPath, autoHealPath, platform);
  hooksObj[HOOK_GROUP_KEY] = {
    SessionStart: [
      {
        type: 'command',
        command,
        timeout: 15,
      },
    ],
  };
  writeJsonAtomic(hooksFile, hooksObj);

  return {
    enabled: true,
    stateFile,
    hooksFile,
    command,
  };
}

function disableAutoHeal({ configDir } = {}) {
  const resolvedConfigDir = resolveConfigDir(configDir);
  const stateFile = path.join(resolvedConfigDir, STATE_FILE_NAME);
  const hooksFile = path.join(resolvedConfigDir, HOOKS_FILE_NAME);

  if (fs.existsSync(hooksFile)) {
    const existing = readJsonSafe(hooksFile);
    if (existing && typeof existing === 'object' && !Array.isArray(existing)) {
      if (Object.prototype.hasOwnProperty.call(existing, HOOK_GROUP_KEY)) {
        delete existing[HOOK_GROUP_KEY];
        if (Object.keys(existing).length === 0) {
          try {
            fs.unlinkSync(hooksFile);
          } catch (_) {}
        } else {
          writeJsonAtomic(hooksFile, existing);
        }
      }
    }
  }

  if (fs.existsSync(stateFile)) {
    try {
      fs.unlinkSync(stateFile);
    } catch (_) {}
  }

  return {
    disabled: true,
    stateFile,
    hooksFile,
  };
}

function getAutoHealStatus({ configDir } = {}) {
  const resolvedConfigDir = resolveConfigDir(configDir);
  const stateFile = path.join(resolvedConfigDir, STATE_FILE_NAME);
  const hooksFile = path.join(resolvedConfigDir, HOOKS_FILE_NAME);
  const state = readJsonSafe(stateFile);
  const hooks = readJsonSafe(hooksFile);
  const hookRegistered = Boolean(
    hooks &&
      typeof hooks === 'object' &&
      hooks[HOOK_GROUP_KEY] &&
      Array.isArray(hooks[HOOK_GROUP_KEY].SessionStart) &&
      hooks[HOOK_GROUP_KEY].SessionStart.length > 0
  );

  return {
    enabled: Boolean(state && state.enabled),
    hookRegistered,
    stateFile,
    hooksFile,
    state,
  };
}

function spawnSwapPrompt(swapScriptPath) {
  if (process.platform !== 'win32' || !swapScriptPath || !fs.existsSync(swapScriptPath)) {
    return false;
  }
  const child = spawn('cmd.exe', ['/c', 'start', '""', '/min', swapScriptPath, '--prompt'], {
    detached: true,
    stdio: 'ignore',
    windowsHide: true,
    cwd: os.tmpdir(),
  });
  child.unref();
  return true;
}

function buildInjectStepsResponse({ appVersion, immediate, cliPath }) {
  const verSuffix = appVersion ? `至 ${appVersion}` : '';
  const batHint = '启动汉化工具.bat';
  const cliApply = cliPath ? `\`node "${cliPath}" apply\`` : '`node cli.js apply`';
  if (immediate) {
    return {
      injectSteps: [
        {
          systemMessage: {
            systemMessage:
              `[not-a-word-of-english] Antigravity was updated (${appVersion || 'new version'}) and overwrote app.asar. ` +
              'Update Auto-Heal has already backed up the new official package and re-applied the Chinese patch automatically. ' +
              'Briefly mention in one Chinese sentence at the end of your reply that the Chinese UI has been automatically restored and will take full effect in new windows or after a restart.',
            metadata: {
              user_markdown:
                `> ✅ **检测到 Antigravity 已更新${verSuffix}**：官方更新覆盖了语言包，「一点英语都不会」自愈守护已自动适配新版并直接完成中文补丁恢复（新打开窗口或重启一次客户端即可生效）。`,
            },
          },
        },
      ],
    };
  }

  return {
    injectSteps: [
      {
        systemMessage: {
          systemMessage:
            `[not-a-word-of-english] Antigravity was updated (${appVersion || 'new version'}) and overwrote app.asar. ` +
            'Update Auto-Heal has already backed up the new official package and staged the Chinese patch. ' +
            `At the end of your reply, briefly remind the user in one Chinese sentence that they can click OK on the restart confirmation popup (or double-click "${batHint}" / run ${cliApply}) to restore the Chinese UI in 2 seconds.`,
          metadata: {
            user_markdown:
              `> 💡 **检测到 Antigravity 已更新${verSuffix}**：官方更新覆盖了语言包，「一点英语都不会」自愈守护已自动适配新版并备好原版汉化内容。点击桌面弹出的 **【确定】** 窗口（或双击汉化目录中的 \`${batHint}\`）即可 2 秒重启恢复中文界面！`,
          },
        },
      },
    ],
  };
}

function runSessionStartCheck({
  configDir,
  spawnPrompt = true,
  cooldownMs = 60000,
  simulateLocked = false,
  isProcessRunning,
} = {}) {
  try {
    const resolvedConfigDir = resolveConfigDir(configDir);
    const stateFile = path.join(resolvedConfigDir, STATE_FILE_NAME);
    const state = readJsonSafe(stateFile);
    if (!state || !state.enabled || !state.asarPath || !fs.existsSync(state.asarPath)) {
      return {};
    }

    // 极速热路径：已存在 .nawe-meta.json 直接返回 {}（< 5ms，不计算全包 SHA-256）
    if (asar.readFileText(state.asarPath, patcher.META_ENTRY_PATH)) {
      return {};
    }

    const current = patcher.inspectAsarState(state.asarPath);
    if (current.state !== 'clean-official') {
      return {};
    }

    const install = patcher.detectAntigravityInstall(state.asarPath);
    const backupInfo = patcher.ensureCleanBackup(install);
    const modifications = builder.buildModifications(backupInfo.sourceAsarPath, {
      version: pkg.version,
    });
    const patchRes = patcher.applyPatch(install, modifications, {
      patchVersion: pkg.version,
      swapLaunchMode: 'prompt',
      autoRestart: true,
      simulateLocked,
      isProcessRunning,
    });

    state.lastHealedVersion = install.appVersion || null;
    state.lastHealedAt = new Date().toISOString();
    state.updatedAt = state.lastHealedAt;

    if (patchRes.mode === 'immediate') {
      writeJsonAtomic(stateFile, state);
      return buildInjectStepsResponse({
        appVersion: install.appVersion,
        immediate: true,
        cliPath: state.cliPath,
      });
    }

    const now = Date.now();
    const lastMs = state.lastPromptAt ? Date.parse(state.lastPromptAt) : 0;
    const canPrompt = Number.isNaN(lastMs) || now - lastMs >= cooldownMs;
    if (spawnPrompt && canPrompt && patchRes.swapScriptPath) {
      if (spawnSwapPrompt(patchRes.swapScriptPath)) {
        state.lastPromptAt = new Date(now).toISOString();
      }
    }
    writeJsonAtomic(stateFile, state);

    return buildInjectStepsResponse({
      appVersion: install.appVersion,
      immediate: false,
      cliPath: state.cliPath,
    });
  } catch (_) {
    // 绝不阻塞 Antigravity 新对话创建
    return {};
  }
}

function sleepMs(ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(resolve, ms);
    if (timer && typeof timer.unref === 'function') timer.unref();
  });
}

async function runPostUpdateWatch({
  configDir,
  initialDelayMs = 4000,
  pollMs = 2500,
  settleMs = 1500,
  maxWaitMs = 180000,
  spawnPrompt = true,
} = {}) {
  try {
    const resolvedConfigDir = resolveConfigDir(configDir);
    const stateFile = path.join(resolvedConfigDir, STATE_FILE_NAME);
    const state = readJsonSafe(stateFile);
    if (!state || !state.enabled || !state.asarPath) {
      return { healed: false, reason: 'disabled' };
    }

    if (initialDelayMs > 0) await sleepMs(initialDelayMs);

    const deadline = Date.now() + maxWaitMs;
    while (Date.now() <= deadline) {
      if (fs.existsSync(state.asarPath) && !patcher.isFileLocked(state.asarPath)) {
        const meta = asar.readFileText(state.asarPath, patcher.META_ENTRY_PATH);
        if (meta === null) {
          if (settleMs > 0) await sleepMs(settleMs);
          const current = patcher.inspectAsarState(state.asarPath);
          if (current.state !== 'clean-official') {
            return { healed: false, reason: current.state };
          }
          const install = patcher.detectAntigravityInstall(state.asarPath);
          const backupInfo = patcher.ensureCleanBackup(install);
          const modifications = builder.buildModifications(backupInfo.sourceAsarPath, {
            version: pkg.version,
          });
          const patchRes = patcher.applyPatch(install, modifications, {
            patchVersion: pkg.version,
            swapLaunchMode: 'prompt',
            autoRestart: true,
          });

          state.lastHealedVersion = install.appVersion || null;
          state.lastHealedAt = new Date().toISOString();
          state.updatedAt = state.lastHealedAt;

          if (patchRes.mode === 'staged-pending-restart' && spawnPrompt && patchRes.swapScriptPath) {
            if (spawnSwapPrompt(patchRes.swapScriptPath)) {
              state.lastPromptAt = new Date().toISOString();
            }
          }
          writeJsonAtomic(stateFile, state);
          return { healed: true, mode: patchRes.mode, appVersion: install.appVersion || null };
        }
      }
      await sleepMs(pollMs);
    }

    return { healed: false, reason: 'timeout' };
  } catch (_) {
    return { healed: false, reason: 'error' };
  }
}

if (require.main === module) {
  const args = process.argv.slice(2);
  if (args.includes('--session-start')) {
    try {
      if (process.stdin && typeof process.stdin.resume === 'function') {
        process.stdin.resume();
        process.stdin.pause();
      }
    } catch (_) {}
    const out = runSessionStartCheck();
    process.stdout.write(JSON.stringify(out) + '\n');
  } else if (args.includes('--post-update-watch')) {
    void runPostUpdateWatch();
  }
}

module.exports = {
  HOOK_GROUP_KEY,
  STATE_FILE_NAME,
  HOOKS_FILE_NAME,
  resolveConfigDir,
  buildHookCommand,
  enableAutoHeal,
  disableAutoHeal,
  getAutoHealStatus,
  runSessionStartCheck,
  runPostUpdateWatch,
};
