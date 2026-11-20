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

/**
 * 构建原生层文案翻译器。
 */
function createNativeTranslator(dict) {
  const safeDict = dict && typeof dict === 'object' ? dict : {};
  const menuExact = new Map();
  const menuLower = new Map();
  for (const [k, v] of Object.entries(safeDict.menuLabels || {})) {
    menuExact.set(k, v);
    menuLower.set(k.toLowerCase(), v);
  }
  const menuPatterns = compilePatterns(safeDict.menuPatterns);

  const dialogExact = new Map(Object.entries((safeDict.dialogs && safeDict.dialogs.exact) || {}));
  const dialogBilingual = new Map(
    Object.entries((safeDict.dialogs && safeDict.dialogs.bilingualConfirm) || {})
  );
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

    for (const rule of menuPatterns) {
      if (rule.regex.test(clean)) {
        return clean.replace(rule.regex, rule.replacement);
      }
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
    if (dialogExact.has(trimmed)) {
      const zh = dialogExact.get(trimmed);
      return preferBilingual && HIGH_RISK_DIALOG_RE.test(trimmed) ? `${zh} (${trimmed})` : zh;
    }
    for (const rule of dialogPatterns) {
      if (rule.regex.test(trimmed)) {
        const zh = trimmed.replace(rule.regex, rule.replacement);
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

    const origLabel = typeof item.label === 'string' ? item.label : '';
    const translatedLabel = translator.translateMenuLabel(origLabel);
    const entry = {
      label: translatedLabel,
      enabled: item.enabled !== false,
      visible: item.visible !== false,
    };

    if (item.id) entry.id = item.id;
    if (item.sublabel) entry.sublabel = translator.translateMenuLabel(item.sublabel);
    if (item.toolTip) entry.toolTip = translator.translateMenuLabel(item.toolTip);
    if (item.accelerator) entry.accelerator = item.accelerator;
    if (item.acceleratorWorksWhenHidden !== undefined) {
      entry.acceleratorWorksWhenHidden = item.acceleratorWorksWhenHidden;
    }
    if (item.type === 'checkbox' || item.type === 'radio') {
      entry.type = item.type;
      entry.checked = Boolean(item.checked);
    }

    if (item.submenu && Array.isArray(item.submenu.items)) {
      // 有子菜单的父级项：递归克隆子菜单，避免传顶层 role 导致覆盖自定义子项
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

/**
 * 在 Electron 主进程中安装全部无侵入原生层 UI 汉化钩子。
 */
function installMainHook(electron, dict) {
  if (!electron || typeof electron !== 'object') return { installed: false, reason: 'no-electron' };
  if (electron[HOOK_FLAG]) return { installed: false, reason: 'already-installed' };

  const translator = createNativeTranslator(dict);
  const localizedMenus = new WeakSet();
  let lastRawAppMenu = null;

  // 1. 代理 Menu.setApplicationMenu / Menu.getApplicationMenu / Menu.prototype.popup
  if (electron.Menu) {
    const Menu = electron.Menu;
    const origSetAppMenu =
      typeof Menu.setApplicationMenu === 'function' ? Menu.setApplicationMenu.bind(Menu) : null;
    const origGetAppMenu =
      typeof Menu.getApplicationMenu === 'function' ? Menu.getApplicationMenu.bind(Menu) : null;
    const origBuildFromTemplate =
      typeof Menu.buildFromTemplate === 'function' ? Menu.buildFromTemplate.bind(Menu) : null;

    if (origSetAppMenu && origBuildFromTemplate) {
      Menu.setApplicationMenu = function naweSetApplicationMenu(menu) {
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
      };
    }

    if (origGetAppMenu) {
      Menu.getApplicationMenu = function naweGetApplicationMenu() {
        return lastRawAppMenu || origGetAppMenu();
      };
    }

    if (Menu.prototype && typeof Menu.prototype.popup === 'function' && origBuildFromTemplate) {
      const origPopup = Menu.prototype.popup;
      Menu.prototype.popup = function nawePopup(options) {
        if (localizedMenus.has(this)) {
          return origPopup.call(this, options);
        }
        try {
          const template = menuToLocalizedTemplate(this, translator, { isRoot: false });
          const localized = origBuildFromTemplate(template);
          localizedMenus.add(localized);
          return origPopup.call(localized, options);
        } catch (_) {
          return origPopup.call(this, options);
        }
      };
    }
  }

  // 2. 代理 Tray.prototype.setContextMenu（覆盖托盘右键与动态智能体计数）
  if (electron.Tray && electron.Tray.prototype && electron.Menu && typeof electron.Menu.buildFromTemplate === 'function') {
    const origSetContextMenu = electron.Tray.prototype.setContextMenu;
    if (typeof origSetContextMenu === 'function') {
      electron.Tray.prototype.setContextMenu = function naweSetContextMenu(menu) {
        if (!menu || localizedMenus.has(menu)) {
          return origSetContextMenu.call(this, menu);
        }
        try {
          const template = menuToLocalizedTemplate(menu, translator, { isRoot: false });
          const localized = electron.Menu.buildFromTemplate(template);
          localizedMenus.add(localized);
          return origSetContextMenu.call(this, localized);
        } catch (_) {
          return origSetContextMenu.call(this, menu);
        }
      };
    }
  }

  // 3. 代理 dialog.showMessageBox / showMessageBoxSync（覆盖退出确认、更新提示、WSL 提示等）
  if (electron.dialog) {
    const dialog = electron.dialog;

    if (typeof dialog.showMessageBox === 'function') {
      const origShow = dialog.showMessageBox.bind(dialog);
      dialog.showMessageBox = function naweShowMessageBox(arg1, arg2) {
        try {
          if (arg2 !== undefined) {
            return origShow(arg1, translator.translateDialogOptions(arg2));
          }
          return origShow(translator.translateDialogOptions(arg1));
        } catch (_) {
          return arg2 !== undefined ? origShow(arg1, arg2) : origShow(arg1);
        }
      };
    }

    if (typeof dialog.showMessageBoxSync === 'function') {
      const origShowSync = dialog.showMessageBoxSync.bind(dialog);
      dialog.showMessageBoxSync = function naweShowMessageBoxSync(arg1, arg2) {
        try {
          if (arg2 !== undefined) {
            return origShowSync(arg1, translator.translateDialogOptions(arg2));
          }
          return origShowSync(translator.translateDialogOptions(arg1));
        } catch (_) {
          return arg2 !== undefined ? origShowSync(arg1, arg2) : origShowSync(arg1);
        }
      };
    }

    for (const methodName of ['showOpenDialog', 'showOpenDialogSync', 'showSaveDialog', 'showSaveDialogSync']) {
      if (typeof dialog[methodName] === 'function') {
        const origFn = dialog[methodName].bind(dialog);
        dialog[methodName] = function naweFileDialog(arg1, arg2) {
          try {
            if (arg2 !== undefined) {
              return origFn(arg1, translator.translateFileDialogOptions(arg2));
            }
            return origFn(translator.translateFileDialogOptions(arg1));
          } catch (_) {
            return arg2 !== undefined ? origFn(arg1, arg2) : origFn(arg1);
          }
        };
      }
    }
  }

  // 4. 兼容 macOS Dock 菜单（如存在）
  if (electron.app && electron.app.dock && typeof electron.app.dock.setMenu === 'function' && electron.Menu && typeof electron.Menu.buildFromTemplate === 'function') {
    const origDockSetMenu = electron.app.dock.setMenu.bind(electron.app.dock);
    electron.app.dock.setMenu = function naweDockSetMenu(menu) {
      if (!menu || localizedMenus.has(menu)) {
        return origDockSetMenu(menu);
      }
      try {
        const template = menuToLocalizedTemplate(menu, translator, { isRoot: false });
        const localized = electron.Menu.buildFromTemplate(template);
        localizedMenus.add(localized);
        return origDockSetMenu(localized);
      } catch (_) {
        return origDockSetMenu(menu);
      }
    };
  }

  try {
    Object.defineProperty(electron, HOOK_FLAG, { value: true, enumerable: false });
  } catch (_) {}

  return { installed: true };
}

module.exports = {
  createNativeTranslator,
  menuToLocalizedTemplate,
  installMainHook,
};
