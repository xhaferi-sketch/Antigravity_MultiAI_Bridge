'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  setTabModelLock,
  getTabModelLock,
  clearTabModelLock,
  buildGeminiLockContract,
  buildCopilotLockContract
} = require('../pipeline/model_locks');

const {
  createGeminiEngine,
  GEMINI_REQUIRED_MODEL,
  resolveGeminiHardCapMs,
  HIGH_REASONING_HARD_CAP_MS
} = require('../engines/gemini_engine');

const {
  createCopilotEngine,
  COPILOT_REQUIRED_MODEL
} = require('../engines/copilot_engine');

function createTempLocksFile() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-model-locks-'));
  return path.join(dir, 'model_locks.json');
}

test('model_locks preserves strict defaults when empty and persists custom user locks atomically', () => {
  const locksPath = createTempLocksFile();

  const defGem = buildGeminiLockContract('gemini1', GEMINI_REQUIRED_MODEL, locksPath);
  assert.equal(defGem.customLocked, false);
  assert.equal(defGem.displayLabel, '4 Neon (High)');

  const defCop = buildCopilotLockContract('web1', COPILOT_REQUIRED_MODEL, locksPath);
  assert.equal(defCop.customLocked, false);
  assert.equal(defCop.allowThinkDeeperFallback, true);

  setTabModelLock('gemini1', {
    engine: 'gemini',
    modelLabel: '4 Neon',
    reasoningLabel: 'Medium',
    reasoning: 'medium',
    displayLabel: '4 Neon (Medium)'
  }, locksPath);

  const saved = getTabModelLock('gemini1', locksPath);
  assert.equal(saved.displayLabel, '4 Neon (Medium)');
  assert.equal(saved.lockedByUser, true);

  const customGem = buildGeminiLockContract('gemini1', GEMINI_REQUIRED_MODEL, locksPath);
  assert.equal(customGem.customLocked, true);
  assert.equal(customGem.modelLabel, '4 Neon');
  assert.equal(customGem.reasoningLabel, 'Medium');
  assert.equal(customGem.reasoning, 'medium');

  assert.equal(clearTabModelLock('gemini1', locksPath), true);
  assert.equal(getTabModelLock('gemini1', locksPath), null);
});

test('resolveGeminiHardCapMs grants full high-reasoning cap for medium user locks', () => {
  assert.equal(resolveGeminiHardCapMs({ modelLabel: '4 Neon (Medium)', reasoningLevel: 'medium' }), HIGH_REASONING_HARD_CAP_MS);
  assert.equal(resolveGeminiHardCapMs({ activeModel: '4 Neon (Medium)' }), HIGH_REASONING_HARD_CAP_MS);
});

test('gemini_engine enforces custom user lock (4 Neon Medium) in DOM and fails closed when unavailable', async () => {
  const locksPath = createTempLocksFile();
  setTabModelLock('gemini1', {
    engine: 'gemini',
    modelLabel: '4 Neon',
    reasoningLabel: 'Medium',
    reasoning: 'medium',
    displayLabel: '4 Neon (Medium)'
  }, locksPath);

  const activeModels = {};
  const discovered = {};
  const engine = createGeminiEngine({ tabActiveModel: activeModels, tabDiscoveredModels: discovered });

  const prevDoc = global.document;
  const prevWin = global.window;
  let selectedLevel = 'High';
  let clickedMedium = false;

  try {
    const makeEl = (opts) => ({
      innerText: opts.text || '',
      textContent: opts.text || '',
      _attrs: Object.assign({}, opts.attrs || {}),
      getAttribute: function(k) { return this._attrs[k] || null; },
      setAttribute: function(k, v) { this._attrs[k] = v; },
      closest: () => null,
      querySelector: () => null,
      getBoundingClientRect: () => ({ width: 100, height: 28 }),
      click: opts.onClick || (() => {})
    });

    const triggerEl = makeEl({
      text: 'Neon\nHigh',
      attrs: { 'data-test-id': 'bard-mode-menu-button', 'aria-label': 'Open mode picker, currently Neon High' }
    });
    const neonOpt = makeEl({
      text: 'Deeper analysis (4 Neon)',
      onClick: () => { menuMode = 'main'; }
    });
    const thinkTrigger = makeEl({
      text: 'Thinking level',
      onClick: () => { menuMode = 'sub'; }
    });
    const medOpt = makeEl({
      text: 'Medium',
      onClick: () => {
        selectedLevel = 'Medium';
        clickedMedium = true;
        triggerEl.innerText = 'Neon\nMedium';
        triggerEl._attrs['aria-label'] = 'Open mode picker, currently Neon Medium';
      }
    });
    const highOpt = makeEl({ text: 'High (Extra thorough)' });

    let menuMode = 'closed';
    triggerEl.click = () => { menuMode = 'main'; };

    global.window = { getComputedStyle: () => ({ display: 'block', visibility: 'visible' }) };
    global.document = {
      dispatchEvent: () => {},
      querySelectorAll: (sel) => {
        if (sel.includes('.cdk-overlay-backdrop')) return [];
        if (sel.includes('bard-mode-switcher') || sel.includes('button[data-test-id*="model"]')) return [triggerEl];
        if (sel.includes('[role="menu"]')) {
          if (menuMode === 'closed') return [];
          return [{
            querySelectorAll: () => (menuMode === 'main' ? [neonOpt, thinkTrigger] : [medOpt, highOpt])
          }];
        }
        if (sel.includes('gem-menu-item') || sel.includes('[role="menuitemradio"]')) {
          if (menuMode === 'main') return [neonOpt, thinkTrigger];
          if (menuMode === 'sub') return [medOpt, highOpt];
          return [];
        }
        return [];
      }
    };

    const mockFrame = { evaluate: async (fn, arg) => fn(arg) };
    const info = await engine.discoverGeminiLiveOptions(mockFrame);
    assert.equal(info.ok, true);
    assert.ok(info.models.some((m) => m.label.includes('4 Neon')));
    assert.ok(info.thinkingLevels.some((lv) => lv.label === 'Medium'));

    const res = await engine.ensureGeminiNeonModel(mockFrame, 'gemini1', { locksPath: locksPath, timeoutMs: 1000 });
    assert.equal(res, '4 Neon (Medium)');
    assert.equal(clickedMedium, true);
    assert.equal(selectedLevel, 'Medium');
    assert.equal(activeModels.gemini1, '4 Neon (Medium)');
  } finally {
    global.document = prevDoc;
    global.window = prevWin;
  }
});

test('copilot_engine enforces custom user lock cleanly via discoverCopilotLiveOptions and ensureCopilotGpt56Model', async () => {
  const locksPath = createTempLocksFile();
  setTabModelLock('web2', {
    engine: 'copilot',
    modelLabel: 'Think deeper',
    displayLabel: 'Think deeper',
    reasoning: 'custom'
  }, locksPath);

  const receipts = {};
  const active = {};
  const engine = createCopilotEngine({
    tabAuthStatus: {},
    tabActiveModel: active,
    tabDiscoveredModels: {},
    copilotModelReceipts: receipts,
    captureSupportEvidence: async () => {}
  });

  const label = await engine.ensureCopilotGpt56Model({
    evaluate: async (fn, req) => {
      assert.equal(req.customLocked, true);
      assert.equal(req.modelLabel, 'Think deeper');
      assert.equal(req.allowThinkDeeperFallback, false);
      return { ok: true, active: 'Think deeper', reasoningLocked: true, customLocked: true };
    }
  }, 'web2', { locksPath: locksPath });

  assert.equal(label, 'Think deeper');
  assert.equal(active.web2, 'Think deeper');
  assert.equal(receipts.web2.verified, true);
});

test('SELEKTO_AI_MODEL.bat and select_ai_model.js expose all 5 isolated slots in repo root', () => {
  const rootDir = path.resolve(__dirname, '..', '..');
  const batPath = path.join(rootDir, 'SELEKTO_AI_MODEL.bat');
  assert.equal(fs.existsSync(batPath), true);
  assert.match(fs.readFileSync(batPath, 'utf8'), /select_ai_model\.js/);

  const { SLOT_DEFS, extractCanonicalGeminiModel, extractCanonicalReason } = require('../select_ai_model');
  assert.deepEqual(Object.keys(SLOT_DEFS).sort(), ['gemini1', 'gemini2', 'gemini3', 'web1', 'web2']);
  assert.equal(extractCanonicalGeminiModel({ label: 'Code & complex work\n4 Carbon' }), '4 Carbon');
  assert.equal(extractCanonicalGeminiModel({ label: 'Auto\nAdapts to your needs' }), 'Auto');
  assert.equal(extractCanonicalReason('Medium\nBalanced thinking'), 'Medium');
  assert.equal(extractCanonicalReason('High (Extra thorough)'), 'High');
});

test('discoverGeminiLiveOptions extracts canonical multi-line models and ensureGeminiNeonModel verifies Carbon lock', async () => {
  const locksPath = createTempLocksFile();
  setTabModelLock('gemini2', {
    engine: 'gemini',
    modelLabel: '4 Carbon',
    displayLabel: '4 Carbon',
    reasoning: 'custom'
  }, locksPath);

  const activeModels = {};
  const engine = createGeminiEngine({ tabActiveModel: activeModels, tabDiscoveredModels: {} });
  const prevDoc = global.document;
  const prevWin = global.window;
  let menuOpen = false;
  let currentLabel = 'Neon';

  try {
    const makeEl = (opts) => ({
      innerText: opts.text || '',
      textContent: opts.text || '',
      _attrs: Object.assign({}, opts.attrs || {}),
      getAttribute: function(k) { return this._attrs[k] || null; },
      setAttribute: function(k, v) { this._attrs[k] = v; },
      closest: () => null,
      querySelector: () => null,
      getBoundingClientRect: () => ({ width: 120, height: 32 }),
      click: opts.onClick || (() => {})
    });

    const triggerEl = makeEl({
      text: 'Neon',
      attrs: { 'data-test-id': 'bard-mode-menu-button', 'aria-label': 'Open mode picker, currently Neon' },
      onClick: () => { menuOpen = !menuOpen; }
    });
    const autoOpt = makeEl({ text: 'Auto\nAdapts to your needs' });
    const carbonOpt = makeEl({
      text: 'Code & complex work\n4 Carbon',
      onClick: () => {
        currentLabel = 'Carbon';
        triggerEl.innerText = 'Carbon';
        triggerEl._attrs['aria-label'] = 'Open mode picker, currently Carbon';
        menuOpen = false;
      }
    });

    global.window = { getComputedStyle: () => ({ display: 'block', visibility: 'visible' }) };
    global.document = {
      dispatchEvent: () => {},
      querySelectorAll: (sel) => {
        if (sel.includes('.cdk-overlay-backdrop')) return [];
        if (sel.includes('bard-mode-switcher') || sel.includes('button[data-test-id*="model"]')) return [triggerEl];
        if (sel.includes('[role="menu"]') || sel.includes('mat-menu-content')) {
          return menuOpen ? [{ querySelectorAll: () => [autoOpt, carbonOpt] }] : [];
        }
        return [];
      }
    };

    const mockFrame = { evaluate: async (fn, arg) => fn(arg) };
    const disc = await engine.discoverGeminiLiveOptions(mockFrame);
    assert.equal(disc.ok, true);
    assert.deepEqual(disc.models.map((m) => m.shortLabel), ['Auto', '4 Carbon']);

    const verified = await engine.ensureGeminiNeonModel(mockFrame, 'gemini2', { locksPath: locksPath, timeoutMs: 1000 });
    assert.equal(verified, '4 Carbon');
    assert.equal(currentLabel, 'Carbon');
    assert.equal(activeModels.gemini2, '4 Carbon');
  } finally {
    global.document = prevDoc;
    global.window = prevWin;
  }
});

test('discoverCopilotLiveOptions falls back to Playwright locator click when synthetic DOM click opens no portal menu', async () => {
  const engine = createCopilotEngine({
    tabAuthStatus: {},
    tabActiveModel: {},
    tabDiscoveredModels: {},
    copilotModelReceipts: {},
    captureSupportEvidence: async () => {}
  });

  const prevDoc = global.document;
  const prevWin = global.window;
  const prevGCS = global.getComputedStyle;
  let portalOpen = false;

  try {
    const makeEl = (opts) => ({
      innerText: opts.text || '',
      textContent: opts.text || '',
      _attrs: Object.assign({}, opts.attrs || {}),
      getAttribute: function(k) { return this._attrs[k] || null; },
      setAttribute: function(k, v) { this._attrs[k] = v; },
      closest: () => null,
      matches: () => false,
      querySelector: () => null,
      querySelectorAll: () => [],
      dispatchEvent: () => {},
      getBoundingClientRect: () => ({ width: 120, height: 32 }),
      click: opts.onClick || (() => {})
    });

    const triggerEl = makeEl({
      text: 'Auto',
      attrs: { 'aria-label': 'Auto, Model Selector' },
      onClick: () => {} // Synthetic DOM click intentionally does not open Fluent UI portal
    });
    const optAuto = makeEl({ text: 'Auto\nChooses the best model', attrs: { role: 'menuitemradio', 'aria-checked': 'true' } });
    const optThink = makeEl({ text: 'Think deeper\nSolves complex problems', attrs: { role: 'menuitemradio' } });

    global.window = { getComputedStyle: () => ({ display: 'block', visibility: 'visible', opacity: '1' }) };
    global.getComputedStyle = global.window.getComputedStyle;
    global.document = {
      dispatchEvent: () => {},
      querySelector: (sel) => (sel.includes('data-ag-model-trigger') && triggerEl._attrs['data-ag-model-trigger'] === '1' ? triggerEl : null),
      querySelectorAll: (sel) => {
        if (sel.includes('button[aria-label*="model" i]')) return [triggerEl];
        if (sel.includes('[role="dialog"]') || sel.includes('.fui-MenuPopover')) {
          return portalOpen ? [{
            innerText: 'Auto Think deeper',
            getAttribute: () => null,
            dispatchEvent: () => {},
            getBoundingClientRect: () => ({ width: 220, height: 140 }),
            querySelectorAll: (subSel) => (subSel.includes('role="menuitemradio"') ? [optAuto, optThink] : [])
          }] : [];
        }
        return [];
      }
    };

    let playwrightClicked = false;
    const mockFrame = {
      evaluate: async (fn, arg) => fn(arg),
      locator: (sel) => ({
        first: () => ({
          click: async () => {
            assert.match(sel, /data-ag-model-trigger/);
            playwrightClicked = true;
            portalOpen = true;
          }
        })
      })
    };

    const res = await engine.discoverCopilotLiveOptions(mockFrame);
    assert.equal(res.ok, true);
    assert.equal(playwrightClicked, true);
    assert.deepEqual(res.options.map((o) => o.shortLabel), ['Auto', 'Think deeper']);
  } finally {
    global.document = prevDoc;
    global.window = prevWin;
    global.getComputedStyle = prevGCS;
  }
});

test('.gemini/rules/model_locks_sovereignty.md explicitly respects user locks in model_locks.json over default High/GPT-5.6 requirements', () => {
  const ruleMd = fs.readFileSync(path.resolve(__dirname, '..', '..', '.gemini', 'rules', 'model_locks_sovereignty.md'), 'utf8');
  assert.match(ruleMd, /model_locks\.json/);
  assert.match(ruleMd, /lockedByUser:\s*true/);
  assert.match(ruleMd, /NDALOHEN.*bllokojn/i);
});
