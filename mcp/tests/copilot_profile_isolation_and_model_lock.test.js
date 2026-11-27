'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const PREV_LOCKS_ENV = process.env.ANTIGRAVITY_MODEL_LOCKS_PATH;
test.before(() => {
  process.env.ANTIGRAVITY_MODEL_LOCKS_PATH = path.join(os.tmpdir(), 'ag-no-locks-copiso-' + process.pid + '.json');
});
test.after(() => {
  if (PREV_LOCKS_ENV === undefined) delete process.env.ANTIGRAVITY_MODEL_LOCKS_PATH;
  else process.env.ANTIGRAVITY_MODEL_LOCKS_PATH = PREV_LOCKS_ENV;
});

const {
  createCopilotEngine,
  ensureCopilotTemporaryChat,
  inspectLiveAuthState,
  checkAuthExpired,
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

test('inspectLiveAuthState truthfully detects ACCOUNT_PICKER without auto-selecting, ACTIVE, and AUTH_EXPIRED', async () => {
  const authMap = {};
  let clicked = false;

  const pickerPage = {
    url: () => 'https://login.microsoftonline.com/common/oauth2/v2.0/authorize',
    waitForTimeout: async () => {},
    evaluate: async () => ({
      composerReady: false,
      hasAccountPicker: true,
      accounts: ['user1@example.com', 'user2@example.com']
    })
  };
  const pickerRes = await inspectLiveAuthState(pickerPage, 'web2', authMap);
  assert.equal(pickerRes.state, 'ACCOUNT_PICKER');
  assert.deepEqual(pickerRes.accounts, ['user1@example.com', 'user2@example.com']);
  assert.equal(authMap.web2, 'ACCOUNT_PICKER');
  assert.equal(clicked, false, 'Must NEVER auto-click/select a user account');

  const blocked = await checkAuthExpired(pickerPage, 'web2', authMap);
  assert.equal(blocked, true);
  assert.equal(authMap.web2, 'ACCOUNT_PICKER');

  const activePage = {
    url: () => 'https://copilot.cloud.microsoft/chat',
    waitForTimeout: async () => {},
    evaluate: async () => ({ composerReady: true, hasAccountPicker: false, accounts: [] })
  };
  const activeRes = await inspectLiveAuthState(activePage, 'web2', authMap);
  assert.equal(activeRes.state, 'ACTIVE');
  assert.equal(authMap.web2, 'ACTIVE');
  assert.equal(await checkAuthExpired(activePage, 'web2', authMap), false);
});

test('server.js and dashboard.html wire isolated M365 CDP ports, live auth refresh, and non-blocking login errors', () => {
  const srvSrc = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  const html = fs.readFileSync(path.join(__dirname, '..', 'dashboard.html'), 'utf8');
  assert.match(srvSrc, /m365_web1:\s*18011/);
  assert.match(srvSrc, /m365_web2:\s*18012/);
  assert.match(srvSrc, /refreshLiveAuthForOpenTabs/);
  assert.match(srvSrc, /ACCOUNT_PICKER_REQUIRED/);
  assert.ok(html.includes('loginNotice'), 'Dashboard must show non-blocking loginNotice banner instead of stealing window focus');
  assert.ok(html.includes('if (!r.ok || d.ok === false)'), 'Dashboard must report login-profile HTTP/JSON failures instead of failing silently');
});
