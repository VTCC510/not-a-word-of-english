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
const pkg = require('./package.json');

function parseArgs(argv) {
  const args = argv.slice(2);
  const opts = {
    command: null,
    path: null,
    yes: false,
    dryRun: false,
    launchSwap: false,
    noRestart: false,
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
    } else if (tok === '--launch-swap') {
      opts.launchSwap = true;
    } else if (tok === '--no-restart') {
      opts.noRestart = true;
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
  install     执行汉化部署（自动备份原版、校验打包、支持运行中两段换包）
  restore     一键无损还原为官方英文原版

选项:
  --path <路径>   手动指定 Antigravity 安装目录、Antigravity.exe 或 app.asar
  --yes, -y       非交互模式（适合在 Antigravity 内一键自动部署）
  --dry-run       仅生成并校验临时补丁包，不覆盖真实 app.asar
  --launch-swap   检测到客户端正在运行时自动拉起独立换包助手窗口
  --no-restart    换包完成后不自动重新启动 Antigravity
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

function cmdInstall(opts) {
  const install = patcher.detectAntigravityInstall(opts.path);
  const backupInfo = patcher.ensureCleanBackup(install);
  const modifications = builder.buildModifications(backupInfo.sourceAsarPath, {
    version: pkg.version,
  });

  const result = patcher.applyPatch(install, modifications, {
    patchVersion: pkg.version,
    dryRun: opts.dryRun,
    launchSwapOnLock: opts.launchSwap,
    autoRestart: !opts.noRestart,
  });

  if (result.dryRun) {
    console.log('[检验完成] 已生成并校验临时补丁包，未修改真实 app.asar：');
    console.log(`  临时包路径: ${result.stagedFile}`);
    console.log(`  修改文件数: ${result.modifiedFiles.length} (${result.modifiedFiles.join(', ')})`);
    return;
  }

  if (result.mode === 'immediate') {
    console.log('[汉化成功] 已安全完成原版备份并原子替换 app.asar！');
    console.log(`  原版备份: ${result.backupFile}`);
    console.log('  现在启动 Antigravity 即可生效（点击界面右下角悬浮按钮可随时切换标准中文 / 中英对照 / 英文原版）。');
  } else {
    console.log('[补丁已就绪 - 等待重启完成最后 1 秒替换]');
    console.log('检测到 Antigravity 当前正在运行，为防止文件损坏未强行覆盖。');
    console.log(`  已校验的新包: ${result.stagedFile}`);
    if (result.swapScriptPath) {
      console.log(`  换包脚本路径: ${result.swapScriptPath}`);
      if (opts.launchSwap) {
        console.log('  已启动换包助手窗口：现在请完全退出 Antigravity，助手会自动完成替换并重新打开软件！');
      } else {
        console.log('  下一步：双击打开上面的换包脚本，然后右键系统托盘彻底退出 Antigravity，将自动完成替换并重启。');
      }
    }
  }
}

function cmdRestore(opts) {
  const install = patcher.detectAntigravityInstall(opts.path);
  const result = patcher.restoreOriginal(install, {
    launchSwapOnLock: opts.launchSwap,
    autoRestart: !opts.noRestart,
  });

  if (result.alreadyOriginal) {
    console.log('[无需还原] 当前 app.asar 已经与官方原版 SHA-256 完全一致。');
    return;
  }

  if (result.mode === 'immediate') {
    console.log('[还原成功] 已无损恢复为官方英文原版！');
    console.log(`  还原后 SHA-256: ${result.originalHash}`);
  } else {
    console.log('[原版已就绪 - 等待重启完成还原]');
    console.log('检测到 Antigravity 正在运行，原版文件已校验备好。');
    if (result.swapScriptPath) {
      console.log(`  换包脚本路径: ${result.swapScriptPath}`);
      console.log('  请完全退出 Antigravity，再运行该脚本或重新执行 node cli.js restore 完成还原。');
    }
  }
}

async function runInteractiveMenu(opts) {
  printBanner();
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  const ask = (q) => new Promise((resolve) => rl.question(q, resolve));

  try {
    console.log('');
    console.log('  [1] 查看 Antigravity 状态与备份体检（纯只读）');
    console.log('  [2] 一键安全汉化（自动备份原版）');
    console.log('  [3] 一键无损还原为官方英文原版');
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
      case '2':
        cmdInstall({ ...opts, launchSwap: true });
        break;
      case '3':
        cmdRestore({ ...opts, launchSwap: true });
        break;
      case '4':
        cmdVerify(opts);
        break;
      case '5':
        cmdBackup(opts);
        break;
      case '0':
        console.log('已退出。');
        break;
      default:
        console.log('无效选项，已退出。');
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
      case 'restore':
        cmdRestore(opts);
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
