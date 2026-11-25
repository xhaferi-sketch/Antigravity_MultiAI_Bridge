'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { createCopilotEngine } = require(path.join(__dirname, '..', 'engines', 'copilot_engine.js'));
const { ensureGeminiTemporaryChat, inspectGeminiTemporaryChatDom } = require(path.join(__dirname, '..', 'engines', 'gemini_engine.js'));

test('Copilot ensureCopilotGpt56Model rejects Auto / unverified reasoning (never bypasses to Auto)', async () => {
  const engine = createCopilotEngine({
    tabAuthStatus: {},
    tabActiveModel: {},
    tabDiscoveredModels: {},
    copilotModelReceipts: {},
    captureSupportEvidence: async () => {}
  });

  await assert.rejects(
    () => engine.ensureCopilotGpt56Model({
      evaluate: async () => ({ ok: false, reason: 'COPILOT_REQUIRED_MODEL_UNAVAILABLE', active: 'Auto' })
    }, 'web1'),
    /COPILOT_MODEL_LOCK_FAILED: COPILOT_REQUIRED_MODEL_UNAVAILABLE/
  );

  await assert.rejects(
    () => engine.ensureCopilotGpt56Model({
      evaluate: async () => ({ ok: true, active: 'GPT-5.6 Sol Think', reasoningLocked: false })
    }, 'web1'),
    /COPILOT_MODEL_LOCK_FAILED: COPILOT_REASONING_NOT_DEEP/
  );
});

test('copilot_engine.js source has no Auto bypass and strictly checks reasoningLocked', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'engines', 'copilot_engine.js'), 'utf8');
  assert.doesNotMatch(src, /else if \(text\(button\)\.toLowerCase\(\)\.includes\('auto'\)/);
  assert.match(src, /COPILOT_REASONING_NOT_DEEP/);
  assert.match(src, /isForbiddenWeakModel/);
});

test('Gemini ensureGeminiTemporaryChat retries inside collapsed sidebar drawer when toggle is initially hidden', async () => {
  let drawerOpened = false;
  const mockPage = {
    evaluate: async (fn, arg) => {
      const code = fn.toString();
      if (code.includes('toggleControl')) {
        return { controlFound: false, active: false, indicatorFound: false, ariaPressed: null, ariaChecked: null, controlLabel: '' };
      }
      if (!drawerOpened && arg && arg.requested) {
        drawerOpened = true;
        return { clicked: false, retryAfterDrawer: true, reason: 'OPENED_DRAWER_FOR_TEMPORARY_CHAT' };
      }
      return { clicked: true, reason: 'CLICKED_TEMPORARY_CHAT_TOGGLE' };
    }
  };
  // After drawer opens and click succeeds, inspectGeminiTemporaryChatDom returns controlFound false on mock unless updated;
  // verify drawer fallback path executes and stops fail-closed on DOM_VERIFICATION_TIMEOUT rather than immediately failing before opening drawer.
  const res = await ensureGeminiTemporaryChat(mockPage, 'gemini1', true, { timeoutMs: 40, pollMs: 10 });
  assert.equal(drawerOpened, true);
  assert.equal(res.reason, 'DOM_VERIFICATION_TIMEOUT');
  assert.equal(res.verified, false);
});

test('inspectGeminiTemporaryChatDom detects real Gemini Temporary Chat banner ("Temporary chats don\'t appear")', async () => {
  const prevDocument = global.document;
  const prevWindow = global.window;
  try {
    const fakeNode = {
      isConnected: true,
      innerText: "Just stopping by?\nTemporary chats don't appear in recent chats and aren't used to improve Google AI. Stored for 72 hours for safety.",
      classList: { contains: () => false },
      getAttribute: () => '',
      getBoundingClientRect: () => ({ width: 400, height: 120 })
    };
    global.window = { getComputedStyle: () => ({ display: 'block', visibility: 'visible' }) };
    global.document = {
      querySelectorAll: (sel) => (sel.includes('main') ? [fakeNode] : []),
      querySelector: () => null
    };
    const res = await inspectGeminiTemporaryChatDom({ evaluate: (fn) => fn() });
    assert.equal(res.indicatorFound, true);
    assert.equal(res.active, true);
  } finally {
    global.document = prevDocument;
    global.window = prevWindow;
  }
});

test('Truthful Dashboard runtime reports disconnected/unverified instead of fake static labels when tabs are closed', () => {
  const prevTestExport = process.env.ANTIGRAVITY_TEST_EXPORT;
  const prevTruthful = process.env.ANTIGRAVITY_TRUTHFUL_TEST;
  process.env.ANTIGRAVITY_TEST_EXPORT = '1';
  process.env.ANTIGRAVITY_TRUTHFUL_TEST = '1';
  const serverPath = path.join(__dirname, '..', 'server.js');
  try {
    delete require.cache[require.resolve(serverPath)];
    const srv = require(serverPath);
    const state = srv.buildDashboardState([]);
    for (const k of ['web1', 'web2', 'gemini1', 'gemini2', 'gemini3', 'google_search_1']) {
      assert.equal(state.tabs[k].open, false);
      assert.equal(state.tabs[k].model, '-', `${k} must show '-' when closed, not a fake model`);
      assert.equal(state.tabs[k].connectionLabel, 'E Shkëputur', `${k} must show E Shkëputur when closed`);
    }
    assert.notEqual(state.tabs.web1.temporaryChatStatus, 'OFF_VERIFIED', 'Closed tab must not claim OFF_VERIFIED');
  } finally {
    delete require.cache[require.resolve(serverPath)];
    if (prevTestExport === undefined) delete process.env.ANTIGRAVITY_TEST_EXPORT; else process.env.ANTIGRAVITY_TEST_EXPORT = prevTestExport;
    if (prevTruthful === undefined) delete process.env.ANTIGRAVITY_TRUTHFUL_TEST; else process.env.ANTIGRAVITY_TRUTHFUL_TEST = prevTruthful;
  }
});

test('autopilot_engine notifyWhatsApp uses shell:false so multi-word messages reach hermes.exe without Exit Code 2', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'pipeline', 'autopilot_engine.js'), 'utf8');
  const fnBlock = src.slice(src.indexOf('function notifyWhatsApp'), src.indexOf('let AdmZip'));
  assert.match(fnBlock, /shell:\s*false/);
  assert.match(fnBlock, /detached:\s*false/);
  assert.match(fnBlock, /windowsHide:\s*true/);
  assert.doesNotMatch(fnBlock, /shell:\s*true/);
});

test('local_executor spawns git/node/python/taskkill strictly with windowsHide:true (zero console flash on Windows)', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'pipeline', 'local_executor.js'), 'utf8');
  const spawnLines = src.split(/\r?\n/).filter((l) => /\b(execSync|spawnSync|nodeSpawnSync|nodeSpawn)\s*\(/.test(l) && !/function\s+|require\(|execSyncFn|spawnSyncFn|const\s+spawnSync/.test(l));
  assert.ok(spawnLines.length >= 10);
  for (const line of spawnLines) {
    assert.match(line, /windowsHide:\s*true/, `Missing windowsHide:true on line: ${line.trim()}`);
  }
});
