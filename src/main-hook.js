'use strict';

/**
 * src/main-hook.js
 * Electron 主进程原生层无侵入 API 轻量代理。
 *
 * 设计原理（只改界面展示，绝不破坏官方业务）：
 * 1. Menu.setApplicationMenu / Menu.getApplicationMenu：
 *    内存中保留原始英文菜单对象给官方 menu.js（保证异步插入 WSL 菜单、View 缩放、macOS 更新回调
 *    完全正常工作），仅在送往操作系统绘制的最后一刻克隆并映射为中文菜单。
 * 2. Menu.prototype.popup：
 *    自动拦截所有运行时动态右键菜单，映射中文后弹出（WeakSet 防递归）。
 * 3. Tray.prototype.setContextMenu：
 *    自动拦截系统托盘菜单与动态智能体数量刷新（"3 agents running" -> "3 个智能体运行中"），
 *    同时保持 WSL 发行版名称等未知专有名词原样不动。
 * 4. dialog.showMessageBox / showMessageBoxSync：
 *    只翻译展示文案字段（title / message / detail / buttons / checkboxLabel），
 *    严格保持 buttons 数组顺序与长度 1:1 不变；对退出确认与高风险弹窗强制保留英文双语对照。
 * 5. 全局异常隔离：任何内部错误都会静默回退到官方原生调用，绝不阻塞软件启动。
 */

const HOOK_FLAG = '__naweMainHookInstalled__';

// 需要保持原有英文标签透传给 click 回调的特殊菜单 ID（例如 macOS 自动更新按 label 查找动作）
const PRESERVE_CLICK_LABEL_IDS = new Set(['check-for-updates']);

// Electron 叶子角色白名单：克隆 MenuItem 时保留 role 以维持原生快捷键与系统行为
const LEAF_ROLES = new Set([
  'undo',
  'redo',
  'cut',
  'copy',
  'paste',
  'pasteandmatchstyle',
  'delete',
  'selectall',
  'reload',
  'forcereload',
  'toggledevtools',
  'resetzoom',
  'zoomin',
  'zoomout',
  'togglefullscreen',
  'minimize',
  'close',
  'quit',
  'about',
  'hide',
  'hideothers',
  'unhide',
  'front',
  'zoom',
  'startspeaking',
  'stopspeaking',
  'services',
  'recentdocuments',
  'clearrecentdocuments',
  'togglespellchecker',
  'showsubstitutions',
  'togglesmartquotes',
  'togglesmartdashes',
  'toggletextreplacement',
  'mergeallwindows',
  'movetabtonewwindow',
  'selectnexttab',
  'selectprevioustab',
  'showalltabs',
]);

// 当原生菜单仅声明 role 而未显式传 label 时，补充标准英文标签用于汉化映射
const ROLE_DEFAULT_LABELS = {
  undo: 'Undo',
  redo: 'Redo',
  cut: 'Cut',
  copy: 'Copy',
  paste: 'Paste',
  pasteandmatchstyle: 'Paste and Match Style',
  delete: 'Delete',
  selectall: 'Select All',
  reload: 'Reload',
  forcereload: 'Force Reload',
  toggledevtools: 'Toggle Developer Tools',
  resetzoom: 'Actual Size',
  zoomin: 'Zoom In',
  zoomout: 'Zoom Out',
  togglefullscreen: 'Toggle Full Screen',
  minimize: 'Minimize',
  close: 'Close',
  quit: 'Quit',
};

// 识别潜在高风险/确认型系统弹窗关键词（此类弹窗若未收录在词库中，坚决保持英文原样或双语对照）
const HIGH_RISK_DIALOG_RE =
  /\b(quit|exit|delete|remove|erase|format|permission|sandbox|bypass|execute|shell|command|certificate|security|trust|admin|elevate|overwrite|reset)\b/i;

function compilePatterns(list) {
  const out = [];
  if (!Array.isArray(list)) return out;
  for (const item of list) {
    if (!item || typeof item.pattern !== 'string' || typeof item.replacement !== 'string') continue;
    try {
      out.push({
        regex: new RegExp(item.pattern, item.flags || ''),
        replacement: item.replacement,
      });
    } catch (_) {}
  }
  return out;
}

function normalizeNativeText(str) {
  return String(str || '')
    .replace(/[\u2018\u2019]/g, "'")
    .replace(/[\u201c\u201d]/g, '"')
    .replace(/\u2026/g, '...')
    .replace(/[\u2013\u2014]/g, '-')
    .replace(/\u00a0/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function splitNativeTrailingPunct(norm) {
  const m = String(norm || '').match(/^([\s\S]*?)(\.{3}|[.!?:])$/);
  if (!m) return { base: norm, suffix: '' };
  return { base: m[1].trimEnd(), suffix: m[2] };
}

function adaptNativeTrailingPunct(zh, suffix) {
  const stem = String(zh || '').replace(/(?:\.{3}|[\u2026。！？：:?!.])$/, '');
  if (!stem) return zh;
  if (suffix === '...') return `${stem}...`;
  if (suffix === ':') return `${stem}：`;
  if (suffix === '.') return `${stem}。`;
  if (suffix === '!') return `${stem}！`;
  if (suffix === '?') return `${stem}？`;
  return stem;
}

/**
 * 构建原生层文案翻译器。
 */
function createNativeTranslator(dict) {
  const safeDict = dict && typeof dict === 'object' ? dict : {};
  const menuExact = new Map();
  const menuLower = new Map();
  const menuNorm = new Map();
  const menuBase = new Map();
  for (const [k, v] of Object.entries(safeDict.menuLabels || {})) {
    menuExact.set(k, v);
    menuLower.set(k.toLowerCase(), v);
    const norm = normalizeNativeText(k).toLowerCase();
    if (norm && !menuNorm.has(norm)) menuNorm.set(norm, v);
    const { base, suffix } = splitNativeTrailingPunct(norm);
    if (base.length >= 3 && (!menuBase.has(base) || suffix === '')) {
      menuBase.set(base, v);
    }
  }
  const menuPatterns = compilePatterns(safeDict.menuPatterns);

  const dialogExact = new Map(Object.entries((safeDict.dialogs && safeDict.dialogs.exact) || {}));
  const dialogNorm = new Map();
  for (const [k, v] of dialogExact.entries()) {
    const norm = normalizeNativeText(k).toLowerCase();
    if (norm && !dialogNorm.has(norm)) dialogNorm.set(norm, { origKey: k, value: v });
  }
  const dialogBilingual = new Map(
    Object.entries((safeDict.dialogs && safeDict.dialogs.bilingualConfirm) || {})
  );
  const dialogBilingualNorm = new Map();
  for (const [k, v] of dialogBilingual.entries()) {
    const norm = normalizeNativeText(k).toLowerCase();
    if (norm && !dialogBilingualNorm.has(norm)) dialogBilingualNorm.set(norm, v);
  }
  const dialogPatterns = compilePatterns(safeDict.dialogs && safeDict.dialogs.patterns);

  /**
   * 规范化 Windows 菜单快捷键助记符（如 "&File" -> "File"）。
   */
  function stripMnemonic(label) {
    return label.replace(/&([A-Za-z0-9])/g, '$1').trim();
  }

  function translateMenuLabel(raw) {
    if (typeof raw !== 'string' || !raw.trim()) return raw;
    // 已经是中文则直接放行
    if (/[\u4e00-\u9fa5]/.test(raw)) return raw;

    const clean = stripMnemonic(raw);
    if (menuExact.has(clean)) return menuExact.get(clean);
    if (menuLower.has(clean.toLowerCase())) return menuLower.get(clean.toLowerCase());

    const norm = normalizeNativeText(clean);
    const normLow = norm.toLowerCase();
    if (menuNorm.has(normLow)) return menuNorm.get(normLow);

    for (const rule of menuPatterns) {
      if (rule.regex.test(clean)) {
        return clean.replace(rule.regex, rule.replacement);
      }
      if (norm !== clean && rule.regex.test(norm)) {
        return norm.replace(rule.regex, rule.replacement);
      }
    }

    const { base, suffix } = splitNativeTrailingPunct(normLow);
    if (base.length >= 3 && menuBase.has(base)) {
      const zh = menuBase.get(base);
      const isOrigEllipsis = clean.trim().endsWith('\u2026');
      if (!suffix) return adaptNativeTrailingPunct(zh, '');
      return isOrigEllipsis && suffix === '...'
        ? `${zh.replace(/(?:\.{3}|[\u2026。！？：:?!.])$/, '')}\u2026`
        : adaptNativeTrailingPunct(zh, suffix);
    }
    return raw;
  }

  function translateDialogText(raw, { preferBilingual = false } = {}) {
    if (typeof raw !== 'string' || !raw.trim()) return raw;
    if (/[\u4e00-\u9fa5]/.test(raw)) return raw;

    const trimmed = raw.trim();
    if (dialogBilingual.has(trimmed)) {
      return dialogBilingual.get(trimmed);
    }
    const norm = normalizeNativeText(trimmed);
    const normLow = norm.toLowerCase();
    if (dialogBilingualNorm.has(normLow)) {
      return dialogBilingualNorm.get(normLow);
    }
    if (dialogExact.has(trimmed)) {
      const zh = dialogExact.get(trimmed);
      return preferBilingual && HIGH_RISK_DIALOG_RE.test(trimmed) ? `${zh} (${trimmed})` : zh;
    }
    if (dialogNorm.has(normLow)) {
      const hit = dialogNorm.get(normLow);
      return preferBilingual && HIGH_RISK_DIALOG_RE.test(trimmed) ? `${hit.value} (${trimmed})` : hit.value;
    }
    for (const rule of dialogPatterns) {
      if (rule.regex.test(trimmed)) {
        const zh = trimmed.replace(rule.regex, rule.replacement);
        return preferBilingual && HIGH_RISK_DIALOG_RE.test(trimmed)
          ? `${zh}\n(${trimmed})`
          : zh;
      }
      if (norm !== trimmed && rule.regex.test(norm)) {
        const zh = norm.replace(rule.regex, rule.replacement);
        return preferBilingual && HIGH_RISK_DIALOG_RE.test(trimmed)
          ? `${zh}\n(${trimmed})`
          : zh;
      }
    }
    return raw;
  }

  function translateDialogOptions(options) {
    if (!options || typeof options !== 'object') return options;
    const combinedText = `${options.title || ''} ${options.message || ''} ${options.detail || ''}`;
    const isHighRisk = HIGH_RISK_DIALOG_RE.test(combinedText);

    // 浅拷贝，绝不修改调用方原始 options 对象
    const next = { ...options };
    if (typeof next.title === 'string') {
      next.title = translateDialogText(next.title, { preferBilingual: isHighRisk });
    }
    if (typeof next.message === 'string') {
      next.message = translateDialogText(next.message, { preferBilingual: isHighRisk });
    }
    if (typeof next.detail === 'string') {
      next.detail = translateDialogText(next.detail, { preferBilingual: isHighRisk });
    }
    if (typeof next.checkboxLabel === 'string') {
      next.checkboxLabel = translateDialogText(next.checkboxLabel, { preferBilingual: isHighRisk });
    }
    // 严格保持 buttons 数组长度与索引顺序 1:1 不变
    if (Array.isArray(next.buttons)) {
      next.buttons = next.buttons.map((btn) =>
        typeof btn === 'string'
          ? translateDialogText(btn, { preferBilingual: isHighRisk })
          : btn
      );
    }
    return next;
  }

  /**
   * 仅翻译文件选择框的展示字段（title / buttonLabel / message），绝不修改 defaultPath 或 filters。
   */
  function translateFileDialogOptions(options) {
    if (!options || typeof options !== 'object') return options;
    const next = { ...options };
    if (typeof next.title === 'string') {
      next.title = translateDialogText(next.title, { preferBilingual: false });
    }
    if (typeof next.buttonLabel === 'string') {
      next.buttonLabel = translateDialogText(next.buttonLabel, { preferBilingual: false });
    }
    if (typeof next.message === 'string') {
      next.message = translateDialogText(next.message, { preferBilingual: false });
    }
    return next;
  }

  return {
    translateMenuLabel,
    translateDialogText,
    translateDialogOptions,
    translateFileDialogOptions,
  };
}

/**
 * 将一个已有的 Electron Menu 实例无损克隆为中文展示模板。
 */
function menuToLocalizedTemplate(menuInstance, translator, { isRoot = false } = {}) {
  const items = Array.isArray(menuInstance && menuInstance.items) ? menuInstance.items : [];
  const template = [];

  for (const item of items) {
    if (!item) continue;

    if (item.type === 'separator') {
      template.push({
        type: 'separator',
        visible: item.visible !== false,
      });
      continue;
    }

    const roleLowerPre = typeof item.role === 'string' ? item.role.toLowerCase() : '';
    const origLabel =
      typeof item.label === 'string' && item.label
        ? item.label
        : ROLE_DEFAULT_LABELS[roleLowerPre] || '';
    const translatedLabel = translator.translateMenuLabel(origLabel);
    const entry = {
      label: translatedLabel,
      enabled: item.enabled !== false,
      visible: item.visible !== false,
    };

    if (item.id) entry.id = item.id;
    if (item.sublabel) entry.sublabel = translator.translateMenuLabel(item.sublabel);
    if (item.toolTip) entry.toolTip = translator.translateMenuLabel(item.toolTip);
    if (item.accelerator) {
      entry.accelerator = item.accelerator;
      if (item.acceleratorWorksWhenHidden !== undefined) {
        entry.acceleratorWorksWhenHidden = item.acceleratorWorksWhenHidden;
      }
    }
    if (item.type === 'checkbox' || item.type === 'radio') {
      entry.type = item.type;
      entry.checked = Boolean(item.checked);
    }

    if (item.submenu && Array.isArray(item.submenu.items)) {
      // 有子菜单的父级项：递归克隆子菜单，避免传顶层 role 导致覆盖自定义子项
      entry.type = 'submenu';
      entry.submenu = menuToLocalizedTemplate(item.submenu, translator, { isRoot: false });
    } else {
      const roleLower = typeof item.role === 'string' ? item.role.toLowerCase() : '';
      if (roleLower && LEAF_ROLES.has(roleLower)) {
        entry.role = item.role;
      }
      if (typeof item.click === 'function') {
        const origClick = item.click;
        const shouldPreserveLabel =
          Boolean(item.id && PRESERVE_CLICK_LABEL_IDS.has(item.id)) ||
          (!roleLower && origLabel !== translatedLabel);

        if (shouldPreserveLabel) {
          entry.click = (menuItem, browserWindow, event) => {
            // 向原始回调透传带有英文原 label 的代理对象，防止按 menuItem.label 分发动作失效
            const proxyItem =
              menuItem && typeof menuItem === 'object'
                ? Object.create(menuItem, {
                    label: {
                      value: origLabel,
                      enumerable: true,
                      configurable: true,
                    },
                  })
                : menuItem;
            return origClick.call(item, proxyItem, browserWindow, event);
          };
        } else {
          entry.click = origClick;
        }
      }
    }

    // 保留空标签项（如 macOS 首项应用名菜单）
    if (isRoot && !entry.label && origLabel) {
      entry.label = origLabel;
    }
    template.push(entry);
  }

  return template;
}

const APP_MENU_BAR_LABELS = new Set(['file', 'edit', 'view', 'window', 'help', 'antigravity']);

function safeOverride(target, key, value) {
  if (!target || (typeof target !== 'object' && typeof target !== 'function')) return false;
  try {
    target[key] = value;
    if (target[key] === value) return true;
  } catch (_) {}
  try {
    Object.defineProperty(target, key, {
      value,
      writable: true,
      configurable: true,
      enumerable: true,
    });
    return target[key] === value;
  } catch (_) {
    return false;
  }
}

function isAppMenuBarTemplate(template) {
  if (!Array.isArray(template) || template.length === 0) return false;
  for (const item of template) {
    if (!item || typeof item !== 'object') continue;
    if (item.id && PRESERVE_CLICK_LABEL_IDS.has(item.id)) return true;
    const labelClean =
      typeof item.label === 'string' ? item.label.replace(/&([A-Za-z0-9])/g, '$1').trim().toLowerCase() : '';
    if (Array.isArray(item.submenu) && labelClean && APP_MENU_BAR_LABELS.has(labelClean)) {
      return true;
    }
    if (Array.isArray(item.submenu) && isAppMenuBarTemplate(item.submenu)) {
      return true;
    }
  }
  return false;
}

/**
 * 递归翻译传入 Menu.buildFromTemplate 的菜单模板对象数组，绝不修改 id/role/click/accelerator 等业务字段。
 */
function translateMenuTemplate(template, translator) {
  if (!Array.isArray(template) || !translator) return template;
  return template.map((item) => {
    if (!item || typeof item !== 'object') return item;
    if (item.type === 'separator') return { ...item };

    const next = { ...item };
    const roleLower = typeof item.role === 'string' ? item.role.toLowerCase() : '';
    if (typeof item.label === 'string' && item.label) {
      next.label = translator.translateMenuLabel(item.label);
    } else if (roleLower && ROLE_DEFAULT_LABELS[roleLower]) {
      next.label = translator.translateMenuLabel(ROLE_DEFAULT_LABELS[roleLower]);
    }
    if (typeof item.sublabel === 'string' && item.sublabel) {
      next.sublabel = translator.translateMenuLabel(item.sublabel);
    }
    if (typeof item.toolTip === 'string' && item.toolTip) {
      next.toolTip = translator.translateMenuLabel(item.toolTip);
    }
    if (Array.isArray(item.submenu)) {
      next.submenu = translateMenuTemplate(item.submenu, translator);
    }
    return next;
  });
}

/**
 * 递归翻译渲染进程通过 IPC 传入的右键菜单原始对象数组，绝不修改 item.id 等回调标识。
 */
function translateContextMenuItems(items, translator) {
  if (!Array.isArray(items) || !translator) return items;
  return items.map((item) => {
    if (!item || typeof item !== 'object') return item;
    const next = { ...item };
    if (typeof next.label === 'string' && next.label) {
      next.label = translator.translateMenuLabel(next.label);
    }
    if (typeof next.sublabel === 'string' && next.sublabel) {
      next.sublabel = translator.translateMenuLabel(next.sublabel);
    }
    if (typeof next.toolTip === 'string' && next.toolTip) {
      next.toolTip = translator.translateMenuLabel(next.toolTip);
    }
    if (Array.isArray(next.submenu)) {
      next.submenu = translateContextMenuItems(next.submenu, translator);
    }
    return next;
  });
}

function hasTranslatableMenuItem(menuInstance, translator) {
  const items = Array.isArray(menuInstance && menuInstance.items) ? menuInstance.items : [];
  for (const item of items) {
    if (!item || item.type === 'separator') continue;
    const roleLower = typeof item.role === 'string' ? item.role.toLowerCase() : '';
    const origLabel =
      typeof item.label === 'string' && item.label
        ? item.label
        : ROLE_DEFAULT_LABELS[roleLower] || '';
    if (origLabel && !/[\u4e00-\u9fa5]/.test(origLabel) && translator.translateMenuLabel(origLabel) !== origLabel) {
      return true;
    }
    if (
      typeof item.sublabel === 'string' &&
      item.sublabel &&
      !/[\u4e00-\u9fa5]/.test(item.sublabel) &&
      translator.translateMenuLabel(item.sublabel) !== item.sublabel
    ) {
      return true;
    }
    if (
      typeof item.toolTip === 'string' &&
      item.toolTip &&
      !/[\u4e00-\u9fa5]/.test(item.toolTip) &&
      translator.translateMenuLabel(item.toolTip) !== item.toolTip
    ) {
      return true;
    }
    if (item.submenu && Array.isArray(item.submenu.items) && hasTranslatableMenuItem(item.submenu, translator)) {
      return true;
    }
  }
  return false;
}

function installPluginSidecarInjector(electron, options = {}) {
  if (!electron || !electron.app || typeof electron.app.on !== 'function') {
    return { active: false };
  }

  let cachedPayload;
  function getPayload() {
    if (cachedPayload !== undefined) return cachedPayload;
    if (typeof options.sidecarPayloadSource === 'string') {
      cachedPayload = options.sidecarPayloadSource;
      return cachedPayload;
    }
    try {
      const fs = require('fs');
      const path = require('path');
      const preloadPath = path.join(__dirname, 'preload.js');
      const raw = fs.readFileSync(preloadPath, 'utf8');
      const beginMarker = '/* [NAWE-PRELOAD-ENGINE-BEGIN] */';
      const endMarker = '/* [NAWE-PRELOAD-ENGINE-END] */';
      const startIdx = raw.indexOf(beginMarker);
      const endIdx = raw.indexOf(endMarker, startIdx + beginMarker.length);
      if (startIdx !== -1 && endIdx !== -1) {
        cachedPayload = raw.slice(startIdx, endIdx + endMarker.length);
        return cachedPayload;
      }
    } catch (_) {}
    cachedPayload = '';
    return cachedPayload;
  }

  electron.app.on('web-contents-created', (_ev, contents) => {
    if (!contents || typeof contents.on !== 'function') return;
    contents.on('did-frame-finish-load', (event, _isMainFrame, frameProcessId, frameRoutingId) => {
      try {
        const frame =
          (event && event.frame) ||
          (electron.webFrameMain && typeof electron.webFrameMain.fromId === 'function'
            ? electron.webFrameMain.fromId(frameProcessId, frameRoutingId)
            : null);
        if (
          !frame ||
          typeof frame.url !== 'string' ||
          !frame.url.startsWith('plugin://') ||
          typeof frame.executeJavaScript !== 'function'
        ) {
          return;
        }
        const payload = getPayload();
        if (!payload) return;
        Promise.resolve(frame.executeJavaScript(payload, false)).catch(() => {});
      } catch (_) {}
    });
  });

  return { active: true };
}

/**
 * 同步监测诸如 check-for-updates 等动态修改原菜单项 label 的行为，自动同步到展示菜单。
 */
function bindDynamicLabelSync(rawMenu, localizedMenu, translator) {
  if (!rawMenu || !localizedMenu) return;
  if (typeof rawMenu.getMenuItemById !== 'function' || typeof localizedMenu.getMenuItemById !== 'function') {
    return;
  }
  for (const id of PRESERVE_CLICK_LABEL_IDS) {
    const rawItem = rawMenu.getMenuItemById(id);
    const locItem = localizedMenu.getMenuItemById(id);
    if (!rawItem || !locItem || rawItem.__naweSynced__) continue;

    let currentRawLabel = rawItem.label;
    try {
      Object.defineProperty(rawItem, 'label', {
        configurable: true,
        enumerable: true,
        get() {
          return currentRawLabel;
        },
        set(nextVal) {
          currentRawLabel = nextVal;
          try {
            locItem.label = translator.translateMenuLabel(nextVal);
          } catch (_) {}
        },
      });
      Object.defineProperty(rawItem, '__naweSynced__', { value: true, enumerable: false });
    } catch (_) {}
  }
}

function resolveDefaultPendingSwapPath() {
  try {
    const path = require('path');
    const parentDir = path.dirname(__dirname);
    if (path.basename(parentDir).toLowerCase() === 'app.asar') {
      return path.join(path.dirname(parentDir), '.nawe-backups', 'pending-swap.json');
    }
  } catch (_) {}
  return null;
}

/**
 * 监听本地 pending-swap.json 信号文件：
 * 当新版本补丁就绪时直接在 Antigravity 窗口内弹出原生中文【立即重启生效】对话框，
 * 避免 AI 命令沙盒隐藏弹窗限制，让用户一键完成自动退后台、换包与重启。
 */
function startPendingSwapWatcher(electron, rawShowMessageBox, options = {}) {
  const pendingSwapPath =
    options.pendingSwapPath !== undefined ? options.pendingSwapPath : resolveDefaultPendingSwapPath();
  if (!pendingSwapPath) {
    return { active: false };
  }

  let fs;
  let spawn;
  try {
    fs = require('fs');
    spawn = require('child_process').spawn;
  } catch (_) {
    return { active: false };
  }

  const pollIntervalMs = options.pollIntervalMs || 1500;
  let promptActive = false;
  const handledIds = new Set();

  function defaultTriggerSwap(info) {
    try {
      if (process.platform === 'win32' && info.swapScriptPath && fs.existsSync(info.swapScriptPath)) {
        const child = spawn('cmd.exe', ['/c', info.swapScriptPath, '--auto'], {
          detached: true,
          stdio: 'ignore',
          windowsHide: true,
        });
        child.unref();
      }
    } catch (_) {}
    const t = setTimeout(() => {
      try {
        if (electron.app && typeof electron.app.exit === 'function') {
          electron.app.exit(0);
        }
      } catch (_) {}
    }, 150);
    if (t && typeof t.unref === 'function') t.unref();
  }

  const triggerFn = typeof options.triggerSwapFn === 'function' ? options.triggerSwapFn : defaultTriggerSwap;

  async function checkOnce() {
    if (promptActive) return;
    try {
      if (!fs.existsSync(pendingSwapPath)) return;
      const rawText = fs.readFileSync(pendingSwapPath, 'utf8');
      let info;
      try {
        info = JSON.parse(rawText);
      } catch (_) {
        return;
      }
      if (!info || typeof info !== 'object') {
        try { fs.unlinkSync(pendingSwapPath); } catch (_) {}
        return;
      }

      const reqId = String(info.id || info.createdAt || '');
      if (reqId && handledIds.has(reqId)) return;

      const createdMs = info.createdAt ? Date.parse(info.createdAt) : NaN;
      const expired = !Number.isNaN(createdMs) && Date.now() - createdMs > 10 * 60 * 1000;
      if (expired || !info.stagedFile || !fs.existsSync(info.stagedFile)) {
        try { fs.unlinkSync(pendingSwapPath); } catch (_) {}
        return;
      }

      if (reqId) handledIds.add(reqId);
      try { fs.unlinkSync(pendingSwapPath); } catch (_) {}

      promptActive = true;
      let confirmed = false;
      try {
        if (info.mode === 'auto') {
          confirmed = true;
        } else if (typeof rawShowMessageBox === 'function') {
          const win =
            (electron.BrowserWindow &&
              typeof electron.BrowserWindow.getFocusedWindow === 'function' &&
              electron.BrowserWindow.getFocusedWindow()) ||
            (electron.BrowserWindow &&
              typeof electron.BrowserWindow.getAllWindows === 'function' &&
              electron.BrowserWindow.getAllWindows()[0]) ||
            null;
          const labelText = info.actionLabel || '汉化补丁更新';
          const verText = info.patchVersion ? ` v${info.patchVersion}` : '';
          const msgOpts = {
            type: 'info',
            buttons: ['立即重启生效', '稍后手动重启'],
            defaultId: 0,
            cancelId: 1,
            noLink: true,
            title: '一点英语都不会 (not-a-word-of-english)',
            message: `${labelText}${verText} 已准备就绪，是否立即自动重启生效？`,
            detail:
              '补丁包已通过 SHA-256 完整性校验。\n点击「立即重启生效」将自动关闭所有前后台 Antigravity 进程、完成替换并重新打开（全程约 2 秒，无需打开任务管理器或查找脚本）。',
          };
          const res = win ? await rawShowMessageBox(win, msgOpts) : await rawShowMessageBox(msgOpts);
          confirmed = Boolean(res && res.response === 0);
        }

        if (confirmed) {
          triggerFn(info);
        }
      } finally {
        promptActive = false;
      }
    } catch (_) {
      promptActive = false;
    }
  }

  let timer = null;
  function startPolling() {
    if (timer) return;
    timer = setInterval(() => {
      void checkOnce();
    }, pollIntervalMs);
    if (timer && typeof timer.unref === 'function') timer.unref();
  }

  if (electron.app && typeof electron.app.whenReady === 'function') {
    Promise.resolve(electron.app.whenReady())
      .then(() => {
        startPolling();
        void checkOnce();
      })
      .catch(() => {});
  } else {
    startPolling();
  }

  return {
    active: true,
    checkOnce,
    stop: () => {
      if (timer) {
        clearInterval(timer);
        timer = null;
      }
    },
  };
}

/**
 * 在 Electron 主进程中安装全部无侵入原生层 UI 汉化钩子。
 */
function installMainHook(electron, dict, options = {}) {
  if (!electron || typeof electron !== 'object') return { installed: false, reason: 'no-electron' };
  if (electron[HOOK_FLAG]) return { installed: false, reason: 'already-installed' };

  const translator = createNativeTranslator(dict);
  const localizedMenus = new WeakSet();
  const rawToLocalizedMenu = new WeakMap();
  let lastRawAppMenu = null;
  const rawShowMessageBox =
    electron.dialog && typeof electron.dialog.showMessageBox === 'function'
      ? electron.dialog.showMessageBox.bind(electron.dialog)
      : null;

  let origBuildFromTemplate = null;

  // 1. 代理 Menu.buildFromTemplate / Menu.setApplicationMenu / Menu.getApplicationMenu / Menu.prototype.popup
  try {
    if (electron.Menu) {
      const Menu = electron.Menu;
      const origSetAppMenu =
        typeof Menu.setApplicationMenu === 'function' ? Menu.setApplicationMenu.bind(Menu) : null;
      const origGetAppMenu =
        typeof Menu.getApplicationMenu === 'function' ? Menu.getApplicationMenu.bind(Menu) : null;
      origBuildFromTemplate =
        typeof Menu.buildFromTemplate === 'function' ? Menu.buildFromTemplate.bind(Menu) : null;

      if (origBuildFromTemplate) {
        safeOverride(Menu, 'buildFromTemplate', function naweBuildFromTemplate(template) {
          if (!Array.isArray(template) || isAppMenuBarTemplate(template)) {
            return origBuildFromTemplate(template);
          }
          try {
            const localizedTemplate = translateMenuTemplate(template, translator);
            const menu = origBuildFromTemplate(localizedTemplate);
            localizedMenus.add(menu);
            return menu;
          } catch (_) {
            return origBuildFromTemplate(template);
          }
        });
      }

      if (origSetAppMenu && origBuildFromTemplate) {
        safeOverride(Menu, 'setApplicationMenu', function naweSetApplicationMenu(menu) {
          if (!menu || localizedMenus.has(menu)) {
            if (!menu) lastRawAppMenu = null;
            return origSetAppMenu(menu);
          }
          try {
            lastRawAppMenu = menu;
            const template = menuToLocalizedTemplate(menu, translator, { isRoot: true });
            const localized = origBuildFromTemplate(template);
            localizedMenus.add(localized);
            bindDynamicLabelSync(menu, localized, translator);
            return origSetAppMenu(localized);
          } catch (_) {
            // 熔断降级：出错立即回退原菜单
            return origSetAppMenu(menu);
          }
        });
      }

      if (origGetAppMenu) {
        safeOverride(Menu, 'getApplicationMenu', function naweGetApplicationMenu() {
          return lastRawAppMenu || origGetAppMenu();
        });
      }

      try {
        if (Menu.prototype && typeof Menu.prototype.popup === 'function' && origBuildFromTemplate) {
          const origPopup = Menu.prototype.popup;
          safeOverride(Menu.prototype, 'popup', function nawePopup(options) {
            if (localizedMenus.has(this) || !hasTranslatableMenuItem(this, translator)) {
              return origPopup.call(this, options);
            }
            try {
              const template = menuToLocalizedTemplate(this, translator, { isRoot: false });
              const localized = origBuildFromTemplate(template);
              localizedMenus.add(localized);
              rawToLocalizedMenu.set(this, localized);
              return origPopup.call(localized, options);
            } catch (_) {
              return origPopup.call(this, options);
            }
          });

          if (typeof Menu.prototype.closePopup === 'function') {
            const origClosePopup = Menu.prototype.closePopup;
            safeOverride(Menu.prototype, 'closePopup', function naweClosePopup(browserWindow) {
              const target = rawToLocalizedMenu.get(this) || this;
              return origClosePopup.call(target, browserWindow);
            });
          }
        }
      } catch (_) {}
    }
  } catch (_) {}

  // 1.5 代理 ipcMain.handle('window:show-context-menu')，在建菜单前直接翻译原始 items（保留 id 不变）
  try {
    if (electron.ipcMain && typeof electron.ipcMain.handle === 'function') {
      const origHandle = electron.ipcMain.handle.bind(electron.ipcMain);
      safeOverride(electron.ipcMain, 'handle', function naweIpcHandle(channel, listener) {
        if (channel === 'window:show-context-menu' && typeof listener === 'function') {
          return origHandle(channel, (event, items, ...rest) => {
            let localizedItems = items;
            try {
              localizedItems = translateContextMenuItems(items, translator);
            } catch (_) {
              localizedItems = items;
            }
            return listener(event, localizedItems, ...rest);
          });
        }
        return origHandle(channel, listener);
      });
    }
  } catch (_) {}

  // 1.6 为 plugin:// 扩展侧边面板（如 Swarm Board）安全注入本地渲染翻译引擎
  try {
    installPluginSidecarInjector(electron, options);
  } catch (_) {}

  // 2. 代理 Tray.prototype.setContextMenu（覆盖托盘右键与动态智能体计数）
  try {
    if (electron.Tray && electron.Tray.prototype && origBuildFromTemplate) {
      const origSetContextMenu = electron.Tray.prototype.setContextMenu;
      if (typeof origSetContextMenu === 'function') {
        safeOverride(electron.Tray.prototype, 'setContextMenu', function naweSetContextMenu(menu) {
          if (!menu || (localizedMenus.has(menu) && !hasTranslatableMenuItem(menu, translator))) {
            return origSetContextMenu.call(this, menu);
          }
          try {
            const template = menuToLocalizedTemplate(menu, translator, { isRoot: false });
            const localized = origBuildFromTemplate(template);
            localizedMenus.add(localized);
            return origSetContextMenu.call(this, localized);
          } catch (_) {
            return origSetContextMenu.call(this, menu);
          }
        });
      }
    }
  } catch (_) {}

  // 3. 代理 dialog.showMessageBox / showMessageBoxSync（覆盖退出确认、更新提示、WSL 提示等）
  try {
    if (electron.dialog) {
      const dialog = electron.dialog;

      if (typeof dialog.showMessageBox === 'function') {
        const origShow = dialog.showMessageBox.bind(dialog);
        safeOverride(dialog, 'showMessageBox', function naweShowMessageBox(arg1, arg2) {
          try {
            if (arg2 !== undefined) {
              return origShow(arg1, translator.translateDialogOptions(arg2));
            }
            return origShow(translator.translateDialogOptions(arg1));
          } catch (_) {
            return arg2 !== undefined ? origShow(arg1, arg2) : origShow(arg1);
          }
        });
      }

      if (typeof dialog.showMessageBoxSync === 'function') {
        const origShowSync = dialog.showMessageBoxSync.bind(dialog);
        safeOverride(dialog, 'showMessageBoxSync', function naweShowMessageBoxSync(arg1, arg2) {
          try {
            if (arg2 !== undefined) {
              return origShowSync(arg1, translator.translateDialogOptions(arg2));
            }
            return origShowSync(translator.translateDialogOptions(arg1));
          } catch (_) {
            return arg2 !== undefined ? origShowSync(arg1, arg2) : origShowSync(arg1);
          }
        });
      }

      for (const methodName of ['showOpenDialog', 'showOpenDialogSync', 'showSaveDialog', 'showSaveDialogSync']) {
        if (typeof dialog[methodName] === 'function') {
          const origFn = dialog[methodName].bind(dialog);
          safeOverride(dialog, methodName, function naweFileDialog(arg1, arg2) {
            try {
              if (arg2 !== undefined) {
                return origFn(arg1, translator.translateFileDialogOptions(arg2));
              }
              return origFn(translator.translateFileDialogOptions(arg1));
            } catch (_) {
              return arg2 !== undefined ? origFn(arg1, arg2) : origFn(arg1);
            }
          });
        }
      }
    }
  } catch (_) {}

  // 4. 兼容 macOS Dock 菜单（如存在）
  try {
    if (electron.app && electron.app.dock && typeof electron.app.dock.setMenu === 'function' && origBuildFromTemplate) {
      const origDockSetMenu = electron.app.dock.setMenu.bind(electron.app.dock);
      safeOverride(electron.app.dock, 'setMenu', function naweDockSetMenu(menu) {
        if (!menu || (localizedMenus.has(menu) && !hasTranslatableMenuItem(menu, translator))) {
          return origDockSetMenu(menu);
        }
        try {
          const template = menuToLocalizedTemplate(menu, translator, { isRoot: false });
          const localized = origBuildFromTemplate(template);
          localizedMenus.add(localized);
          return origDockSetMenu(localized);
        } catch (_) {
          return origDockSetMenu(menu);
        }
      });
    }
  } catch (_) {}

  let swapWatcher = { active: false };
  try {
    swapWatcher = startPendingSwapWatcher(electron, rawShowMessageBox, options);
  } catch (_) {}

  try {
    Object.defineProperty(electron, HOOK_FLAG, { value: true, enumerable: false });
  } catch (_) {}

  return { installed: true, swapWatcher };
}

module.exports = {
  createNativeTranslator,
  menuToLocalizedTemplate,
  translateMenuTemplate,
  translateContextMenuItems,
  installMainHook,
};
