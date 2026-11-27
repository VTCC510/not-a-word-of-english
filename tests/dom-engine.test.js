'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { isAllowedOrigin, createDomTranslator, installDomEngine } = require('../src/dom-engine');
const { loadAndValidateDictionaries } = require('../tools/build-payload');

const dicts = loadAndValidateDictionaries();
const bundle = {
  sandboxRules: dicts.sandboxRules,
  highRiskBilingual: dicts.highRiskBilingual,
  uiStatic: dicts.uiStatic,
  uiPatterns: dicts.uiPatterns,
  nativeMenu: dicts.nativeMenu,
};

function createMockDom(locationObj = { protocol: 'http:', hostname: '127.0.0.1' }) {
  class MockNode {
    constructor(nodeType) {
      this.nodeType = nodeType;
      this.parentElement = null;
      this.parentNode = null;
      this.previousSibling = null;
      this.childNodes = [];
    }
    appendChild(child) {
      child.parentNode = this;
      child.parentElement = this.nodeType === 1 ? this : null;
      child.previousSibling = this.childNodes.length > 0 ? this.childNodes[this.childNodes.length - 1] : null;
      this.childNodes.push(child);
      return child;
    }
  }

  class MockText extends MockNode {
    constructor(value) {
      super(3);
      this.nodeValue = value;
    }
    get textContent() {
      return this.nodeValue;
    }
  }

  function matchSingleSelector(el, sel) {
    const s = sel.trim();
    if (!s || !el || el.nodeType !== 1) return false;
    if (/^[a-z0-9-]+$/i.test(s)) return el.tagName.toLowerCase() === s.toLowerCase();
    if (s.startsWith('.')) return el.classList.has(s.slice(1));
    let m = s.match(/^\[([a-z0-9_-]+)\*=['"]([^'"]+)['"]\]$/i);
    if (m) {
      const val = el.getAttribute(m[1]);
      return typeof val === 'string' && val.includes(m[2]);
    }
    m = s.match(/^\[([a-z0-9_-]+)=['"]([^'"]+)['"]\]$/i);
    if (m) return el.getAttribute(m[1]) === m[2];
    m = s.match(/^\[([a-z0-9_-]+)\]$/i);
    if (m) return el.attrs.has(m[1]);
    return false;
  }

  class MockClassList extends Set {
    toggle(name, force) {
      if (force === undefined) {
        if (this.has(name)) { this.delete(name); return false; }
        this.add(name); return true;
      }
      if (force) this.add(name);
      else this.delete(name);
      return Boolean(force);
    }
  }

  class MockElement extends MockNode {
    constructor(tagName, attrs = {}, classes = []) {
      super(1);
      this.tagName = tagName.toUpperCase();
      this.attrs = new Map(Object.entries(attrs));
      this.classList = new MockClassList(classes);
      this.style = {};
      this.shadowRoot = null;
      this.listeners = new Map();
      this.isContentEditable = this.attrs.get('contenteditable') === 'true';
    }
    getAttribute(k) {
      return this.attrs.has(k) ? this.attrs.get(k) : null;
    }
    setAttribute(k, v) {
      this.attrs.set(k, String(v));
      if (k === 'contenteditable') this.isContentEditable = v === 'true';
    }
    removeAttribute(k) {
      this.attrs.delete(k);
    }
    addEventListener(type, fn) {
      if (!this.listeners.has(type)) this.listeners.set(type, []);
      this.listeners.get(type).push(fn);
    }
    click() {
      const fns = this.listeners.get('click') || [];
      fns.forEach((fn) => fn({ target: this }));
    }
    attachShadow() {
      this.shadowRoot = new MockShadowRoot(this);
      return this.shadowRoot;
    }
    matches(selectorList) {
      return String(selectorList).split(',').some((part) => matchSingleSelector(this, part));
    }
    closest(selectorList) {
      let cur = this;
      while (cur && cur.nodeType === 1) {
        if (cur.matches(selectorList)) return cur;
        cur = cur.parentElement;
      }
      return null;
    }
    contains(target) {
      let cur = target;
      while (cur) {
        if (cur === this) return true;
        cur = cur.parentNode;
      }
      return false;
    }
    get textContent() {
      return this.childNodes.map((c) => c.textContent).join('');
    }
    set textContent(val) {
      this.childNodes = [];
      if (val !== undefined && val !== null && val !== '') {
        this.appendChild(new MockText(String(val)));
      }
    }
  }

  class MockShadowRoot extends MockNode {
    constructor(host) {
      super(11);
      this.host = host;
    }
  }

  class MockMutationObserver {
    constructor(cb) {
      this.cb = cb;
      this.disconnected = false;
    }
    observe() {}
    disconnect() {
      this.disconnected = true;
    }
  }

  const body = new MockElement('body');
  const doc = {
    readyState: 'complete',
    body,
    documentElement: body,
    getElementById: () => null,
    createElement: (tag) => new MockElement(tag),
  };

  const keydownListeners = [];
  const win = {
    location: locationObj,
    document: doc,
    MutationObserver: MockMutationObserver,
    addEventListener: (type, fn) => {
      if (type === 'keydown') keydownListeners.push(fn);
    },
    _keydownListeners: keydownListeners,
  };
  win.top = win;

  return { win, doc, body, MockElement, MockText, MockShadowRoot };
}

test('Origin guard allows Antigravity local Hub UI and blocks external websites in built-in browser', () => {
  assert.equal(isAllowedOrigin({ protocol: 'http:', hostname: '127.0.0.1' }), true);
  assert.equal(isAllowedOrigin({ protocol: 'http:', hostname: 'localhost' }), true);
  assert.equal(isAllowedOrigin({ protocol: 'data:', hostname: '' }), true);
  assert.equal(isAllowedOrigin({ protocol: 'file:', hostname: '' }), true);
  assert.equal(isAllowedOrigin({ protocol: 'https:', hostname: 'github.com' }), false);
  assert.equal(isAllowedOrigin({ protocol: 'https:', hostname: 'google.com' }), false);

  const extDom = createMockDom({ protocol: 'https:', hostname: 'github.com' });
  const res = installDomEngine(extDom.win, bundle);
  assert.equal(res.installed, false);
  assert.equal(res.reason, 'disallowed-origin');
});

test('Slash command identifiers and split /command spans stay in English while title-case UI labels translate', () => {
  const t = createDomTranslator(bundle);
  for (const cmd of ['/goal', '/grill-me', '/teamwork', '/plan', '/compact', '/schedule', '/boost', 'goal', 'grill-me', 'teamwork']) {
    const res = t.translateText(cmd);
    assert.equal(res.changed, false, `Expected "${cmd}" to remain untouched`);
    assert.equal(res.translated, cmd);
  }
  assert.equal(t.translateText('/goal — Settings').translated, '/goal — 设置');
  assert.equal(t.translateText('Help').translated, '帮助');
  assert.equal(t.translateText('Plan').translated, '计划');
  assert.equal(t.translateText('Model').translated, '模型');
  assert.equal(t.translateText('Skills').translated, '技能');
  assert.equal(t.translateText('Rules').translated, '规则');
  assert.equal(t.translateText('Hooks').translated, '钩子');
  assert.equal(t.translateText('Clear').translated, '清空');
  assert.equal(t.translateText('Find in files').translated, '在文件中查找');
  assert.equal(t.translateText('Type a message...').translated, '输入消息...');

  const dom = createMockDom();
  const { body, MockElement, MockText } = dom;
  const slashRow = new MockElement('div');
  const slashSpan = new MockElement('span');
  slashSpan.appendChild(new MockText('/'));
  const cmdSpan = new MockElement('span');
  cmdSpan.appendChild(new MockText('plan'));
  slashRow.appendChild(slashSpan);
  slashRow.appendChild(cmdSpan);

  const chatBox = new MockElement('textarea', { placeholder: 'Ask anything...' });
  chatBox.appendChild(new MockText('Settings'));
  body.appendChild(slashRow);
  body.appendChild(chatBox);

  installDomEngine(dom.win, bundle);
  assert.equal(cmdSpan.textContent, 'plan');
  assert.equal(chatBox.getAttribute('placeholder'), '输入你想让 Antigravity 做的事情...');
  assert.equal(chatBox.textContent, 'Settings');
});

test('Slash typeahead menu preserves all bare lowercase command/skill identifiers while translating descriptions', () => {
  const dom = createMockDom();
  const { body, MockElement, MockText } = dom;

  const listbox = new MockElement('div', { role: 'listbox', 'aria-label': 'Typeahead menu' });
  const rows = [
    ['browser', 'Invoke a browser agent for web tasks.'],
    ['plan', 'Plan carefully before executing a task.'],
    ['grill-me', 'Interview me to align on a plan.'],
    ['schedule', 'Run an instruction on a recurring schedule or as a one-time timer.'],
    ['teamwork', 'Invoke a team of agents to autonomously tackle large projects.'],
    ['learn', 'Reflect on recent successes or corrections to capture reusable skills or rules.'],
    ['boost', 'Invoke the Boost multi-agent orchestrator for complex tasks.'],
    ['btw', 'Ask a quick question without interrupting the main conversation.'],
    ['goal', 'Run until the specified goal is completely finished.'],
    ['compact', 'Compact the conversation now (summarize history to free up the context window).'],
    [
      'swarm_monitor',
      'ONLY for the native-swarm worker whose brief says it is the monitor. On a timer, it checks whether the whole swarm has stalled and calls on the one member who can unstick it. Coordinators and other workers: do not load this.',
    ],
    [
      'antigravity-guide',
      'Provides a comprehensive guide, quick reference, and sitemap for Google Antigravity (AGY), including the Antigravity CLI (agy), Antigravity 2.0, Antigravity IDE, Python SDK, slash commands, keybindings, and customizations (skills, rules, MCP, sidecars). Activate this skill when the user asks questions about how to use, configure, or customize Antigravity, AGY, the agy CLI, the Antigravity IDE, or Antigravity 2.0.',
    ],
    [
      'chrome-extensions',
      "Build and publish Chrome Extensions using Manifest V3 best practices. Use this skill whenever the user asks to create, modify, debug, or understand Chrome browser extensions, add-ons, or anything involving the Chrome Extensions API. Trigger on mentions of: 'Chrome extension', 'browser extension', 'manifest.json', 'content script', 'service worker' (in browser context), 'popup' (in browser extension context), 'side panel', 'chrome.* API', 'declarativeNetRequest', 'omnibox', 'context menu' (in extension context), 'userScripts', 'user script', 'script manager', or any request to build functionality that integrates with the Chrome browser UI. Also trigger for publishing to the Chrome Web Store: 'publish extension', preparing an extension for publishing, responding to a review rejection, writing permission justifications, or drafting a privacy policy.",
    ],
    [
      'modern-web-guidance',
      'Search tool for modern web development best practices. MANDATORY: Execute FIRST.\nTrigger immediately for: modals/dialogs/popovers, tables, dark mode.',
    ],
    ['automation', 'Interactive guide to design and create a scheduled background automation. Use this skill when the user wants to create an automated or recurring scheduled task.'],
    ['generative_ui', 'How to render rich interactive HTML widgets inline in the chat or as standalone artifacts.'],
  ];

  const rowRefs = rows.map(([cmd, desc]) => {
    const opt = new MockElement('div', { role: 'option' });
    const nameEl = new MockElement('span');
    nameEl.appendChild(new MockText(cmd));
    const descEl = new MockElement('span');
    descEl.appendChild(new MockText(desc));
    opt.appendChild(nameEl);
    opt.appendChild(descEl);
    listbox.appendChild(opt);
    return { cmd, nameEl, descEl };
  });

  // 对比验证：普通界面中的首字母大写 "Browser" / "Plan" 仍正常翻译
  const navBrowser = new MockElement('span');
  navBrowser.appendChild(new MockText('Browser'));
  const navPlan = new MockElement('span');
  navPlan.appendChild(new MockText('Plan'));

  body.appendChild(listbox);
  body.appendChild(navBrowser);
  body.appendChild(navPlan);

  installDomEngine(dom.win, bundle);

  for (const r of rowRefs) {
    assert.equal(r.nameEl.textContent, r.cmd, `Slash identifier "${r.cmd}" must remain untouched in English`);
    assert.match(r.descEl.textContent, /[\u4e00-\u9fff]/, `Description for "${r.cmd}" should be translated to Chinese`);
  }
  assert.equal(navBrowser.textContent, '浏览器');
  assert.equal(navPlan.textContent, '计划');
});

test('Code, paths, URLs, acronyms, PowerShell cmdlets, slugs, and shell commands are strictly shielded', () => {
  const t = createDomTranslator(bundle);
  const shieldedSamples = [
    'C:\\Users\\Demo\\AppData\\Local\\Programs\\antigravity',
    '/usr/local/bin/node',
    './tools/patcher.js',
    'https://github.com/demo/not-a-word-of-english',
    'v2.33.0',
    '$HOME',
    '%APPDATA%',
    '--yes',
    'useEffect',
    'max_tokens',
    'modern-web-guidance',
    'Ctrl',
    '16px',
    'app.asar',
    'API',
    'MCP',
    'JSON',
    'WSL',
    'rm -rf /tmp/build',
    'git push --force origin main',
    'node cli.js install --yes',
    'Remove-Item -Recurse ./tmp',
    'Get-ChildItem -Force',
    'npm run build && echo done',
  ];
  for (const sample of shieldedSamples) {
    const res = t.translateText(sample);
    assert.equal(res.changed, false, `Expected "${sample}" to be shielded, got "${res.translated}"`);
  }
});

test('High-risk terminal command approval preserves raw command verbatim and enforces bilingual options', () => {
  const dom = createMockDom();
  const { body, MockElement, MockText } = dom;

  const dialog = new MockElement('div', { role: 'dialog' });
  const heading = new MockElement('h2');
  heading.appendChild(new MockText('Command requires approval'));
  const warning = new MockElement('p');
  warning.appendChild(new MockText('This command will run outside the sandbox'));
  const reqLine = new MockElement('div');
  reqLine.appendChild(new MockText('Requesting permission to run rm -rf ./build'));
  const editor = new MockElement('textarea', {
    'aria-label': 'Edit permission target',
    'data-testid': 'permission-target-editor',
  });
  editor.appendChild(new MockText('rm -rf ./build'));
  const opt1 = new MockElement('div', { 'data-testid': 'ask-question-option-text' });
  opt1.appendChild(new MockText('Yes, allow this time'));
  const opt2 = new MockElement('div', { 'data-testid': 'ask-question-option-text' });
  opt2.appendChild(new MockText("Yes, and always allow 'rm -rf ./build' in this conversation"));
  const opt3 = new MockElement('div', { 'data-testid': 'ask-question-option-text' });
  opt3.appendChild(new MockText("Yes, and always allow 'rm -rf ./build'"));
  const btnAllow = new MockElement('button');
  btnAllow.appendChild(new MockText('ALWAYS ALLOW'));
  const btnDeny = new MockElement('button');
  btnDeny.appendChild(new MockText('Deny'));
  const btnClose = new MockElement('button');
  btnClose.appendChild(new MockText('Close'));

  dialog.appendChild(heading);
  dialog.appendChild(warning);
  dialog.appendChild(reqLine);
  dialog.appendChild(editor);
  dialog.appendChild(opt1);
  dialog.appendChild(opt2);
  dialog.appendChild(opt3);
  dialog.appendChild(btnAllow);
  dialog.appendChild(btnDeny);
  dialog.appendChild(btnClose);
  body.appendChild(dialog);

  installDomEngine(dom.win, bundle);

  assert.equal(editor.textContent, 'rm -rf ./build');
  assert.equal(editor.getAttribute('aria-label'), '编辑授权目标命令 (Edit permission target)');
  assert.equal(heading.textContent, '该命令需要人工批准 (Command requires approval)');
  assert.equal(
    warning.textContent,
    '警告：此命令将在沙盒外运行 (This command will run outside the sandbox)'
  );
  assert.equal(
    reqLine.textContent,
    '请求授权执行命令 (Requesting permission to run)：rm -rf ./build'
  );
  assert.equal(opt1.textContent, '是，仅允许这一次 (Yes, allow this time)');
  assert.equal(
    opt2.textContent,
    "是，且在本次对话中始终允许 (Yes, and always allow in this conversation)：'rm -rf ./build'"
  );
  assert.equal(
    opt3.textContent,
    "高风险：是，并永久始终允许 (Yes, and always allow)：'rm -rf ./build'"
  );
  assert.equal(btnAllow.textContent, '始终允许 (Always Allow)');
  assert.equal(btnDeny.textContent, '拒绝 (Deny)');
  assert.equal(btnClose.textContent, '关闭 (Close)');
});

test('Complex commands with inner single quotes, Chinese paths, newlines, $env variables, and mixed-language UI templates translate cleanly without loops', () => {
  const t = createDomTranslator(bundle);
  const complexCmd =
    "$env:GCM_INTERACTIVE = 'never'; $env:GIT_TERMINAL_PROMPT = '0'; git -c safe.directory=E:/示例项目 -c http.proxy=http://127.0.0.1:7897 push origin main v1.0.2";

  const opt2Raw = `Yes, and always allow '${complexCmd}' in this conversation`;
  const opt2Res = t.translateText(opt2Raw);
  assert.equal(opt2Res.changed, true);
  assert.equal(
    opt2Res.translated,
    `是，且在本次对话中始终允许 (Yes, and always allow in this conversation)：'${complexCmd}'`
  );
  // 幂等性校验：二次翻译必须微秒短路，绝不重复包装
  assert.equal(t.translateText(opt2Res.translated).changed, false);

  const opt3Raw = `Yes, and always allow '${complexCmd}'`;
  const opt3Res = t.translateText(opt3Raw);
  assert.equal(opt3Res.changed, true);
  assert.equal(opt3Res.translated, `高风险：是，并永久始终允许 (Yes, and always allow)：'${complexCmd}'`);
  assert.equal(t.translateText(opt3Res.translated).changed, false);

  // 多行命令与无单引号目标（如域名/工具授权）
  const multiLineCmd = "echo '第一行'\ngit status --short";
  const multiLineRes = t.translateText(`Yes, and always allow '${multiLineCmd}' in this conversation`);
  assert.equal(multiLineRes.changed, true);
  assert.equal(
    multiLineRes.translated,
    `是，且在本次对话中始终允许 (Yes, and always allow in this conversation)：'${multiLineCmd}'`
  );

  assert.equal(
    t.translateText('Yes, and always allow github.com in this conversation').translated,
    '是，且在本次对话中始终允许 (Yes, and always allow in this conversation)：github.com'
  );
  assert.equal(
    t.translateText('Yes, and always allow "https://example.com" in this workspace').translated,
    '是，且在当前项目中始终允许 (Yes, and always allow in this workspace)："https://example.com"'
  );

  // 含中文参数的常规与高风险混合模板
  assert.equal(t.translateText('Select project, current: 示例项目').translated, '选择项目（当前：示例项目）');
  assert.equal(t.translateText('Branch, current: 功能分支').translated, 'Git 分支（当前：功能分支）');
  assert.equal(t.translateText('Search in 示例项目...').translated, '在 示例项目 中搜索...');
  assert.equal(
    t.translateText('Delete side question: 菜单翻译').translated,
    '删除旁白追问：菜单翻译 (Delete side question: 菜单翻译)'
  );
  assert.equal(
    t.translateText('Allow 推送更新到 GitHub?').translated,
    '是否允许 推送更新到 GitHub？ (Allow 推送更新到 GitHub?)'
  );

  // 审批卡片即使位于助手消息区域内（controlOnly）且使用 Allow ...? 标题，选项与提交按钮仍可靠双语化
  const dom = createMockDom();
  const { body, MockElement, MockText } = dom;
  const assistantMsg = new MockElement('div', { 'data-message-role': 'assistant' });
  const approvalCard = new MockElement('div', { 'data-testid': 'command-approval-card' });
  const titleEl = new MockElement('div');
  titleEl.appendChild(new MockText('Allow push update to GitHub?'));
  const opt1Btn = new MockElement('button');
  opt1Btn.appendChild(new MockText('Yes, allow this time'));
  const opt2Btn = new MockElement('button');
  opt2Btn.appendChild(new MockText(opt2Raw));
  const opt3Btn = new MockElement('button');
  opt3Btn.appendChild(new MockText(opt3Raw));
  const submitBtn = new MockElement('button');
  submitBtn.appendChild(new MockText('Submit'));

  approvalCard.appendChild(titleEl);
  approvalCard.appendChild(opt1Btn);
  approvalCard.appendChild(opt2Btn);
  approvalCard.appendChild(opt3Btn);
  approvalCard.appendChild(submitBtn);
  assistantMsg.appendChild(approvalCard);
  body.appendChild(assistantMsg);

  installDomEngine(dom.win, bundle);

  assert.equal(titleEl.textContent, '是否允许 push update to GitHub？ (Allow push update to GitHub?)');
  assert.equal(opt1Btn.textContent, '是，仅允许这一次 (Yes, allow this time)');
  assert.equal(opt2Btn.textContent, opt2Res.translated);
  assert.equal(opt3Btn.textContent, opt3Res.translated);
  assert.equal(submitBtn.textContent, '提交 (Submit)');
});

test('Physical immunity sandbox isolates Monaco, xterm, File Viewer code, breadcrumbs, prose, and streaming word spans', () => {
  const dom = createMockDom();
  const { body, MockElement, MockText } = dom;

  const monaco = new MockElement('div', {}, ['monaco-editor']);
  const monacoBtn = new MockElement('button');
  monacoBtn.appendChild(new MockText('Settings'));
  monaco.appendChild(monacoBtn);

  const xterm = new MockElement('div', {}, ['xterm']);
  const termSpan = new MockElement('span');
  termSpan.appendChild(new MockText('3 files changed'));
  xterm.appendChild(termSpan);

  const fileViewer = new MockElement('div', { 'aria-label': 'File Viewer' });
  const codeSpan = new MockElement('span');
  codeSpan.appendChild(new MockText('Open'));
  const foldBtn = new MockElement('button', { title: 'Fold lines 6-9', 'aria-label': 'Fold code block' });
  fileViewer.appendChild(codeSpan);
  fileViewer.appendChild(foldBtn);

  const crumbs = new MockElement('nav', { 'aria-label': 'File path breadcrumbs' });
  const folderCrumb = new MockElement('span');
  folderCrumb.appendChild(new MockText('Settings'));
  crumbs.appendChild(folderCrumb);

  const prose = new MockElement('div', { 'data-message-role': 'assistant' }, ['markdown-body']);
  const proseP = new MockElement('p');
  proseP.appendChild(new MockText('Settings'));
  const copyBtn = new MockElement('button');
  copyBtn.appendChild(new MockText('Copy'));
  prose.appendChild(proseP);
  prose.appendChild(copyBtn);

  const streamP = new MockElement('p');
  const streamWords = ['The', 'request', 'Allow', 'Error', 'was', 'checked.'];
  const streamSpans = streamWords.map((w) => {
    const sp = new MockElement('span');
    sp.appendChild(new MockText(w));
    streamP.appendChild(sp);
    return sp;
  });

  const input = new MockElement('input', { placeholder: 'Search settings...', value: 'Settings' });

  body.appendChild(monaco);
  body.appendChild(xterm);
  body.appendChild(fileViewer);
  body.appendChild(crumbs);
  body.appendChild(prose);
  body.appendChild(streamP);
  body.appendChild(input);

  installDomEngine(dom.win, bundle);

  assert.equal(monacoBtn.textContent, 'Settings');
  assert.equal(termSpan.textContent, '3 files changed');
  assert.equal(codeSpan.textContent, 'Open');
  assert.equal(foldBtn.getAttribute('title'), '折叠第 6-9 行');
  assert.equal(foldBtn.getAttribute('aria-label'), '折叠代码块');
  assert.equal(folderCrumb.textContent, 'Settings');
  assert.equal(proseP.textContent, 'Settings');
  assert.equal(copyBtn.textContent, '复制');
  streamSpans.forEach((sp, i) => assert.equal(sp.textContent, streamWords[i]));
  assert.equal(input.getAttribute('placeholder'), '搜索设置...');
  assert.equal(input.getAttribute('value'), 'Settings');
});

test('Large Settings dialog stays clean Chinese in zh mode while translating long descriptions and menus', () => {
  const dom = createMockDom();
  const { body, MockElement, MockText } = dom;

  const settingsDialog = new MockElement('div', { role: 'dialog' });
  const filler = new MockElement('div');
  filler.appendChild(new MockText('x'.repeat(1700) + ' bypass sandbox'));
  const foldersH = new MockElement('h3');
  foldersH.appendChild(new MockText('Folders'));
  const descP = new MockElement('p');
  descP.appendChild(
    new MockText(
      'The breakdown below shows token usage from customizations like rules, skills, and MCP. If a budget is exceeded, large rules are demoted to path pointers and large customizations are excluded automatically.'
    )
  );
  const splitRight = new MockElement('div', { role: 'menuitem' });
  splitRight.appendChild(new MockText('Split Right'));
  const pullReq = new MockElement('div', { role: 'menuitem' });
  pullReq.appendChild(new MockText('Pull Requests'));

  settingsDialog.appendChild(filler);
  settingsDialog.appendChild(foldersH);
  settingsDialog.appendChild(descP);
  body.appendChild(settingsDialog);
  body.appendChild(splitRight);
  body.appendChild(pullReq);

  installDomEngine(dom.win, bundle);

  assert.equal(foldersH.textContent, '文件夹');
  assert.match(descP.textContent, /下方明细展示了规则、技能与 MCP/);
  assert.equal(splitRight.textContent, '向右拆分');
  assert.equal(pullReq.textContent, '拉取请求 (PR)');
});

test('Bottom-right floating language switcher mounts in Shadow DOM with zero hotkeys, switches zh/bilingual/en, and trips circuit breaker on errors', () => {
  const dom = createMockDom();
  const { body, MockElement, MockText, MockShadowRoot } = dom;

  const shadowHost = new MockElement('div');
  const shadow = new MockShadowRoot(shadowHost);
  const shadowSpan = new MockElement('span');
  shadowSpan.appendChild(new MockText('Preferences'));
  shadowHost.shadowRoot = shadow;
  shadow.appendChild(shadowSpan);

  const highRiskBtn = new MockElement('button');
  highRiskBtn.appendChild(new MockText('Allow'));
  const turboLabel = new MockElement('span');
  turboLabel.appendChild(new MockText('Turbo'));

  body.appendChild(shadowHost);
  body.appendChild(highRiskBtn);
  body.appendChild(turboLabel);

  const { controller } = installDomEngine(dom.win, bundle);

  // 无任何键盘快捷键监听
  assert.equal(dom.win._keydownListeners.length, 0);

  // 右下角悬浮按钮挂载在独立 Shadow DOM 且标记 data-nawe-skip="true"
  const floatingHost = body.childNodes.find((n) => n.id === 'nawe-floating-root');
  assert.ok(floatingHost);
  assert.equal(floatingHost.getAttribute('data-nawe-skip'), 'true');
  assert.ok(floatingHost.shadowRoot);

  // 模式 1：标准中文
  assert.equal(controller.getMode(), 'zh');
  assert.equal(shadowSpan.textContent, '偏好设置');
  assert.equal(highRiskBtn.textContent, '允许 (Allow)');
  assert.equal(turboLabel.textContent, '极速全放行 (Turbo)');

  // 模式 2：中英对照
  controller.setMode('bilingual');
  assert.equal(controller.getMode(), 'bilingual');
  assert.equal(shadowSpan.textContent, '偏好设置 (Preferences)');
  assert.equal(highRiskBtn.textContent, '允许 (Allow)');

  // 模式 3：英文原版
  controller.setMode('en');
  assert.equal(controller.getMode(), 'en');
  assert.equal(shadowSpan.textContent, 'Preferences');
  assert.equal(highRiskBtn.textContent, 'Allow');

  // 切回中文并触发异常熔断 -> 自动恢复英文原版
  controller.setMode('zh');
  assert.equal(shadowSpan.textContent, '偏好设置');
  for (let i = 0; i < 15; i++) {
    controller._forceErrorForTest(new Error('synthetic'));
  }
  assert.equal(controller.isTripped(), true);
  assert.equal(shadowSpan.textContent, 'Preferences');
});

test('Text selection popovers, shortcut-suffixed labels, and copy/clipboard popups translate cleanly inside prose and file viewer', () => {
  const dom = createMockDom();
  const { body, MockElement, MockText } = dom;

  const msg = new MockElement('div', { 'data-message-role': 'assistant' }, ['markdown-body']);
  const proseText = new MockElement('p');
  proseText.appendChild(new MockText('Quote'));

  // 划词浮动工具栏（模拟两种 DOM 形态：拆分子节点 vs 单文本节点带快捷键后缀）
  const popover = new MockElement('div', { role: 'toolbar' });
  const quoteBtn = new MockElement('button', { title: 'Quote (Ctrl+L)' });
  const quoteLabel = new MockElement('span');
  quoteLabel.appendChild(new MockText('Quote'));
  const quoteKbd = new MockElement('kbd');
  quoteKbd.appendChild(new MockText('Ctrl+L'));
  quoteBtn.appendChild(quoteLabel);
  quoteBtn.appendChild(quoteKbd);

  const sideQBtn = new MockElement('button');
  sideQBtn.appendChild(new MockText('Side Question Ctrl+E'));

  const commentItem = new MockElement('div');
  commentItem.appendChild(new MockText('Comment Ctrl+M'));

  const toast = new MockElement('div');
  toast.appendChild(new MockText('Copied to clipboard'));

  popover.appendChild(quoteBtn);
  popover.appendChild(sideQBtn);
  popover.appendChild(commentItem);
  msg.appendChild(proseText);
  msg.appendChild(popover);
  body.appendChild(msg);
  body.appendChild(toast);

  installDomEngine(dom.win, bundle);

  // 对话正文中的英文词 "Quote" 仍受物理免疫保护
  assert.equal(proseText.textContent, 'Quote');
  // 划词浮窗按钮、快捷键后缀与提示气泡全部精准汉化，快捷键本身原样保留
  assert.equal(quoteLabel.textContent, '引用');
  assert.equal(quoteKbd.textContent, 'Ctrl+L');
  assert.equal(quoteBtn.getAttribute('title'), '引用 (Ctrl+L)');
  assert.equal(sideQBtn.textContent, '旁白追问 Ctrl+E');
  assert.equal(commentItem.textContent, '批注 Ctrl+M');
  assert.equal(toast.textContent, '已复制到剪贴板');

  // 动态行数与 macOS/标点快捷键后缀测试
  const t = createDomTranslator(bundle);
  assert.equal(t.translateText('Record Audio Ctrl+M').translated, '录制语音 Ctrl+M');
  assert.equal(t.translateText('Open Settings Ctrl+,').translated, '打开设置 Ctrl+,');
  assert.equal(t.translateText('Add to Chat ⌘L').translated, '添加到对话 ⌘L');
  assert.equal(t.translateText('Copied 5 lines').translated, '已复制 5 行');
  assert.equal(t.translateText('Quote lines 10-20').translated, '引用第 10-20 行');
});

test('Antigravity 2.34.0 voices, model effort tooltips, settings sections, and updated queue wording translate cleanly', () => {
  const dom = createMockDom();
  const { body, MockElement, MockText } = dom;

  // 1) 语音声线选择器弹窗（含拆分按钮文本 node "Use " + "Fola"）
  const modal = new MockElement('div', { role: 'dialog' });
  const voiceHeading = new MockElement('h2');
  voiceHeading.appendChild(new MockText("Choose Antigravity's Voice"));
  const voiceName = new MockElement('div', { 'data-testid': 'voice-picker-name' });
  voiceName.appendChild(new MockText('Fola'));
  const voiceTone = new MockElement('div');
  voiceTone.appendChild(new MockText('Clear and friendly'));
  const dotBtn = new MockElement('button', { 'aria-label': 'Fola, voice 1 of 9' });
  const useBtn = new MockElement('button', { 'data-testid': 'voice-picker-use' });
  useBtn.appendChild(new MockText('Use '));
  useBtn.appendChild(new MockText('Fola'));
  modal.appendChild(voiceHeading);
  modal.appendChild(voiceName);
  modal.appendChild(voiceTone);
  modal.appendChild(dotBtn);
  modal.appendChild(useBtn);
  body.appendChild(modal);

  installDomEngine(dom.win, bundle);

  assert.equal(voiceHeading.textContent, '选择 Antigravity 的语音声线');
  assert.equal(voiceName.textContent, '芙拉');
  assert.equal(voiceTone.textContent, '清晰亲切');
  assert.equal(dotBtn.getAttribute('aria-label'), '声线 Fola（第 1 / 9 个）');
  assert.equal(useBtn.textContent, '使用芙拉');

  const t = createDomTranslator(bundle);
  // 全部 9 个内置声线及描述词均完整覆盖
  const expectedVoices = [
    ['Fola', '芙拉'],
    ['Arlo', '阿洛'],
    ['Cleo', '克莉奥'],
    ['Finn', '芬恩'],
    ['Gero', '杰罗'],
    ['Lora', '洛拉'],
    ['Neno', '尼诺'],
    ['Olin', '奥林'],
    ['Tari', '塔里'],
  ];
  for (const [en, zh] of expectedVoices) {
    assert.equal(t.translateText(en).translated, zh);
  }
  assert.equal(t.translateText('Confident and clear').translated, '自信清晰');
  assert.equal(t.translateText('Warm and engaging').translated, '温暖且富有感染力');
  assert.equal(t.translateText('Warm and approachable').translated, '温和亲近');
  assert.equal(t.translateText('Deep and velvety').translated, '低沉醇厚');
  assert.equal(t.translateText('Light and precise').translated, '轻快干脆');

  // 2) Input Box 排队消息改为“立即发送”
  assert.equal(t.translateText('Send Immediately').translated, '立即发送');
  assert.equal(t.translateText('Alt+Enter Sends immediately').translated, '按 Alt+Enter 键：立即发送');

  // 3) 2.34.0 新增模型选择器、置顶对话、更新与工具权限设置文案
  assert.equal(t.translateText('Thinking effort').translated, '思考深度');
  assert.equal(t.translateText('Extra High').translated, '超高');
  assert.equal(t.translateText('Leaving Soon').translated, '即将下线');
  assert.equal(t.translateText('For your hardest, long-horizon tasks').translated, '专为最复杂、超长跨度的高难度任务打造');
  assert.equal(
    t.translateText('The original Gemini 4 model for advanced workflows. Leaving on Nov 30.').translated,
    '面向进阶工作流的初代 Gemini 4 模型，将于 11 月 30 日下线。'
  );
  assert.equal(t.translateText('Pinned Conversations').translated, '置顶对话');
  assert.equal(t.translateText('Show 6 More').translated, '再显示 6 项');
  assert.equal(t.translateText('Input Box').translated, '输入框');
  assert.equal(t.translateText('File access rules').translated, '文件访问规则');
  assert.equal(t.translateText('Terminal commands').translated, '终端命令');
  assert.equal(t.translateText('MCP tools').translated, 'MCP 工具');
  assert.equal(t.translateText('Commands outside sandbox').translated, '沙盒外允许执行的命令 (Commands outside sandbox)');
  assert.match(
    t.translateText('Controls whether terminal commands require your approval before running.\n\nNote: A change to this setting will only apply to new messages sent to the agent.').translated,
    /控制运行终端命令前是否需要人工批准/
  );

  // 4) 客户端更新胶囊 / 弹窗 / 单单位重置倒计时
  assert.equal(t.translateText('Downloading Update').translated, '正在下载更新');
  assert.equal(t.translateText('Install Update').translated, '安装更新');
  assert.equal(t.translateText('Installing Update').translated, '正在安装更新');
  assert.equal(t.translateText('Restart to Update').translated, '重启以更新');
  assert.equal(t.translateText('Updating…').translated, '正在更新…');
  assert.equal(t.translateText('Update Anyway').translated, '仍然更新');
  assert.equal(t.translateText('Active Tasks & Conversations:').translated, '进行中的任务与对话：');
  assert.equal(
    t.translateText('You have 3 conversations in progress. Updating will interrupt them, and they will automatically resume once the update completes.').translated,
    '当前有 3 个对话正在进行中。更新将暂时中断这些对话，更新完成后会自动恢复继续执行。'
  );
  assert.equal(
    t.translateText("You have 2 conversations in progress. Updating will cancel them and you'll need to manually restart them.").translated,
    '当前有 2 个对话正在进行中。更新将取消这些对话，之后你需要手动重新发起。'
  );
  assert.equal(t.translateText('A new version is available.').translated, '发现新版本可用。');
  assert.equal(t.translateText('Resets in <1m').translated, '将在 1 分钟内重置');
  assert.equal(t.translateText('Resets in 2d').translated, '将在 2 天后重置');
  assert.equal(t.translateText('Resets in 4h').translated, '将在 4 小时后重置');
  assert.equal(t.translateText('Copy Content').translated, '复制内容');
  assert.equal(t.translateText('Download File').translated, '下载文件');
  assert.equal(t.translateText('Show in File Explorer').translated, '在文件资源管理器中显示');
});

test('Antigravity 2.35.1 Models/Credits, Orchestrator, Permissions, Browser Rules, Customizations, Skills, and Marketplace translate cleanly', () => {
  const dom = createMockDom();
  const { body, MockElement, MockText } = dom;

  // 1) Customizations 列表：验证斜杠指令原词锁定，而插件/技能说明、Search/Built In/Sign in required/空态全部汉化
  const searchInput = new MockElement('input', { placeholder: 'Search customizations...' });
  const skillsHeading = new MockElement('h2');
  skillsHeading.appendChild(new MockText('Skills & Rules'));

  const listbox = new MockElement('div', { role: 'listbox' });
  const skillRows = [
    [
      '/conversations',
      'Built In',
      'Manage local Antigravity conversations programmatically over HTTP+JSON: create a new conversation (with an optional initial prompt), list conversations, read conversation metadata and run state, rename, archive, pin, star, tag, or group conversations, and delete conversations.',
    ],
    [
      '/mcp-app-development',
      'Built In',
      'Build, package, and debug MCP Apps for Antigravity: MCP server tools whose results render as interactive UI in the conversation, in the side pane, or full-page from the sidebar.',
    ],
    [
      '/permissioned-github',
      'Built In',
      'Guidelines for interacting with GitHub and request permissions from the user when commands fail due to restrictions in the agent environment.',
    ],
    [
      '/swarm_pane',
      'Built In',
      "ONLY for the coordinator of an active /swarm session. What the coordinator writes so the Swarm UI's Overview can show the swarm's goal, its groups of work and a screenshot timeline; load it before you brief and add the first workers. Outside /swarm, do not load this.",
    ],
  ];

  const rowRefs = skillRows.map(([cmd, badge, desc]) => {
    const opt = new MockElement('div', { role: 'option' });
    const cmdEl = new MockElement('span');
    cmdEl.appendChild(new MockText(cmd));
    const badgeEl = new MockElement('span');
    badgeEl.appendChild(new MockText(badge));
    const descEl = new MockElement('span');
    descEl.appendChild(new MockText(desc));
    opt.appendChild(cmdEl);
    opt.appendChild(badgeEl);
    opt.appendChild(descEl);
    listbox.appendChild(opt);
    return { cmd, cmdEl, badgeEl, descEl };
  });

  const emptyAgents = new MockElement('p');
  emptyAgents.appendChild(new MockText('No custom agents yet.'));
  const emptyMcp = new MockElement('p');
  emptyMcp.appendChild(new MockText('No MCP servers yet. Use Add to browse the store.'));

  body.appendChild(searchInput);
  body.appendChild(skillsHeading);
  body.appendChild(listbox);
  body.appendChild(emptyAgents);
  body.appendChild(emptyMcp);

  installDomEngine(dom.win, bundle);

  assert.equal(searchInput.getAttribute('placeholder'), '搜索自定义配置...');
  assert.equal(skillsHeading.textContent, '技能与规则');
  for (const r of rowRefs) {
    assert.equal(r.cmdEl.textContent, r.cmd, `Slash identifier "${r.cmd}" must stay locked`);
    assert.equal(r.badgeEl.textContent, '内置');
    assert.match(r.descEl.textContent, /[\u4e00-\u9fff]/);
  }
  assert.equal(emptyAgents.textContent, '暂无自定义智能体。');
  assert.equal(emptyMcp.textContent, '暂无 MCP 服务器，点击添加按钮即可浏览商店。');

  const t = createDomTranslator(bundle);

  // 2) Models & Usage / AI Credits / Orchestrator / Quota
  assert.equal(
    t.translateText(
      "When toggled on, Antigravity will use your AI credits to fulfill model requests once you're out of model quota. Antigravity will always use your model quota first before using AI credits."
    ).translated,
    '开启后，当你的模型配额用尽时，Antigravity 将使用 AI 积分继续处理模型请求。系统会始终优先消耗模型配额，再使用 AI 积分。'
  );
  assert.equal(t.translateText('Available AI credits: 1200').translated, '可用 AI 积分：1200');
  assert.equal(t.translateText('Orchestrator Settings').translated, '编排器设置');
  assert.equal(t.translateText('Orchestrator Model').translated, '编排器模型');
  assert.equal(t.translateText('Executor Model').translated, '执行器模型');
  assert.equal(t.translateText('Model selection').translated, '模型选择');
  assert.equal(
    t.translateText(
      'You have hit your weekly limit, it refreshes in 39 minutes. If on a supported paid plan, you can use AI credits in the interim or upgrade to a higher tier.'
    ).translated,
    '你已达到每周限额，将于 39 分钟后重置。如使用受支持的付费方案，期间可使用 AI 积分继续调用，或升级至更高档位。'
  );
  assert.equal(
    t.translateText(
      'You have hit your weekly limit, the 5-hour limit does not currently apply. Your weekly limit will fully refresh in 39 minutes.'
    ).translated,
    '你已达到每周限额，当前不适用 5 小时限额。你的每周限额将于 39 分钟后完全重置。'
  );
  assert.equal(
    t.translateText('You need at least 50 AI Credits to send messages. To continue using Gemini 4 Neon now, purchase more AI Credits.').translated,
    '需要至少 50 AI 积分才能发送消息。若需立即继续使用 Gemini 4 Neon，请购买更多 AI 积分。'
  );
  assert.equal(
    t.translateText('Quota is shared across all models in this group.').translated,
    '该分组内的所有模型共享同一配额。'
  );
  assert.equal(
    t.translateText('Models in this group share the same quota pool.').translated,
    '该分组内的模型共享同一配额池。'
  );
  assert.match(
    t.translateText('Models in this group share the 5-hour and weekly quota.').translated,
    /^该分组内的模型共享 /
  );

  // 3) Tool Permissions & Browser Actuation Rules
  assert.equal(t.translateText('Plugin permissions').translated, '插件权限');
  assert.equal(t.translateText('Changes plugins can make without asking.').translated, '插件无需再次询问即可执行的更改操作。');
  assert.equal(
    t.translateText("Nothing is always allowed. You'll be asked before this plugin makes changes.").translated,
    '当前无始终允许的操作。插件在执行更改前会向你请求确认。'
  );
  assert.equal(t.translateText('Browser actuation rules').translated, '浏览器操作规则');
  assert.equal(t.translateText('Browser Actuation Permissions').translated, '浏览器操作权限');
  assert.equal(t.translateText('Execute URLs').translated, '允许操作的网址');
  assert.equal(t.translateText('Download files').translated, '下载文件');
  assert.equal(t.translateText('Clear Browsing Data?').translated, '清除浏览数据？');
  assert.equal(t.translateText('3 cookies').translated, '3 个 Cookie');

  // 4) 已安装插件、技能、应用市场货架与代表性插件（含 >320 字符描述）
  assert.equal(t.translateText('Sign in required').translated, '需要登录');
  assert.equal(t.translateText('Unlock the power of agent swarms.').translated, '释放多智能体集群协作的强大能力。');
  assert.equal(
    t.translateText('Access and clone GitHub repositories in remote environments.').translated,
    '在远程环境中访问并克隆 GitHub 代码仓库。'
  );
  assert.equal(
    t.translateText(
      'Reliable automation, in-depth debugging, and performance analysis in Chrome using Chrome DevTools and Puppeteer'
    ).translated,
    '借助 Chrome DevTools 与 Puppeteer，在 Chrome 中实现可靠的自动化、深度调试与性能分析。'
  );
  assert.equal(t.translateText('Search, read, draft, and send emails in Gmail.').translated, '在 Gmail 中搜索、阅读、起草和发送电子邮件。');
  assert.equal(t.translateText('Google Workspace').translated, 'Google Workspace 办公套件');
  assert.equal(t.translateText('Build with Google').translated, 'Google 开发者平台');
  assert.equal(t.translateText('Design, Creative & Media').translated, '设计、创意与媒体');
  assert.equal(t.translateText('Productivity & Project Management').translated, '效率与项目管理');
  assert.equal(
    t.translateText('Enter the configuration values this MCP server needs. Saving restarts the server with them.').translated,
    '请输入此 MCP 服务器所需的配置参数，保存后将使用新配置重启服务器。'
  );
  assert.match(
    t.translateText(
      "This plugin provides a specialized suite of skills for data engineers and database practitioners working on Google Cloud. It acts as an expert assistant, allowing you to use natural language prompts in your preferred coding agent to architect complex data pipelines, transform data with dbt, write Spark and BigQuery SQL notebooks, and orchestrate end-to-end workflows across GCP's data ecosystem."
    ).translated,
    /专为 Google Cloud 数据工程师/
  );
  assert.match(
    t.translateText(
      'Teamwork Graph CLI is Atlassian\'s agent-first interface to your entire work context: Jira issues, Confluence pages, Bitbucket PRs, along with your connected third-party data sources. Purpose-built for coding agents like Antigravity (terminal or desktop), and powered by Atlassian\'s context graph. Try: "draft a Jira issue from this PR and link it to the epic." Run /twg-setup after install to connect Atlassian Teamwork Graph CLI to Antigravity.'
    ).translated,
    /Teamwork Graph CLI 是 Atlassian/
  );
});

test('Anti-drift resilience preserves translations across typography, casing, punctuation, multiline JSX, and DOM refactors without breaching code shields', () => {
  const t = createDomTranslator(bundle);

  // 1) 弯引号、省略号（… vs ...）、换行/不间断空格、连字符、大小写（>64 字符长句）与末尾标点漂移
  assert.equal(
    t.translateText(
      'when toggled on, Antigravity will use your AI credits to fulfill model requests once you\u2019re out of model quota.\nAntigravity will always use\u00a0your model quota first before using AI credits.'
    ).translated,
    '开启后，当你的模型配额用尽时，Antigravity 将使用 AI 积分继续处理模型请求。系统会始终优先消耗模型配额，再使用 AI 积分。'
  );
  assert.equal(t.translateText('Sign-in required').translated, '需要登录');
  assert.equal(t.translateText('Built-in').translated, '内置');
  assert.equal(t.translateText('Search projects...').translated, '搜索项目…');
  assert.equal(t.translateText('Search customizations\u2026').translated, '搜索自定义配置...');
  assert.equal(t.translateText('No Plugins Available').translated, '暂无可用插件');
  assert.equal(t.translateText('No plugins available').translated, '暂无可用插件');
  assert.equal(t.translateText('No custom agents yet').translated, '暂无自定义智能体');
  assert.equal(t.translateText('Downloading update\u2026').translated, '正在下载更新...');
  assert.equal(t.translateText('Something went wrong!').translated, '出现了一些问题！');
  assert.equal(t.translateText('Source:').translated, '源码：');
  assert.equal(t.translateText('Loading').translated, '正在加载');
  assert.equal(t.translateText('Working...').translated, '处理中...');
  assert.equal(t.translateText('Settings - ').translated, '设置 - ');

  // 2) 动态模板在弯引号与换行下仍准确命中
  assert.equal(
    t.translateText(
      'Your plan\u2019s baseline quota will refresh on\n5/1/2026. To continue using this model now, enable AI Credit overages.'
    ).translated,
    '你的方案基础配额将于 5/1/2026 重置。若需立即继续使用此模型，请开启 AI 积分超额计费。'
  );

  // 3) 高风险长句即使大小写/弯引号微调，仍强制保留英文双语对照（绝不降级）
  const hrDrifted = t.translateText(
    'CONTROLS WHETHER THE AGENT CAN RUN CUSTOM JAVASCRIPT TO AUTOMATE COMPLEX BROWSER ACTIONS.'
  );
  assert.equal(hrDrifted.changed, true);
  assert.match(hrDrifted.translated, /Browser|JavaScript/i);
  assert.match(hrDrifted.translated, /[\u4e00-\u9fff]/);

  // 4) 安全护盾零回退：代码/路径/命令/kebab-slug/缩写/裸斜杠词依然 100% 锁定
  for (const shielded of [
    'modern-web-guidance',
    'API',
    'JSON',
    'useEffect',
    'git push --force origin main',
    'rm -rf /tmp/build',
    'C:\\Users\\Demo\\app.asar',
  ]) {
    const res = t.translateText(shielded);
    assert.equal(res.changed, false, `Expected "${shielded}" to remain shielded, got "${res.translated}"`);
  }

  // 5) DOM/React 抗重构：UI 控件内 4+ 单词 span 正常翻译，流式英文正文与 File Viewer 仍受保护，扩展属性生效
  const dom = createMockDom();
  const { body, MockElement, MockText } = dom;

  const tablist = new MockElement('div', { role: 'tablist' });
  const spans = ['Low', 'Medium', 'High', 'Auto'].map((w) => {
    const s = new MockElement('span');
    s.appendChild(new MockText(w));
    tablist.appendChild(s);
    return s;
  });

  const streamP = new MockElement('p');
  const streamSpans = ['The', 'request', 'Allow', 'Error', 'was', 'checked.'].map((w) => {
    const s = new MockElement('span');
    s.appendChild(new MockText(w));
    streamP.appendChild(s);
    return s;
  });

  const fileViewer = new MockElement('div', { 'aria-label': 'File Viewer' });
  const innerCodeSpan = new MockElement('span');
  innerCodeSpan.appendChild(new MockText('Open'));
  fileViewer.appendChild(innerCodeSpan);

  const customInput = new MockElement('div', {
    'aria-placeholder': 'Search customizations...',
    'data-tooltip-content': 'Refresh quota and credits data',
  });
  const localizedViewer = new MockElement('div', { 'aria-label': '文件查看器' });
  const localizedInnerSpan = new MockElement('span');
  localizedInnerSpan.appendChild(new MockText('Open'));
  localizedViewer.appendChild(localizedInnerSpan);

  body.appendChild(tablist);
  body.appendChild(streamP);
  body.appendChild(fileViewer);
  body.appendChild(localizedViewer);
  body.appendChild(customInput);

  const { controller } = installDomEngine(dom.win, bundle);

  assert.deepEqual(
    spans.map((s) => s.textContent),
    ['低', '中', '高', '自动']
  );
  assert.deepEqual(
    streamSpans.map((s) => s.textContent),
    ['The', 'request', 'Allow', 'Error', 'was', 'checked.']
  );
  assert.equal(fileViewer.getAttribute('aria-label'), 'File Viewer');
  assert.equal(innerCodeSpan.textContent, 'Open');
  assert.equal(localizedInnerSpan.textContent, 'Open');
  controller.rescan();
  assert.equal(innerCodeSpan.textContent, 'Open');
  assert.equal(customInput.getAttribute('aria-placeholder'), '搜索自定义配置...');
  assert.equal(customInput.getAttribute('data-tooltip-content'), '刷新配额与积分数据');
});

test('Model group/lock tooltips, Firebase detail page, all 9 Marketplace shelves, and MCP/account setup screens translate cleanly', () => {
  const dom = createMockDom();
  const { body, MockElement, MockText } = dom;

  // 1) 模拟 Firebase 插件详情页（概览提示词、Commands 列表、技能与智能体说明，斜杠标识锁定）
  const detailPage = new MockElement('div');
  const promptBtn = new MockElement('button');
  promptBtn.appendChild(new MockText('Set up Firebase in my app and connect it to a Firebase project'));
  const cmdHeading = new MockElement('h3');
  cmdHeading.appendChild(new MockText('Commands'));
  const cmdRow = new MockElement('div', { role: 'option' });
  const cmdSlug = new MockElement('span');
  cmdSlug.appendChild(new MockText('/firebase-hosting-basics'));
  const cmdDesc = new MockElement('span');
  cmdDesc.appendChild(
    new MockText(
      "Deploys and configures classic Firebase Hosting for static websites, single-page apps (SPAs), and microservices. Use when deploying static sites/SPAs, setting up custom domains, configuring firebase.json hosting settings (redirects, rewrites, headers, multi-site), or managing preview channels. Don't use for Firebase App Hosting (Next.js/SSR), Auth, Firestore queries/rules, Data Connect, or Crashlytics."
    )
  );
  cmdRow.appendChild(cmdSlug);
  cmdRow.appendChild(cmdDesc);

  const readmeSection = new MockElement('section', { 'aria-label': 'Readme', 'data-markdown-root': '' });
  const readmeH2 = new MockElement('h2');
  readmeH2.appendChild(new MockText('🚀 Key Capabilities'));
  readmeSection.appendChild(readmeH2);

  detailPage.appendChild(promptBtn);
  detailPage.appendChild(cmdHeading);
  detailPage.appendChild(cmdRow);
  detailPage.appendChild(readmeSection);
  body.appendChild(detailPage);

  installDomEngine(dom.win, bundle);

  assert.match(promptBtn.textContent, /[\u4e00-\u9fff]/);
  assert.equal(cmdHeading.textContent, '指令');
  assert.equal(cmdSlug.textContent, '/firebase-hosting-basics');
  assert.match(cmdDesc.textContent, /Firebase Hosting/);
  assert.match(cmdDesc.textContent, /[\u4e00-\u9fff]/);
  assert.equal(readmeSection.getAttribute('aria-label'), '自述说明');
  assert.equal(readmeH2.textContent, '🚀 核心能力');

  const t = createDomTranslator(bundle);

  // 2) Gemini / Claude & GPT 分组右侧提示弹窗 + 智能体运行中禁止切换模型提示弹窗
  assert.equal(
    t.translateText(
      'Models within this group: Gemini 4 Neon, Gemini 4 Carbon, Gemini 4 Argon, Gemini 4 Hydrogen, Orchestrator (Neon), Orchestrator (Carbon), Orchestrator (Argon), Gemini 3.8 Flash'
    ).translated,
    '该分组包含的模型：Gemini 4 Neon, Gemini 4 Carbon, Gemini 4 Argon, Gemini 4 Hydrogen, Orchestrator (Neon), Orchestrator (Carbon), Orchestrator (Argon), Gemini 3.8 Flash'
  );
  assert.equal(
    t.translateText('Models within this group: Claude Opus 5.5, Claude Sonnet 5.5, GPT-OSS 120B').translated,
    '该分组包含的模型：Claude Opus 5.5, Claude Sonnet 5.5, GPT-OSS 120B'
  );
  assert.equal(
    t.translateText('Model cannot be changed while the agent is running').translated,
    '智能体运行期间无法切换模型'
  );

  // 3) Firebase 其他推荐提示词与应用配置弹窗（MCP 参数、OAuth 账号、侧边栏 UI 插件）
  assert.match(t.translateText('Add Firebase Authentication with Google sign-in to my app').translated, /[\u4e00-\u9fff]/);
  assert.match(t.translateText('Write and audit Firestore security rules for my data model').translated, /[\u4e00-\u9fff]/);
  assert.equal(t.translateText('Configure looker').translated, '配置 looker');
  assert.equal(t.translateText('Looker Instance FQDN').translated, 'Looker 实例完整域名（FQDN）');
  assert.equal(t.translateText('n8n MCP server URL').translated, 'n8n MCP 服务器地址');
  assert.equal(t.translateText('Arize API Key').translated, 'Arize API 密钥');
  assert.equal(t.translateText('Neo4j URI').translated, 'Neo4j 连接地址（URI）');
  assert.equal(t.translateText('Android Device Hub').translated, 'Android 设备中心');
  assert.equal(t.translateText('Biomolecular Structure Viewer').translated, '生物大分子 3D 结构查看器');
  assert.equal(
    t.translateText('The looker MCP server requires configuration parameters before it can be started.').translated,
    '启动 looker MCP 服务器前需要先填写配置参数。'
  );
  assert.equal(
    t.translateText('Sign in to finish setting up this plugin.').translated,
    '请登录以完成此插件的配置。'
  );
  assert.equal(
    t.translateText('Credentials stay on this machine and are only sent to the domains listed.').translated,
    '凭据仅保存在本机，且只会发送至所列域名。'
  );
  assert.equal(t.translateText('Generate Figma Design').translated, '生成 Figma 设计稿');
});

test('Antigravity 2.35.2 in-flight model switching, sidebar display options, Command Palette, and project/conversation menus translate cleanly', () => {
  const t = createDomTranslator(bundle);

  // 1) Antigravity 2.35.2 运行中切换模型新提示
  assert.equal(
    t.translateText('Applies to /btw and messages sent after this turn').translated,
    '将应用于 /btw 及本轮对话之后发送的消息'
  );
  assert.equal(
    t.translateText('Applies to messages sent after this turn').translated,
    '将应用于本轮对话之后发送的消息'
  );

  // 2) 右侧边栏搜索框与自定义分区
  assert.equal(t.translateText('Search or enter a URL').translated, '搜索或输入网址');
  assert.equal(t.translateText('Skills Used').translated, '已使用的技能');
  assert.equal(t.translateText('Active Goal').translated, '当前目标');
  assert.equal(t.translateText('Agent Edits').translated, '智能体编辑');

  // 3) 命令面板（Command Palette）指令与筛选 + restore_page 图标标识安全锁定
  assert.equal(t.translateText('Search for commands...').translated, '搜索指令...');
  assert.equal(t.translateText('Collapse All Folders').translated, '全部折叠文件夹');
  assert.equal(t.translateText('Expand All Folders').translated, '全部展开文件夹');
  assert.equal(t.translateText('Provide Feedback').translated, '提交反馈');
  assert.equal(t.translateText('Download Diagnostics').translated, '下载诊断信息');
  assert.equal(t.translateText('Toggle Between Light/Dark Themes').translated, '切换浅色/深色主题');
  assert.equal(t.translateText('Mark All as Read').translated, '全部标为已读');
  assert.equal(t.translateText('Unpin This Conversation').translated, '取消置顶当前对话');
  assert.equal(t.translateText('Mark This Conversation as Unread').translated, '将当前对话标为未读');
  assert.equal(t.translateText('Rename This Conversation').translated, '重命名当前对话');
  assert.equal(t.translateText('Copy Conversation Markdown').translated, '复制对话 Markdown');
  assert.equal(t.translateText('File Picker').translated, '文件选择器');
  assert.equal(t.translateText('Open Project Picker').translated, '打开项目选择器');
  assert.equal(t.translateText('Select Sidebar Item 3').translated, '选择侧边栏第 3 项');
  assert.equal(t.translateText('restore_page').changed, false);
  assert.equal(t.translateText('restore_page').translated, 'restore_page');

  // 4) 侧边栏显示选项及子菜单（Sort / Filter / Display / Auto Pin / Archived Only / 收件箱模式）
  assert.equal(t.translateText('Sort Conversations').translated, '对话排序');
  assert.equal(t.translateText('Sort Projects').translated, '项目排序');
  assert.equal(t.translateText('Last Updated').translated, '最近更新');
  assert.equal(t.translateText('Last Prompt').translated, '最近提问');
  assert.equal(t.translateText('Custom Order').translated, '自定义顺序');
  assert.equal(t.translateText('Display').translated, '显示内容');
  assert.equal(t.translateText('Subtitles').translated, '副标题');
  assert.equal(t.translateText('Project + Worktree').translated, '项目 + 工作树');
  assert.equal(t.translateText('Decorations').translated, '附加标识');
  assert.equal(t.translateText('Auto Pin').translated, '自动置顶');
  assert.equal(
    t.translateText('Automatically pin conversations when you send a message. Unpin as needed to keep your Pinned list focused.').translated,
    '发送消息时自动置顶对话，可按需取消置顶以保持置顶列表精简聚焦。'
  );
  assert.equal(t.translateText('Archived Only').translated, '仅看已归档');
  assert.equal(t.translateText('Projects (Archived)').translated, '项目列表（已归档）');
  assert.equal(t.translateText('No archived conversations').translated, '暂无已归档的对话');
  assert.equal(t.translateText('Inbox Mode').translated, '收件箱模式');
  assert.equal(t.translateText('Working Section').translated, '运行中分区');
  assert.equal(t.translateText('Auto-Resolve').translated, '自动归结');
  assert.equal(t.translateText('Needs Input').translated, '等待输入');

  // 5) 项目/对话菜单与高风险删除弹窗
  assert.equal(t.translateText('Copy Project Name').translated, '复制项目名称');
  assert.equal(t.translateText('Delete Project').translated, '删除项目 (Delete Project)');
  assert.equal(t.translateText('Delete Permanently').translated, '永久删除 (Delete Permanently)');
  assert.equal(t.translateText('Mark Unread').translated, '标为未读');
  assert.equal(
    t.translateText('2 active conversations and 1 archived conversation').translated,
    '2 个活跃对话和 1 个已归档对话'
  );
});

test('Adjacent split text nodes merge cleanly without breaking Use+Voice, Automations UI, screenshots 1-15, and all context menus', () => {
  const dom = createMockDom();
  const { body, MockElement, MockText } = dom;

  // 1) 相邻文本节点合并翻译与无损还原（根治 "No ", "automations", " yet" -> "否 自动化 yet"）
  const emptyAutoP = new MockElement('p');
  emptyAutoP.appendChild(new MockText('No '));
  emptyAutoP.appendChild(new MockText('automations'));
  emptyAutoP.appendChild(new MockText(' yet'));

  const matchAutoP = new MockElement('p');
  matchAutoP.appendChild(new MockText('No '));
  matchAutoP.appendChild(new MockText('automations'));
  matchAutoP.appendChild(new MockText(' match “'));
  matchAutoP.appendChild(new MockText('daily'));
  matchAutoP.appendChild(new MockText('”.'));

  const useVoiceBtn = new MockElement('button');
  useVoiceBtn.appendChild(new MockText('Use '));
  useVoiceBtn.appendChild(new MockText('Fola'));

  body.appendChild(emptyAutoP);
  body.appendChild(matchAutoP);
  body.appendChild(useVoiceBtn);

  const { controller } = installDomEngine(dom.win, bundle);

  assert.equal(emptyAutoP.textContent, '暂无自动化任务');
  assert.equal(matchAutoP.textContent, '没有与“daily”匹配的自动化任务。');
  assert.equal(useVoiceBtn.textContent, '使用芙拉');

  controller.setMode('en');
  assert.equal(emptyAutoP.childNodes.map((n) => n.nodeValue).join(''), 'No automations yet');
  assert.equal(emptyAutoP.childNodes[0].nodeValue, 'No ');
  assert.equal(emptyAutoP.childNodes[1].nodeValue, 'automations');
  assert.equal(emptyAutoP.childNodes[2].nodeValue, ' yet');
  assert.equal(matchAutoP.childNodes.map((n) => n.nodeValue).join(''), 'No automations match “daily”.');
  assert.equal(useVoiceBtn.textContent, 'Use Fola');

  controller.setMode('zh');
  assert.equal(emptyAutoP.textContent, '暂无自动化任务');
  assert.equal(matchAutoP.textContent, '没有与“daily”匹配的自动化任务。');
  assert.equal(useVoiceBtn.textContent, '使用芙拉');

  const t = createDomTranslator(bundle);

  // 2) 自动化表单与定时选择器
  assert.equal(t.translateText('Create with Prompt').translated, '用提示词创建');
  assert.equal(
    t.translateText('Uses your local files and tools. Schedules only.').translated,
    '使用你的本地文件与工具，仅支持定时触发。'
  );
  assert.equal(t.translateText('Trigger').translated, '触发方式');
  assert.equal(t.translateText('Scheduled').translated, '定时触发');
  assert.equal(t.translateText('Every day').translated, '每天');
  assert.equal(t.translateText('at').translated, '于');
  assert.equal(t.translateText('Instructions').translated, '执行指令');
  assert.equal(t.translateText('Daily at 9:00 AM').translated, '每天 9:00 AM');

  // 3) 15 张截图核心项
  assert.equal(t.translateText('Open in Remote Control').translated, '在远程控制中打开');
  assert.equal(t.translateText('Search for conversations...').translated, '搜索对话...');
  assert.equal(t.translateText('Browse').translated, '浏览');
  assert.equal(t.translateText('Browse rules').translated, '浏览规则');
  assert.equal(t.translateText('Folder').translated, '文件夹');
  assert.equal(t.translateText('Mentions').translated, '提及');
  assert.equal(t.translateText('Drive').translated, 'Google 云端硬盘');
  assert.equal(t.translateText('Set up').translated, '去配置');
  assert.equal(t.translateText('No folders added yet.').translated, '尚未添加任何文件夹。');
  assert.equal(t.translateText('Edit Conversation Title').translated, '编辑对话标题');
  assert.equal(t.translateText('Insert into main conversation').translated, '插入到主对话');
  assert.equal(t.translateText('Runs on this machine').translated, '在本机运行');
  assert.equal(t.translateText('Runs in a cloud environment').translated, '在云端环境中运行');
  assert.equal(t.translateText('Updated 16:48').translated, '更新于 16:48');
  assert.equal(t.translateText('No file changes').translated, '无文件变更');
  assert.equal(t.translateText('View Split Diff').translated, '并排对比视图');
  assert.equal(t.translateText('Hide Whitespace Changes').translated, '隐藏空白字符变更');
  assert.equal(t.translateText('Continue as a New Conversation').translated, '作为新对话继续');
  assert.equal(t.translateText('Delete Side Question').translated, '删除旁白追问 (Delete Side Question)');

  // 4) 全界面右键菜单与子菜单
  assert.equal(t.translateText('Open in Side Panel').translated, '在侧边面板中打开');
  assert.equal(t.translateText('Open In').translated, '打开方式');
  assert.equal(t.translateText('Save Image').translated, '保存图片');
  assert.equal(t.translateText('Find References').translated, '查找引用');
  assert.equal(t.translateText('Copy File Path').translated, '复制文件路径');
  assert.equal(t.translateText('Edit Shortcut').translated, '编辑快捷键');
  assert.equal(t.translateText('Keep Open').translated, '保持打开');
  assert.equal(t.translateText('Pin Tab').translated, '固定标签页');
  assert.equal(t.translateText('Close Tabs to the Right').translated, '关闭右侧标签页');
  assert.equal(t.translateText('Fork in Current Workspace').translated, '在当前工作区中派生');
  assert.equal(t.translateText('Undo to Here').translated, '回滚到此处 (Undo to Here)');
  assert.equal(t.translateText('Delete Group').translated, '删除分组 (Delete Group)');
});

test('Cancel is pure Chinese on normal pages and bilingual in high-risk dialogs; Review, Search, Open File, Feedback, Code Block, and plugin:// Swarm UI translate cleanly', () => {
  // 1) plugin:// origin allowed & subframe suppresses duplicate floating widget
  assert.equal(isAllowedOrigin({ protocol: 'plugin:', hostname: 'swarm-hash-id' }), true);

  const subDom = createMockDom({ protocol: 'plugin:', hostname: 'swarm-hash-id' });
  subDom.win.top = { mockParent: true };
  subDom.win.parent = subDom.win.top;
  const emptyCard = new subDom.MockElement('section', { id: 'empty' });
  const emptyTitle = new subDom.MockElement('h2');
  emptyTitle.appendChild(new subDom.MockText('No swarm in this conversation'));
  const emptyBody = new subDom.MockElement('p');
  emptyBody.appendChild(
    new subDom.MockText(
      'Swarms started in this conversation appear here automatically, with their board, members and @mention graph. Start one with '
    )
  );
  const swarmCode = new subDom.MockElement('code');
  swarmCode.appendChild(new subDom.MockText('/swarm'));
  emptyBody.appendChild(swarmCode);
  emptyBody.appendChild(new subDom.MockText('.'));
  const emptyHint = new subDom.MockElement('p');
  emptyHint.appendChild(new subDom.MockText('Watching for a swarm'));
  emptyCard.appendChild(emptyTitle);
  emptyCard.appendChild(emptyBody);
  emptyCard.appendChild(emptyHint);
  subDom.body.appendChild(emptyCard);

  installDomEngine(subDom.win, bundle);
  assert.equal(subDom.doc.getElementById('nawe-floating-root'), null);
  assert.equal(emptyTitle.textContent, '当前对话中暂无智能体集群');
  assert.equal(
    emptyBody.childNodes[0].nodeValue,
    '在当前对话中启动的智能体集群会自动显示在这里，包含留言板、成员与 @提及关系图。使用以下指令启动： '
  );
  assert.equal(swarmCode.textContent, '/swarm');
  assert.equal(emptyHint.textContent, '正在监听智能体集群');

  // 2) Cancel 按钮在普通页面（如新建自动化表单）只显示“取消”，在高风险删除/沙盒确认框内自动升级为“取消 (Cancel)”
  const normalDom = createMockDom();
  const normalForm = new normalDom.MockElement('form');
  const formTitle = new normalDom.MockElement('h2');
  formTitle.appendChild(new normalDom.MockText('New automation'));
  const normalBtn = new normalDom.MockElement('button');
  normalBtn.appendChild(new normalDom.MockText('Cancel'));
  normalForm.appendChild(formTitle);
  normalForm.appendChild(normalBtn);
  normalDom.body.appendChild(normalForm);
  installDomEngine(normalDom.win, bundle);
  assert.equal(normalBtn.textContent, '取消');

  const riskDom = createMockDom();
  const highRiskDialog = new riskDom.MockElement('div', { role: 'alertdialog' });
  const riskTitle = new riskDom.MockElement('p');
  riskTitle.appendChild(new riskDom.MockText('This command will run outside the sandbox'));
  const riskCancelBtn = new riskDom.MockElement('button');
  riskCancelBtn.appendChild(new riskDom.MockText('Cancel'));
  highRiskDialog.appendChild(riskTitle);
  highRiskDialog.appendChild(riskCancelBtn);
  riskDom.body.appendChild(highRiskDialog);
  installDomEngine(riskDom.win, bundle);
  assert.equal(riskCancelBtn.textContent, '取消 (Cancel)');

  // 3) Review / Search / Open File / Feedback / Code Block 文案与动态正则
  const t = createDomTranslator(bundle);
  assert.equal(t.translateText('Uncommitted').translated, '未提交变更');
  assert.equal(t.translateText('Staged index changes and working tree changes').translated, '暂存区变更与工作区变更');
  assert.equal(t.translateText('All changes since origin/main').translated, '自 origin/main 以来的所有变更');
  assert.equal(
    t.translateText('Files modified by the agent in this conversation').translated,
    '智能体在本次对话中修改的文件'
  );
  assert.equal(t.translateText('Stage and commit all changes').translated, '暂存并提交所有更改');
  assert.equal(t.translateText('Commit staged changes').translated, '提交已暂存的更改');
  assert.equal(t.translateText('No commits to push').translated, '没有可推送的提交');
  assert.equal(t.translateText('Amend').translated, '修正提交');

  assert.equal(t.translateText('Find').translated, '查找');
  assert.equal(t.translateText('No Results').translated, '无结果');
  assert.equal(t.translateText('1 of 5').translated, '第 1 / 5 项');
  assert.equal(t.translateText('Match Case (Aa)').translated, '区分大小写 (Aa)');
  assert.equal(t.translateText('Match Whole Word (ab)').translated, '全词匹配 (ab)');
  assert.equal(t.translateText('Use Regular Expression (.*)').translated, '使用正则表达式 (.*)');
  assert.equal(t.translateText('Previous Match (Shift+Enter)').translated, '上一个匹配项 (Shift+Enter)');
  assert.equal(t.translateText('Next Match (Enter)').translated, '下一个匹配项 (Enter)');
  assert.equal(t.translateText('Close (Escape)').translated, '关闭 (Escape)');

  assert.equal(t.translateText('Search for files in the project...').translated, '搜索项目中的文件...');
  assert.equal(t.translateText('Search file contents...').translated, '搜索文件内容...');
  assert.equal(t.translateText('Recent files').translated, '最近文件');
  assert.equal(t.translateText('Recent Files').translated, '最近文件');

  assert.equal(
    t.translateText(
      'Please describe the issue in detail. The more actionable your feedback, the quicker our team can address your request. Some helpful information includes:'
    ).translated,
    '请详细描述你遇到的问题。反馈越具体可执行，我们的团队就能越快处理你的请求。以下信息会很有帮助：'
  );
  assert.equal(t.translateText('At Mention Code Block').translated, '@提及此代码块');
  assert.equal(t.translateText('Insert in Terminal').translated, '插入到终端');
  assert.equal(t.translateText('Copy code').translated, '复制代码');

  // 4) 反馈确认提示、完整命令展开/折叠与资源管理器标签 + __naweTranslateContextMenuItems
  assert.equal(t.translateText('Thanks for your feedback!').translated, '感谢你的反馈！');
  assert.equal(t.translateText('Show full command').translated, '显示完整命令');
  assert.equal(t.translateText('Collapse command').translated, '折叠命令');
  assert.equal(t.translateText('Copy command').translated, '复制命令');
  assert.equal(t.translateText('Copied!').translated, '已复制！');
  assert.equal(t.translateText('Show in File Explorer').translated, '在文件资源管理器中显示');

  const ctxDom = createMockDom();
  const { controller: ctxCtrl } = installDomEngine(ctxDom.win, bundle);
  const rawMenuItems = [
    { id: 'c1', label: 'Rename' },
    { id: 'c2', label: 'Unpin' },
    { id: 'c3', label: 'Mark Unread' },
    {
      id: 'c4',
      type: 'submenu',
      label: 'Copy',
      submenu: [{ id: 'c4-1', label: 'Conversation Name' }, { id: 'c4-2', label: 'Conversation ID' }],
    },
    {
      id: 'c5',
      type: 'submenu',
      label: 'Split',
      submenu: [{ id: 'c5-1', label: 'Split Right' }, { id: 'c5-2', label: 'Split Down' }],
    },
    { id: 'c6', label: 'Archive' },
    { id: 'c7', label: 'Delete' },
    { id: 'p1', label: 'Sort By' },
    { id: 'p2', label: 'Last Updated' },
    { id: 'p3', label: 'Last Prompt' },
    { id: 'p4', label: 'Custom Order' },
    { id: 'p5', label: 'Copy Project Name' },
    { id: 'p6', label: 'Project Settings' },
    { id: 'p7', label: 'Show in File Explorer' },
    { id: 'p8', label: 'Delete Project' },
    { id: 'm1', label: 'Good Response' },
    { id: 'm2', label: 'Bad Response' },
  ];

  const translatedZh = ctxDom.win.__naweTranslateContextMenuItems(rawMenuItems);
  assert.equal(rawMenuItems[0].label, 'Rename');
  assert.deepEqual(
    translatedZh.map((i) => [i.id, i.label]),
    [
      ['c1', '重命名'],
      ['c2', '取消置顶'],
      ['c3', '标为未读'],
      ['c4', '复制'],
      ['c5', '拆分视图'],
      ['c6', '归档'],
      ['c7', '删除'],
      ['p1', '排序方式'],
      ['p2', '最近更新'],
      ['p3', '最近提问'],
      ['p4', '自定义顺序'],
      ['p5', '复制项目名称'],
      ['p6', '项目设置'],
      ['p7', '在文件资源管理器中显示'],
      ['p8', '删除项目 (Delete Project)'],
      ['m1', '回答不错'],
      ['m2', '回答不佳'],
    ]
  );
  assert.deepEqual(
    translatedZh[3].submenu.map((i) => i.label),
    ['对话名称', '对话 ID']
  );

  ctxCtrl.setMode('bilingual');
  const translatedBi = ctxDom.win.__naweTranslateContextMenuItems(rawMenuItems);
  assert.equal(translatedBi[0].label, '重命名 (Rename)');
  assert.equal(translatedBi[3].submenu[1].label, '对话 ID (Conversation ID)');
  assert.equal(translatedBi[14].label, '删除项目 (Delete Project)');

  ctxCtrl.setMode('en');
  const translatedEn = ctxDom.win.__naweTranslateContextMenuItems(rawMenuItems);
  assert.equal(translatedEn[0].label, 'Rename');
  ctxCtrl.disconnect();
});

test('Open SSH Host modal and SSH remote security prompts translate accurately', () => {
  const dom = createMockDom();
  const { body, MockElement, MockText } = dom;

  const dialog = new MockElement('div', { role: 'dialog' });
  const heading = new MockElement('h2');
  heading.appendChild(new MockText('Open SSH Host'));

  const subtitle = new MockElement('p');
  subtitle.appendChild(new MockText('Enter [user@]host[:port], or pick a host from your SSH config.'));
  subtitle.appendChild(new MockText(' Then create the project in its window.'));

  const input = new MockElement('input', {
    placeholder: 'user@host:port',
    'aria-label': 'SSH host',
  });

  const configLabel = new MockElement('span');
  configLabel.appendChild(new MockText('SSH config: '));
  const defaultPathSpan = new MockElement('span');
  defaultPathSpan.appendChild(new MockText('~/.ssh/config (default)'));
  const chooseBtn = new MockElement('button');
  chooseBtn.appendChild(new MockText('Choose File…'));

  const emptyHosts = new MockElement('p');
  emptyHosts.appendChild(new MockText('No hosts in '));
  emptyHosts.appendChild(new MockText('~/.ssh/config'));
  emptyHosts.appendChild(new MockText(' yet. Type one above.'));

  const customEmptyHosts = new MockElement('p');
  customEmptyHosts.appendChild(new MockText('No hosts in '));
  customEmptyHosts.appendChild(new MockText('C:\\Users\\demo\\.ssh\\config'));
  customEmptyHosts.appendChild(new MockText(' yet. Type one above.'));

  const hostKeyTitle = new MockElement('h3');
  hostKeyTitle.appendChild(new MockText('Trust github.com?'));
  const updatedKeysTitle = new MockElement('h3');
  updatedKeysTitle.appendChild(new MockText('Accept updated host keys?'));
  const errBanner = new MockElement('span');
  errBanner.appendChild(new MockText("Couldn't connect to "));
  errBanner.appendChild(new MockText('prod-box'));

  dialog.appendChild(heading);
  dialog.appendChild(subtitle);
  dialog.appendChild(input);
  dialog.appendChild(configLabel);
  dialog.appendChild(defaultPathSpan);
  dialog.appendChild(chooseBtn);
  dialog.appendChild(emptyHosts);
  dialog.appendChild(customEmptyHosts);
  dialog.appendChild(hostKeyTitle);
  dialog.appendChild(updatedKeysTitle);
  dialog.appendChild(errBanner);
  body.appendChild(dialog);

  installDomEngine(dom.win, bundle);

  assert.equal(heading.textContent, '打开 SSH 主机');
  assert.equal(
    subtitle.textContent,
    '输入 [用户名@]主机[:端口]，或从 SSH 配置中选择主机，随后在其窗口中创建项目。'
  );
  assert.equal(input.getAttribute('placeholder'), '用户名@主机:端口');
  assert.equal(input.getAttribute('aria-label'), 'SSH 主机');
  assert.equal(configLabel.textContent, 'SSH 配置文件： ');
  assert.equal(defaultPathSpan.textContent, '~/.ssh/config（默认）');
  assert.equal(chooseBtn.textContent, '选择文件…');
  assert.equal(emptyHosts.textContent, '~/.ssh/config 中暂无主机，请在上方直接输入。');
  assert.equal(customEmptyHosts.textContent, 'C:\\Users\\demo\\.ssh\\config 中暂无主机，请在上方直接输入。');
  assert.equal(hostKeyTitle.textContent, '是否信任主机 github.com？ (Trust github.com?)');
  assert.equal(updatedKeysTitle.textContent, '是否接受更新后的主机密钥？ (Accept updated host keys?)');
  assert.equal(errBanner.textContent, '无法连接到 prod-box');
});

test('Agent selector, selected Agent chip/tooltip, Orchestrator rows, Agent modals, and Home greetings translate cleanly', () => {
  const dom = createMockDom();
  const { body, MockElement, MockText } = dom;

  const docsTooltip = new MockElement('div');
  docsTooltip.appendChild(new MockText('Click to Open Docs'));
  const docsLink = new MockElement('a', { 'aria-label': 'Click to open docs' });

  const mainAgentRow = new MockElement('div');
  mainAgentRow.appendChild(new MockText('Main Agent'));
  const loadingScripts = new MockElement('div');
  loadingScripts.appendChild(new MockText('Getting scripts...'));
  const newScriptRow = new MockElement('div');
  newScriptRow.appendChild(new MockText('New Agent Script'));
  const scriptChip = new MockElement('div', { title: 'Agent Script' });
  const optionsBtn = new MockElement('button', { 'aria-label': 'Agent options' });

  const agentTip = new MockElement('div');
  agentTip.appendChild(new MockText('Agent: '));
  agentTip.appendChild(new MockText('firestore-rules-author'));
  agentTip.appendChild(new MockText('. Change it in the model menu.'));

  const standaloneTip = new MockElement('span');
  standaloneTip.appendChild(new MockText('. Change it in the model menu.'));

  const orchCarbon = new MockElement('span');
  orchCarbon.appendChild(new MockText('Orchestrator (Carbon)'));
  const orchHydrogen = new MockElement('span');
  orchHydrogen.appendChild(new MockText('Orchestrator (Hydrogen)'));
  const orchFuture = new MockElement('span');
  orchFuture.appendChild(new MockText('Orchestrator (Xenon)'));

  const greetingNamed = new MockElement('h1');
  greetingNamed.appendChild(new MockText("Good to see you, 张三. What's next?"));
  const greetingUnnamed = new MockElement('h1');
  greetingUnnamed.appendChild(new MockText("Good to see you. What's next?"));

  const modalTitle = new MockElement('h2');
  modalTitle.appendChild(new MockText('New Coordinator'));
  const createAgentBtn = new MockElement('button');
  createAgentBtn.appendChild(new MockText('Create Agent'));
  const goalTextarea = new MockElement('textarea', {
    placeholder: 'What should this agent accomplish?',
  });
  const settingsTitle = new MockElement('h2');
  settingsTitle.appendChild(new MockText('Coordinator settings'));
  const startingLabel = new MockElement('span');
  startingLabel.appendChild(new MockText('Starting the conversation\u2026'));

  for (const el of [
    docsTooltip,
    docsLink,
    mainAgentRow,
    loadingScripts,
    newScriptRow,
    scriptChip,
    optionsBtn,
    agentTip,
    standaloneTip,
    orchCarbon,
    orchHydrogen,
    orchFuture,
    greetingNamed,
    greetingUnnamed,
    modalTitle,
    createAgentBtn,
    goalTextarea,
    settingsTitle,
    startingLabel,
  ]) {
    body.appendChild(el);
  }

  installDomEngine(dom.win, bundle);

  assert.equal(docsTooltip.textContent, '点击查看文档');
  assert.equal(docsLink.getAttribute('aria-label'), '点击查看文档');
  assert.equal(mainAgentRow.textContent, '主智能体');
  assert.equal(loadingScripts.textContent, '正在获取脚本...');
  assert.equal(newScriptRow.textContent, '新建智能体脚本');
  assert.equal(scriptChip.getAttribute('title'), '智能体脚本');
  assert.equal(optionsBtn.getAttribute('aria-label'), '智能体选项');
  assert.equal(agentTip.textContent, '智能体：firestore-rules-author。可在模型菜单中切换。');
  assert.equal(standaloneTip.textContent, '。可在模型菜单中切换。');
  assert.equal(orchCarbon.textContent, '智能编排 (Carbon)');
  assert.equal(orchHydrogen.textContent, '智能编排 (Hydrogen)');
  assert.equal(orchFuture.textContent, '智能编排 (Xenon)');
  assert.equal(greetingNamed.textContent, '很高兴见到你，张三。接下来做什么？');
  assert.equal(greetingUnnamed.textContent, '很高兴见到你，接下来做什么？');
  assert.equal(modalTitle.textContent, '新建协调器');
  assert.equal(createAgentBtn.textContent, '创建智能体');
  assert.equal(goalTextarea.getAttribute('placeholder'), '这个智能体需要完成什么任务？');
  assert.equal(settingsTitle.textContent, '协调器设置');
  assert.equal(startingLabel.textContent, '正在启动对话…');
});

test('Side Question empty state, Swarm Board empty/board/hive UI, and Antigravity 2.36.0 features translate cleanly', () => {
  const dom = createMockDom();
  const { body, MockElement, MockText } = dom;

  // 1) Screenshot 1: Side Question
  const sqEmpty = new MockElement('span');
  sqEmpty.appendChild(new MockText('Ask a side question without interrupting the main conversation'));

  // 2) Screenshot 2: Swarm Board empty state with split <code>/swarm</code>
  const swarmTitle = new MockElement('h2');
  swarmTitle.appendChild(new MockText('No swarm in this conversation'));
  const swarmBody = new MockElement('p');
  swarmBody.appendChild(
    new MockText(
      'Open this pane from a conversation to see its swarm. Swarms started there appear here automatically; start one with '
    )
  );
  const swarmCode = new MockElement('code');
  swarmCode.appendChild(new MockText('/swarm'));
  swarmBody.appendChild(swarmCode);
  swarmBody.appendChild(new MockText('.'));
  const swarmWatching = new MockElement('p');
  swarmWatching.appendChild(new MockText('Watching for a swarm'));

  // 3) 2.36.0 Floating Composer + High-Risk + Credentials + Feeds + Org Policy + Git Worktree Fork
  const composerStatus = new MockElement('button', {
    'aria-label': '3 tasks running \u2014 restore split view',
  });
  composerStatus.appendChild(new MockText('3 tasks running'));
  const subagentNeeds = new MockElement('span');
  subagentNeeds.appendChild(new MockText('Subagent needs approval'));
  const unreadPill = new MockElement('span');
  unreadPill.appendChild(new MockText('Unread message'));
  const addEnvBtn = new MockElement('button');
  addEnvBtn.appendChild(new MockText('Add Environment Variable'));
  const delSecretBtn = new MockElement('button');
  delSecretBtn.appendChild(new MockText('Delete Network Secret'));
  const feedsEmpty = new MockElement('p');
  feedsEmpty.appendChild(
    new MockText('Nothing needs your attention right now. New deliverables, docs, and agent updates will appear here.')
  );
  const waitingYou = new MockElement('span');
  waitingYou.appendChild(new MockText('Waiting on you'));
  const expandFull = new MockElement('button');
  expandFull.appendChild(new MockText('Expand full view'));
  const orgDisabled = new MockElement('span');
  orgDisabled.appendChild(new MockText('Disabled by your organization'));
  const orgWallet = new MockElement('h3');
  orgWallet.appendChild(new MockText('Organization prepaid wallet is empty'));
  const forkWorktree = new MockElement('div', { role: 'menuitem' });
  forkWorktree.appendChild(new MockText('Fork in New Git Worktree'));

  for (const el of [
    sqEmpty,
    swarmTitle,
    swarmBody,
    swarmWatching,
    composerStatus,
    subagentNeeds,
    unreadPill,
    addEnvBtn,
    delSecretBtn,
    feedsEmpty,
    waitingYou,
    expandFull,
    orgDisabled,
    orgWallet,
    forkWorktree,
  ]) {
    body.appendChild(el);
  }

  installDomEngine(dom.win, bundle);

  assert.equal(sqEmpty.textContent, '在不打断主对话的情况下发起旁白追问');
  assert.equal(swarmTitle.textContent, '当前对话中暂无智能体集群');
  assert.equal(swarmCode.textContent, '/swarm', '/swarm 指令必须保持英文原样');
  assert.ok(swarmBody.textContent.includes('请从对话中打开此面板以查看其智能体集群'));
  assert.ok(swarmBody.textContent.includes('/swarm'));
  assert.equal(swarmWatching.textContent, '正在监听智能体集群');

  assert.equal(composerStatus.textContent, '3 个任务运行中');
  assert.equal(composerStatus.getAttribute('aria-label'), '3 tasks running — 恢复分栏视图');
  assert.equal(subagentNeeds.textContent, '子智能体需要人工批准 (Subagent needs approval)');
  assert.equal(unreadPill.textContent, '有未读消息');
  assert.equal(addEnvBtn.textContent, '添加环境变量');
  assert.equal(delSecretBtn.textContent, '删除网络密钥 (Delete Network Secret)');
  assert.equal(
    feedsEmpty.textContent,
    '当前没有需要你处理的事项。新的交付物、文档与智能体进展会显示在这里。'
  );
  assert.equal(waitingYou.textContent, '等待你确认');
  assert.equal(expandFull.textContent, '展开全屏视图');
  assert.equal(orgDisabled.textContent, '已被你的组织禁用');
  assert.equal(orgWallet.textContent, '组织预付余额已用尽');
  assert.equal(forkWorktree.textContent, '在新 Git 工作树中派生');
});

test('Subframe Swarm Board syncs initial bilingual/zh/en mode via parent postMessage handshake and translates innerHTML /swarm paragraph', () => {
  const parentDom = createMockDom();
  const childDom = createMockDom();

  const attachMsgBus = (win) => {
    const listeners = [];
    win.addEventListener = (ev, fn) => {
      if (ev === 'message') listeners.push(fn);
    };
    win.removeEventListener = (ev, fn) => {
      if (ev === 'message') {
        const i = listeners.indexOf(fn);
        if (i !== -1) listeners.splice(i, 1);
      }
    };
    win.postMessage = (data, _origin, source) => {
      for (const fn of [...listeners]) {
        fn({ data, source: source || win });
      }
    };
  };

  attachMsgBus(parentDom.win);
  attachMsgBus(childDom.win);
  parentDom.win.top = parentDom.win;
  parentDom.win.parent = parentDom.win;
  childDom.win.location = { protocol: 'plugin:', hostname: 'swarm-board' };
  childDom.win.top = parentDom.win;
  childDom.win.parent = {
    postMessage(data) {
      parentDom.win.postMessage(data, '*', {
        postMessage(reply) {
          childDom.win.postMessage(reply, '*', childDom.win.parent);
        },
      });
    },
  };

  const title = new childDom.MockElement('h2');
  title.appendChild(new childDom.MockText('No swarm in this conversation'));
  const desc = new childDom.MockElement('p');
  desc.appendChild(
    new childDom.MockText(
      'Swarms started in this conversation appear here automatically, with their board, members and @mention graph. Start one with '
    )
  );
  const code = new childDom.MockElement('code');
  code.appendChild(new childDom.MockText('/swarm'));
  desc.appendChild(code);
  desc.appendChild(new childDom.MockText('.'));
  childDom.body.appendChild(title);
  childDom.body.appendChild(desc);

  // 父窗口先设为中英对照，再安装子帧（模拟在 bilingual 模式下打开侧边栏 Swarm 面板）
  const { controller: parentCtrl } = installDomEngine(parentDom.win, bundle, { initialMode: 'bilingual' });
  const { controller: childCtrl } = installDomEngine(childDom.win, bundle);

  assert.equal(childCtrl.getMode(), 'bilingual');
  assert.equal(title.textContent, '当前对话中暂无智能体集群 (No swarm in this conversation)');
  assert.equal(code.textContent, '/swarm');

  parentCtrl.setMode('zh');
  childDom.win.postMessage({ __naweSyncMode: 'zh' }, '*', childDom.win.parent);
  assert.equal(childCtrl.getMode(), 'zh');
  assert.equal(title.textContent, '当前对话中暂无智能体集群');
  assert.ok(desc.textContent.includes('在当前对话中启动的智能体集群会自动显示在这里'));
  assert.ok(desc.textContent.includes('/swarm'));
});



