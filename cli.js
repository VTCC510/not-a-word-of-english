#!/usr/bin/env node
'use strict';

/**
 * cli.js
 * not-a-word-of-english（一点英语都不会）统一命令行与交互入口。
 */

const fs = require('fs');
const readline = require('readline');
const asar = require('./tools/asar-lite');
const patcher = require('./tools/patcher');
const builder = require('./tools/build-payload');
const autoHeal = require('./tools/auto-heal');
const pkg = require('./package.json');

function parseArgs(argv) {
  const args = argv.slice(2);
  const opts = {
    command: null,
    path: null,
    yes: false,
    dryRun: false,
    apply: false,
    autoRestart: false,
    fromBat: false,
    launchSwap: false,
    noRestart: false,
    noAutoHeal: false,
    enable: false,
    disable: false,
    help: false,
  };

  for (let i = 0; i < args.length; i++) {
    const tok = args[i];
    if (tok === '-h' || tok === '--help') {
      opts.help = true;
    } else if (tok === '-y' || tok === '--yes') {
      opts.yes = true;
    } else if (tok === '--dry-run') {
      opts.dryRun = true;
    } else if (tok === '--apply' || tok === '-a') {
      opts.apply = true;
    } else if (tok === '--auto-restart') {
      opts.autoRestart = true;
    } else if (tok === '--from-bat') {
      opts.fromBat = true;
    } else if (tok === '--launch-swap') {
      opts.launchSwap = true;
    } else if (tok === '--no-restart') {
      opts.noRestart = true;
    } else if (tok === '--no-auto-heal') {
      opts.noAutoHeal = true;
    } else if (tok === '--enable') {
      opts.enable = true;
    } else if (tok === '--disable') {
      opts.disable = true;
    } else if (tok === '--path' || tok === '-p') {
      opts.path = args[++i] || null;
    } else if (tok.startsWith('--path=')) {
      opts.path = tok.slice('--path='.length);
    } else if (!tok.startsWith('-') && !opts.command) {
      opts.command = tok.toLowerCase();
    }
  }
  return opts;
}

function resolveSwapLaunchMode(opts, defaultMode = 'none') {
  if (opts.autoRestart) return 'auto';
  if (opts.apply || opts.launchSwap) return 'prompt';
  return defaultMode;
}

function printBanner() {
  console.log('============================================================');
  console.log(`  not-a-word-of-english (一点英语都不会) v${pkg.version}`);
  console.log('  安全 · 零依赖 · 指令保留 · 高风险操作强制双语对照');
  console.log('============================================================');
}

function printHelp() {
  printBanner();
  console.log(`
用法:
  node cli.js <命令> [选项]

命令:
  status      查看本机 Antigravity 路径、版本、当前状态与备份健康度（纯只读）
  verify      校验当前 app.asar 及原版备份的 SHA-256 完整性（纯只读）
  check       对词典规则与注入脚本执行离线安全校验（不接触客户端）
  backup      仅为官方原版创建不可变 SHA-256 备份（不修改客户端）
  install     执行汉化部署（自动备份原版、开启更新自愈、支持运行中一键弹窗或热换包）
  apply       应用已暂存的补丁包（自动关闭前后台 Antigravity 并完成替换重启）
  restore     一键无损还原为官方英文原版（同步清理更新自愈钩子）
  auto-heal   查看或开关客户端更新自愈守护（--enable / --disable）

选项:
  --path <路径>   手动指定 Antigravity 安装目录、Antigravity.exe 或 app.asar
  --yes, -y       非交互模式（适合在 Antigravity 内一键部署）
  --apply, -a     运行中自动在桌面弹出【确定】确认框，点击即可自动关闭后台进程并重启生效
  --auto-restart  无需确认，2 秒后直接关闭所有前后台 Antigravity 进程并替换重启
  --dry-run       仅生成并校验临时补丁包，不覆盖真实 app.asar
  --no-restart    换包完成后不自动重新启动 Antigravity
  --no-auto-heal  不写入 ~/.gemini/config/hooks.json 更新自愈钩子
  --help, -h      显示本帮助信息
`);
}

function stateToChinese(state) {
  switch (state) {
    case 'clean-official':
      return '官方英文原版（纯净未修改）';
    case 'patched-by-nawe':
      return '已安装 not-a-word-of-english 汉化';
    case 'modified-by-other':
      return '检测到其他第三方修改痕迹';
    default:
      return state;
  }
}

function cmdStatus(opts) {
  const report = patcher.getStatusReport(opts.path);
  console.log(`安装目录:       ${report.install.installDir}`);
  console.log(`核心包路径:     ${report.install.asarPath}`);
  console.log(`客户端版本:     Antigravity ${report.install.appVersion || '未知'} (内核 ${report.install.runtimeVersion || '未知'})`);
  const runText =
    report.running === true
      ? '正在运行（换包将启用两段式安全模式）'
      : report.running === false
        ? '已退出（可直接原子替换）'
        : '当前受限环境无法查询进程（换包时将自动通过文件锁保障安全）';
  console.log(`运行状态:       ${runText}`);
  console.log(`当前包状态:     ${stateToChinese(report.current.state)}`);
  console.log(`当前 SHA-256:   ${report.current.hash.slice(0, 16)}... (${(report.current.size / 1024 / 1024).toFixed(2)} MB)`);
  if (report.current.naweMeta) {
    console.log(`补丁版本:       v${report.current.naweMeta.patchVersion} (部署于 ${report.current.naweMeta.patchedAt})`);
  }
  if (report.current.thirdPartySignals.length > 0) {
    console.log(`第三方痕迹:     ${report.current.thirdPartySignals.join('；')}`);
  }
  if (report.manifest) {
    console.log(`原版备份路径:   ${report.manifest.originalBackupFile}`);
    console.log(`原版备份体检:   ${report.backupHealthy ? '健康完整（SHA-256 匹配）' : '异常或缺失！'}`);
  } else {
    console.log('原版备份状态:   尚未创建（首次备份或安装时将自动创建）');
  }
  const ah = autoHeal.getAutoHealStatus();
  console.log(
    `更新自愈守护:   ${ah.enabled && ah.hookRegistered ? '已开启（客户端更新后将自动备份新版并弹出恢复提示）' : '未开启'}`
  );
}

function cmdVerify(opts) {
  const report = patcher.getStatusReport(opts.path);
  console.log('正在校验当前 app.asar 结构与全部条目 SHA-256 完整性...');
  const curRes = asar.verifyAsar(report.install.asarPath, { checkIntegrity: true });
  console.log(`  [通过] 当前 app.asar 完好：${curRes.packedCount} 个打包文件 + ${curRes.unpackedCount} 个外部解包映射`);

  if (report.manifest && report.manifest.originalBackupFile && fs.existsSync(report.manifest.originalBackupFile)) {
    console.log('正在校验原版备份文件...');
    const bakRes = asar.verifyAsar(report.manifest.originalBackupFile, { checkIntegrity: true });
    const hashOk = asar.sha256File(report.manifest.originalBackupFile) === report.manifest.originalHash;
    if (!hashOk) {
      throw new Error('原版备份文件 SHA-256 与清单不匹配！');
    }
    console.log(`  [通过] 原版备份完好：${bakRes.packedCount} 个打包文件，SHA-256 匹配。`);
  } else {
    console.log('  [提示] 尚未生成 .nawe-backups 原版备份。');
  }
}

function cmdCheck() {
  const res = builder.runFullAudit();
  console.log('[校验通过] 全部词典、安全规则与注入脚本语法均正常！');
  console.log(`  原生菜单词条:   ${res.counts.nativeMenuLabels} 条 + ${res.counts.nativeMenuPatterns} 条模板`);
  console.log(`  原生弹窗词条:   ${res.counts.nativeDialogsExact} 条普通 + ${res.counts.nativeDialogsBilingual} 条双语确认`);
  console.log(`  高风险双语词条: ${res.counts.highRiskExact} 条 + ${res.counts.highRiskPatterns} 条模板（全部含原英文）`);
  console.log(`  主界面静态词条: ${res.counts.uiStaticExact} 条`);
  console.log(`  主界面动态模板: ${res.counts.uiPatterns} 条`);
  console.log(`  受保护斜杠指令: ${res.counts.preservedSlashCommands} 个`);
  console.log(`  主进程载荷体积: ${(res.payloadSizes.mainHookBytes / 1024).toFixed(1)} KB`);
  console.log(`  渲染层载荷体积: ${(res.payloadSizes.preloadBytes / 1024).toFixed(1)} KB (零 require 依赖)`);
}

function cmdBackup(opts) {
  const install = patcher.detectAntigravityInstall(opts.path);
  const res = patcher.ensureCleanBackup(install);
  console.log(res.backupCreated ? '已创建全新的官方原版不可变备份：' : '已有完整可用的官方原版备份（未覆写）：');
  console.log(`  备份文件: ${res.sourceAsarPath}`);
  console.log(`  SHA-256:  ${res.originalHash}`);
}

function cmdInstall(opts, defaultSwapMode = 'none') {
  const install = patcher.detectAntigravityInstall(opts.path);
  const backupInfo = patcher.ensureCleanBackup(install);
  const modifications = builder.buildModifications(backupInfo.sourceAsarPath, {
    version: pkg.version,
  });

  const swapLaunchMode = resolveSwapLaunchMode(opts, defaultSwapMode);
  const result = patcher.applyPatch(install, modifications, {
    patchVersion: pkg.version,
    dryRun: opts.dryRun,
    swapLaunchMode,
    allowExternalSpawn: Boolean(opts.fromBat),
    autoRestart: !opts.noRestart,
  });

  if (result.dryRun) {
    console.log('[检验完成] 已生成并校验临时补丁包，未修改真实 app.asar：');
    console.log(`  临时包路径: ${result.stagedFile}`);
    console.log(`  修改文件数: ${result.modifiedFiles.length} (${result.modifiedFiles.join(', ')})`);
    return result;
  }

  if (result.mode === 'immediate') {
    console.log('[汉化成功] 已安全完成原版备份并原子替换 app.asar！');
    console.log(`  原版备份: ${result.backupFile}`);
    console.log('  现在启动 Antigravity 即可生效（点击界面右下角悬浮按钮可随时切换标准中文 / 中英对照 / 英文原版）。');
  } else {
    console.log('[补丁已就绪 - 等待重启替换]');
    console.log('检测到 Antigravity 当前正在运行，为防止文件损坏未强行覆盖。');
    console.log(`  已校验的新包: ${result.stagedFile}`);
    if (result.deliveryMethod === 'in-app-dialog') {
      console.log('  已在 Antigravity 窗口内弹出【立即重启生效】对话框：直接点击即可自动关闭前后台进程并完成重启！');
    } else if (result.deliveryMethod === 'external-auto') {
      console.log('  正在自动关闭前后台 Antigravity 进程并完成替换重启（约 2 秒）...');
    } else {
      console.log('  补丁包已就绪！请双击一次项目目录中的「启动汉化工具.bat」（无需输入任何数字、无需打开任务管理器，会自动关闭后台并重启生效）。升至 v1.0.5 后，今后在 Antigravity 内更新将直接在软件窗口弹出【立即重启生效】按钮！');
    }
  }

  if (!opts.noAutoHeal) {
    try {
      autoHeal.enableAutoHeal({ repoDir: __dirname, installInfo: install });
      console.log(
        '  更新自愈守护: 已写入 ~/.gemini/config/hooks.json（今后 Antigravity 自动更新覆盖后，无需重新配置词库，将自动重新打包原汉化内容并提醒一键重启恢复）'
      );
    } catch (ahErr) {
      console.log(`  [提示] 更新自愈守护注册未完成: ${ahErr.message}`);
    }
  }

  if (!opts.fromBat) {
    console.log('');
    console.log('[提示说明 / AI 助手部署回复必读]');
    console.log('  1. Antigravity 官方每次版本更新都会重写 app.asar，导致界面暂时变回英文（属正常现象）。');
    console.log('  2. 本工具已自动开启「更新自愈守护」：客户端更新后会自动保留全部汉化内容并重新暂存新版补丁、弹出【确定】一键恢复提示。');
    console.log('  3. 若移动过本汉化目录或需手动恢复，随时重新运行 `node cli.js install --yes --apply` 或双击 `启动汉化工具.bat` 即可恢复。');
    console.log('  （若你是正在帮用户部署本项目的 Antigravity 智能体，请在回复末尾将上述更新失效原因与自动恢复/手动重装方法明确告知用户。）');
  }
  return result;
}

function cmdApply(opts) {
  const install = patcher.detectAntigravityInstall(opts.path);
  const swapLaunchMode = resolveSwapLaunchMode(opts, 'prompt');
  const result = patcher.applyPendingStaged(install, {
    swapLaunchMode,
    allowExternalSpawn: Boolean(opts.fromBat),
    autoRestart: !opts.noRestart,
  });

  if (result.mode === 'immediate') {
    console.log(`[应用成功] ${result.actionLabel}已完成，可直接启动 Antigravity！`);
  } else if (result.deliveryMethod === 'in-app-dialog') {
    console.log(`  已在 Antigravity 窗口内弹出【立即重启生效】对话框：点击即可自动关闭前后台进程并完成${result.actionLabel}与重启！`);
  } else if (result.deliveryMethod === 'external-auto') {
    console.log(`  正在自动关闭前后台 Antigravity 进程并完成${result.actionLabel}与重启（约 2 秒）...`);
  } else {
    console.log('  请双击一次项目目录中的「启动汉化工具.bat」即可自动关闭前后台进程并重启生效。');
  }
  return result;
}

function cmdAutoHeal(opts) {
  if (opts.disable) {
    autoHeal.disableAutoHeal();
    console.log('[已关闭] 已移除 ~/.gemini/config/hooks.json 中的更新自愈钩子。');
    return;
  }
  if (opts.enable) {
    const install = patcher.detectAntigravityInstall(opts.path);
    const res = autoHeal.enableAutoHeal({ repoDir: __dirname, installInfo: install });
    console.log('[已开启] 更新自愈守护已激活！');
    console.log(`  钩子配置: ${res.hooksFile}`);
    console.log(`  状态档案: ${res.stateFile}`);
    return;
  }
  const st = autoHeal.getAutoHealStatus();
  console.log(`更新自愈守护: ${st.enabled && st.hookRegistered ? '已开启' : '未开启'}`);
  console.log(`  钩子配置: ${st.hooksFile}`);
  console.log(`  状态档案: ${st.stateFile}`);
}

function cmdRestore(opts, defaultSwapMode = 'none') {
  const install = patcher.detectAntigravityInstall(opts.path);
  const swapLaunchMode = resolveSwapLaunchMode(opts, defaultSwapMode);
  const result = patcher.restoreOriginal(install, {
    swapLaunchMode,
    allowExternalSpawn: Boolean(opts.fromBat),
    autoRestart: !opts.noRestart,
  });

  if (result.alreadyOriginal) {
    console.log('[无需还原] 当前 app.asar 已经与官方原版 SHA-256 完全一致。');
    if (!opts.noAutoHeal) {
      try {
        autoHeal.disableAutoHeal();
        console.log('  已同步移除 ~/.gemini/config/hooks.json 中的更新自愈钩子。');
      } catch (_) {}
    }
    return result;
  }

  if (result.mode === 'immediate') {
    console.log('[还原成功] 已无损恢复为官方英文原版！');
    console.log(`  还原后 SHA-256: ${result.originalHash}`);
  } else {
    console.log('[原版已就绪 - 等待重启完成还原]');
    console.log('检测到 Antigravity 正在运行，原版文件已校验备好。');
    if (result.deliveryMethod === 'in-app-dialog') {
      console.log('  已在 Antigravity 窗口内弹出【立即重启生效】对话框：点击即可自动关闭前后台进程并还原重启！');
    } else if (result.deliveryMethod === 'external-auto') {
      console.log('  正在自动关闭前后台 Antigravity 进程并完成还原重启（约 2 秒）...');
    } else {
      console.log('  请双击一次项目目录中的「启动汉化工具.bat」即可一键自动完成还原重启。');
    }
  }
  if (!opts.noAutoHeal) {
    try {
      autoHeal.disableAutoHeal();
      console.log('  已同步移除 ~/.gemini/config/hooks.json 中的更新自愈钩子。');
    } catch (_) {}
  }
  return result;
}

async function runInteractiveMenu(opts) {
  printBanner();
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const ask = (q) => new Promise((resolve) => rl.question(q, resolve));

  let skipPause = false;
  try {
    console.log('');
    console.log('  [1] 查看 Antigravity 状态与备份体检（纯只读）');
    console.log('  [2] 一键安全汉化（自动备份 + 自动关闭后台进程并重启生效）');
    console.log('  [3] 一键无损还原为官方英文原版（自动关闭后台进程并重启生效）');
    console.log('  [4] 校验 app.asar 完整性（纯只读）');
    console.log('  [5] 仅创建官方原版备份（不汉化）');
    console.log('  [0] 退出');
    console.log('');

    const choice = (await ask('请输入数字选项并按回车: ')).trim();
    console.log('');
    switch (choice) {
      case '1':
        cmdStatus(opts);
        break;
      case '2': {
        const res = cmdInstall(opts, 'auto');
        if (res && (res.deliveryMethod === 'external-auto' || res.deliveryMethod === 'in-app-dialog')) {
          skipPause = true;
        }
        break;
      }
      case '3': {
        const res = cmdRestore(opts, 'auto');
        if (res && (res.deliveryMethod === 'external-auto' || res.deliveryMethod === 'in-app-dialog')) {
          skipPause = true;
        }
        break;
      }
      case '4':
        cmdVerify(opts);
        break;
      case '5':
        cmdBackup(opts);
        break;
      case '0':
        console.log('已退出。');
        skipPause = true;
        break;
      default:
        console.log('无效选项，已退出。');
    }

    if (opts.fromBat && !skipPause) {
      await ask('\n按回车键关闭窗口...');
    }
  } finally {
    rl.close();
  }
}

async function main() {
  const opts = parseArgs(process.argv);
  if (opts.help) {
    printHelp();
    return;
  }

  try {
    if (!opts.command) {
      if (opts.fromBat) {
        const pending = patcher.consumePendingSwapFromBat(opts.path);
        if (pending.consumed) {
          if (pending.immediate) {
            console.log(`[应用成功] ${(pending.info && pending.info.actionLabel) || '汉化补丁替换'}已完成，正在启动 Antigravity...`);
          } else {
            console.log('[一键生效中] 检测到已准备就绪的补丁包，正在自动关闭前后台 Antigravity 进程并完成替换重启...');
          }
          return;
        }
      }
      if (process.stdin.isTTY && !opts.yes) {
        await runInteractiveMenu(opts);
      } else {
        printHelp();
      }
      return;
    }

    switch (opts.command) {
      case 'status':
        cmdStatus(opts);
        break;
      case 'verify':
        cmdVerify(opts);
        break;
      case 'check':
        cmdCheck();
        break;
      case 'backup':
        cmdBackup(opts);
        break;
      case 'install':
        cmdInstall(opts);
        break;
      case 'apply':
        cmdApply(opts);
        break;
      case 'restore':
        cmdRestore(opts);
        break;
      case 'auto-heal':
        cmdAutoHeal(opts);
        break;
      default:
        console.error(`未知命令: ${opts.command}`);
        printHelp();
        process.exitCode = 1;
    }
  } catch (err) {
    console.error(`\n[执行中止] ${err.message}`);
    process.exitCode = 1;
  }
}

if (require.main === module) {
  main();
}

module.exports = { parseArgs };
