'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const {
  createCopilotEngine,
  ensureCopilotTemporaryChat,
  COPILOT_REQUIRED_MODEL
} = require('../engines/copilot_engine.js');

test('Copilot web1 and web2 map to strictly isolated profiles m365_web1 and m365_web2', () => {
  const prevExport = process.env.ANTIGRAVITY_TEST_EXPORT;
  const prevTruthful = process.env.ANTIGRAVITY_TRUTHFUL_TEST;
  process.env.ANTIGRAVITY_TEST_EXPORT = '1';
  process.env.ANTIGRAVITY_TRUTHFUL_TEST = '1';
  const serverPath = path.join(__dirname, '..', 'server.js');
  try {
    delete require.cache[require.resolve(serverPath)];
    const srv = require(serverPath);

    assert.equal(srv.getProfileNameForTab('web1'), 'm365_web1');
    assert.equal(srv.getProfileNameForTab('web2'), 'm365_web2');
    assert.notEqual(srv.getProfileNameForTab('web1'), srv.getProfileNameForTab('web2'));
    assert.equal(srv.getProfileNameForTab('m365_web1'), 'm365_web1');
    assert.equal(srv.getProfileNameForTab('m365_web2'), 'm365_web2');

    const state = srv.buildDashboardState([]);
    assert.equal(state.tabs.web1.profileName, 'm365_web1');
    assert.equal(state.tabs.web2.profileName, 'm365_web2');
  } finally {
    delete require.cache[require.resolve(serverPath)];
    if (prevExport === undefined) delete process.env.ANTIGRAVITY_TEST_EXPORT;
    else process.env.ANTIGRAVITY_TEST_EXPORT = prevExport;
    if (prevTruthful === undefined) delete process.env.ANTIGRAVITY_TRUTHFUL_TEST;
    else process.env.ANTIGRAVITY_TRUTHFUL_TEST = prevTruthful;
  }
});

test('Dashboard and server enforce separate m365_web1 and m365_web2 login profiles without shared m365 button', () => {
  const html = fs.readFileSync(path.join(__dirname, '..', 'dashboard.html'), 'utf8');
  assert.ok(html.includes("loginProfile('m365_web1')"), 'Dashboard must have dedicated loginProfile for m365_web1');
  assert.ok(html.includes("loginProfile('m365_web2')"), 'Dashboard must have dedicated loginProfile for m365_web2');
  assert.equal(html.includes("loginProfile('m365')"), false, 'Dashboard must not use shared m365 login button');

  const serverSrc = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  assert.match(serverSrc, /SHARED_M365_PROFILE_DEPRECATED/);
  assert.match(serverSrc, /tempRes\.active !== false/);
});

test('Copilot 5.6 Sol Think Deeper lock strictly accepts GPT-5.6 Sol Think + Think deeper and excludes Auto/Dark mode', async () => {
  assert.equal(COPILOT_REQUIRED_MODEL.modelLabel, 'GPT-5.6 Sol Think');
  assert.equal(COPILOT_REQUIRED_MODEL.reasoningLabel, 'Think deeper');
  assert.equal(COPILOT_REQUIRED_MODEL.reasoning, 'high');

  const receipts = {};
  const activeModels = {};
  const discovered = {};
  const engine = createCopilotEngine({
    tabAuthStatus: {},
    tabActiveModel: activeModels,
    tabDiscoveredModels: discovered,
    copilotModelReceipts: receipts,
    captureSupportEvidence: async () => {}
  });

  const verified = await engine.ensureCopilotGpt56Model({
    evaluate: async () => ({
      ok: true,
      active: 'GPT-5.6 Sol Think · Think deeper',
      reasoningLocked: true
    })
  }, 'web2');

  assert.equal(verified, 'GPT-5.6 Sol Think (Deep / High)');
  assert.equal(receipts.web2.verified, true);
  assert.equal(receipts.web2.reasoningLocked, true);
  assert.equal(activeModels.web2, 'GPT-5.6 Sol Think (Deep / High)');

  const engineSrc = fs.readFileSync(path.join(__dirname, '..', 'engines', 'copilot_engine.js'), 'utf8');
  assert.match(engineSrc, /isExcludedControl/);
  assert.match(engineSrc, /dark\\s\*mode/i);
  assert.match(engineSrc, /gpt-4/);
});

test('ensureCopilotTemporaryChat verifies toggling from ON back to OFF cleanly', async () => {
  let stateActive = true;
  const mockPage = {
    waitForTimeout: async () => {},
    evaluate: async (fn) => {
      const code = fn.toString();
      if (code.includes('toggleControl.click')) {
        stateActive = false;
        return true;
      }
      return {
        controlFound: true,
        active: stateActive,
        indicatorFound: stateActive,
        ariaPressed: stateActive ? 'true' : 'false',
        ariaChecked: null,
        controlLabel: 'Temporary chat'
      };
    }
  };

  const offRes = await ensureCopilotTemporaryChat(mockPage, 'web1', false, { timeoutMs: 500, pollMs: 10 });
  assert.equal(offRes.verified, true);
  assert.equal(offRes.active, false);
  assert.equal(offRes.status, 'OFF_VERIFIED');
  assert.equal(offRes.reason, 'TOGGLED_AND_CONFIRMED');
});

test('autopilot_engine does not emit default /run-cycle WhatsApp notifications', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'pipeline', 'autopilot_engine.js'), 'utf8');
  assert.equal(src.includes("notifyWhatsApp('[HERMES /run-cycle]"), false, '/run-cycle must not trigger default WhatsApp notifications');
  assert.match(src, /process\.env\.ANTIGRAVITY_RUN_CYCLE_NOTIFY !== '1'/);
});
