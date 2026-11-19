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
  const captureSupportEvidence = runtimeContext.captureSupportEvidence || (async function() {});

  async function checkAuth(page, tabKey) {
    return checkAuthExpired(page, tabKey, tabAuthStatus);
  }

  async function ensureCopilotGpt56Model(targetFrame, tabKey, opts) {
    opts = opts || {};
    const contract = opts.contract || COPILOT_REQUIRED_MODEL;
    const result = await targetFrame.evaluate(async function(req) {
      const visible = function(el) {
        if (!el) return false;
        const s = getComputedStyle(el), r = el.getBoundingClientRect();
        return s.display !== 'none' && s.visibility !== 'hidden' && r.width > 4 && r.height > 4;
      };
      const text = function(el) {
        return ((el && el.innerText) || '') + ' ' + ((el && el.getAttribute('aria-label')) || '');
      };
      const selectors = 'button[aria-label*="model" i],button[aria-label*="mode" i],[data-testid*="model-switcher" i],[data-testid*="mode-selector" i],.fui-Dropdown';
      let button = Array.from(document.querySelectorAll(selectors)).find(visible) || null;
      const requiredModelVisible = function(val) {
        const lower = String(val || '').toLowerCase();
        return lower.includes('gpt-5.6') || lower.includes('5.6 sol think') || lower.includes('sol think');
      };
      if (button && requiredModelVisible(text(button))) {
        const reasoningLocked = text(button).toLowerCase().includes(req.reasoningLabel.toLowerCase());
        return { ok: true, active: text(button).trim(), reasoningLocked: reasoningLocked };
      }
      if (!button) {
        const opener = Array.from(document.querySelectorAll('button')).filter(visible).find(function(el) {
          return /model|gpt|think/i.test(text(el));
        });
        if (opener) {
          opener.click();
          await new Promise(function(resolve) { setTimeout(resolve, 350); });
          button = Array.from(document.querySelectorAll(selectors)).find(visible) || button;
        }
      }
      if (button) {
        button.click();
        await new Promise(function(resolve) { setTimeout(resolve, 350); });
        const options = Array.from(document.querySelectorAll('[role="option"],[role="menuitemradio"],[role="menuitem"],button')).filter(visible);
        const model = options.find(function(el) {
          const value = text(el).toLowerCase();
          return (value.includes('gpt-5.6') && (value.includes('sol think') || value.includes('think deeper'))) || value.includes(req.modelLabel.toLowerCase()) || value.includes('5.6 sol think') || value.includes('sol think');
        });
        if (!model) return { ok: false, reason: 'COPILOT_REQUIRED_MODEL_UNAVAILABLE', active: text(button).trim() };
        model.click();
        await new Promise(function(resolve) { setTimeout(resolve, 500); });
        button = Array.from(document.querySelectorAll(selectors)).find(visible) || button;
      }
      if (!button || !requiredModelVisible(text(button))) return { ok: false, reason: 'COPILOT_REQUIRED_MODEL_NOT_ACTIVE', active: button ? text(button).trim() : 'missing' };
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
        await new Promise(function(resolve) { setTimeout(resolve, 300); });
      }
      const finalButton = Array.from(document.querySelectorAll(selectors)).find(visible) || button;
      const finalActive = text(finalButton).trim();
      return { ok: requiredModelVisible(finalActive), active: finalActive, reasoningLocked: finalActive.toLowerCase().includes(req.reasoningLabel.toLowerCase()) };
    }, contract);

    if (!result.ok) {
      throw new Error('COPILOT_MODEL_LOCK_FAILED: ' + result.reason + ' (active: ' + result.active + ')');
    }
    if (tabKey) tabActiveModel[tabKey] = contract.displayLabel;
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

module.exports = {
  createCopilotEngine,
  COPILOT_REQUIRED_MODEL,
  COPILOT_OUTPUT_CONTRACT,
  M365_CHAT_URL,
  findChatFrameOrPage,
  checkAuthExpired,
  buildCopilotPromptWithContract
};
