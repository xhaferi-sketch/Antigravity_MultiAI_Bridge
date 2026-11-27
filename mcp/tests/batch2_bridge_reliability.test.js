'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');

const { createCopilotEngine } = require('../engines/copilot_engine.js');
const { createLocalExecutor } = require('../pipeline/local_executor.js');

const PREV_LOCKS_ENV = process.env.ANTIGRAVITY_MODEL_LOCKS_PATH;
test.before(() => {
  process.env.ANTIGRAVITY_MODEL_LOCKS_PATH = path.join(os.tmpdir(), 'ag-no-locks-batch2-' + process.pid + '.json');
});
test.after(() => {
  if (PREV_LOCKS_ENV === undefined) delete process.env.ANTIGRAVITY_MODEL_LOCKS_PATH;
  else process.env.ANTIGRAVITY_MODEL_LOCKS_PATH = PREV_LOCKS_ENV;
});

function createMockDom() {
  const allElements = [];

  class MockElement {
    constructor(tagName, opts) {
      opts = opts || {};
      this.tagName = String(tagName || 'div').toUpperCase();
      this.innerText = opts.innerText || '';
      this.textContent = opts.textContent !== undefined ? opts.textContent : this.innerText;
      this.attrs = Object.assign({}, opts.attrs || {});
      this.classes = new Set(opts.classes || []);
      this.visible = opts.visible !== false;
      this.isConnected = opts.isConnected !== false;
      this.children = [];
      this.parentElement = null;
      this.clickCount = 0;
      this.events = [];
      this._onClick = opts.onClick || null;
      this._onEvent = opts.onEvent || null;
      allElements.push(this);
    }

    get className() {
      return Array.from(this.classes).join(' ');
    }

    get classList() {
      const self = this;
      return {
        contains: (c) => self.classes.has(c),
        add: (c) => self.classes.add(c),
        remove: (c) => self.classes.delete(c)
      };
    }

    appendChild(child) {
      child.parentElement = this;
      this.children.push(child);
      return child;
    }

    getAttribute(name) {
      return Object.prototype.hasOwnProperty.call(this.attrs, name) ? this.attrs[name] : null;
    }

    setAttribute(name, val) {
      this.attrs[name] = String(val);
    }

    getBoundingClientRect() {
      return this.visible ? { width: 120, height: 32 } : { width: 0, height: 0 };
    }

    click() {
      this.clickCount++;
      if (typeof this._onClick === 'function') this._onClick(this);
    }

    dispatchEvent(evt) {
      this.events.push(evt);
      if (typeof this._onEvent === 'function') this._onEvent(evt, this);
    }

    matches(selectorList) {
      const parts = String(selectorList || '').split(',').map((s) => s.trim()).filter(Boolean);
      return parts.some((sel) => matchSingleSelector(this, sel));
    }

    closest(selectorList) {
      let cur = this;
      while (cur) {
        if (cur.matches(selectorList)) return cur;
        cur = cur.parentElement;
      }
      return null;
    }

    querySelectorAll(selectorList) {
      const out = [];
      const visit = (node) => {
        for (const child of node.children) {
          if (child.matches(selectorList)) out.push(child);
          visit(child);
        }
      };
      visit(this);
      return out;
    }

    querySelector(selectorList) {
      return this.querySelectorAll(selectorList)[0] || null;
    }
  }

  function matchSingleSelector(el, sel) {
    let rest = sel.trim();
    const tagMatch = rest.match(/^([a-zA-Z0-9_-]+)/);
    if (tagMatch) {
      if (el.tagName.toLowerCase() !== tagMatch[1].toLowerCase()) return false;
      rest = rest.slice(tagMatch[0].length);
    }
    const classMatches = Array.from(rest.matchAll(/\.([a-zA-Z0-9_-]+)/g));
    for (const cm of classMatches) {
      if (!el.classes.has(cm[1])) return false;
    }
    const attrMatches = Array.from(rest.matchAll(/\[([^\]=*~]+)(?:(\*?=)"([^"]*)"(\s*i)?)?\]/g));
    for (const am of attrMatches) {
      const attrName = am[1].trim();
      const op = am[2] || '';
      const expected = am[3] || '';
      const ci = Boolean(am[4]);
      const actual = el.getAttribute(attrName);
      if (actual === null) return false;
      if (op === '=') {
        if (ci ? actual.toLowerCase() !== expected.toLowerCase() : actual !== expected) return false;
      } else if (op === '*=') {
        if (ci ? !actual.toLowerCase().includes(expected.toLowerCase()) : !actual.includes(expected)) return false;
      }
    }
    if (rest.includes(':checked')) {
      return el.attrs.checked === 'true';
    }
    return true;
  }

  const root = new MockElement('body');
  const doc = {
    activeElement: null,
    dispatchEvent(evt) {
      if (evt && evt.key === 'Escape') {
        for (const el of allElements) {
          if (el.classes.has('fui-MenuPopover') || el.getAttribute('role') === 'menu') {
            el.visible = false;
          }
        }
      }
    },
    querySelectorAll(selectorList) {
      return root.querySelectorAll(selectorList);
    },
    querySelector(selectorList) {
      return root.querySelector(selectorList);
    }
  };

  function withDom(fn) {
    const prevDoc = global.document;
    const prevGCS = global.getComputedStyle;
    global.document = doc;
    global.getComputedStyle = (el) => ({
      display: el && el.visible ? 'block' : 'none',
      visibility: el && el.visible ? 'visible' : 'hidden',
      opacity: el && el.visible ? '1' : '0'
    });
    return Promise.resolve().then(fn).finally(() => {
      global.document = prevDoc;
      global.getComputedStyle = prevGCS;
    });
  }

  return { MockElement, root, doc, withDom };
}

function loadServerForTest() {
  const prevExport = process.env.ANTIGRAVITY_TEST_EXPORT;
  const prevTruthful = process.env.ANTIGRAVITY_TRUTHFUL_TEST;
  process.env.ANTIGRAVITY_TEST_EXPORT = '1';
  process.env.ANTIGRAVITY_TRUTHFUL_TEST = '1';
  const serverPath = path.join(__dirname, '..', 'server.js');
  delete require.cache[require.resolve(serverPath)];
  const srv = require(serverPath);
  return {
    srv,
    cleanup() {
      delete require.cache[require.resolve(serverPath)];
      if (prevExport === undefined) delete process.env.ANTIGRAVITY_TEST_EXPORT;
      else process.env.ANTIGRAVITY_TEST_EXPORT = prevExport;
      if (prevTruthful === undefined) delete process.env.ANTIGRAVITY_TRUTHFUL_TEST;
      else process.env.ANTIGRAVITY_TRUTHFUL_TEST = prevTruthful;
    }
  };
}

test('Copilot ensureCopilotGpt56Model avoids double-toggle on opener and already-active options', async () => {
  const { MockElement, root, withDom } = createMockDom();
  const menu = new MockElement('div', { classes: ['fui-MenuPopover'], attrs: { role: 'menu' }, visible: false });
  const pill = new MockElement('button', {
    innerText: 'Model',
    attrs: { 'data-testid': 'model-switcher', 'aria-label': 'Model Selector' },
    onClick() { menu.visible = !menu.visible; }
  });
  const gptOpt = new MockElement('div', {
    innerText: 'GPT-5.6 Sol Think',
    attrs: { role: 'menuitemradio', 'aria-checked': 'true' }
  });
  const deepOpt = new MockElement('div', {
    innerText: 'Think deeper',
    attrs: { role: 'menuitemradio', 'aria-checked': 'true' }
  });
  menu.appendChild(gptOpt);
  menu.appendChild(deepOpt);
  root.appendChild(pill);
  root.appendChild(menu);

  const engine = createCopilotEngine({
    tabAuthStatus: {},
    tabActiveModel: {},
    tabDiscoveredModels: {},
    copilotModelReceipts: {},
    captureSupportEvidence: async () => {}
  });

  await withDom(async () => {
    const label = await engine.ensureCopilotGpt56Model({ evaluate: async (fn, arg) => fn(arg) }, 'web1');
    assert.equal(label, 'GPT-5.6 Sol Think (Deep / High)');
  });
  assert.equal(gptOpt.clickCount, 0, 'Already-active GPT-5.6 Sol Think must not be clicked again');
  assert.equal(deepOpt.clickCount, 0, 'Already-active Think deeper must not be clicked again');
  assert.ok(pill.clickCount <= 2, 'Opener must only open menu cleanly without double-toggling closed');
});

test('Copilot ensureCopilotGpt56Model expands Fluent UI submenu portal and locks GPT-5.6 Sol Think + Think deeper', async () => {
  const { MockElement, root, withDom } = createMockDom();
  const mainMenu = new MockElement('div', { classes: ['fui-MenuPopover'], attrs: { role: 'menu' }, visible: false });
  const subMenu = new MockElement('div', { classes: ['fui-MenuPopover'], attrs: { role: 'menu' }, visible: false });

  const pill = new MockElement('button', {
    innerText: 'Auto',
    attrs: { 'data-testid': 'model-switcher', 'aria-label': 'Model' },
    onClick() { mainMenu.visible = !mainMenu.visible; }
  });
  const subTrigger = new MockElement('div', {
    innerText: 'More models',
    attrs: { role: 'menuitem', 'aria-haspopup': 'menu', 'data-testid': 'gptSubMenuModelTrigger' },
    onEvent(evt) {
      if (evt && (evt.type === 'mouseenter' || evt.type === 'pointerover')) subMenu.visible = true;
    },
    onClick() { subMenu.visible = true; }
  });
  const gptOpt = new MockElement('div', {
    innerText: 'GPT-5.6 Sol Think',
    attrs: { role: 'menuitemradio', 'aria-checked': 'false', 'data-testid': 'gptSubMenuModelTrigger-56' },
    onClick(el) {
      el.setAttribute('aria-checked', 'true');
      pill.innerText = 'GPT-5.6 Sol Think';
      mainMenu.visible = false;
      subMenu.visible = false;
    }
  });
  const deepOpt = new MockElement('div', {
    innerText: 'Think deeper',
    attrs: { role: 'menuitemradio', 'aria-checked': 'false' },
    onClick(el) {
      el.setAttribute('aria-checked', 'true');
      pill.innerText = 'GPT-5.6 Sol Think · Think deeper';
      mainMenu.visible = false;
      subMenu.visible = false;
    }
  });

  mainMenu.appendChild(subTrigger);
  mainMenu.appendChild(deepOpt);
  subMenu.appendChild(gptOpt);
  root.appendChild(pill);
  root.appendChild(mainMenu);
  root.appendChild(subMenu);

  const receipts = {};
  const engine = createCopilotEngine({
    tabAuthStatus: {},
    tabActiveModel: {},
    tabDiscoveredModels: {},
    copilotModelReceipts: receipts,
    captureSupportEvidence: async () => {}
  });

  await withDom(async () => {
    const label = await engine.ensureCopilotGpt56Model({ evaluate: async (fn, arg) => fn(arg) }, 'web1');
    assert.equal(label, 'GPT-5.6 Sol Think (Deep / High)');
  });
  assert.equal(gptOpt.clickCount, 1);
  assert.equal(deepOpt.clickCount, 1);
  assert.equal(receipts.web1.verified, true);
});

test('Copilot ensureCopilotGpt56Model fails closed in strict mode when Think deeper exists without GPT-5.6 Sol Think, and succeeds with default fallback', async () => {
  const { MockElement, root, withDom } = createMockDom();
  const menu = new MockElement('div', { classes: ['fui-MenuPopover'], attrs: { role: 'menu' }, visible: false });
  const pill = new MockElement('button', {
    innerText: 'Auto',
    attrs: { 'data-testid': 'model-switcher' },
    onClick() { menu.visible = !menu.visible; }
  });
  menu.appendChild(new MockElement('div', { innerText: 'Auto', attrs: { role: 'menuitemradio', 'aria-checked': 'true' } }));
  const deepOpt = new MockElement('div', {
    innerText: 'Think deeper',
    attrs: { role: 'menuitemradio', 'aria-checked': 'false' },
    onClick(el) {
      el.setAttribute('aria-checked', 'true');
      pill.innerText = 'Think deeper';
      menu.visible = false;
    }
  });
  menu.appendChild(deepOpt);
  root.appendChild(pill);
  root.appendChild(menu);

  const receipts = {};
  const engine = createCopilotEngine({ tabAuthStatus: {}, tabActiveModel: {}, copilotModelReceipts: receipts });
  await withDom(async () => {
    await assert.rejects(
      () => engine.ensureCopilotGpt56Model(
        { evaluate: async (fn, arg) => fn(arg) },
        'web1',
        { contract: Object.assign({}, engine.COPILOT_REQUIRED_MODEL, { allowThinkDeeperFallback: false }) }
      ),
      /COPILOT_MODEL_LOCK_FAILED: COPILOT_REQUIRED_MODEL_(?:UNAVAILABLE|NOT_ACTIVE)/
    );
    const fallbackLabel = await engine.ensureCopilotGpt56Model({ evaluate: async (fn, arg) => fn(arg) }, 'web1');
    assert.match(fallbackLabel, /Think deeper/);
    assert.equal(receipts.web1.verified, true);
    assert.equal(receipts.web1.gpt56TemporarilyUnavailable, true);
  });
});

test('Copilot ensureCopilotGpt56Model fails closed when GPT-5.6 Sol Think activates but Think deeper is missing', async () => {
  const { MockElement, root, withDom } = createMockDom();
  const menu = new MockElement('div', { classes: ['fui-MenuPopover'], attrs: { role: 'menu' }, visible: false });
  const pill = new MockElement('button', {
    innerText: 'Quick response',
    attrs: { 'data-testid': 'model-switcher' },
    onClick() { menu.visible = !menu.visible; }
  });
  const gptOpt = new MockElement('div', {
    innerText: 'GPT-5.6 Sol Think',
    attrs: { role: 'menuitemradio', 'aria-checked': 'false' },
    onClick(el) {
      el.setAttribute('aria-checked', 'true');
      pill.innerText = 'GPT-5.6 Sol Think';
      menu.visible = false;
    }
  });
  menu.appendChild(gptOpt);
  root.appendChild(pill);
  root.appendChild(menu);

  const engine = createCopilotEngine({ tabAuthStatus: {}, tabActiveModel: {}, copilotModelReceipts: {} });
  await withDom(async () => {
    await assert.rejects(
      () => engine.ensureCopilotGpt56Model({ evaluate: async (fn, arg) => fn(arg) }, 'web2'),
      /COPILOT_MODEL_LOCK_FAILED: COPILOT_REASONING_NOT_DEEP/
    );
  });
});

test('Copilot ensureCopilotGpt56Model ignores Dark mode .fui-Dropdown and verifies read-back when pill shows only half', async () => {
  const { MockElement, root, withDom } = createMockDom();
  const darkModeDropdown = new MockElement('button', {
    innerText: 'Dark mode',
    classes: ['fui-Dropdown'],
    attrs: { 'aria-label': 'Dark mode' }
  });
  const menu = new MockElement('div', { classes: ['fui-MenuPopover'], attrs: { role: 'menu' }, visible: false });
  const pill = new MockElement('button', {
    innerText: 'Think deeper',
    attrs: { 'data-testid': 'model-switcher' },
    onClick() { menu.visible = !menu.visible; }
  });
  menu.appendChild(new MockElement('div', {
    innerText: 'GPT-5.6 Sol Think',
    attrs: { role: 'menuitemradio', 'aria-checked': 'true' }
  }));
  menu.appendChild(new MockElement('div', {
    innerText: 'Think deeper',
    attrs: { role: 'menuitemradio', 'aria-checked': 'true' }
  }));
  root.appendChild(darkModeDropdown);
  root.appendChild(pill);
  root.appendChild(menu);

  const engine = createCopilotEngine({ tabAuthStatus: {}, tabActiveModel: {}, copilotModelReceipts: {} });
  await withDom(async () => {
    const verified = await engine.ensureCopilotGpt56Model({ evaluate: async (fn, arg) => fn(arg) }, 'web1');
    assert.equal(verified, 'GPT-5.6 Sol Think (Deep / High)');
  });
  assert.equal(darkModeDropdown.clickCount, 0, 'Dark mode dropdown must never be clicked or selected as finalButton');
});

test('server.js isTransientCopilotResponse accurately classifies transient statuses vs real responses and keeps exports non-enumerable', () => {
  const { srv, cleanup } = loadServerForTest();
  try {
    assert.equal(Object.keys(srv).includes('isTransientCopilotResponse'), false, 'isTransientCopilotResponse must be non-enumerable');
    assert.equal(Object.keys(srv).includes('attachFilesSafely'), false, 'attachFilesSafely must be non-enumerable');
    assert.equal(typeof srv.isTransientCopilotResponse, 'function');

    assert.equal(srv.isTransientCopilotResponse('Thinking...'), true);
    assert.equal(srv.isTransientCopilotResponse('Analyzing your files...'), true);
    assert.equal(srv.isTransientCopilotResponse('Duke menduar...'), true);
    assert.equal(srv.isTransientCopilotResponse('Një moment…'), true);
    assert.equal(srv.isTransientCopilotResponse('Working on it', { transientStatusOnly: true }), true);
    assert.equal(srv.isTransientCopilotResponse('Preparing output', { turnBusy: true, hasFeedback: false }), true);

    assert.equal(srv.isTransientCopilotResponse(null), false);
    assert.equal(srv.isTransientCopilotResponse(undefined), false);
    assert.equal(srv.isTransientCopilotResponse('   '), false);
    assert.equal(srv.isTransientCopilotResponse('```js\nconsole.log("Thinking...");\n```'), false);
    assert.equal(srv.isTransientCopilotResponse('diff --git a/a.js b/a.js\n--- a/a.js\n+++ b/a.js'), false);
    assert.equal(srv.isTransientCopilotResponse('FILE: src/app.js\nconst x = 1;'), false);
    assert.equal(srv.isTransientCopilotResponse('STATUS: PASSED'), false);
    assert.equal(srv.isTransientCopilotResponse('OK', { hasFeedback: true, turnBusy: false }), false);
  } finally {
    cleanup();
  }
});

test('server.js preserves Copilot structural DOM guards, chatRoot stop fallback, candidateSet and processingProbeSuppressed', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  assert.match(src, /const codeAncestorSelector='pre, code, \.monaco-editor/);
  assert.match(src, /!el\.closest\(codeAncestorSelector\)/);
  assert.match(src, /Array\.from\(chatRoot\.querySelectorAll\(stopSelector\)\)\.find\(isVisibleStop\)/);
  assert.match(src, /candidateSet=new Set\(\)/);
  assert.match(src, /processingProbeSuppressed=!canProbeProcessing/);
  assert.match(src, /COPILOT_TRANSIENT_STATUS_TIMEOUT/);
});

test('attachFilesSafely selects non-image input, recovers from fresh-boot overlay, supports targetFrame, and fails closed on UPLOAD_MENU_NOT_READY', async () => {
  const { srv, cleanup } = loadServerForTest();
  try {
    const emptyRes = await srv.attachFilesSafely({}, {}, 'web1', '.', []);
    assert.equal(emptyRes.status, 'ATTACHMENTS_READY');
    assert.deepEqual(emptyRes.files, []);

    const makeComposerMocks = (frame) => {
      const origLocator = frame.locator.bind(frame);
      frame.locator = (sel) => {
        if (sel.includes('data-antigravity-composer-token') || sel.includes('contenteditable') || sel.includes('m365-chat-editor')) {
          const item = {
            evaluate: async () => ({ area: 5000, proximity: 1 }),
            getAttribute: async () => 'tok-1'
          };
          return {
            count: async () => 1,
            nth: () => item
          };
        }
        if (sel === 'button,[role="button"]') {
          return {
            evaluateAll: async () => [{ i: 0, score: 99990, semantic: 'send' }],
            nth: () => ({ isEnabled: async () => true })
          };
        }
        return origLocator(sel);
      };
    };

    // 1) Selects non-image input on targetFrame over image-only input
    const uploadedTo = [];
    const imgInput = {
      getAttribute: async (k) => (k === 'accept' ? 'image/png' : null),
      setInputFiles: async (f) => uploadedTo.push({ kind: 'image', f })
    };
    const docInput = {
      getAttribute: async (k) => (k === 'accept' ? '.txt,.md' : null),
      setInputFiles: async (f) => uploadedTo.push({ kind: 'doc', f })
    };
    const mockFrame1 = {
      $$: async () => [imgInput, docInput],
      evaluate: async () => ({ visible: true, busy: false, error: false, editorText: '' }),
      locator: () => ({ filter: () => ({ first: () => ({ count: async () => 0 }) }) })
    };
    makeComposerMocks(mockFrame1);
    const mockPage1 = {
      $$: async () => [],
      waitForTimeout: async () => {},
      keyboard: { press: async () => {} }
    };
    const res1 = await srv.attachFilesSafely(mockPage1, mockFrame1, 'web1', '.', ['demo.txt']);
    assert.equal(res1.status, 'ATTACHMENTS_READY');
    assert.equal(uploadedTo.length, 1);
    assert.equal(uploadedTo[0].kind, 'doc');

    // 2) Fresh boot overlay closes menu on attempt 1, succeeds on attempt 2
    let clicks = 0;
    let menuOpen = false;
    let overlayVisible = true;
    const chooserFiles = [];
    const mockPage2 = {
      $$: async () => [],
      waitForTimeout: async () => {},
      keyboard: { press: async (k) => { if (k === 'Escape') overlayVisible = false; } },
      once: () => {},
      off: () => {},
      waitForEvent: async () => ({ setFiles: async (f) => chooserFiles.push(f) }),
      locator: (sel) => ({
        filter: () => ({
          first: () => ({
            count: async () => (sel.includes('overlay') ? (overlayVisible ? 1 : 0) : 1),
            waitFor: async () => {},
            scrollIntoViewIfNeeded: async () => {},
            click: async () => {
              if (sel.includes('menuitem')) return;
              clicks++;
              if (clicks >= 2) menuOpen = true;
            },
            isVisible: async () => (sel.includes('menuitem') ? menuOpen : true)
          })
        })
      })
    };
    const mockFrame2 = {
      $$: async () => [],
      evaluate: async () => ({ visible: true, busy: false, error: false, editorText: '' }),
      locator: mockPage2.locator.bind(mockPage2)
    };
    makeComposerMocks(mockFrame2);
    const res2 = await srv.attachFilesSafely(mockPage2, mockFrame2, 'web1', '.', ['spec.txt']);
    assert.equal(res2.status, 'ATTACHMENTS_READY');
    assert.equal(clicks, 2);
    assert.deepEqual(chooserFiles, [['spec.txt']]);

    // 3) Fail-closed UPLOAD_MENU_NOT_READY when menu never opens
    const mockPage3 = {
      $$: async () => [],
      waitForTimeout: async () => {},
      keyboard: { press: async () => {} },
      once: () => {},
      off: () => {},
      locator: () => ({
        filter: () => ({
          first: () => ({
            count: async () => 0,
            waitFor: async () => {},
            scrollIntoViewIfNeeded: async () => {},
            click: async () => {},
            focus: async () => {},
            evaluate: async () => {},
            isVisible: async () => false
          })
        })
      })
    };
    await assert.rejects(
      () => srv.attachFilesSafely(mockPage3, mockPage3, 'web1', '.', ['fail.txt']),
      /ATTACHMENT_UPLOAD_FAILED: UPLOAD_MENU_NOT_READY/
    );
  } finally {
    cleanup();
  }
});

test('local_executor applyAndTestDeterministically applies patch on unstaged modified file, untracked file, offset hunks, and rolls back atomically on corruption', async () => {
  const setupRepo = (prefix) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    fs.mkdirSync(path.join(dir, '.antigravity', 'bridge', 'exchange'), { recursive: true });
    fs.writeFileSync(path.join(dir, '.antigravity', 'bridge', 'routing.json'), JSON.stringify({ buildCmd: '', testCmd: '' }), 'utf8');
    execFileSync('git', ['init', '-q'], { cwd: dir });
    execFileSync('git', ['config', 'user.email', 'test@example.com'], { cwd: dir });
    execFileSync('git', ['config', 'user.name', 'Test'], { cwd: dir });
    return dir;
  };
  const executor = createLocalExecutor({ fs, path, crypto });

  // 1) Unstaged modification on tracked file (previously failed under --3way "does not match index")
  const dir1 = setupRepo('ag-b2-unstaged-');
  try {
    const file1 = path.join(dir1, 'app.js');
    fs.writeFileSync(file1, 'const a = 1;\nconst b = 2;\n', 'utf8');
    execFileSync('git', ['add', 'app.js'], { cwd: dir1 });
    execFileSync('git', ['commit', '-qm', 'init'], { cwd: dir1 });
    fs.writeFileSync(file1, 'const a = 100;\nconst b = 2;\n', 'utf8');
    const patch1 = [
      '```diff',
      'diff --git a/app.js b/app.js',
      '--- a/app.js',
      '+++ b/app.js',
      '@@ -1,2 +1,2 @@',
      ' const a = 100;',
      '-const b = 2;',
      '+const b = 200;',
      '```'
    ].join('\n');
    fs.writeFileSync(path.join(dir1, '.antigravity', 'bridge', 'exchange', 'code.md'), patch1, 'utf8');
    const res1 = await executor.applyAndTestDeterministically(dir1);
    assert.equal(res1.status, 'APPLIED_AND_GREEN');
    assert.equal(fs.readFileSync(file1, 'utf8').replace(/\r\n/g, '\n'), 'const a = 100;\nconst b = 200;\n');
  } finally {
    fs.rmSync(dir1, { recursive: true, force: true });
  }

  // 2) Untracked file in git repo (previously failed under --3way "does not exist in index")
  const dir2 = setupRepo('ag-b2-untracked-');
  try {
    const file2 = path.join(dir2, 'untracked.js');
    fs.writeFileSync(file2, 'const u = 1;\n', 'utf8');
    const patch2 = [
      'diff --git a/untracked.js b/untracked.js',
      '--- a/untracked.js',
      '+++ b/untracked.js',
      '@@ -1,1 +1,1 @@',
      '-const u = 1;',
      '+const u = 2;'
    ].join('\n');
    fs.writeFileSync(path.join(dir2, '.antigravity', 'bridge', 'exchange', 'code.md'), patch2, 'utf8');
    const res2 = await executor.applyAndTestDeterministically(dir2);
    assert.equal(res2.status, 'APPLIED_AND_GREEN');
    assert.equal(fs.readFileSync(file2, 'utf8').replace(/\r\n/g, '\n'), 'const u = 2;\n');
  } finally {
    fs.rmSync(dir2, { recursive: true, force: true });
  }

  // 3) Tier 3 fallback on large line offset
  const dir3 = setupRepo('ag-b2-offset-');
  try {
    const file3 = path.join(dir3, 'shifted.js');
    const filler = Array.from({ length: 25 }, (_, i) => '// line ' + i);
    fs.writeFileSync(file3, [...filler, 'const target = "old";', 'module.exports = target;', ''].join('\n'), 'utf8');
    const patch3 = [
      'diff --git a/shifted.js b/shifted.js',
      '--- a/shifted.js',
      '+++ b/shifted.js',
      '@@ -1,2 +1,2 @@',
      '-const target = "old";',
      '+const target = "new";',
      ' module.exports = target;'
    ].join('\n');
    fs.writeFileSync(path.join(dir3, '.antigravity', 'bridge', 'exchange', 'code.md'), patch3, 'utf8');
    const res3 = await executor.applyAndTestDeterministically(dir3);
    assert.equal(res3.status, 'APPLIED_AND_GREEN');
    assert.ok(fs.readFileSync(file3, 'utf8').includes('const target = "new";'));
  } finally {
    fs.rmSync(dir3, { recursive: true, force: true });
  }

  // 4) Atomic rollback on unrecoverable multi-file patch
  const dir4 = setupRepo('ag-b2-rollback-');
  try {
    const fA = path.join(dir4, 'a.js');
    const fB = path.join(dir4, 'b.js');
    fs.writeFileSync(fA, 'const a = 1;\n', 'utf8');
    fs.writeFileSync(fB, 'const b = 1;\n', 'utf8');
    const badPatch = [
      'diff --git a/a.js b/a.js',
      '--- a/a.js',
      '+++ b/a.js',
      '@@ -1,1 +1,1 @@',
      '-const a = 1;',
      '+const a = 999;',
      'diff --git a/b.js b/b.js',
      '--- a/b.js',
      '+++ b/b.js',
      '@@ -1,1 +1,1 @@',
      '-const NON_EXISTENT = true;',
      '+const b = 999;'
    ].join('\n');
    fs.writeFileSync(path.join(dir4, '.antigravity', 'bridge', 'exchange', 'code.md'), badPatch, 'utf8');
    await assert.rejects(() => executor.applyAndTestDeterministically(dir4), /GIT_APPLY_FAILED/);
    assert.equal(fs.readFileSync(fA, 'utf8'), 'const a = 1;\n', 'First file must be rolled back atomically');
    assert.equal(fs.readFileSync(fB, 'utf8'), 'const b = 1;\n');
    const leftovers = fs.readdirSync(dir4).filter((n) => n.startsWith('.antigravity-patch-'));
    assert.equal(leftovers.length, 0, 'Temporary patch file must be cleaned up');
  } finally {
    fs.rmSync(dir4, { recursive: true, force: true });
  }

  // 5) Path traversal blocked with SECURITY_BLOCK
  const dir5 = setupRepo('ag-b2-sec-');
  try {
    const secPatch = [
      'diff --git a/../outside.js b/../outside.js',
      '--- a/../outside.js',
      '+++ b/../outside.js',
      '@@ -1,1 +1,1 @@',
      '-x',
      '+y'
    ].join('\n');
    fs.writeFileSync(path.join(dir5, '.antigravity', 'bridge', 'exchange', 'code.md'), secPatch, 'utf8');
    await assert.rejects(() => executor.applyAndTestDeterministically(dir5), /SECURITY_BLOCK/);
  } finally {
    fs.rmSync(dir5, { recursive: true, force: true });
  }
});
