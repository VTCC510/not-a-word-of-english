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
  assert.equal(useBtn.textContent, '使用 芙拉');

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

