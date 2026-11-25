'use strict';

const path = require('node:path');
const crypto = require('node:crypto');

const NL = String.fromCharCode(10);
const FENCE3 = String.fromCharCode(96, 96, 96);
const M365_CHAT_URL = 'https://' + 'm365.cloud.' + 'microsoft/chat';
const LOGIN_MS = 'microsoft' + 'online.com';
const LOGIN_LIVE = 'login.' + 'live.com';
const LOGIN_GOOGLE = 'accounts.' + 'google.com';

const COPILOT_REQUIRED_MODEL = Object.freeze({
  family: 'gpt-5.6-sol-think',
  modelLabel: 'GPT-5.6 Sol Think',
  displayLabel: 'GPT-5.6 Sol Think (Deep / High)',
  reasoningLabel: 'Think deeper',
  reasoning: 'high'
});

const COPILOT_OUTPUT_CONTRACT = [
  'OUTPUT CONTRACT — MANDATORY',
  'Return ONLY the authorized target files.',
  'FILE: relative/path.ext',
  FENCE3 + 'language',
  '<complete file content>',
  FENCE3,
  'Rules: Opening and closing triple backticks are mandatory. No prose. No diffs.'
].join(NL);

function findChatFrameOrPage(page) {
  if (!page || typeof page.frames !== 'function') return page;
  for (const frame of page.frames()) {
    const fu = (frame.url() || '').toLowerCase();
    if (fu.includes('m365.cloud.microsoft') || fu.includes('copilot') || fu.includes('bing.com')) {
      return frame;
    }
  }
  return page;
}

async function checkAuthExpired(page, tabKey, authStatusMap) {
  if (!page || typeof page.url !== 'function') return false;
  for (let i = 0; i < 15; i++) {
    const u = (page.url() || '').toLowerCase();
    const onLogin =
      u.includes(LOGIN_MS) ||
      u.includes(LOGIN_LIVE) ||
      u.includes('login.windows.net') ||
      u.includes(LOGIN_GOOGLE);

    if (!onLogin && u.startsWith('http') && !u.includes('chromewebdata')) {
      const target = findChatFrameOrPage(page);
      const ready = await target.evaluate(function() {
        return Boolean(document.querySelector('rich-textarea, div[contenteditable="true"], [role="textbox"], textarea'));
      }).catch(function() { return false; });

      if (ready) {
        if (typeof page.waitForTimeout === 'function') await page.waitForTimeout(800);
        if (authStatusMap && tabKey) authStatusMap[tabKey] = 'ACTIVE';
        return false;
      }
    }
    if (typeof page.waitForTimeout === 'function') await page.waitForTimeout(1000);
  }
  if (authStatusMap && tabKey) authStatusMap[tabKey] = 'AUTH_EXPIRED';
  return true;
}

function buildCopilotPromptWithContract(promptText, outputContract) {
  const contract = outputContract || COPILOT_OUTPUT_CONTRACT;
  const combined = String(promptText || '');
  if (!combined.includes('OUTPUT CONTRACT')) {
    return contract + NL + NL + combined;
  }
  return combined;
}

function createCopilotEngine(runtimeContext) {
  if (!runtimeContext || typeof runtimeContext !== 'object') {
    throw new Error('Mandatory runtimeContext dependency is required');
  }

  const tabAuthStatus = runtimeContext.tabAuthStatus || {};
  const tabActiveModel = runtimeContext.tabActiveModel || {};
  const tabDiscoveredModels = runtimeContext.tabDiscoveredModels || {};
  const copilotModelReceipts = runtimeContext.copilotModelReceipts || {};
  const captureSupportEvidence = runtimeContext.captureSupportEvidence || (async function() {});

  async function checkAuth(page, tabKey) {
    return checkAuthExpired(page, tabKey, tabAuthStatus);
  }

  async function ensureCopilotGpt56Model(targetFrame, tabKey, opts) {
    opts = opts || {};
    const contract = opts.contract || COPILOT_REQUIRED_MODEL;
    if (tabKey && copilotModelReceipts) copilotModelReceipts[tabKey] = null;
    const result = await targetFrame.evaluate(async function(req) {
      const visible = function(el) {
        if (!el) return false;
        const s = getComputedStyle(el), r = el.getBoundingClientRect();
        return s.display !== 'none' && s.visibility !== 'hidden' && r.width > 4 && r.height > 4;
      };
      const text = function(el) {
        return (((el && el.innerText) || '') + ' ' + ((el && el.getAttribute('aria-label')) || '')).replace(/\s+/g, ' ').trim();
      };
      const selectors = 'button[aria-label*="model" i],button[aria-label*="mode" i],[data-testid*="model-switcher" i],[data-testid*="mode-selector" i],.fui-Dropdown';
      let button = Array.from(document.querySelectorAll(selectors)).find(visible) || null;
      const isForbiddenWeakModel = function(val) {
        const lower = String(val || '').toLowerCase();
        return /\b(auto|quick\s*response|fast|flash|lite|mini|basic|standard)\b/i.test(lower);
      };
      const requiredModelVisible = function(val) {
        const lower = String(val || '').toLowerCase();
        return (lower.includes('gpt-5.6') || lower.includes('5.6 sol think') || lower.includes('sol think')) && !isForbiddenWeakModel(lower);
      };
      const hasDeepReasoningSignal = function(val) {
        const lower = String(val || '').toLowerCase();
        if (lower.includes(req.reasoningLabel.toLowerCase()) || /\bdeep\b|think\s*deeper|extra\s*thorough|\bhigh\b/i.test(lower)) return true;
        return Array.from(document.querySelectorAll('button,[role="switch"],[role="menuitemradio"],[role="option"]')).filter(visible).some(function(el) {
          const t = text(el).toLowerCase();
          const active = el.getAttribute('aria-pressed') === 'true' || el.getAttribute('aria-checked') === 'true' || el.classList.contains('active') || el.classList.contains('is-active');
          return active && /think\s*deeper|deep|high/i.test(t);
        });
      };
      if (button && requiredModelVisible(text(button)) && hasDeepReasoningSignal(text(button))) {
        return { ok: true, active: text(button), reasoningLocked: true };
      }
      if (!button) {
        const opener = Array.from(document.querySelectorAll('button')).filter(visible).find(function(el) {
          return /model|gpt|think|auto|quick/i.test(text(el));
        });
        if (opener) {
          opener.click();
          await new Promise(function(resolve) { setTimeout(resolve, 350); });
          button = Array.from(document.querySelectorAll(selectors)).find(visible) || opener;
        }
      }
      if (button) {
        button.click();
        await new Promise(function(resolve) { setTimeout(resolve, 600); });
        const menuContainer = document.querySelector('.fui-MenuPopover, [role="menu"], [role="listbox"], .fui-MenuList');
        const searchScope = menuContainer || document;
        const options = Array.from(searchScope.querySelectorAll('[role="option"],[role="menuitemradio"],[role="menuitem"],[role="menuitemcheckbox"],.fui-MenuItem,.fui-Option,button,div')).filter(function(el) {
          if (!visible(el)) return false;
          const t = text(el);
          return t.length > 2 && t.length < 100;
        });
        const available = options.map(function(o) { return text(o); }).filter(Boolean).slice(0, 25);
        const model = options.find(function(el) {
          const value = text(el).toLowerCase();
          if (isForbiddenWeakModel(value)) return false;
          return (value.includes('gpt-5.6') && (value.includes('sol think') || value.includes('think deeper'))) || value.includes(req.modelLabel.toLowerCase()) || value.includes('5.6 sol think') || value.includes('sol think') || value.includes('think deeper');
        });
        if (model) {
          model.click();
          await new Promise(function(resolve) { setTimeout(resolve, 500); });
          button = Array.from(document.querySelectorAll(selectors)).find(visible) || button;
        } else {
          return { ok: false, reason: 'COPILOT_REQUIRED_MODEL_UNAVAILABLE', active: text(button), available: available, hasMenu: Boolean(menuContainer) };
        }
      }
      if (!button || !requiredModelVisible(text(button))) {
        return { ok: false, reason: 'COPILOT_REQUIRED_MODEL_NOT_ACTIVE', active: button ? text(button) : 'missing' };
      }
      const reasoningControls = Array.from(document.querySelectorAll('button,[role="option"],[role="menuitemradio"],[role="menuitem"]')).filter(visible);
      let reasoning = reasoningControls.find(function(el) {
        return String(text(el)).toLowerCase().includes(req.reasoningLabel.toLowerCase());
      });
      if (!reasoning) {
        const opener = reasoningControls.find(function(el) { return /reason|think/i.test(text(el)); });
        if (opener) {
          opener.click();
          await new Promise(function(resolve) { setTimeout(resolve, 250); });
          reasoning = Array.from(document.querySelectorAll('[role="option"],[role="menuitemradio"],[role="menuitem"],button')).filter(visible).find(function(el) {
            return String(text(el)).toLowerCase().includes(req.reasoningLabel.toLowerCase());
          });
        }
      }
      if (reasoning && typeof reasoning.click === 'function') {
        reasoning.click();
        await new Promise(function(resolve) { setTimeout(resolve, 350); });
      }
      const finalButton = Array.from(document.querySelectorAll(selectors)).find(visible) || button;
      const finalActive = text(finalButton);
      const reasoningLocked = hasDeepReasoningSignal(finalActive);
      return { ok: requiredModelVisible(finalActive) && reasoningLocked, reason: !reasoningLocked ? 'COPILOT_REASONING_NOT_DEEP' : undefined, active: finalActive, reasoningLocked: reasoningLocked };
    }, contract);

    if (!result || !result.ok || result.reasoningLocked === false) {
      const availInfo = Array.isArray(result && result.available) && result.available.length ? (', available: [' + result.available.join(' | ') + ']') : '';
      const reason = (result && result.reason) || (result && result.reasoningLocked === false ? 'COPILOT_REASONING_NOT_DEEP' : 'COPILOT_REQUIRED_MODEL_NOT_ACTIVE');
      throw new Error('COPILOT_MODEL_LOCK_FAILED: ' + reason + ' (active: ' + ((result && result.active) || 'unknown') + availInfo + ')');
    }
    if (tabKey) {
      tabActiveModel[tabKey] = contract.displayLabel;
      tabDiscoveredModels[tabKey] = result.active || contract.displayLabel;
      if (copilotModelReceipts) {
        copilotModelReceipts[tabKey] = { verified: true, family: contract.family, observedLabel: result.active || contract.displayLabel, reasoningLocked: true };
      }
    }
    return contract.displayLabel;
  }

  return {
    findChatFrameOrPage,
    checkAuthExpired: checkAuth,
    ensureCopilotGpt56Model,
    buildCopilotPromptWithContract,
    COPILOT_REQUIRED_MODEL,
    COPILOT_OUTPUT_CONTRACT,
    M365_CHAT_URL
  };
}

const COPILOT_TEMP_CHAT_ALLOWLIST = Object.freeze(['web1', 'web2']);

async function inspectCopilotTemporaryChatDom(page) {
  if (!page || typeof page.evaluate !== 'function') {
    return {
      controlFound: false,
      active: false,
      indicatorFound: false,
      ariaPressed: null,
      ariaChecked: null,
      controlLabel: ''
    };
  }
  try {
    return await page.evaluate(function() {
      const normalize = function(s) { return String(s || '').toLowerCase().replace(/\s+/g, ' ').trim(); };
      const actionable = function(el) {
        if (!el || !el.isConnected) return false;
        const st = window.getComputedStyle(el);
        const r = el.getBoundingClientRect();
        return st.display !== 'none' && st.visibility !== 'hidden' && r.width > 3 && r.height > 3;
      };

      const toggleControl = Array.from(document.querySelectorAll('button, [role="button"], [role="switch"], [role="checkbox"], a'))
        .find(function(el) {
          if (!actionable(el)) return false;
          const label = normalize((el.getAttribute('aria-label') || '') + ' ' + (el.innerText || el.textContent || '') + ' ' + (el.getAttribute('data-testid') || ''));
          return /temporary chat|private chat|off the record|incognito|don't save history|mos ruaj|përkohshme/i.test(label);
        }) || null;

      const ariaPressed = toggleControl ? toggleControl.getAttribute('aria-pressed') : null;
      const ariaChecked = toggleControl ? toggleControl.getAttribute('aria-checked') : null;
      const controlLabel = toggleControl
        ? String(toggleControl.getAttribute('aria-label') || toggleControl.innerText || toggleControl.getAttribute('data-testid') || '').trim().slice(0, 120)
        : '';

      const controlActive = Boolean(
        toggleControl && (
          ariaPressed === 'true' ||
          ariaChecked === 'true' ||
          toggleControl.classList.contains('active') ||
          toggleControl.classList.contains('is-active') ||
          toggleControl.getAttribute('data-state') === 'checked'
        )
      );

      let indicatorFound = false;
      const promptEl = document.querySelector('rich-textarea div.ql-editor, textarea, [contenteditable="true"], [role="textbox"]');
      if (promptEl) {
        const ph = promptEl.getAttribute('data-placeholder') || promptEl.getAttribute('placeholder') || '';
        if (/temporary|private|përkohshme/i.test(ph)) indicatorFound = true;
      }
      if (!indicatorFound) {
        const elements = Array.from(document.querySelectorAll('[role="region"], [role="status"], aside, header, div, span, p, .badge'))
          .filter(actionable);
        indicatorFound = elements.some(function(el) {
          const t = normalize(el.innerText || el.textContent || '');
          return (t.includes('temporary chat') || t.includes('private chat') || t.includes('bisedë e përkohshme')) &&
            (t.includes("won't be saved") || t.includes("won't appear") || t.includes('is on') || t.includes('është aktive') || el.classList.contains('active'));
        });
      }

      return {
        controlFound: Boolean(toggleControl),
        active: Boolean(controlActive || indicatorFound),
        indicatorFound: Boolean(indicatorFound),
        ariaPressed: ariaPressed,
        ariaChecked: ariaChecked,
        controlLabel: controlLabel
      };
    });
  } catch (err) {
    return {
      controlFound: false,
      active: false,
      indicatorFound: false,
      ariaPressed: null,
      ariaChecked: null,
      controlLabel: '',
      error: String(err && err.message || err).slice(0, 160)
    };
  }
}

async function ensureCopilotTemporaryChat(page, tabId, desiredEnabled, opts) {
  opts = opts || {};
  const requested = Boolean(desiredEnabled);
  const timeoutMs = Number.isFinite(opts.timeoutMs) ? Math.max(100, opts.timeoutMs) : 5000;
  const pollMs = Number.isFinite(opts.pollMs) ? Math.max(20, opts.pollMs) : 150;
  const nowIso = function() { return new Date().toISOString(); };

  if (!COPILOT_TEMP_CHAT_ALLOWLIST.includes(tabId)) {
    return {
      tabId: tabId,
      requested: requested,
      active: false,
      verified: false,
      status: 'MISMATCH_OR_UNVERIFIED',
      reason: 'INVALID_COPILOT_TAB_ID',
      checkedAt: nowIso()
    };
  }

  if (!page || typeof page.evaluate !== 'function') {
    return {
      tabId: tabId,
      requested: requested,
      active: false,
      verified: false,
      status: 'SAVED_WAITING_TAB',
      reason: 'TAB_NOT_ACTIVE',
      checkedAt: nowIso()
    };
  }

  const initial = await inspectCopilotTemporaryChatDom(page);
  if (initial.active === requested) {
    return {
      tabId: tabId,
      requested: requested,
      active: initial.active,
      verified: true,
      status: initial.active ? 'ACTIVE_VERIFIED' : 'OFF_VERIFIED',
      reason: 'ALREADY_MATCHED',
      checkedAt: nowIso()
    };
  }

  if (!initial.controlFound) {
    if (!requested) {
      return {
        tabId: tabId,
        requested: false,
        active: false,
        verified: true,
        status: 'OFF_VERIFIED',
        reason: 'DEFAULT_OFF_NO_TOGGLE',
        checkedAt: nowIso()
      };
    }
    return {
      tabId: tabId,
      requested: true,
      active: initial.active,
      verified: false,
      status: 'CONTROL_NOT_FOUND',
      reason: 'COPILOT_TOGGLE_NOT_FOUND',
      checkedAt: nowIso()
    };
  }

  const clicked = await page.evaluate(function() {
    const normalize = function(s) { return String(s || '').toLowerCase().replace(/\s+/g, ' ').trim(); };
    const actionable = function(el) {
      if (!el || !el.isConnected) return false;
      const st = window.getComputedStyle(el);
      const r = el.getBoundingClientRect();
      return st.display !== 'none' && st.visibility !== 'hidden' && r.width > 3 && r.height > 3;
    };
    const toggleControl = Array.from(document.querySelectorAll('button, [role="button"], [role="switch"], [role="checkbox"], a'))
      .find(function(el) {
        if (!actionable(el)) return false;
        const label = normalize((el.getAttribute('aria-label') || '') + ' ' + (el.innerText || el.textContent || '') + ' ' + (el.getAttribute('data-testid') || ''));
        return /temporary chat|private chat|off the record|incognito|don't save history|mos ruaj|përkohshme/i.test(label);
      });
    if (toggleControl && typeof toggleControl.click === 'function') {
      toggleControl.click();
      return true;
    }
    return false;
  }).catch(function() { return false; });

  if (!clicked) {
    return {
      tabId: tabId,
      requested: requested,
      active: initial.active,
      verified: false,
      status: 'CONTROL_CLICK_FAILED',
      reason: 'COULD_NOT_CLICK_TOGGLE',
      checkedAt: nowIso()
    };
  }

  const start = Date.now();
  let lastObserved = initial;
  while (Date.now() - start < timeoutMs) {
    if (typeof page.waitForTimeout === 'function') {
      await page.waitForTimeout(pollMs);
    } else {
      await new Promise(function(resolve) { setTimeout(resolve, pollMs); });
    }
    lastObserved = await inspectCopilotTemporaryChatDom(page);
    if (lastObserved.active === requested) {
      return {
        tabId: tabId,
        requested: requested,
        active: lastObserved.active,
        verified: true,
        status: lastObserved.active ? 'ACTIVE_VERIFIED' : 'OFF_VERIFIED',
        reason: 'TOGGLED_AND_CONFIRMED',
        checkedAt: nowIso()
      };
    }
  }

  return {
    tabId: tabId,
    requested: requested,
    active: lastObserved.active,
    verified: false,
    status: 'TIMEOUT_WAITING_VERIFICATION',
    reason: 'DOM_UPDATE_TIMEOUT',
    checkedAt: nowIso()
  };
}

module.exports = {
  createCopilotEngine,
  COPILOT_REQUIRED_MODEL,
  COPILOT_OUTPUT_CONTRACT,
  M365_CHAT_URL,
  findChatFrameOrPage,
  checkAuthExpired,
  buildCopilotPromptWithContract,
  COPILOT_TEMP_CHAT_ALLOWLIST,
  inspectCopilotTemporaryChatDom,
  ensureCopilotTemporaryChat
};
