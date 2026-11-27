'use strict';

/**
 * src/dom-engine.js
 * not-a-word-of-english 渲染层安全翻译引擎（零外部依赖、自包含、兼容 sandboxed preload）。
 *
 * 核心安全机制：
 * 1. Origin 严格隔离：仅在 Antigravity 本地 Hub UI / 引导页生效，绝不污染内置浏览器外部网页。
 * 2. 两级物理免疫沙盒：
 *    - 硬免疫区（Monaco 代码编辑器 / Diff / xterm 终端 / pre / code / contenteditable / 路径导航）：100% 锁定，绝不穿透；
 *    - 正文免疫区（AI 对话正文 / 流式逐词片段 / 文件查看器代码区 / 文件树 / Git 日志）：正文锁定，仅对明确的 UI 按钮放行。
 * 3. 斜杠指令标识符保护：/goal、/grill-me、/teamwork 等指令原词强制锁定，绝不改写。
 * 4. 高风险与终端授权强制双语对照：涉及命令执行、沙盒外运行、删除、覆盖、授权的提示与按钮强制保留原英文。
 * 5. React 零崩溃 + 右下角悬浮语言切换按钮 + 异常自动熔断：绝不增删 DOM 结构，只修改文本值与白名单属性；
 *    通过右下角可拖动悬浮按钮免重启切换「标准中文 / 中英对照 / 英文原版」，异常超限自动恢复英文原版。
 */

(function initNaweDomEngineFactory(globalScope) {
  const MAX_ERRORS = 15;
  const CJK_RE = /[\u4e00-\u9fff]/;
  const LEADING_CJK_RE = /^[\s\d\p{P}\p{S}]*[\u4e00-\u9fff]/u;
  const ASCII_LETTER_RE = /[A-Za-z]/;
  const SLASH_CMD_ONLY_RE = /^\/[a-z][a-z0-9_-]{0,32}$/i;
  const SLASH_CMD_WITH_DESC_RE = /^(\/[a-z][a-z0-9_-]{0,32})(\s*[-—:：]?\s+)(.+)$/i;

  const URL_OR_EMAIL_RE = /^(?:https?:\/\/|wss?:\/\/|file:\/\/|mailto:|[^\s@]+@[^\s@]+\.[^\s@]+$)/i;
  const WIN_PATH_RE = /^[A-Za-z]:[\\/]/;
  const UNIX_OR_REL_PATH_RE = /^(?:~\/|\.\.?\/|\/(?:usr|etc|var|opt|tmp|home|Users|Applications|System|Library|bin|dev)\b)/;
  const FILE_WITH_EXT_RE = /^[\w./\\-]+\.(?:js|cjs|mjs|ts|tsx|jsx|json|md|txt|yml|yaml|toml|ini|env|sh|bash|zsh|bat|cmd|ps1|py|go|rs|java|c|cpp|h|css|scss|html|xml|svg|png|jpg|jpeg|webp|pdf|asar|bak|exe|dll|node|lock|log)$/i;
  const SEMVER_RE = /^v?\d+\.\d+(?:\.\d+)?(?:-[0-9A-Za-z.-]+)?$/;
  const ENV_VAR_RE = /^(?:\$\{?[A-Z_][A-Z0-9_]*\}?|%[A-Z_][A-Z0-9_]*%)$/;
  const CLI_FLAG_RE = /^--?[a-zA-Z0-9][a-zA-Z0-9_-]*(?:=.*)?$/;
  const SHELL_OPERATOR_RE = /(?:&&|\|\||>>?|2>&1|\$\(|\s\|\s)/;
  const BACKTICK_CMD_RE = /`[^`]+`/;
  const CAMEL_OR_SNAKE_RE = /^(?:[a-z]+[A-Z][A-Za-z0-9]*|[a-z][a-z0-9]*(?:_[a-z0-9]+)+)$/;
  const DOTTED_CODE_RE = /^[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)+(?:\(\))?$/;
  const KEBAB_SLUG_RE = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)+$/;
  const KEYCAP_OR_UNIT_RE = /^(?:[A-Z]|Ctrl|Shift|Alt|Cmd|Option|Meta|Esc|Tab|(?:(?:Ctrl|Shift|Alt|Cmd|Option|Meta)\+)+[^\s]+|[⌘⌃⌥⇧]+[^\s]+|\d+(?:px|rem|em|%))$/;
  const LABEL_WITH_SHORTCUT_RE = /^([A-Za-z][A-Za-z0-9 /&'’-]{0,48}?)(\s+(?:\(?(?:(?:Ctrl|Cmd|Shift|Alt|Option|Meta)\+)+[^\s()]+\)?|[⌘⌃⌥⇧]+[^\s()]+))$/;
  const POWERSHELL_CMDLET_RE = /^(?:Get|Set|New|Remove|Add|Clear|Copy|Move|Invoke|Start|Stop|Restart|Test|Enable|Disable|Install|Uninstall|Update|Import|Export)-[A-Z][A-Za-z0-9]+(?:\s|$)/;

  function isAllowedOrigin(loc) {
    if (!loc) return true;
    const proto = String(loc.protocol || '').toLowerCase();
    const host = String(loc.hostname || '').toLowerCase();
    if (proto === 'file:' || proto === 'data:' || proto === 'antigravity:' || proto === 'app:' || proto === 'about:' || proto === 'plugin:') {
      return true;
    }
    if (proto === 'http:' || proto === 'https:') {
      return host === '127.0.0.1' || host === 'localhost' || host === '[::1]' || host === '::1';
    }
    return false;
  }

  function extractKeywords(text) {
    const words = String(text || '').toLowerCase().match(/[a-z]+/g);
    return words ? new Set(words) : new Set();
  }

  function compileBucketedPatterns(list) {
    const buckets = new Map();
    const fallback = [];
    if (!Array.isArray(list)) return { buckets, fallback };

    for (const item of list) {
      if (!item || typeof item.pattern !== 'string' || typeof item.replacement !== 'string') continue;
      let regex;
      try {
        regex = new RegExp(item.pattern, item.flags || '');
      } catch (_) {
        continue;
      }
      const rule = { regex, replacement: item.replacement };
      const kws = Array.isArray(item.keywords) ? item.keywords : [];
      if (kws.length === 0) {
        fallback.push(rule);
      } else {
        for (const kw of kws) {
          const key = String(kw).toLowerCase();
          if (!buckets.has(key)) buckets.set(key, []);
          buckets.get(key).push(rule);
        }
      }
    }
    return { buckets, fallback };
  }

  function normalizeTypographyPreserveCase(str) {
    return String(str || '')
      .replace(/[\u2018\u2019]/g, "'")
      .replace(/[\u201c\u201d]/g, '"')
      .replace(/\u2026/g, '...')
      .replace(/[\u2013\u2014]/g, '-')
      .replace(/\u00a0/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function canonicalizeKey(str) {
    return normalizeTypographyPreserveCase(str).toLowerCase();
  }

  function splitTrailingPunct(rawTrimmed) {
    const str = String(rawTrimmed || '')
      .replace(/[\u2018\u2019]/g, "'")
      .replace(/[\u201c\u201d]/g, '"')
      .replace(/[\u2013\u2014]/g, '-')
      .replace(/\u00a0/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    const m = str.match(/^([\s\S]*?)(\s+-|\.{3}|\u2026|[.!?:])$/);
    if (!m) return { base: str, suffix: '' };
    const base = m[1].trimEnd();
    return { base, suffix: m[2] === '\u2026' ? '\u2026' : m[2].trimEnd() === '-' ? ' -' : m[2] };
  }

  function normalizeLooseBase(base) {
    return String(base || '').replace(/-/g, ' ').replace(/\s+/g, ' ').trim().toLowerCase();
  }

  function adaptTranslatedTrailingPunct(zhText, origSuffix, inputSuffix) {
    if (!zhText || inputSuffix === origSuffix) return zhText;
    const stem = String(zhText).replace(/(?:\.{3}|[\u2026。！？：:?!.]|\s+-)+$/, '');
    if (!stem) return zhText;
    switch (inputSuffix) {
      case '':
        return stem;
      case '.':
        return `${stem}。`;
      case '!':
        return `${stem}！`;
      case '?':
        return `${stem}？`;
      case ':':
        return `${stem}：`;
      case '...':
        return `${stem}...`;
      case '\u2026':
        return `${stem}\u2026`;
      case ' -':
        return `${stem} -`;
      default:
        return zhText;
    }
  }

  function matchBucketedPatterns(trimmed, compiled) {
    const words = extractKeywords(trimmed);
    const tried = new Set();

    for (const word of words) {
      const list = compiled.buckets.get(word);
      if (!list) continue;
      for (const rule of list) {
        if (tried.has(rule)) continue;
        tried.add(rule);
        if (rule.regex.test(trimmed)) {
          return trimmed.replace(rule.regex, rule.replacement);
        }
      }
    }
    for (const rule of compiled.fallback) {
      if (rule.regex.test(trimmed)) {
        return trimmed.replace(rule.regex, rule.replacement);
      }
    }
    return null;
  }

  /**
   * 构建纯函数级文本翻译与安全防护内核。
   */
  function createDomTranslator(bundle) {
    const safe = bundle && typeof bundle === 'object' ? bundle : {};
    const rules = safe.sandboxRules || {};
    const highRisk = safe.highRiskBilingual || {};
    const uiStatic = safe.uiStatic || {};
    const uiPatterns = safe.uiPatterns || {};
    const nativeMenu = safe.nativeMenu || {};

    const menuExact = new Map();
    const menuLower = new Map();
    const menuNorm = new Map();
    const menuBase = new Map();
    for (const [k, v] of Object.entries(nativeMenu.menuLabels || {})) {
      menuExact.set(k, v);
      menuLower.set(k.toLowerCase(), v);
      const norm = normalizeTypographyPreserveCase(k).toLowerCase();
      if (norm && !menuNorm.has(norm)) menuNorm.set(norm, v);
      const { base, suffix } = splitTrailingPunct(k);
      const baseLow = base.toLowerCase();
      if (baseLow.length >= 3 && (!menuBase.has(baseLow) || suffix === '')) {
        menuBase.set(baseLow, { origSuffix: suffix, value: v });
      }
    }
    const compiledMenuPatterns = [];
    for (const item of Array.isArray(nativeMenu.menuPatterns) ? nativeMenu.menuPatterns : []) {
      if (!item || typeof item.pattern !== 'string' || typeof item.replacement !== 'string') continue;
      try {
        compiledMenuPatterns.push({
          regex: new RegExp(item.pattern, item.flags || ''),
          replacement: item.replacement,
        });
      } catch (_) {}
    }

    const skipTags = new Set((rules.skipTags || []).map((t) => String(t).toUpperCase()));
    const attributeOnlyTags = new Set(
      (rules.attributeOnlyTags || ['INPUT', 'TEXTAREA']).map((t) => String(t).toUpperCase())
    );
    const allowedAttributes = Array.isArray(rules.allowedAttributes)
      ? rules.allowedAttributes
      : ['placeholder', 'title', 'aria-label', 'data-tooltip'];
    const hardImmuneSelectors = Array.isArray(rules.hardImmuneSelectors) ? rules.hardImmuneSelectors : [];
    const proseImmuneSelectors = Array.isArray(rules.proseImmuneSelectors) ? rules.proseImmuneSelectors : [];
    const controlPenetrationSelectors = Array.isArray(rules.controlPenetrationSelectors)
      ? rules.controlPenetrationSelectors
      : ['button', '[role="button"]'];
    const highRiskContainerSelectors = Array.isArray(rules.highRiskContainerSelectors)
      ? rules.highRiskContainerSelectors
      : ['[role="dialog"]', '[role="alertdialog"]'];
    const highRiskKeywords = (rules.highRiskKeywords || []).map((k) => String(k).toLowerCase());
    const preservedSlashCommands = new Set(
      (rules.preservedSlashCommands || []).map((c) => String(c).toLowerCase().replace(/^\//, ''))
    );
    const strictBareCommandSlugs = new Set(
      (rules.strictBareCommandSlugs || ['goal', 'grill-me', 'teamwork', 'compact', 'boost', 'init']).map(
        (c) => String(c).toLowerCase().replace(/^\//, '')
      )
    );
    const preservedAcronyms = new Set((rules.preservedAcronyms || []).map((a) => String(a).toUpperCase()));
    const shellCommandPrefixes = new Set((rules.shellCommandPrefixes || []).map((p) => String(p).toLowerCase()));

    const highRiskExact = new Map(Object.entries(highRisk.exact || {}));
    const highRiskCanonical = new Map();
    const highRiskLooseBase = new Map();
    for (const [k, v] of highRiskExact.entries()) {
      const canon = canonicalizeKey(k);
      if (canon && !highRiskCanonical.has(canon)) highRiskCanonical.set(canon, { origKey: k, value: v });
      const { base, suffix } = splitTrailingPunct(k);
      const loose = normalizeLooseBase(base);
      if (loose.length >= 4 && (!highRiskLooseBase.has(loose) || suffix === '')) {
        highRiskLooseBase.set(loose, { origKey: k, origSuffix: suffix, value: v });
      }
    }
    const highRiskPatterns = compileBucketedPatterns(highRisk.patterns);

    const staticExact = new Map(Object.entries(uiStatic.exact || {}));
    const staticLower = new Map();
    const staticCanonical = new Map();
    const staticLooseBase = new Map();
    for (const [k, v] of staticExact.entries()) {
      const low = k.toLowerCase();
      if (!staticLower.has(low)) staticLower.set(low, v);
      const canon = canonicalizeKey(k);
      if (canon && !staticCanonical.has(canon)) staticCanonical.set(canon, { origKey: k, value: v });
      const { base, suffix } = splitTrailingPunct(k);
      const loose = normalizeLooseBase(base);
      if (loose.length >= 4 && !highRiskLooseBase.has(loose)) {
        const existingLoose = staticLooseBase.get(loose);
        if (!existingLoose || (existingLoose.origSuffix !== '' && suffix === '')) {
          staticLooseBase.set(loose, { origKey: k, origSuffix: suffix, value: v });
        }
      }
    }
    const compiledUiPatterns = compileBucketedPatterns(uiPatterns.patterns);

    function isCodeLikeForCanonical(trimmed) {
      if (!trimmed) return true;
      if (preservedAcronyms.has(trimmed)) return true;
      if (
        URL_OR_EMAIL_RE.test(trimmed) ||
        WIN_PATH_RE.test(trimmed) ||
        UNIX_OR_REL_PATH_RE.test(trimmed) ||
        FILE_WITH_EXT_RE.test(trimmed) ||
        SEMVER_RE.test(trimmed) ||
        ENV_VAR_RE.test(trimmed) ||
        CLI_FLAG_RE.test(trimmed) ||
        SHELL_OPERATOR_RE.test(trimmed) ||
        CAMEL_OR_SNAKE_RE.test(trimmed) ||
        DOTTED_CODE_RE.test(trimmed) ||
        KEBAB_SLUG_RE.test(trimmed) ||
        KEYCAP_OR_UNIT_RE.test(trimmed) ||
        POWERSHELL_CMDLET_RE.test(trimmed)
      ) {
        return true;
      }
      if (trimmed === trimmed.toLowerCase() && !/\s/.test(trimmed)) return true;
      return false;
    }

    function looksLikeCodeOrCommand(trimmed) {
      if (!trimmed) return true;
      if (trimmed.length > 320) return true;
      if (trimmed.includes('\n')) return true;
      if (URL_OR_EMAIL_RE.test(trimmed)) return true;
      if (WIN_PATH_RE.test(trimmed) || UNIX_OR_REL_PATH_RE.test(trimmed)) return true;
      if (FILE_WITH_EXT_RE.test(trimmed)) return true;
      if (SEMVER_RE.test(trimmed) || ENV_VAR_RE.test(trimmed) || CLI_FLAG_RE.test(trimmed)) return true;
      if (SHELL_OPERATOR_RE.test(trimmed)) return true;
      if (trimmed.length <= 100 && BACKTICK_CMD_RE.test(trimmed)) return true;
      if (CAMEL_OR_SNAKE_RE.test(trimmed) || DOTTED_CODE_RE.test(trimmed)) return true;
      if (KEBAB_SLUG_RE.test(trimmed) || KEYCAP_OR_UNIT_RE.test(trimmed)) return true;
      if (preservedAcronyms.has(trimmed)) return true;
      if (POWERSHELL_CMDLET_RE.test(trimmed)) return true;
      if (trimmed === trimmed.toLowerCase() && (preservedSlashCommands.has(trimmed) || strictBareCommandSlugs.has(trimmed))) {
        return true;
      }

      const parts = trimmed.split(/\s+/);
      if (parts.length >= 2) {
        const first = parts[0];
        if (first === first.toLowerCase() && shellCommandPrefixes.has(first)) {
          if (!staticExact.has(trimmed) && !highRiskExact.has(trimmed)) {
            return true;
          }
        }
      }

      if (/[{}[\];]/.test(trimmed) && !staticExact.has(trimmed) && !highRiskExact.has(trimmed)) {
        return true;
      }

      return false;
    }

    function preserveWhitespace(raw, translatedCore) {
      const m = raw.match(/^(\s*)([\s\S]*?)(\s*)$/);
      if (!m) return translatedCore;
      return `${m[1]}${translatedCore}${m[3]}`;
    }

    function ensureBilingual(zhText, origEnglish) {
      if (ASCII_LETTER_RE.test(zhText) && zhText.toLowerCase().includes(origEnglish.toLowerCase())) {
        return zhText;
      }
      return `${zhText} (${origEnglish})`;
    }

    function translateText(rawText, ctx) {
      if (typeof rawText !== 'string' || !rawText) {
        return { translated: rawText, changed: false, reason: 'empty' };
      }
      if (!ASCII_LETTER_RE.test(rawText)) {
        return { translated: rawText, changed: false, reason: 'no-ascii' };
      }
      // 已以中文或中文标点开头的文本直接微秒短路；
      // 若以英文开头但内部夹杂中文参数（如含中文路径的命令授权或中文项目名），放行给锚定模板匹配
      if (CJK_RE.test(rawText) && LEADING_CJK_RE.test(rawText)) {
        return { translated: rawText, changed: false, reason: 'already-cjk' };
      }

      const trimmed = rawText.trim();
      if (!trimmed) {
        return { translated: rawText, changed: false, reason: 'whitespace' };
      }

      const isHighRisk = Boolean(ctx && ctx.isHighRisk);
      const controlOnly = Boolean(ctx && ctx.controlOnly);
      const precededBySlash = Boolean(ctx && ctx.precededBySlash);
      const bilingualAll = Boolean(ctx && ctx.bilingualAll);

      // 1. 斜杠指令标识符强制保护（/goal、/grill-me、/teamwork 等，以及 `/` 菜单中的全小写指令名如 browser / plan / schedule）
      if (SLASH_CMD_ONLY_RE.test(trimmed)) {
        return { translated: rawText, changed: false, reason: 'slash-command-locked' };
      }
      if (trimmed === trimmed.toLowerCase() && (preservedSlashCommands.has(trimmed) || strictBareCommandSlugs.has(trimmed))) {
        return { translated: rawText, changed: false, reason: 'slash-bare-command-locked' };
      }
      if (precededBySlash && preservedSlashCommands.has(trimmed.toLowerCase())) {
        return { translated: rawText, changed: false, reason: 'slash-split-command-locked' };
      }
      const slashDescMatch = trimmed.match(SLASH_CMD_WITH_DESC_RE);
      if (slashDescMatch) {
        const cmdToken = slashDescMatch[1];
        const sep = slashDescMatch[2];
        const desc = slashDescMatch[3].trim();
        const descZh = staticExact.get(desc) || staticLower.get(desc.toLowerCase());
        if (descZh) {
          const out = preserveWhitespace(rawText, `${cmdToken}${sep}${descZh}`);
          return { translated: out, changed: out !== rawText, reason: 'slash-desc-translated' };
        }
        return { translated: rawText, changed: false, reason: 'slash-command-preserved' };
      }

      // 2. 高风险双语词典优先（强制保留英文原文对照，全长度抗排版/大小写漂移）
      if (highRiskExact.has(trimmed)) {
        const out = preserveWhitespace(rawText, highRiskExact.get(trimmed));
        return { translated: out, changed: out !== rawText, reason: 'high-risk-exact' };
      }
      const canonTrimmed = canonicalizeKey(trimmed);
      if (!isCodeLikeForCanonical(trimmed) && highRiskCanonical.has(canonTrimmed)) {
        const hit = highRiskCanonical.get(canonTrimmed);
        const out = preserveWhitespace(rawText, hit.value);
        return { translated: out, changed: out !== rawText, reason: 'high-risk-canonical' };
      }
      const hrPatternHit =
        matchBucketedPatterns(trimmed, highRiskPatterns) ||
        matchBucketedPatterns(normalizeTypographyPreserveCase(trimmed), highRiskPatterns);
      if (hrPatternHit) {
        const out = preserveWhitespace(rawText, hrPatternHit);
        return { translated: out, changed: out !== rawText, reason: 'high-risk-pattern' };
      }

      // 3. L1 精确词条直命中（含长说明与内置技能完整描述，O(1) 极速匹配）
      if (staticExact.has(trimmed)) {
        const exactHit = staticExact.get(trimmed);
        const wantBilingual = isHighRisk || bilingualAll;
        const finalText = wantBilingual ? ensureBilingual(exactHit, trimmed) : exactHit;
        const out = preserveWhitespace(rawText, finalText);
        return {
          translated: out,
          changed: out !== rawText,
          reason: isHighRisk ? 'high-risk-upgraded' : bilingualAll ? 'bilingual-static' : 'static-exact',
        };
      }

      // 3.2 L1 全长度规范化索引命中（抵抗客户端更新导致的弯引号、省略号、大小写、多行换行与连接符微调）
      if (!isCodeLikeForCanonical(trimmed) && staticCanonical.has(canonTrimmed)) {
        const canonHit = staticCanonical.get(canonTrimmed).value;
        const wantBilingual = isHighRisk || bilingualAll;
        const finalText = wantBilingual ? ensureBilingual(canonHit, trimmed) : canonHit;
        const out = preserveWhitespace(rawText, finalText);
        return {
          translated: out,
          changed: out !== rawText,
          reason: isHighRisk ? 'high-risk-upgraded' : bilingualAll ? 'bilingual-canonical' : 'static-canonical',
        };
      }

      // 3.5 长英文 UI/技能说明（>320 字符或含换行，仅允许锚定英文句子命中分桶模板）
      if (!controlOnly && (trimmed.length > 320 || trimmed.includes('\n')) && trimmed.length <= 1600 && /^[A-Z(]/.test(trimmed)) {
        const normalizedLong = normalizeTypographyPreserveCase(trimmed);
        const longPatternHit =
          matchBucketedPatterns(trimmed.replace(/\s+/g, ' '), compiledUiPatterns) ||
          matchBucketedPatterns(normalizedLong, compiledUiPatterns);
        if (longPatternHit) {
          const wantBilingual = isHighRisk || bilingualAll;
          const finalText = wantBilingual ? ensureBilingual(longPatternHit, normalizedLong) : longPatternHit;
          const out = preserveWhitespace(rawText, finalText);
          return {
            translated: out,
            changed: out !== rawText,
            reason: isHighRisk ? 'high-risk-pattern-upgraded' : bilingualAll ? 'bilingual-pattern' : 'ui-pattern-long',
          };
        }
      }

      // 4. 代码 / 路径 / 终端命令行启发式护盾
      if (looksLikeCodeOrCommand(trimmed)) {
        return { translated: rawText, changed: false, reason: 'code-or-command-shielded' };
      }

      // 5. L1 短语大小写不敏感与末尾标点/连字符容错查表
      if (!CJK_RE.test(trimmed)) {
        if (trimmed.length <= 64 && staticLower.has(trimmed.toLowerCase())) {
          const ciHit = staticLower.get(trimmed.toLowerCase());
          const wantBilingual = isHighRisk || bilingualAll;
          const finalText = wantBilingual ? ensureBilingual(ciHit, trimmed) : ciHit;
          const out = preserveWhitespace(rawText, finalText);
          return {
            translated: out,
            changed: out !== rawText,
            reason: isHighRisk ? 'high-risk-upgraded' : bilingualAll ? 'bilingual-static' : 'static-exact',
          };
        }

        const { base: inputBase, suffix: inputSuffix } = splitTrailingPunct(trimmed);
        const inputLoose = normalizeLooseBase(inputBase);
        if (inputLoose.length >= 4) {
          if (highRiskLooseBase.has(inputLoose) && /^[A-Z]/.test(trimmed)) {
            const hrLoose = highRiskLooseBase.get(inputLoose);
            const adaptedHr = ensureBilingual(hrLoose.value, trimmed);
            const out = preserveWhitespace(rawText, adaptedHr);
            return { translated: out, changed: out !== rawText, reason: 'high-risk-loose' };
          }
          if (staticLooseBase.has(inputLoose)) {
            const looseHit = staticLooseBase.get(inputLoose);
            const adaptedZh = adaptTranslatedTrailingPunct(looseHit.value, looseHit.origSuffix, inputSuffix);
            const wantBilingual = isHighRisk || bilingualAll;
            const finalText = wantBilingual ? ensureBilingual(adaptedZh, trimmed) : adaptedZh;
            const out = preserveWhitespace(rawText, finalText);
            return {
              translated: out,
              changed: out !== rawText,
              reason: isHighRisk ? 'high-risk-upgraded' : bilingualAll ? 'bilingual-loose' : 'static-loose',
            };
          }
        }
      }

      // 5.5 带快捷键后缀的按钮 / 浮层菜单项 / 提示（如 "Quote Ctrl+L"、"Side Question (Ctrl+E)"）
      if (!CJK_RE.test(trimmed) && trimmed.length <= 80) {
        const scMatch = trimmed.match(LABEL_WITH_SHORTCUT_RE);
        if (scMatch) {
          const baseLabel = scMatch[1].trim();
          const shortcutSuffix = scMatch[2];
          const baseCanon = canonicalizeKey(baseLabel);
          const baseZh =
            staticExact.get(baseLabel) ||
            staticLower.get(baseLabel.toLowerCase()) ||
            (staticCanonical.has(baseCanon) ? staticCanonical.get(baseCanon).value : undefined);
          if (baseZh) {
            const wantBilingual = isHighRisk || bilingualAll;
            const renderedLabel = wantBilingual ? ensureBilingual(baseZh, baseLabel) : baseZh;
            const out = preserveWhitespace(rawText, `${renderedLabel}${shortcutSuffix}`);
            return {
              translated: out,
              changed: out !== rawText,
              reason: isHighRisk ? 'high-risk-upgraded' : bilingualAll ? 'bilingual-shortcut' : 'static-with-shortcut',
            };
          }
        }
      }

      if (controlOnly) {
        return { translated: rawText, changed: false, reason: 'control-only-miss' };
      }

      // 6. L2 关键词分桶动态模板匹配（先试原空白规范化，再试全排版标点规范化）
      const normalized = trimmed.includes('\n') ? trimmed.replace(/\s+/g, ' ') : trimmed;
      const patternHit =
        matchBucketedPatterns(normalized, compiledUiPatterns) ||
        matchBucketedPatterns(normalizeTypographyPreserveCase(trimmed), compiledUiPatterns);
      if (patternHit) {
        const wantBilingual = isHighRisk || bilingualAll;
        const finalText = wantBilingual ? ensureBilingual(patternHit, trimmed) : patternHit;
        const out = preserveWhitespace(rawText, finalText);
        return {
          translated: out,
          changed: out !== rawText,
          reason: isHighRisk ? 'high-risk-pattern-upgraded' : bilingualAll ? 'bilingual-pattern' : 'ui-pattern',
        };
      }

      return { translated: rawText, changed: false, reason: 'miss' };
    }

    function containsHighRiskKeyword(text) {
      if (!text) return false;
      const lower = String(text).toLowerCase();
      for (const kw of highRiskKeywords) {
        if (lower.includes(kw)) return true;
      }
      return false;
    }

    function translateMenuItemLabel(rawLabel, { langMode = 'zh' } = {}) {
      if (langMode === 'en' || typeof rawLabel !== 'string' || !rawLabel.trim()) return rawLabel;
      if (CJK_RE.test(rawLabel)) return rawLabel;

      const clean = rawLabel.replace(/&([A-Za-z0-9])/g, '$1').trim();
      const norm = normalizeTypographyPreserveCase(clean);
      const normLow = norm.toLowerCase();
      let translated = null;

      if (menuExact.has(clean)) {
        translated = menuExact.get(clean);
      } else if (menuLower.has(clean.toLowerCase())) {
        translated = menuLower.get(clean.toLowerCase());
      } else if (menuNorm.has(normLow)) {
        translated = menuNorm.get(normLow);
      } else {
        for (const rule of compiledMenuPatterns) {
          if (rule.regex.test(clean)) {
            translated = clean.replace(rule.regex, rule.replacement);
            break;
          }
          if (norm !== clean && rule.regex.test(norm)) {
            translated = norm.replace(rule.regex, rule.replacement);
            break;
          }
        }
        if (translated === null) {
          const { base, suffix } = splitTrailingPunct(clean);
          const baseLow = base.toLowerCase();
          if (baseLow.length >= 3 && menuBase.has(baseLow)) {
            const hit = menuBase.get(baseLow);
            translated = adaptTranslatedTrailingPunct(hit.value, hit.origSuffix, suffix);
          }
        }
      }

      if (translated === null) {
        const res = translateText(clean, {
          isHighRisk: containsHighRiskKeyword(clean),
          controlOnly: false,
          bilingualAll: langMode === 'bilingual',
        });
        return res.changed ? preserveWhitespace(rawLabel, res.translated) : rawLabel;
      }

      const finalLabel = langMode === 'bilingual' ? ensureBilingual(translated, clean) : translated;
      return preserveWhitespace(rawLabel, finalLabel);
    }

    function translateMenuItems(items, opts = {}) {
      if (!Array.isArray(items)) return items;
      return items.map((item) => {
        if (!item || typeof item !== 'object') return item;
        const next = { ...item };
        if (typeof next.label === 'string' && next.label) {
          next.label = translateMenuItemLabel(next.label, opts);
        }
        if (typeof next.sublabel === 'string' && next.sublabel) {
          next.sublabel = translateMenuItemLabel(next.sublabel, opts);
        }
        if (typeof next.toolTip === 'string' && next.toolTip) {
          next.toolTip = translateMenuItemLabel(next.toolTip, opts);
        }
        if (Array.isArray(next.submenu)) {
          next.submenu = translateMenuItems(next.submenu, opts);
        }
        return next;
      });
    }

    return {
      skipTags,
      attributeOnlyTags,
      allowedAttributes,
      hardImmuneSelectors,
      proseImmuneSelectors,
      controlPenetrationSelectors,
      highRiskContainerSelectors,
      preservedSlashCommands,
      strictBareCommandSlugs,
      looksLikeCodeOrCommand,
      containsHighRiskKeyword,
      translateText,
      translateMenuItemLabel,
      translateMenuItems,
    };
  }

  /**
   * 在浏览器 / Electron 渲染进程 DOM 上安装安全翻译引擎。
   */
  function installDomEngine(win, bundle, options) {
    const opts = options && typeof options === 'object' ? options : {};
    const doc = win && win.document;
    if (!win || !doc) return { installed: false, reason: 'no-document' };

    if (!opts.bypassOriginCheck && !isAllowedOrigin(win.location)) {
      return { installed: false, reason: 'disallowed-origin' };
    }

    const ENGINE_FLAG = '__naweDomEngineController__';
    if (win[ENGINE_FLAG]) {
      return { installed: false, reason: 'already-installed', controller: win[ENGINE_FLAG] };
    }

    const translator = createDomTranslator(bundle);
    const hardSel = translator.hardImmuneSelectors.join(', ');
    const proseSel = translator.proseImmuneSelectors.join(', ');
    const controlSel = translator.controlPenetrationSelectors.join(', ');
    const highRiskSel = translator.highRiskContainerSelectors.join(', ');

    const textRecords = new WeakMap();
    const attrRecords = new WeakMap();
    const observedRoots = new WeakSet();
    const boundIframes = new WeakSet();
    const activeObservers = [];
    const trackedTextRefs = new Set();
    const trackedAttrRefs = new Set();

    const UI_STREAM_EXCLUDED_SEL =
      '[role="toolbar"], [role="tablist"], [role="menu"], [role="menubar"], [role="listbox"], [role="radiogroup"], [role="dialog"], [role="alertdialog"], nav, header, footer, aside';
    const LOWERCASE_PROSE_WORD_RE = /^[a-z]{2,16}[.,!?;:]?$/;

    const LANG_MODE_STORAGE_KEY = 'nawe_lang_mode_v1';
    const WIDGET_POS_STORAGE_KEY = 'nawe_widget_pos_v1';

    function readSavedMode() {
      if (opts.initialMode === 'zh' || opts.initialMode === 'bilingual' || opts.initialMode === 'en') {
        return opts.initialMode;
      }
      try {
        const saved = win.localStorage && win.localStorage.getItem(LANG_MODE_STORAGE_KEY);
        if (saved === 'zh' || saved === 'bilingual' || saved === 'en') return saved;
      } catch (_) {}
      return 'zh';
    }

    let langMode = readSavedMode();
    let enabled = langMode !== 'en';
    let errorCount = 0;
    let tripped = false;
    let flushScheduled = false;
    const pendingNodes = new Set();
    let widgetSyncUi = null;
    let isSubframe = false;
    try {
      isSubframe = Boolean(win.top && win.top !== win);
    } catch (_) {
      isSubframe = true;
    }
    let subframeMessageHandler = null;
    let parentMessageHandler = null;

    const hasWeakRef = typeof WeakRef === 'function';
    const wrapRef = (obj) => (hasWeakRef ? new WeakRef(obj) : { deref: () => obj });

    function safeClosest(el, selector) {
      if (!selector || !el || el.nodeType !== 1 || typeof el.closest !== 'function') return null;
      try {
        return el.closest(selector);
      } catch (_) {
        return null;
      }
    }

    /**
     * 识别流式输出的逐词 <span> 片段，防止 AI 英文回复中的单个词被误翻。
     */
    function isStreamingWordSpan(el) {
      try {
        if (!el || el.nodeType !== 1 || String(el.tagName || '').toUpperCase() !== 'SPAN') {
          return false;
        }
        if (
          typeof el.getAttribute === 'function' &&
          (el.getAttribute('role') ||
            el.getAttribute('data-testid') ||
            el.getAttribute('title') ||
            el.getAttribute('aria-label'))
        ) {
          return false;
        }
        const host = el.parentElement;
        if (!host || host.nodeType !== 1) return false;
        const hostTag = String(host.tagName || '').toUpperCase();
        if (hostTag === 'BUTTON' || hostTag === 'A') return false;
        if (safeClosest(el, UI_STREAM_EXCLUDED_SEL)) return false;

        const siblings = host.childNodes || [];
        let plainSpanCount = 0;
        let singleWordSpanCount = 0;
        let lowercaseProseCount = 0;
        for (let i = 0; i < siblings.length; i++) {
          const sib = siblings[i];
          if (!sib || sib.nodeType !== 1 || String(sib.tagName || '').toUpperCase() !== 'SPAN') continue;
          plainSpanCount++;
          const t = String(sib.textContent || '').trim();
          if (t && !/\s/.test(t) && t.length <= 24) {
            singleWordSpanCount++;
            if (LOWERCASE_PROSE_WORD_RE.test(t)) {
              lowercaseProseCount++;
            }
          }
          if (plainSpanCount >= 4 && singleWordSpanCount >= 4 && lowercaseProseCount >= 2) {
            return true;
          }
        }
      } catch (_) {}
      return false;
    }

    function classifyElement(el) {
      if (!el || el.nodeType !== 1) return 'hard-immune';
      const tag = String(el.tagName || '').toUpperCase();
      if (translator.skipTags.has(tag)) return 'hard-immune';
      if (el.isContentEditable) return 'hard-immune';
      if (hardSel && safeClosest(el, hardSel)) return 'hard-immune';
      if (isStreamingWordSpan(el)) return 'prose-immune';

      if (proseSel) {
        const proseAncestor = safeClosest(el, proseSel);
        if (proseAncestor) {
          const ctrl = controlSel ? safeClosest(el, controlSel) : null;
          if (ctrl && proseAncestor.contains(ctrl)) {
            return 'control';
          }
          return 'prose-immune';
        }
      }
      return 'normal';
    }

    function isInHighRiskContext(el) {
      if (!el || el.nodeType !== 1) return false;
      if (highRiskSel) {
        const container = safeClosest(el, highRiskSel);
        if (container) {
          const fullText = container.textContent || '';
          if (fullText.length <= 1600 && translator.containsHighRiskKeyword(fullText)) {
            return true;
          }
        }
      }
      let cur = el.parentElement;
      for (let depth = 0; cur && depth < 4; depth++) {
        const txt = cur.textContent || '';
        if (txt.length <= 600 && translator.containsHighRiskKeyword(txt)) {
          return true;
        }
        cur = cur.parentElement;
      }
      return false;
    }

    function isPrecededBySlash(textNode) {
      try {
        const prev = textNode && textNode.previousSibling;
        if (prev && typeof prev.textContent === 'string' && prev.textContent.trim().endsWith('/')) {
          return true;
        }
        const parent = textNode && textNode.parentElement;
        const parentPrev = parent && parent.previousSibling;
        if (parentPrev && typeof parentPrev.textContent === 'string' && parentPrev.textContent.trim().endsWith('/')) {
          return true;
        }
      } catch (_) {}
      return false;
    }

    function processTextNode(textNode) {
      if (!enabled || tripped || !textNode || textNode.nodeType !== 3) return;
      const parent = textNode.parentElement;
      if (!parent) return;

      const parentTag = String(parent.tagName || '').toUpperCase();
      if (translator.attributeOnlyTags.has(parentTag)) return;

      const cls = classifyElement(parent);
      if (cls === 'hard-immune' || cls === 'prose-immune') return;

      const currentVal = textNode.nodeValue;
      const existing = textRecords.get(textNode);
      if (existing && currentVal === existing.trans) return;

      const res = translator.translateText(currentVal, {
        isHighRisk: isInHighRiskContext(parent),
        controlOnly: cls === 'control',
        precededBySlash: isPrecededBySlash(textNode),
        bilingualAll: langMode === 'bilingual',
      });

      if (res.changed) {
        textRecords.set(textNode, { orig: currentVal, trans: res.translated });
        trackedTextRefs.add(wrapRef(textNode));
        textNode.nodeValue = res.translated;
      }
    }

    function processTextRun(parent, runNodes) {
      if (!enabled || tripped || !parent || !runNodes || runNodes.length === 0) return;
      if (runNodes.length === 1) {
        processTextNode(runNodes[0]);
        return;
      }
      const parentTag = String(parent.tagName || '').toUpperCase();
      if (translator.attributeOnlyTags.has(parentTag)) return;

      const cls = classifyElement(parent);
      if (cls === 'hard-immune' || cls === 'prose-immune') return;

      let allMatchTrans = true;
      const origVals = [];
      for (let i = 0; i < runNodes.length; i++) {
        const node = runNodes[i];
        const curVal = node.nodeValue;
        const rec = textRecords.get(node);
        if (!rec || curVal !== rec.trans) {
          allMatchTrans = false;
        }
        origVals.push(rec && curVal === rec.trans ? rec.orig : curVal);
      }
      if (allMatchTrans) return;

      const combined = origVals.join('');
      const res = translator.translateText(combined, {
        isHighRisk: isInHighRiskContext(parent),
        controlOnly: cls === 'control',
        precededBySlash: isPrecededBySlash(runNodes[0]),
        bilingualAll: langMode === 'bilingual',
      });

      if (res.changed) {
        for (let i = 0; i < runNodes.length; i++) {
          const node = runNodes[i];
          const targetVal = i === 0 ? res.translated : '';
          textRecords.set(node, { orig: origVals[i], trans: targetVal });
          trackedTextRefs.add(wrapRef(node));
          if (node.nodeValue !== targetVal) {
            node.nodeValue = targetVal;
          }
        }
        return;
      }

      for (let i = 0; i < runNodes.length; i++) {
        processTextNode(runNodes[i]);
      }
    }

    function processAttributes(el) {
      if (!enabled || tripped || !el || el.nodeType !== 1) return;
      const tag = String(el.tagName || '').toUpperCase();
      if (translator.skipTags.has(tag)) return;
      if (hardSel && safeClosest(el, hardSel)) return;

      const cls = classifyElement(el);
      if (cls === 'hard-immune' || cls === 'prose-immune') return;

      const isHighRisk = isInHighRiskContext(el);
      let map = attrRecords.get(el);

      for (const attr of translator.allowedAttributes) {
        if (typeof el.getAttribute !== 'function') continue;
        const curVal = el.getAttribute(attr);
        if (!curVal) continue;

        const rec = map && map.get(attr);
        if (rec && curVal === rec.trans) continue;

        const res = translator.translateText(curVal, {
          isHighRisk,
          controlOnly: false,
          bilingualAll: langMode === 'bilingual',
        });

        if (res.changed) {
          if (!map) {
            map = new Map();
            attrRecords.set(el, map);
            trackedAttrRefs.add(wrapRef(el));
          }
          map.set(attr, { orig: curVal, trans: res.translated });
          el.setAttribute(attr, res.translated);
        }
      }
    }

    function walkSubtree(root) {
      if (!enabled || tripped || !root) return;

      if (root.nodeType === 3) {
        processTextNode(root);
        return;
      }

      if (root.nodeType === 1) {
        const cls = classifyElement(root);
        if (cls === 'hard-immune') return;
        processAttributes(root);

        if (root.shadowRoot) {
          observeRoot(root.shadowRoot);
          walkSubtree(root.shadowRoot);
        }

        if (String(root.tagName || '').toUpperCase() === 'IFRAME') {
          try {
            if (root.contentDocument && root.contentDocument.body) {
              observeRoot(root.contentDocument.body);
              walkSubtree(root.contentDocument.body);
            }
            if (!boundIframes.has(root) && typeof root.addEventListener === 'function') {
              boundIframes.add(root);
              root.addEventListener('load', () => {
                if (!enabled || tripped) return;
                try {
                  if (root.contentDocument && root.contentDocument.body) {
                    observeRoot(root.contentDocument.body);
                    scheduleNode(root.contentDocument.body);
                  }
                } catch (_) {}
              });
            }
          } catch (_) {}
        }
      }

      const children = root.childNodes;
      if (!children) return;
      if (root.nodeType === 1) {
        let textRun = [];
        for (let i = 0; i < children.length; i++) {
          const child = children[i];
          if (child && child.nodeType === 3) {
            textRun.push(child);
          } else {
            if (textRun.length > 0) {
              processTextRun(root, textRun);
              textRun = [];
            }
            walkSubtree(child);
          }
        }
        if (textRun.length > 0) {
          processTextRun(root, textRun);
        }
        return;
      }
      for (let i = 0; i < children.length; i++) {
        walkSubtree(children[i]);
      }
    }

    function handleError(err) {
      errorCount += 1;
      if (errorCount >= MAX_ERRORS && !tripped) {
        tripped = true;
        try {
          restoreAllOriginal();
          disconnectAll();
        } catch (_) {}
      }
      return err;
    }

    function scheduleNode(node) {
      if (!enabled || tripped || !node) return;
      pendingNodes.add(node);
      if (flushScheduled) return;
      flushScheduled = true;

      const scheduleFn =
        typeof queueMicrotask === 'function'
          ? queueMicrotask
          : (cb) => Promise.resolve().then(cb);

      scheduleFn(() => {
        flushScheduled = false;
        if (!enabled || tripped) {
          pendingNodes.clear();
          return;
        }
        const batch = Array.from(pendingNodes);
        pendingNodes.clear();
        for (const target of batch) {
          try {
            walkSubtree(target);
          } catch (err) {
            handleError(err);
            if (tripped) break;
          }
        }
      });
    }

    function observeRoot(root) {
      if (!root || observedRoots.has(root) || typeof win.MutationObserver !== 'function') return;
      observedRoots.add(root);

      const observer = new win.MutationObserver((mutations) => {
        if (!enabled || tripped) return;
        try {
          for (let i = 0; i < mutations.length; i++) {
            const m = mutations[i];
            if (m.type === 'characterData') {
              const p = m.target && m.target.parentNode;
              if (p && p.nodeType === 1 && p.childNodes && p.childNodes.length >= 2) {
                scheduleNode(p);
              } else {
                scheduleNode(m.target);
              }
            } else if (m.type === 'attributes') {
              scheduleNode(m.target);
            } else if (m.type === 'childList' && m.addedNodes) {
              for (let j = 0; j < m.addedNodes.length; j++) {
                scheduleNode(m.addedNodes[j]);
              }
            }
          }
        } catch (err) {
          handleError(err);
        }
      });

      observer.observe(root, {
        childList: true,
        subtree: true,
        characterData: true,
        attributes: true,
        attributeFilter: translator.allowedAttributes.concat(['data-state']),
      });
      activeObservers.push(observer);
    }

    function disconnectAll() {
      while (activeObservers.length > 0) {
        const obs = activeObservers.pop();
        try {
          obs.disconnect();
        } catch (_) {}
      }
      if (!isSubframe) {
        try {
          if (globalScope && globalScope.__naweTranslateContextMenuItems === translatePreloadMenuItems) {
            delete globalScope.__naweTranslateContextMenuItems;
          }
          if (win && win.__naweTranslateContextMenuItems === translatePreloadMenuItems) {
            delete win.__naweTranslateContextMenuItems;
          }
        } catch (_) {}
      }
      if (subframeMessageHandler && typeof win.removeEventListener === 'function') {
        try {
          win.removeEventListener('message', subframeMessageHandler);
        } catch (_) {}
        subframeMessageHandler = null;
      }
      if (parentMessageHandler && typeof win.removeEventListener === 'function') {
        try {
          win.removeEventListener('message', parentMessageHandler);
        } catch (_) {}
        parentMessageHandler = null;
      }
    }

    function translatePreloadMenuItems(items) {
      if (!enabled || tripped) return items;
      try {
        return translator.translateMenuItems(items, { langMode });
      } catch (_) {
        return items;
      }
    }

    function restoreAllOriginal() {
      for (const ref of Array.from(trackedTextRefs)) {
        const node = ref.deref();
        if (!node) {
          trackedTextRefs.delete(ref);
          continue;
        }
        const rec = textRecords.get(node);
        if (rec && node.nodeValue === rec.trans) {
          node.nodeValue = rec.orig;
        }
      }
      for (const ref of Array.from(trackedAttrRefs)) {
        const el = ref.deref();
        if (!el) {
          trackedAttrRefs.delete(ref);
          continue;
        }
        const map = attrRecords.get(el);
        if (!map) continue;
        for (const [attr, rec] of map.entries()) {
          if (el.getAttribute(attr) === rec.trans) {
            el.setAttribute(attr, rec.orig);
          }
        }
      }
    }

    function showToast(msg) {
      try {
        if (!doc.body) return;
        const id = 'nawe-status-toast';
        let el = doc.getElementById(id);
        if (!el) {
          el = doc.createElement('div');
          el.id = id;
          el.setAttribute('data-nawe-skip', 'true');
          Object.assign(el.style, {
            position: 'fixed',
            right: '14px',
            bottom: '54px',
            zIndex: '2147483647',
            padding: '8px 14px',
            borderRadius: '8px',
            background: 'rgba(17, 24, 39, 0.94)',
            color: '#f9fafb',
            fontSize: '12px',
            fontFamily: 'system-ui, -apple-system, sans-serif',
            boxShadow: '0 4px 14px rgba(0,0,0,0.35)',
            pointerEvents: 'none',
            transition: 'opacity 0.2s ease',
          });
          doc.body.appendChild(el);
        }
        el.textContent = msg;
        el.style.opacity = '1';
        clearTimeout(el.__naweTimer);
        el.__naweTimer = setTimeout(() => {
          el.style.opacity = '0';
        }, 2200);
        if (el.__naweTimer && typeof el.__naweTimer.unref === 'function') {
          el.__naweTimer.unref();
        }
      } catch (_) {}
    }

    function setMode(nextMode, { silent = false } = {}) {
      if (tripped) return langMode;
      if (nextMode !== 'zh' && nextMode !== 'bilingual' && nextMode !== 'en') return langMode;

      langMode = nextMode;
      enabled = nextMode !== 'en';

      try {
        if (win.localStorage && typeof win.localStorage.setItem === 'function') {
          win.localStorage.setItem(LANG_MODE_STORAGE_KEY, nextMode);
        }
      } catch (_) {}

      restoreAllOriginal();
      if (enabled && doc.body) {
        walkSubtree(doc.body);
      }
      if (typeof widgetSyncUi === 'function') widgetSyncUi();

      if (!isSubframe && typeof doc.querySelectorAll === 'function') {
        try {
          const frames = doc.querySelectorAll('iframe');
          for (let i = 0; i < frames.length; i++) {
            const f = frames[i];
            try {
              if (f && f.contentWindow && typeof f.contentWindow.postMessage === 'function') {
                f.contentWindow.postMessage({ __naweSyncMode: nextMode }, '*');
              }
            } catch (_) {}
          }
        } catch (_) {}
      }

      if (!silent) {
        const modeLabels = {
          zh: '已切换：标准中文（高风险授权保留双语）',
          bilingual: '已切换：全界面中英对照模式',
          en: '已切换：官方英文原版',
        };
        showToast(modeLabels[nextMode]);
      }
      return langMode;
    }

    function toggleEnabled() {
      return setMode(enabled ? 'en' : 'zh') !== 'en';
    }

    /**
     * 在全界面右下角挂载独立 Shadow DOM 悬浮语言切换按钮（可拖动、零 CSS 冲突、绝不干扰 React）。
     */
    function mountFloatingLanguageWidget() {
      try {
        if (isSubframe || opts.disableWidget === true) return null;
        const mountRoot = doc.documentElement || doc.body;
        if (!mountRoot || typeof doc.createElement !== 'function') return null;

        const HOST_ID = 'nawe-floating-root';
        if (typeof doc.getElementById === 'function' && doc.getElementById(HOST_ID)) return null;

        const host = doc.createElement('div');
        host.id = HOST_ID;
        host.setAttribute('data-nawe-skip', 'true');
        Object.assign(host.style, {
          position: 'fixed',
          right: '14px',
          bottom: '14px',
          zIndex: '2147483646',
          margin: '0',
          padding: '0',
          lineHeight: '1',
        });

        try {
          const rawPos = win.localStorage && win.localStorage.getItem(WIDGET_POS_STORAGE_KEY);
          if (rawPos) {
            const pos = JSON.parse(rawPos);
            if (typeof pos.left === 'number' && typeof pos.top === 'number') {
              host.style.right = 'auto';
              host.style.bottom = 'auto';
              host.style.left = `${Math.max(8, Math.min(pos.left, (win.innerWidth || 1200) - 70))}px`;
              host.style.top = `${Math.max(8, Math.min(pos.top, (win.innerHeight || 800) - 36))}px`;
            }
          }
        } catch (_) {}

        const shadow = typeof host.attachShadow === 'function' ? host.attachShadow({ mode: 'open' }) : host;

        const styleEl = doc.createElement('style');
        styleEl.textContent = `
          :host { all: initial; font-family: system-ui, -apple-system, "Segoe UI", "Microsoft YaHei", sans-serif; }
          .nawe-wrap { position: relative; user-select: none; }
          .nawe-pill {
            display: inline-flex; align-items: center; gap: 6px;
            height: 30px; padding: 0 11px; border-radius: 999px;
            border: 1px solid rgba(148, 163, 184, 0.35);
            background: rgba(24, 24, 27, 0.84); color: #f4f4f5;
            font-size: 12px; font-weight: 600; cursor: pointer;
            box-shadow: 0 4px 14px rgba(0, 0, 0, 0.28);
            backdrop-filter: blur(8px); -webkit-backdrop-filter: blur(8px);
            opacity: 0.86; transition: opacity 0.15s ease, border-color 0.15s ease;
          }
          .nawe-pill:hover { opacity: 1; border-color: rgba(96, 165, 250, 0.75); }
          .nawe-dot { width: 7px; height: 7px; border-radius: 50%; background: #22c55e; flex-shrink: 0; }
          .nawe-dot.en { background: #94a3b8; }
          .nawe-dot.bilingual { background: #38bdf8; }
          .nawe-panel {
            position: absolute; right: 0; bottom: 38px; width: 236px;
            background: rgba(24, 24, 27, 0.96); color: #f4f4f5;
            border: 1px solid rgba(148, 163, 184, 0.28); border-radius: 12px;
            box-shadow: 0 12px 32px rgba(0, 0, 0, 0.45);
            padding: 12px; display: none; flex-direction: column; gap: 9px;
            backdrop-filter: blur(12px); -webkit-backdrop-filter: blur(12px);
          }
          .nawe-panel.open { display: flex; }
          .nawe-panel.drop-down { bottom: auto; top: 38px; }
          .nawe-panel.align-left { right: auto; left: 0; }
          .nawe-head {
            display: flex; align-items: center; justify-content: space-between;
            font-size: 12px; font-weight: 600; color: #e4e4e7;
          }
          .nawe-tag {
            font-size: 10px; padding: 2px 6px; border-radius: 999px;
            background: rgba(56, 189, 248, 0.16); color: #7dd3fc; font-weight: 500;
          }
          .nawe-seg { display: grid; grid-template-columns: repeat(3, 1fr); gap: 5px; }
          .nawe-seg button {
            height: 28px; border-radius: 7px; border: 1px solid rgba(148, 163, 184, 0.25);
            background: rgba(39, 39, 42, 0.9); color: #d4d4d8;
            font-size: 11px; font-weight: 500; cursor: pointer;
            transition: background 0.12s ease, border-color 0.12s ease, color 0.12s ease;
          }
          .nawe-seg button:hover { background: rgba(63, 63, 70, 0.95); color: #ffffff; }
          .nawe-seg button.active {
            background: #2563eb; border-color: #60a5fa; color: #ffffff; font-weight: 600;
          }
          .nawe-desc { font-size: 11px; color: #a1a1aa; line-height: 1.45; }
          .nawe-foot {
            font-size: 10px; color: #71717a; line-height: 1.4;
            border-top: 1px solid rgba(148, 163, 184, 0.15); padding-top: 7px;
          }
        `;

        const wrap = doc.createElement('div');
        wrap.className = 'nawe-wrap';

        const panel = doc.createElement('div');
        panel.className = 'nawe-panel';

        const head = doc.createElement('div');
        head.className = 'nawe-head';
        const headTitle = doc.createElement('span');
        headTitle.textContent = '界面语言切换';
        const headTag = doc.createElement('span');
        headTag.className = 'nawe-tag';
        headTag.textContent = '一点英语都不会';
        head.appendChild(headTitle);
        head.appendChild(headTag);

        const seg = doc.createElement('div');
        seg.className = 'nawe-seg';
        const modeButtons = {};
        const modeDefs = [
          { id: 'zh', label: '标准中文', desc: '日常界面简体中文，高风险授权与 /指令 保留英文。' },
          { id: 'bilingual', label: '中英对照', desc: '全界面保留中英双语对照，方便核对原始术语。' },
          { id: 'en', label: '英文原版', desc: '免重启即时恢复官方原始英文界面。' },
        ];
        const modeDescMap = {};
        for (const m of modeDefs) {
          modeDescMap[m.id] = m.desc;
          const btn = doc.createElement('button');
          btn.type = 'button';
          btn.textContent = m.label;
          btn.addEventListener('click', () => {
            setMode(m.id);
          });
          modeButtons[m.id] = btn;
          seg.appendChild(btn);
        }

        const modeDesc = doc.createElement('div');
        modeDesc.className = 'nawe-desc';

        const foot = doc.createElement('div');
        foot.className = 'nawe-foot';
        foot.textContent = '可按住按钮拖动位置 · 更改立即生效';

        panel.appendChild(head);
        panel.appendChild(seg);
        panel.appendChild(modeDesc);
        panel.appendChild(foot);

        const pill = doc.createElement('button');
        pill.type = 'button';
        pill.className = 'nawe-pill';
        pill.setAttribute('aria-label', '切换界面语言');
        pill.setAttribute('aria-expanded', 'false');
        const dot = doc.createElement('span');
        dot.className = 'nawe-dot';
        const pillText = doc.createElement('span');
        pill.appendChild(dot);
        pill.appendChild(pillText);

        wrap.appendChild(panel);
        wrap.appendChild(pill);
        shadow.appendChild(styleEl);
        shadow.appendChild(wrap);
        mountRoot.appendChild(host);

        let panelOpen = false;
        let dragging = false;
        let dragged = false;
        let startX = 0;
        let startY = 0;
        let origLeft = 0;
        let origTop = 0;

        function syncUi() {
          pill.setAttribute('aria-expanded', panelOpen ? 'true' : 'false');
          panel.classList.toggle('open', panelOpen);

          if (panelOpen && typeof host.getBoundingClientRect === 'function') {
            const rect = host.getBoundingClientRect();
            panel.classList.toggle('drop-down', rect.top < 170);
            panel.classList.toggle('align-left', rect.left < 250);
          }

          const shortNames = { zh: '中文', bilingual: '中/EN', en: 'EN' };
          pillText.textContent = shortNames[langMode] || '中文';
          modeDesc.textContent = modeDescMap[langMode] || '';

          dot.className = 'nawe-dot';
          if (langMode === 'en') dot.classList.add('en');
          else if (langMode === 'bilingual') dot.classList.add('bilingual');

          for (const [id, b] of Object.entries(modeButtons)) {
            b.classList.toggle('active', langMode === id);
          }
        }

        pill.addEventListener('pointerdown', (e) => {
          if (!e || e.button !== 0) return;
          dragging = true;
          dragged = false;
          startX = e.clientX;
          startY = e.clientY;
          if (typeof host.getBoundingClientRect === 'function') {
            const rect = host.getBoundingClientRect();
            origLeft = rect.left;
            origTop = rect.top;
          }
          if (typeof pill.setPointerCapture === 'function') {
            try { pill.setPointerCapture(e.pointerId); } catch (_) {}
          }
        });

        pill.addEventListener('pointermove', (e) => {
          if (!dragging || !e) return;
          const dx = e.clientX - startX;
          const dy = e.clientY - startY;
          if (!dragged && Math.abs(dx) + Math.abs(dy) < 5) return;
          dragged = true;
          const maxLeft = Math.max(8, (win.innerWidth || 1200) - 72);
          const maxTop = Math.max(8, (win.innerHeight || 800) - 38);
          const nextLeft = Math.max(8, Math.min(origLeft + dx, maxLeft));
          const nextTop = Math.max(8, Math.min(origTop + dy, maxTop));
          host.style.right = 'auto';
          host.style.bottom = 'auto';
          host.style.left = `${nextLeft}px`;
          host.style.top = `${nextTop}px`;
        });

        pill.addEventListener('pointerup', () => {
          if (!dragging) return;
          dragging = false;
          if (dragged) {
            try {
              const rect = host.getBoundingClientRect();
              if (win.localStorage && typeof win.localStorage.setItem === 'function') {
                win.localStorage.setItem(
                  WIDGET_POS_STORAGE_KEY,
                  JSON.stringify({ left: Math.round(rect.left), top: Math.round(rect.top) })
                );
              }
            } catch (_) {}
            return;
          }
          panelOpen = !panelOpen;
          syncUi();
        });

        if (typeof doc.addEventListener === 'function') {
          doc.addEventListener('pointerdown', (e) => {
            if (!panelOpen) return;
            const pathList = typeof e.composedPath === 'function' ? e.composedPath() : [];
            if (pathList.includes(host)) return;
            panelOpen = false;
            syncUi();
          });
        }

        widgetSyncUi = syncUi;
        syncUi();
        return host;
      } catch (_) {
        return null;
      }
    }

    function installShadowHook() {
      try {
        win.__naweOnShadowRoot = (hostEl, sr) => {
          if (!enabled || tripped || !sr) return;
          if (
            hostEl &&
            (hostEl.id === 'nawe-floating-root' ||
              (typeof hostEl.getAttribute === 'function' && hostEl.getAttribute('data-nawe-skip') === 'true'))
          ) {
            return;
          }
          observeRoot(sr);
          scheduleNode(sr);
        };
        const proto = win.Element && win.Element.prototype;
        if (proto && typeof proto.attachShadow === 'function' && !proto.__naweAttachShadowHooked__) {
          const origAttachShadow = proto.attachShadow;
          proto.attachShadow = function nawePatchedAttachShadow(init) {
            const sr = origAttachShadow.call(this, init);
            try {
              if (typeof win.__naweOnShadowRoot === 'function') {
                win.__naweOnShadowRoot(this, sr);
              }
            } catch (_) {}
            return sr;
          };
          Object.defineProperty(proto, '__naweAttachShadowHooked__', { value: true, enumerable: false });
        }
      } catch (_) {}
    }

    function start() {
      try {
        installShadowHook();
        if (!isSubframe) {
          try {
            if (globalScope) globalScope.__naweTranslateContextMenuItems = translatePreloadMenuItems;
            if (win) win.__naweTranslateContextMenuItems = translatePreloadMenuItems;
          } catch (_) {}
          if (typeof win.addEventListener === 'function' && !parentMessageHandler) {
            parentMessageHandler = (e) => {
              try {
                if (e && e.data && e.data.__naweQueryMode === true && e.source && typeof e.source.postMessage === 'function') {
                  e.source.postMessage({ __naweSyncMode: langMode }, '*');
                }
              } catch (_) {}
            };
            win.addEventListener('message', parentMessageHandler);
          }
        }
        if (isSubframe && typeof win.addEventListener === 'function' && !subframeMessageHandler) {
          subframeMessageHandler = (e) => {
            try {
              const mode = e && e.data && e.data.__naweSyncMode;
              if (e.source === win.parent && (mode === 'zh' || mode === 'bilingual' || mode === 'en')) {
                setMode(mode, { silent: true });
              }
            } catch (_) {}
          };
          win.addEventListener('message', subframeMessageHandler);
          if (win.parent && win.parent !== win && typeof win.parent.postMessage === 'function') {
            try {
              win.parent.postMessage({ __naweQueryMode: true }, '*');
            } catch (_) {}
          }
        }
        const target = doc.documentElement || doc.body;
        if (!target) return;
        observeRoot(target);
        if (enabled) {
          walkSubtree(target);
        }
        mountFloatingLanguageWidget();
      } catch (err) {
        handleError(err);
      }
    }

    if (doc.readyState === 'loading' && typeof doc.addEventListener === 'function') {
      doc.addEventListener('DOMContentLoaded', start, { once: true });
    } else {
      start();
    }

    const controller = {
      isEnabled: () => enabled,
      getMode: () => langMode,
      setMode,
      isTripped: () => tripped,
      toggle: toggleEnabled,
      restoreAllOriginal,
      rescan: () => {
        if (enabled && !tripped && doc.body) walkSubtree(doc.body);
      },
      disconnect: disconnectAll,
      _forceErrorForTest: handleError,
    };

    try {
      Object.defineProperty(win, ENGINE_FLAG, { value: controller, enumerable: false, configurable: true });
    } catch (_) {}

    return { installed: true, controller };
  }

  const api = {
    isAllowedOrigin,
    createDomTranslator,
    installDomEngine,
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  } else if (globalScope) {
    globalScope.__naweDomEngineFactory = api;
  }
})(typeof globalThis !== 'undefined' ? globalThis : typeof window !== 'undefined' ? window : {});
