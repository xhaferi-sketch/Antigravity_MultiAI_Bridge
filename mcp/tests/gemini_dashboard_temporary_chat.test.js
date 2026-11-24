'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');

const {
  inspectGeminiTemporaryChatDom,
  ensureGeminiTemporaryChat,
  GEMINI_REQUIRED_MODEL
} = require('../engines/gemini_engine');

test('DoD-1: inspectGeminiTemporaryChatDom & ensureGeminiTemporaryChat cover enable, disable, no-op, timeout, and invalid tabId', async function() {
  let domActive = false;
  let clickCount = 0;

  const mockPage = {
    evaluate: async function(fn, arg) {
      if (arg && typeof arg.requested === 'boolean') {
        clickCount++;
        domActive = arg.requested;
        return { clicked: true, reason: 'CLICKED' };
      }
      return {
        controlFound: true,
        active: domActive,
        indicatorFound: domActive,
        ariaPressed: String(domActive),
        ariaChecked: String(domActive),
        controlLabel: 'Temporary chat'
      };
    }
  };

  const inspectedOff = await inspectGeminiTemporaryChatDom(mockPage);
  assert.equal(inspectedOff.active, false);

  // Enable
  const enabledRes = await ensureGeminiTemporaryChat(mockPage, 'gemini1', true, { timeoutMs: 500, pollMs: 20 });
  assert.equal(enabledRes.tabId, 'gemini1');
  assert.equal(enabledRes.requested, true);
  assert.equal(enabledRes.active, true);
  assert.equal(enabledRes.verified, true);
  assert.equal(enabledRes.status, 'ACTIVE_VERIFIED');
  assert.ok(enabledRes.checkedAt);
  assert.equal(clickCount, 1);

  // No-op when already matched
  const noopRes = await ensureGeminiTemporaryChat(mockPage, 'gemini1', true, { timeoutMs: 500, pollMs: 20 });
  assert.equal(noopRes.verified, true);
  assert.equal(noopRes.status, 'ACTIVE_VERIFIED');
  assert.equal(clickCount, 1);

  // Disable
  const disabledRes = await ensureGeminiTemporaryChat(mockPage, 'gemini1', false, { timeoutMs: 500, pollMs: 20 });
  assert.equal(disabledRes.requested, false);
  assert.equal(disabledRes.active, false);
  assert.equal(disabledRes.verified, true);
  assert.equal(disabledRes.status, 'OFF_VERIFIED');
  assert.equal(clickCount, 2);

  // MISMATCH_OR_UNVERIFIED when control missing
  const missingPage = {
    evaluate: async function(fn, arg) {
      if (arg && typeof arg.requested === 'boolean') {
        return { clicked: false, reason: 'TEMPORARY_CHAT_CONTROL_NOT_FOUND' };
      }
      return { controlFound: false, active: false, indicatorFound: false, ariaPressed: null, ariaChecked: null, controlLabel: '' };
    }
  };
  const missingRes = await ensureGeminiTemporaryChat(missingPage, 'gemini2', true, { timeoutMs: 200, pollMs: 20 });
  assert.equal(missingRes.verified, false);
  assert.equal(missingRes.status, 'MISMATCH_OR_UNVERIFIED');

  // Reject non-Gemini tabs
  for (const invalid of ['web1', 'web2', 'google_search_1']) {
    const rej = await ensureGeminiTemporaryChat(mockPage, invalid, true);
    assert.equal(rej.verified, false);
    assert.equal(rej.status, 'MISMATCH_OR_UNVERIFIED');
    assert.equal(rej.reason, 'INVALID_GEMINI_TAB_ID');
  }

  // 4 Neon lock preserved
  assert.equal(GEMINI_REQUIRED_MODEL.modelLabel, '4 Neon');
  assert.equal(GEMINI_REQUIRED_MODEL.reasoning, 'high');
});

test('DoD-2: mcp/dashboard.html renders Aktivizo Temporary Chat exclusively for gemini1..gemini3 via POST /api/save-routing', function() {
  const dashboardPath = path.resolve(__dirname, '../dashboard.html');
  const html = fs.readFileSync(dashboardPath, 'utf8');

  assert.ok(html.includes('Aktivizo Temporary Chat'), 'Exact label must be present');
  assert.ok(html.includes('data-temp-chat-toggle="${k}"'), 'data-temp-chat-toggle attribute must be present');
  assert.ok(html.includes('data-temp-chat-badge="${k}"'), 'data-temp-chat-badge attribute must be present');
  assert.ok(html.includes("action: 'set_temporary_chat'"), 'Must call POST /api/save-routing with set_temporary_chat');
  assert.ok(html.includes('Duke verifikuar DOM...'), 'Must display verifying status while in flight');
  assert.ok(!html.includes('/api/toggle-temporary-chat'), 'Must not call non-inventory route');
});

test('DoD-3: mcp/server.js uses atomic tab_config.json, extends POST /api/save-routing, and isolates web1/web2/google_search in buildDashboardState', function() {
  const serverPath = path.resolve(__dirname, '../server.js');
  const serverCode = fs.readFileSync(serverPath, 'utf8');

  assert.ok(serverCode.includes('fs.renameSync('), 'persistTabConfig must write atomically via renameSync');
  assert.ok(serverCode.includes("data.action === 'set_temporary_chat'"), 'POST /api/save-routing must handle set_temporary_chat');
  assert.ok(!serverCode.includes('/api/toggle-temporary-chat'), 'Must not add an 11th HTTP route');

  process.env.ANTIGRAVITY_TEST_EXPORT = '1';
  const exported = require('../server.js');
  assert.equal(typeof exported.buildDashboardState, 'function');
  const state = exported.buildDashboardState([]);

  for (const g of ['gemini1', 'gemini2', 'gemini3']) {
    assert.ok(Object.prototype.hasOwnProperty.call(state.tabs[g], 'temporaryChatRequested'));
    assert.ok(Object.prototype.hasOwnProperty.call(state.tabs[g], 'temporaryChatActive'));
    assert.ok(Object.prototype.hasOwnProperty.call(state.tabs[g], 'temporaryChatVerified'));
    assert.ok(Object.prototype.hasOwnProperty.call(state.tabs[g], 'temporaryChatStatus'));
    assert.ok(Object.prototype.hasOwnProperty.call(state.tabs[g], 'temporaryChatReason'));
    assert.ok(Object.prototype.hasOwnProperty.call(state.tabs[g], 'temporaryChatCheckedAt'));
  }

  for (const untouched of ['google_search_1', 'google_search_2', 'google_search_3']) {
    assert.equal(Object.prototype.hasOwnProperty.call(state.tabs[untouched], 'temporaryChat'), false);
    assert.equal(Object.prototype.hasOwnProperty.call(state.tabs[untouched], 'temporaryChatRequested'), false);
    assert.equal(Object.prototype.hasOwnProperty.call(state.tabs[untouched], 'temporaryChatActive'), false);
  }
});