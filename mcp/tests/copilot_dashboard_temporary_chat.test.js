'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');

const {
  inspectCopilotTemporaryChatDom,
  ensureCopilotTemporaryChat,
  COPILOT_TEMP_CHAT_ALLOWLIST
} = require('../engines/copilot_engine.js');

test('DoD-1: inspectCopilotTemporaryChatDom & ensureCopilotTemporaryChat cover enable, disable, no-op, timeout, and invalid tabId', async function() {
  assert.deepEqual(COPILOT_TEMP_CHAT_ALLOWLIST, ['web1', 'web2']);

  // Invalid tab check
  const invalidRes = await ensureCopilotTemporaryChat(null, 'gemini1', true);
  assert.equal(invalidRes.verified, false);
  assert.equal(invalidRes.status, 'MISMATCH_OR_UNVERIFIED');
  assert.equal(invalidRes.reason, 'INVALID_COPILOT_TAB_ID');

  const invalidGoogleRes = await ensureCopilotTemporaryChat(null, 'google_search_1', true);
  assert.equal(invalidGoogleRes.verified, false);
  assert.equal(invalidGoogleRes.status, 'MISMATCH_OR_UNVERIFIED');
  assert.equal(invalidGoogleRes.reason, 'INVALID_COPILOT_TAB_ID');

  // Page not active
  const noPage = await ensureCopilotTemporaryChat(null, 'web1', true);
  assert.equal(noPage.verified, false);
  assert.equal(noPage.status, 'SAVED_WAITING_TAB');
  assert.equal(noPage.reason, 'TAB_NOT_ACTIVE');

  // Mock Frame already in requested state (no-op)
  const mockAlreadyOn = {
    evaluate: async function(fn, ...args) {
      return {
        controlFound: true,
        active: true,
        indicatorFound: true,
        ariaPressed: 'true',
        ariaChecked: null,
        controlLabel: 'Temporary chat'
      };
    }
  };
  const noOpRes = await ensureCopilotTemporaryChat(mockAlreadyOn, 'web1', true);
  assert.equal(noOpRes.verified, true);
  assert.equal(noOpRes.active, true);
  assert.equal(noOpRes.status, 'ACTIVE_VERIFIED');
  assert.equal(noOpRes.reason, 'ALREADY_MATCHED');

  // Mock toggle transition (enable from off to on)
  let stateActive = false;
  const mockToggle = {
    waitForTimeout: async function(ms) {},
    evaluate: async function(fn, ...args) {
      const code = fn.toString();
      if (code.includes('toggleControl.click')) {
        stateActive = true;
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
  const toggleRes = await ensureCopilotTemporaryChat(mockToggle, 'web1', true, { timeoutMs: 500, pollMs: 10 });
  assert.equal(toggleRes.verified, true);
  assert.equal(toggleRes.active, true);
  assert.equal(toggleRes.status, 'ACTIVE_VERIFIED');
  assert.equal(toggleRes.reason, 'TOGGLED_AND_CONFIRMED');

  // Timeout case
  const mockStuck = {
    waitForTimeout: async function(ms) {},
    evaluate: async function(fn, ...args) {
      const code = fn.toString();
      if (code.includes('toggleControl.click')) return true;
      return {
        controlFound: true,
        active: false,
        indicatorFound: false,
        ariaPressed: 'false',
        ariaChecked: null,
        controlLabel: 'Temporary chat'
      };
    }
  };
  const timeoutRes = await ensureCopilotTemporaryChat(mockStuck, 'web2', true, { timeoutMs: 60, pollMs: 10 });
  assert.equal(timeoutRes.verified, false);
  assert.equal(timeoutRes.status, 'TIMEOUT_WAITING_VERIFICATION');
  assert.equal(timeoutRes.reason, 'DOM_UPDATE_TIMEOUT');
});

test('DoD-2: mcp/dashboard.html renders Aktivizo Temporary Chat for web1 and web2', function() {
  const htmlPath = path.resolve(__dirname, '../dashboard.html');
  const html = fs.readFileSync(htmlPath, 'utf8');

  assert.ok(html.includes('Aktivizo Temporary Chat'), 'Must contain Aktivizo Temporary Chat label');
  assert.ok(html.includes("const COPILOT_TEMP_CHAT_TABS = new Set(['web1', 'web2'])"), 'Must register web1 and web2');
  assert.ok(html.includes('data-temp-chat-toggle="${k}"'), 'data-temp-chat-toggle attribute must be present');
  assert.ok(html.includes('data-temp-chat-badge="${k}"'), 'data-temp-chat-badge attribute must be present');
  assert.ok(html.includes("action: 'set_temporary_chat'"), 'Must call POST /api/save-routing with set_temporary_chat');
});

test('DoD-3: mcp/server.js persists web1/web2, extends POST /api/save-routing, and isolates google_search_1..3', function() {
  process.env.ANTIGRAVITY_TEST_EXPORT = '1';
  const exported = require('../server.js');
  assert.equal(typeof exported.buildDashboardState, 'function');
  const state = exported.buildDashboardState([]);

  for (const w of ['web1', 'web2']) {
    assert.ok(Object.prototype.hasOwnProperty.call(state.tabs[w], 'temporaryChatRequested'));
    assert.ok(Object.prototype.hasOwnProperty.call(state.tabs[w], 'temporaryChatActive'));
    assert.ok(Object.prototype.hasOwnProperty.call(state.tabs[w], 'temporaryChatVerified'));
    assert.ok(Object.prototype.hasOwnProperty.call(state.tabs[w], 'temporaryChatStatus'));
    assert.ok(Object.prototype.hasOwnProperty.call(state.tabs[w], 'temporaryChatReason'));
    assert.ok(Object.prototype.hasOwnProperty.call(state.tabs[w], 'temporaryChatCheckedAt'));
  }

  for (const untouched of ['google_search_1', 'google_search_2', 'google_search_3']) {
    assert.equal(Object.prototype.hasOwnProperty.call(state.tabs[untouched], 'temporaryChat'), false);
    assert.equal(Object.prototype.hasOwnProperty.call(state.tabs[untouched], 'temporaryChatRequested'), false);
    assert.equal(Object.prototype.hasOwnProperty.call(state.tabs[untouched], 'temporaryChatActive'), false);
  }
});
