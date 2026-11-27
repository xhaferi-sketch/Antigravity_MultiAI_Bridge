'use strict';

const path = require('node:path');
const crypto = require('node:crypto');
const { buildCopilotLockContract } = require('../pipeline/model_locks');

const NL = String.fromCharCode(10);
const FENCE3 = String.fromCharCode(96, 96, 96);
const M365_CHAT_URL = 'https://' + 'm365.cloud.' + 'microsoft/chat';
const LOGIN_MS = 'microsoft' + 'online.com';
const LOGIN_LIVE = 'login.' + 'live.com';
const LOGIN_GOOGLE = 'accounts.' + 'google.com';

// NOTE (2026-11-24 Microsoft global rollout — NOT a user credit limit):
// Microsoft temporarily removed 'GPT-5.6 Sol' globally from the Copilot dropdown.
// Keep COPILOT_REQUIRED_MODEL ('GPT-5.6 Sol Think') intact as priority #1;
// allowThinkDeeperFallback enables 'Think deeper' while GPT-5.6 Sol is missing.
// Flip allowThinkDeeperFallback to false once Microsoft restores GPT-5.6 Sol.
const COPILOT_REQUIRED_MODEL = Object.freeze({
  family: 'gpt-5.6-sol-think',
  modelLabel: 'GPT-5.6 Sol Think',
  displayLabel: 'GPT-5.6 Sol Think (Deep / High)',
  reasoningLabel: 'Think deeper',
  reasoning: 'high',
  allowThinkDeeperFallback: true
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

async function inspectLiveAuthState(page, tabKey, authStatusMap) {
  if (!page || typeof page.url !== 'function') {
    return { state: 'UNKNOWN', accounts: [], url: '', reason: 'NO_PAGE' };
  }
  const u = (page.url() || '').toLowerCase();
  const onLogin =
    u.includes(LOGIN_MS) ||
    u.includes(LOGIN_LIVE) ||
    u.includes('login.windows.net') ||
    u.includes(LOGIN_GOOGLE);

  const target = findChatFrameOrPage(page);
  const domProbe = await target.evaluate(function() {
    const bodyText = String((document.body && document.body.innerText) || '');
    const composerReady = Boolean(document.querySelector('rich-textarea, div[contenteditable="true"], [role="textbox"], textarea'));
    const pickerHeading = /pick an account|choose an account|zgjidhni nj[eë] llogari/i.test(bodyText);
    const tileNodes = Array.from(document.querySelectorAll(
      '[data-test-id="accountTile"], #tilesHolder .tile-container, [role="listitem"], .table[role="button"]'
    ));
    const accounts = [];
    tileNodes.forEach(function(el) {
      const t = String(el.innerText || '').replace(/\s+/g, ' ').trim();
      const mail = t.match(/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/);
      if (mail && !accounts.includes(mail[0])) accounts.push(mail[0]);
    });
    const hasAccountPicker = pickerHeading || (accounts.length >= 1 && /signed in|use another account/i.test(bodyText));
    return { composerReady: composerReady, hasAccountPicker: hasAccountPicker, accounts: accounts };
  }).catch(function() {
    return { composerReady: false, hasAccountPicker: false, accounts: [] };
  });

  let result;
  if (domProbe.hasAccountPicker) {
    result = {
      state: 'ACCOUNT_PICKER',
      accounts: domProbe.accounts || [],
      url: page.url() || '',
      reason: domProbe.accounts && domProbe.accounts.length
        ? ('MICROSOFT_PICK_AN_ACCOUNT: ' + domProbe.accounts.join(', '))
        : 'MICROSOFT_PICK_AN_ACCOUNT'
    };
  } else if (!onLogin && u.startsWith('http') && !u.includes('chromewebdata') && domProbe.composerReady) {
    result = { state: 'ACTIVE', accounts: [], url: page.url() || '', reason: 'CHAT_COMPOSER_READY' };
  } else if (onLogin) {
    result = { state: 'AUTH_EXPIRED', accounts: [], url: page.url() || '', reason: 'LOGIN_HOST_REDIRECT' };
  } else if (!u || u === 'about:blank') {
    result = { state: 'CHECKING', accounts: [], url: page.url() || '', reason: 'BLANK_OR_LOADING' };
  } else {
    result = { state: 'AUTH_EXPIRED', accounts: [], url: page.url() || '', reason: 'COMPOSER_NOT_READY' };
  }

  if (authStatusMap && tabKey && result.state !== 'CHECKING') {
    authStatusMap[tabKey] = result.state;
  }
  return result;
}

async function checkAuthExpired(page, tabKey, authStatusMap) {
  if (!page || typeof page.url !== 'function') return false;
  let lastState = { state: 'AUTH_EXPIRED', accounts: [], url: '', reason: '' };
  for (let i = 0; i < 15; i++) {
    lastState = await inspectLiveAuthState(page, tabKey, authStatusMap);
    if (lastState.state === 'ACTIVE') {
      if (typeof page.waitForTimeout === 'function') await page.waitForTimeout(800);
      if (authStatusMap && tabKey) authStatusMap[tabKey] = 'ACTIVE';
      return false;
    }
    // Keep polling up to 15s only for blank/loading or redirects; stop early once Pick-an-Account is clearly settled.
    if (lastState.state === 'ACCOUNT_PICKER' && i >= 2) {
      break;
    }
    if (typeof page.waitForTimeout === 'function') await page.waitForTimeout(1000);
  }
  if (authStatusMap && tabKey) authStatusMap[tabKey] = lastState.state === 'ACCOUNT_PICKER' ? 'ACCOUNT_PICKER' : 'AUTH_EXPIRED';
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

  async function discoverCopilotLiveOptions(targetFrame, opts) {
    opts = opts || {};
    const collectFromTarget = async function(frameOrPage, arg) {
      return await frameOrPage.evaluate(async function(a) {
        const sleep = function(ms) { return new Promise(function(resolve) { setTimeout(resolve, ms); }); };
        const visible = function(el) {
          if (!el || el.isConnected === false) return false;
          const s = getComputedStyle(el), r = el.getBoundingClientRect();
          return s.display !== 'none' && s.visibility !== 'hidden' && parseFloat(s.opacity || '1') > 0.05 && r.width > 4 && r.height > 4;
        };
        const rawTextOf = function(el) {
          const inner = String((el && el.innerText) || '').trim();
          const aria = String((el && typeof el.getAttribute === 'function' && el.getAttribute('aria-label')) || '').trim();
          const title = String((el && typeof el.getAttribute === 'function' && el.getAttribute('title')) || '').trim();
          return { inner: inner, aria: aria, title: title };
        };
        const text = function(el) {
          const t = rawTextOf(el);
          return (t.inner + ' ' + t.aria + ' ' + t.title).replace(/\s+/g, ' ').trim();
        };
        const cleanOptionLabel = function(el) {
          const t = rawTextOf(el);
          const primary = t.inner || t.aria || t.title || '';
          const lines = primary.split(/\r?\n/).map(function(l) { return l.replace(/\s+/g, ' ').trim(); }).filter(Boolean);
          const shortLabel = lines[0] || primary.replace(/\s+/g, ' ').trim();
          const fullLabel = lines.join(' — ') || shortLabel;
          return { shortLabel: shortLabel, label: fullLabel };
        };
        const isControlActive = function(el) {
          if (!el || typeof el.getAttribute !== 'function') return false;
          if (el.getAttribute('aria-checked') === 'true' || el.getAttribute('aria-selected') === 'true' || el.getAttribute('aria-pressed') === 'true') return true;
          return Boolean(typeof el.querySelector === 'function' && el.querySelector('[aria-checked="true"], [data-icon-name*="Check"], svg[data-icon-name*="Check"]'));
        };
        const fireRealishClick = function(el) {
          if (el && typeof el.click === 'function') el.click();
        };

        const selectors = 'button[aria-label*="model" i],button[aria-label*="mode" i],[data-testid*="model-switcher" i],[data-testid*="mode-selector" i],.fui-Dropdown';
        const menuSelector = '.fui-MenuPopover, .fui-PopoverSurface, [role="menu"], [role="listbox"], [role="dialog"], [role="radiogroup"], .fui-MenuList, [data-popper-placement], [class*="MenuPopover" i], [class*="PopoverSurface" i]';
        const optionSelector = '[role="option"],[role="menuitemradio"],[role="menuitem"],[role="menuitemcheckbox"],[role="radio"],.fui-MenuItem,.fui-Option,[data-testid*="gptSubMenuModelTrigger-"],[data-testid*="model" i] button,button,[role="button"]';

        const findTrigger = function() {
          const tagged = document.querySelector('[data-ag-model-trigger="1"]');
          if (tagged && visible(tagged)) return tagged;
          const direct = Array.from(document.querySelectorAll(selectors)).filter(visible).find(function(el) {
            return !el.closest('[role="menu"], [role="listbox"], .fui-MenuPopover') &&
              !/\b(dark\s*mode|light\s*mode|color\s*mode|theme|sidebar|navigation)\b/i.test(text(el));
          }) || null;
          if (direct) return direct;
          return Array.from(document.querySelectorAll('button,[role="button"]')).filter(visible).find(function(el) {
            if (el.closest('[role="menu"], [role="listbox"], .fui-MenuPopover')) return false;
            return /model selector|gpt-5\.6|sol\s*think|think\s*deeper|quick\s*response|\bauto\b/i.test(text(el)) &&
              !/\b(dark\s*mode|light\s*mode|color\s*mode|theme|sidebar|navigation)\b/i.test(text(el));
          }) || null;
        };

        const btn = findTrigger();
        let activeLabel = btn ? cleanOptionLabel(btn).shortLabel : '';
        if (!btn && !a.collectOnly) {
          return { ok: false, reason: 'COPILOT_MODEL_TRIGGER_NOT_FOUND', active: '', options: [] };
        }
        if (btn && typeof btn.setAttribute === 'function') {
          btn.setAttribute('data-ag-model-trigger', '1');
          const tBtn = rawTextOf(btn);
          activeLabel = (tBtn.inner || tBtn.aria || '').replace(/\s+/g, ' ').trim() || activeLabel;
        }

        const getVisibleMenus = function() {
          return Array.from(document.querySelectorAll(menuSelector)).filter(visible);
        };

        if (!a.collectOnly && getVisibleMenus().length === 0 && btn) {
          fireRealishClick(btn);
          const openDeadline = Date.now() + 1400;
          while (getVisibleMenus().length === 0 && Date.now() < openDeadline) {
            await sleep(100);
          }
        } else if (a.collectOnly) {
          const waitDeadline = Date.now() + 1800;
          while (getVisibleMenus().length === 0 && Date.now() < waitDeadline) {
            await sleep(100);
          }
        }

        const menus = getVisibleMenus();
        for (const m of menus) {
          const subs = Array.from(m.querySelectorAll('[role="menuitem"][aria-haspopup="menu"],[role="menuitem"][aria-haspopup="true"],[role="menuitem"][aria-haspopup="listbox"],[aria-haspopup="menu"],[aria-haspopup="true"],[aria-haspopup="listbox"]')).filter(function(el) {
            if (!visible(el)) return false;
            const role = typeof el.getAttribute === 'function' ? el.getAttribute('role') : null;
            return role !== 'menuitemradio' && role !== 'option' && role !== 'radio';
          });
          for (const s of subs) {
            if (typeof s.dispatchEvent === 'function' && typeof MouseEvent === 'function') {
              try { s.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true })); } catch (_) {}
            }
            if (typeof s.click === 'function') { s.click(); await sleep(250); }
          }
        }

        const allMenus = getVisibleMenus();
        const options = [];
        const seen = new Set();
        for (const m of allMenus) {
          for (const el of Array.from(m.querySelectorAll(optionSelector))) {
            if (seen.has(el) || !visible(el) || el === btn) continue;
            seen.add(el);
            const popup = el.getAttribute ? el.getAttribute('aria-haspopup') : null;
            if (popup === 'menu' || popup === 'true' || popup === 'listbox') continue;
            const rawCombined = text(el);
            if (rawCombined.length <= 1 || rawCombined.length >= 260 || /\b(dark\s*mode|light\s*mode|theme|sidebar|settings|cookie)\b/i.test(rawCombined)) continue;
            const parsed = cleanOptionLabel(el);
            if (!parsed.shortLabel || parsed.shortLabel.length < 2) continue;
            if (!options.some(function(o) { return (o.shortLabel || o.label).toLowerCase() === parsed.shortLabel.toLowerCase(); })) {
              options.push({
                label: parsed.label,
                shortLabel: parsed.shortLabel,
                selected: isControlActive(el)
              });
            }
          }
        }

        if (a.closeAfter !== false && (options.length > 0 || a.forceClose)) {
          try { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true })); } catch (_) {}
        }
        return {
          ok: true,
          active: activeLabel,
          options: options,
          debug: { menuCount: allMenus.length }
        };
      }, arg).catch(function(err) {
        return { ok: false, reason: String(err && err.message || err), active: '', options: [] };
      });
    };

    let res = await collectFromTarget(targetFrame, { collectOnly: false, closeAfter: false });
    if (res && res.ok && (!res.options || res.options.length === 0) && typeof targetFrame.locator === 'function') {
      try {
        await targetFrame.locator('[data-ag-model-trigger="1"]').first().click({ timeout: 5000 });
        await new Promise(function(r) { setTimeout(r, 700); });
        res = await collectFromTarget(targetFrame, { collectOnly: true, closeAfter: true, forceClose: true });
        if ((!res.options || res.options.length === 0) && typeof targetFrame.page === 'function') {
          const parentPage = targetFrame.page();
          if (parentPage && parentPage !== targetFrame) {
            const pageRes = await collectFromTarget(parentPage, { collectOnly: true, closeAfter: true, forceClose: true });
            if (pageRes && pageRes.options && pageRes.options.length > 0) {
              pageRes.active = res.active || pageRes.active;
              res = pageRes;
            }
          }
        }
      } catch (_) {}
    } else if (res && res.ok && res.options && res.options.length > 0) {
      await targetFrame.evaluate(function() {
        try { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true })); } catch (_) {}
      }).catch(function() {});
    }
    return res;
  }

  async function ensureCopilotGpt56Model(targetFrame, tabKey, opts) {
    opts = opts || {};
    const contract = opts.contract || buildCopilotLockContract(tabKey, COPILOT_REQUIRED_MODEL, opts.locksPath);
    if (tabKey && copilotModelReceipts) copilotModelReceipts[tabKey] = null;
    const evaluateEnsure = async function() {
      return await targetFrame.evaluate(async function(req) {
      const sleep = function(ms) {
        return new Promise(function(resolve) { setTimeout(resolve, ms); });
      };
      const visible = function(el) {
        if (!el || el.isConnected === false) return false;
        const s = getComputedStyle(el), r = el.getBoundingClientRect();
        return s.display !== 'none' && s.visibility !== 'hidden' && parseFloat(s.opacity || '1') > 0.05 && r.width > 4 && r.height > 4;
      };
      const text = function(el) {
        return (
          ((el && el.innerText) || '') + ' ' +
          ((el && typeof el.getAttribute === 'function' && el.getAttribute('aria-label')) || '') + ' ' +
          ((el && typeof el.getAttribute === 'function' && el.getAttribute('title')) || '')
        ).replace(/\s+/g, ' ').trim();
      };
      const selectors = 'button[aria-label*="model" i],button[aria-label*="mode" i],[data-testid*="model-switcher" i],[data-testid*="mode-selector" i],.fui-Dropdown';
      const menuSelector = '.fui-MenuPopover, .fui-PopoverSurface, [role="menu"], [role="listbox"], [role="dialog"], [role="radiogroup"], .fui-MenuList, [data-popper-placement], [class*="MenuPopover" i], [class*="PopoverSurface" i]';
      const optionSelector = '[role="option"],[role="menuitemradio"],[role="menuitem"],[role="menuitemcheckbox"],[role="radio"],.fui-MenuItem,.fui-Option,[data-testid*="gptSubMenuModelTrigger-"],[data-testid*="model" i] button,button,[role="button"]';
      const submenuTriggerSelector = '[role="menuitem"][aria-haspopup="menu"],[role="menuitem"][aria-haspopup="true"],[role="menuitem"][aria-haspopup="listbox"],[aria-haspopup="menu"],[aria-haspopup="true"],[aria-haspopup="listbox"]';
      const isExcludedControl = function(val) {
        return /\b(dark\s*mode|light\s*mode|color\s*mode|theme|sidebar|navigation|history|voice|microphone|dictate|attach|upload|settings|cookie)\b/i.test(String(val || ''));
      };
      const isForbiddenWeakModel = function(val) {
        const lower = String(val || '').toLowerCase();
        return /\b(auto|quick(\s*response)?|fast|flash|lite|nano|mini|low|basic|standard|gpt-4|gpt-4o|gpt-3\.5)\b/i.test(lower);
      };
      const requiredModelVisible = function(val) {
        const lower = String(val || '').toLowerCase();
        return (lower.includes('gpt-5.6') || lower.includes('5.6 sol think') || lower.includes('sol think')) && !isForbiddenWeakModel(lower);
      };
      const isDeepReasoningLabel = function(val) {
        const lower = String(val || '').toLowerCase();
        const targetLabel = String((req && req.reasoningLabel) || 'think deeper').toLowerCase();
        return (lower.includes(targetLabel) || /\bdeep\b|think\s*deeper|extra\s*thorough|\bhigh\b/i.test(lower)) && !isForbiddenWeakModel(lower);
      };
      const isControlActive = function(el) {
        if (!el) return false;
        const getAttr = function(name) { return typeof el.getAttribute === 'function' ? el.getAttribute(name) : null; };
        if (
          getAttr('aria-pressed') === 'true' ||
          getAttr('aria-checked') === 'true' ||
          getAttr('aria-selected') === 'true' ||
          getAttr('data-checked') === 'true' ||
          getAttr('data-state') === 'checked'
        ) return true;
        if (el.classList && (
          el.classList.contains('active') ||
          el.classList.contains('is-active') ||
          el.classList.contains('is-checked') ||
          el.classList.contains('fui-MenuItem--selected')
        )) return true;
        if (typeof el.querySelector === 'function' && el.querySelector('input:checked')) return true;
        if (typeof el.querySelectorAll === 'function') {
          const hasCheckIcon = Array.from(el.querySelectorAll('svg,[class*="check" i],[data-icon*="check" i],[aria-label*="check" i],[aria-label*="selected" i]')).some(function(icon) {
            if (!visible(icon)) return false;
            const id = (
              ((typeof icon.getAttribute === 'function' && icon.getAttribute('aria-label')) || '') + ' ' +
              ((typeof icon.getAttribute === 'function' && icon.getAttribute('data-icon')) || '') + ' ' +
              String(icon.className || '')
            ).toLowerCase();
            return /(check|checkmark|tick|selected)/.test(id);
          });
          if (hasCheckIcon) return true;
        }
        return false;
      };
      const hasDeepReasoningSignal = function(val) {
        if (isDeepReasoningLabel(val)) return true;
        return Array.from(document.querySelectorAll('button,[role="switch"],[role="menuitemradio"],[role="option"]')).filter(visible).some(function(el) {
          const t = text(el);
          return !isExcludedControl(t) && !isForbiddenWeakModel(t) && isControlActive(el) && isDeepReasoningLabel(t);
        });
      };
      const isLikelyModelControl = function(el) {
        if (!visible(el)) return false;
        if (typeof el.closest === 'function' && el.closest('[role="menu"],[role="listbox"],.fui-MenuPopover')) return false;
        const t = text(el);
        if (!t || isExcludedControl(t)) return false;
        if (typeof el.matches === 'function' && el.matches('[data-testid*="model-switcher" i],[data-testid*="mode-selector" i],button[aria-label*="model" i]')) return true;
        return /\b(gpt-5\.6|sol\s*think|think\s*deeper|quick\s*response|auto|model|smart|study)\b/i.test(t);
      };
      const getModelButton = function() {
        const direct = Array.from(document.querySelectorAll(selectors)).filter(visible).find(isLikelyModelControl);
        if (direct) return direct;
        return Array.from(document.querySelectorAll('button')).filter(visible).find(function(el) {
          if (typeof el.closest === 'function' && el.closest('[role="menu"],[role="listbox"],.fui-MenuPopover')) return false;
          const t = text(el);
          return !isExcludedControl(t) && /gpt-5\.6|sol\s*think|think\s*deeper|model|gpt|auto|quick/i.test(t);
        }) || null;
      };
      const getVisibleMenus = function() {
        return Array.from(document.querySelectorAll(menuSelector)).filter(function(el) {
          if (!visible(el)) return false;
          if (typeof el.querySelectorAll === 'function' && el.querySelectorAll('[role="option"],[role="menuitemradio"],[role="menuitem"],[role="menuitemcheckbox"],.fui-MenuItem,.fui-Option,[data-testid*="gptSubMenuModelTrigger"]').length > 0) return true;
          return /\b(gpt-5\.6|sol\s*think|think\s*deeper|quick\s*response|auto|model|gpt|smart|study)\b/i.test(text(el));
        });
      };
      const closeMenus = async function() {
        const fireEscape = function(target) {
          if (!target || typeof target.dispatchEvent !== 'function') return;
          if (typeof KeyboardEvent === 'function') {
            target.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true }));
          } else {
            target.dispatchEvent({ type: 'keydown', key: 'Escape', code: 'Escape', bubbles: true });
          }
        };
        const deadline = Date.now() + 600;
        while (getVisibleMenus().length > 0 && Date.now() <= deadline) {
          if (document.activeElement) fireEscape(document.activeElement);
          fireEscape(document);
          Array.from(document.querySelectorAll('.cdk-overlay-backdrop')).filter(visible).forEach(function(b) {
            if (typeof b.click === 'function') b.click();
          });
          if (getVisibleMenus().length === 0) break;
          await sleep(100);
        }
      };
      const openModelMenuOnce = async function(btn) {
        const existing = getVisibleMenus();
        if (existing.length > 0) return existing;
        if (btn && typeof btn.setAttribute === 'function') btn.setAttribute('data-ag-model-trigger', '1');
        if (btn && typeof btn.click === 'function') btn.click();
        const deadline = Date.now() + 2500;
        while (Date.now() <= deadline) {
          const opened = getVisibleMenus();
          if (opened.length > 0) return opened;
          await sleep(100);
        }
        return getVisibleMenus();
      };
      const expandSubmenus = async function(menus) {
        const seenTriggers = new Set();
        for (const menu of (menus || [])) {
          if (!menu || typeof menu.querySelectorAll !== 'function') continue;
          const triggers = Array.from(menu.querySelectorAll(submenuTriggerSelector)).filter(visible);
          for (const sub of triggers) {
            if (seenTriggers.has(sub)) continue;
            seenTriggers.add(sub);
            const beforeCount = getVisibleMenus().length;
            try {
              if (typeof sub.dispatchEvent === 'function') {
                sub.dispatchEvent(typeof MouseEvent === 'function' ? new MouseEvent('mouseenter', { bubbles: true }) : { type: 'mouseenter', bubbles: true });
                sub.dispatchEvent(typeof PointerEvent === 'function' ? new PointerEvent('pointerover', { bubbles: true }) : { type: 'pointerover', bubbles: true });
              }
            } catch (_) {}
            await sleep(250);
            if (getVisibleMenus().length <= beforeCount && typeof sub.click === 'function') {
              sub.click();
              await sleep(300);
            }
          }
        }
        return getVisibleMenus();
      };
      const collectMenuOptions = function(menus) {
        const unique = [];
        const seen = new Set();
        for (const menu of (menus || [])) {
          if (!menu || typeof menu.querySelectorAll !== 'function') continue;
          const items = Array.from(menu.querySelectorAll(optionSelector));
          for (const el of items) {
            if (seen.has(el) || !visible(el)) continue;
            seen.add(el);
            const popup = typeof el.getAttribute === 'function' ? el.getAttribute('aria-haspopup') : null;
            if (popup === 'menu' || popup === 'true' || popup === 'listbox') continue;
            const t = text(el);
            if (t.length <= 2 || t.length >= 260 || isExcludedControl(t)) continue;
            unique.push(el);
          }
        }
        return unique;
      };

      let button = getModelButton();
      if (req.customLocked) {
        const want = String(req.modelLabel || '').toLowerCase().trim();
        const curText = button ? text(button).toLowerCase() : '';
        if (button && want && curText.includes(want)) {
          return { ok: true, active: text(button), reasoningLocked: true, customLocked: true };
        }
        if (!button) {
          return { ok: false, reason: 'COPILOT_REQUIRED_MODEL_NOT_ACTIVE', active: 'missing', reasoningLocked: false };
        }
        const menus = await expandSubmenus(await openModelMenuOnce(button));
        const options = collectMenuOptions(menus);
        const available = options.map(function(o) { return text(o); }).filter(Boolean).slice(0, 25);
        const match = options.find(function(el) {
          const v = text(el).toLowerCase();
          return v === want || v.includes(want);
        }) || null;
        if (!match) {
          await closeMenus();
          return { ok: false, reason: 'COPILOT_USER_LOCKED_MODEL_UNAVAILABLE', active: text(button), available: available, hasMenu: menus.length > 0, reasoningLocked: false };
        }
        if (!isControlActive(match) && typeof match.click === 'function') {
          if (typeof match.setAttribute === 'function') match.setAttribute('data-ag-model-option', '1');
          match.click();
          await sleep(450);
        }
        await closeMenus();
        const finalBtn = getModelButton() || button;
        const finalTxt = finalBtn ? text(finalBtn) : '';
        return {
          ok: true,
          active: finalTxt || req.modelLabel,
          needsPlaywrightOptionClick: Boolean(want && !finalTxt.toLowerCase().includes(want)),
          reasoningLocked: true,
          customLocked: true
        };
      }
      if (button && requiredModelVisible(text(button)) && hasDeepReasoningSignal(text(button)) && !isForbiddenWeakModel(text(button))) {
        return { ok: true, active: text(button), reasoningLocked: true };
      }
      if (!button) {
        return { ok: false, reason: 'COPILOT_REQUIRED_MODEL_NOT_ACTIVE', active: 'missing', reasoningLocked: false };
      }

      const menus = await expandSubmenus(await openModelMenuOnce(button));
      const options = collectMenuOptions(menus);
      const available = options.map(function(o) { return text(o); }).filter(Boolean).slice(0, 25);
      const nonWeakOptions = options.filter(function(el) { return !isForbiddenWeakModel(text(el)); });
      const modelOption =
        nonWeakOptions.find(function(el) {
          const v = text(el).toLowerCase();
          return v.includes('gpt-5.6') && v.includes('sol think') && v.includes('think deeper');
        }) ||
        nonWeakOptions.find(function(el) {
          const v = text(el).toLowerCase();
          return v.includes('gpt-5.6') && v.includes('sol think');
        }) ||
        nonWeakOptions.find(function(el) {
          const v = text(el).toLowerCase();
          return v.includes(req.modelLabel.toLowerCase()) || v.includes('5.6 sol think') || v.includes('sol think');
        }) || null;

      let activeOption = modelOption;
      let usingThinkDeeperFallback = false;
      if (!activeOption && req.allowThinkDeeperFallback) {
        // Microsoft global incident (2026-11-24): GPT-5.6 Sol absent from menu; select Think deeper (excluding weak models).
        activeOption = nonWeakOptions.find(function(el) {
          return isDeepReasoningLabel(text(el));
        }) || null;
        if (activeOption) {
          usingThinkDeeperFallback = true;
        } else if (hasDeepReasoningSignal(text(button)) && !isForbiddenWeakModel(text(button))) {
          usingThinkDeeperFallback = true;
        }
      }

      if (!activeOption && !usingThinkDeeperFallback) {
        await closeMenus();
        return { ok: false, reason: 'COPILOT_REQUIRED_MODEL_UNAVAILABLE', active: text(button), available: available, hasMenu: menus.length > 0, reasoningLocked: false };
      }

      const selectedModelWasCombined = activeOption ? isDeepReasoningLabel(text(activeOption)) : usingThinkDeeperFallback;
      if (activeOption && !isControlActive(activeOption) && typeof activeOption.click === 'function') {
        activeOption.click();
        await sleep(450);
      }

      button = getModelButton() || button;
      if (!selectedModelWasCombined && !hasDeepReasoningSignal(text(button))) {
        let reasoningEl = Array.from(document.querySelectorAll('button,[role="switch"],[role="option"],[role="menuitemradio"],[role="menuitem"]')).filter(function(el) {
          if (el === button || !visible(el)) return false;
          if (typeof el.closest === 'function' && el.closest('[role="menu"],[role="listbox"],.fui-MenuPopover')) return false;
          const t = text(el);
          return !isExcludedControl(t) && !isForbiddenWeakModel(t) && isDeepReasoningLabel(t);
        })[0] || null;
        if (!reasoningEl) {
          const rMenus = await expandSubmenus(await openModelMenuOnce(button));
          const rOptions = collectMenuOptions(rMenus);
          reasoningEl = rOptions.find(function(el) {
            const t = text(el);
            return !isExcludedControl(t) && !isForbiddenWeakModel(t) && isDeepReasoningLabel(t);
          }) || null;
        }
        if (reasoningEl && !isControlActive(reasoningEl) && typeof reasoningEl.click === 'function') {
          reasoningEl.click();
          await sleep(350);
        }
      }
      await closeMenus();

      const finalButton = getModelButton() || (button && visible(button) && isLikelyModelControl(button) ? button : null) || button;
      const finalActive = finalButton ? text(finalButton) : '';
      if (isForbiddenWeakModel(finalActive)) {
        return { ok: false, reason: 'COPILOT_REQUIRED_MODEL_NOT_ACTIVE', active: finalActive, reasoningLocked: false };
      }

      const pillHasModel = requiredModelVisible(finalActive);
      const pillHasDeep = hasDeepReasoningSignal(finalActive);
      let menuHasForbiddenChecked = false;
      let menuHasModel = false;
      let menuHasDeep = false;
      if (!(pillHasModel && pillHasDeep) && !(usingThinkDeeperFallback && pillHasDeep) && finalButton) {
        const verifyMenus = await expandSubmenus(await openModelMenuOnce(finalButton));
        const verifyOptions = collectMenuOptions(verifyMenus);
        verifyOptions.forEach(function(opt) {
          if (!isControlActive(opt)) return;
          const ot = text(opt);
          if (isForbiddenWeakModel(ot)) menuHasForbiddenChecked = true;
          if (requiredModelVisible(ot)) menuHasModel = true;
          if (isDeepReasoningLabel(ot)) menuHasDeep = true;
        });
        if (!menuHasDeep && hasDeepReasoningSignal('')) menuHasDeep = true;
        await closeMenus();
      }

      const modelVerified = !menuHasForbiddenChecked && (pillHasModel || menuHasModel || (req.allowThinkDeeperFallback && (pillHasDeep || menuHasDeep)));
      const reasoningVerified = !menuHasForbiddenChecked && (pillHasDeep || menuHasDeep);
      if (!modelVerified) {
        return { ok: false, reason: 'COPILOT_REQUIRED_MODEL_NOT_ACTIVE', active: finalActive || 'missing', reasoningLocked: reasoningVerified };
      }
      if (!reasoningVerified) {
        return { ok: false, reason: 'COPILOT_REASONING_NOT_DEEP', active: finalActive, reasoningLocked: false };
      }
      return {
        ok: true,
        active: finalActive || (usingThinkDeeperFallback ? 'Think deeper (GPT-5.6 Sol temporarily unavailable)' : req.displayLabel),
        reasoningLocked: true,
        fallbackUsed: Boolean(usingThinkDeeperFallback && !(pillHasModel || menuHasModel))
      };
      }, contract);
    };
    let result = await evaluateEnsure();
    if (typeof targetFrame.locator === 'function') {
      if ((!result || !result.ok) && result && result.hasMenu === false) {
        try {
          await targetFrame.locator('[data-ag-model-trigger="1"]').first().click({ timeout: 5000 });
          await new Promise(function(r) { setTimeout(r, 700); });
          result = await evaluateEnsure();
        } catch (_) {}
      }
      if (result && result.ok && result.needsPlaywrightOptionClick) {
        try {
          await targetFrame.locator('[data-ag-model-trigger="1"]').first().click({ timeout: 5000 });
          await new Promise(function(r) { setTimeout(r, 500); });
          if (await targetFrame.locator('[data-ag-model-option="1"]').count() > 0) {
            await targetFrame.locator('[data-ag-model-option="1"]').first().click({ timeout: 5000 });
            await new Promise(function(r) { setTimeout(r, 600); });
            result = await evaluateEnsure();
          }
        } catch (_) {}
      }
    }

    if (!result || !result.ok || result.reasoningLocked === false) {
      const availInfo = Array.isArray(result && result.available) && result.available.length ? (', available: [' + result.available.join(' | ') + ']') : '';
      const reason = (result && result.reason) || (result && result.reasoningLocked === false ? 'COPILOT_REASONING_NOT_DEEP' : 'COPILOT_REQUIRED_MODEL_NOT_ACTIVE');
      throw new Error('COPILOT_MODEL_LOCK_FAILED: ' + reason + ' (active: ' + ((result && result.active) || 'unknown') + availInfo + ')');
    }
    const resolvedDisplay = result.fallbackUsed ? 'Think deeper (GPT-5.6 Sol disabled 2026-11-24)' : contract.displayLabel;
    if (tabKey) {
      tabActiveModel[tabKey] = resolvedDisplay;
      tabDiscoveredModels[tabKey] = result.active || resolvedDisplay;
      if (copilotModelReceipts) {
        copilotModelReceipts[tabKey] = {
          verified: true,
          family: contract.family,
          observedLabel: result.active || resolvedDisplay,
          reasoningLocked: true,
          gpt56TemporarilyUnavailable: Boolean(result.fallbackUsed)
        };
      }
    }
    return resolvedDisplay;
  }

  return {
    findChatFrameOrPage,
    checkAuthExpired: checkAuth,
    discoverCopilotLiveOptions,
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
          const label = normalize((el.getAttribute('aria-label') || '') + ' ' + (el.getAttribute('title') || '') + ' ' + (el.innerText || el.textContent || '') + ' ' + (el.getAttribute('data-testid') || ''));
          return /temporary chat|private chat|off the record|incognito|don't save history|mos ruaj|përkohshme/i.test(label);
        }) || null;

      const ariaPressed = toggleControl ? toggleControl.getAttribute('aria-pressed') : null;
      const ariaChecked = toggleControl ? toggleControl.getAttribute('aria-checked') : null;
      const controlLabel = toggleControl
        ? String(toggleControl.getAttribute('aria-label') || toggleControl.getAttribute('title') || toggleControl.innerText || toggleControl.getAttribute('data-testid') || '').trim().slice(0, 120)
        : '';

      const controlActive = Boolean(
        toggleControl && (
          ariaPressed === 'true' ||
          ariaChecked === 'true' ||
          toggleControl.getAttribute('aria-selected') === 'true' ||
          toggleControl.getAttribute('data-checked') === 'true' ||
          toggleControl.checked === true ||
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
          return t.length > 0 && t.length <= 320 &&
            (t.includes('temporary chat') || t.includes('private chat') || t.includes('bisedë e përkohshme')) &&
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
        const label = normalize((el.getAttribute('aria-label') || '') + ' ' + (el.getAttribute('title') || '') + ' ' + (el.innerText || el.textContent || '') + ' ' + (el.getAttribute('data-testid') || ''));
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
  inspectLiveAuthState,
  checkAuthExpired,
  buildCopilotPromptWithContract,
  COPILOT_TEMP_CHAT_ALLOWLIST,
  inspectCopilotTemporaryChatDom,
  ensureCopilotTemporaryChat
};
