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
