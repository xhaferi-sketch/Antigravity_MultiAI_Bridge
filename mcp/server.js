const { Server } = require('@modelcontextprotocol/sdk/server/index.js');
const { StdioServerTransport } = require('@modelcontextprotocol/sdk/server/stdio.js');
const { CallToolRequestSchema, ListToolsRequestSchema } = require('@modelcontextprotocol/sdk/types.js');
const { chromium } = require('playwright');
const AdmZip = require('adm-zip');
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execSync, spawnSync } = require('child_process');

const PORT = 4321;
const HOST = '127.0.0.1';
const PLUGIN_ROOT = path.resolve(__dirname, '..');
const PROFILES_DIR = path.join(PLUGIN_ROOT, '.profiles');
const REGISTRY_PATH = path.join(PLUGIN_ROOT, 'projects_registry.json');
const SCORES_PATH = path.join(__dirname, 'model_scores.json');
const NL = String.fromCharCode(10);
const FENCE3 = String.fromCharCode(96, 96, 96);

function normalizeGeneratedSourceText(value) {
  return String(value ?? '')
    .replace(/\u00a0/g, ' ')
    .replace(/\r\n?/g, '\n');
}

function findUnsafeGeneratedSourceCharacters(value) {
  const matches = [];
  const pattern = /[\u2007\u202f\ufeff]/g;
  let match;
  while ((match = pattern.exec(String(value ?? ''))) !== null) {
    matches.push({
      index: match.index,
      codePoint: 'U+' + match[0].codePointAt(0).toString(16).toUpperCase().padStart(4, '0')
    });
  }
  return matches;
}
const COPILOT_REQUIRED_MODEL = Object.freeze({ family: 'gpt-5.6-sol-think', modelLabel: 'GPT-5.6 Sol Think', reasoningLabel: 'Think deeper', reasoning: 'high' });
const COPILOT_OUTPUT_CONTRACT = ['OUTPUT CONTRACT — MANDATORY','Return ONLY the authorized target files.','FILE: relative/path.ext',FENCE3+'language','<complete file content>',FENCE3,'Rules: Opening and closing triple backticks are mandatory. No prose. No diffs.'].join(NL);

const GEMINI_APP_URL = 'https://' + 'gemini.' + 'google.com' + '/app';
const GEMINI_REQUIRED_MODEL = Object.freeze({
  family: 'neon',
  menuPattern: '4\\s*neon',
  activePattern: '(?:^|\\b)neon(?:\\b|$)',
  menuLabel: 'Deeper analysis (4 Neon)',
  modelLabel: '4 Neon',
  displayLabel: 'Neon',
  reasoning: 'high',
  reasoningSource: 'integrated-model-mode'
});

const geminiModelReceipts = {
  gemini1: null,
  gemini2: null,
  gemini3: null
};

function invalidateGeminiReceipt(tabKey) {
  if (tabKey && geminiModelReceipts.hasOwnProperty(tabKey)) {
    geminiModelReceipts[tabKey] = null;
  }
}
const M365_CHAT_URL = 'https://' + 'm365.cloud.' + 'microsoft/chat';
const LOGIN_GOOGLE = 'accounts.' + 'google.com';
const LOGIN_MS = 'microsoft' + 'online.com';
const LOGIN_LIVE = 'login.' + 'live.com';

if (!fs.existsSync(PROFILES_DIR)) fs.mkdirSync(PROFILES_DIR, { recursive: true });
if (!fs.existsSync(REGISTRY_PATH)) fs.writeFileSync(REGISTRY_PATH, JSON.stringify({ projects: [] }, null, 2));

const contexts = {};
const contextModes = {};
const tabs = {
  web1: null, web2: null,
  gemini1: null, gemini2: null, gemini3: null,
  google_search_1: null, google_search_2: null, google_search_3: null
};
const tabAuthStatus = {
  web1: 'UNKNOWN', web2: 'UNKNOWN',
  gemini1: 'UNKNOWN', gemini2: 'UNKNOWN', gemini3: 'UNKNOWN',
  google_search_1: 'UNKNOWN', google_search_2: 'UNKNOWN', google_search_3: 'UNKNOWN'
};
const tabActiveModel = {
  web1: '-', web2: '-',
  gemini1: '-', gemini2: '-', gemini3: '-',
  google_search_1: '4 Hydrogen · Everyday help & 4 Carbon · Most complex work',
  google_search_2: '4 Hydrogen · Everyday help & 4 Carbon · Most complex work',
  google_search_3: '4 Hydrogen · Everyday help & 4 Carbon · Most complex work'
};
const tabDiscoveredModels = {
  web1: '-', web2: '-',
  gemini1: '-', gemini2: '-', gemini3: '-',
  google_search_1: '4 Hydrogen · Everyday help, 4 Carbon · Most complex work',
  google_search_2: '4 Hydrogen · Everyday help, 4 Carbon · Most complex work',
  google_search_3: '4 Hydrogen · Everyday help, 4 Carbon · Most complex work'
};
const activeProjectPerTab = {};
const tabLocks = {
  web1: Promise.resolve(),
  web2: Promise.resolve(),
  gemini1: Promise.resolve(),
  gemini2: Promise.resolve(),
  gemini3: Promise.resolve(),
  google_search_1: Promise.resolve(),
  google_search_2: Promise.resolve(),
  google_search_3: Promise.resolve()
};

function withTabLock(tabKey, fn) {
  const prev = tabLocks[tabKey] || Promise.resolve();
  let release;
  tabLocks[tabKey] = new Promise(function(r) { release = r; });
  return prev.then(function() { return fn(); }).finally(function() { release(); });
}

const GOOGLE_SEARCH_AI_URL = 'https://www.google.com/ai';

function getProfileNameForTab(tabKey) {
  if (tabKey.startsWith('web')) return 'm365';
  if (tabKey.startsWith('google_search_')) {
    const num = tabKey.replace('google_search_', '');
    return 'gemini' + num;
  }
  return tabKey;
}

function getTargetUrl(tabKey) {
  if (tabKey.startsWith('google_search_')) return GOOGLE_SEARCH_AI_URL;
  return tabKey.startsWith('gemini') ? GEMINI_APP_URL : M365_CHAT_URL;
}

async function getOrLaunchContext(profileName, headless) {
  if (headless === undefined) headless = false;
  // Nëse konteksti ekziston tashmë (i hapur nga përdoruesi me 'Hap Dritaren' ose nga agjenti), PËRDORE MENJËHERË dhe mos e mbyll kurrë!
  if (contexts[profileName]) {
    try {
      const openPages = contexts[profileName].pages();
      if (openPages.length > 0 && !openPages[0].isClosed()) {
        return contexts[profileName];
      }
    } catch (_) {}
  }

  const userDataDir = path.join(PROFILES_DIR, profileName);
  if (!fs.existsSync(userDataDir)) fs.mkdirSync(userDataDir, { recursive: true });

  const launchArgs = [
    '--disable-blink-features=AutomationControlled',
    '--disable-gpu',
    '--disable-dev-shm-usage',
    '--mute-audio',
    '--no-first-run',
    '--no-default-browser-check',
    '--start-maximized',
    '--window-position=50,50'
  ];

  const ctx = await chromium.launchPersistentContext(userDataDir, {
    channel: 'chrome',
    headless: false,
    viewport: null,
    userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36',
    args: launchArgs,
    ignoreDefaultArgs: ['--enable-automation', '--password-store=basic', '--use-mock-keychain']
  });

  ctx.on('close', function() {
    delete contexts[profileName];
    delete contextModes[profileName];
    for (const k of Object.keys(tabs)) {
      if (getProfileNameForTab(k) === profileName) tabs[k] = null;
    }
  });

  contexts[profileName] = ctx;
  contextModes[profileName] = 'visible';
  return ctx;
}

function doesUrlMatchEngine(tabKey,url){
  try{const u=new URL(String(url||'')),host=u.hostname.toLowerCase(),pathname=u.pathname.toLowerCase();if(tabKey.startsWith('gemini'))return host==='gemini.google.com';if(tabKey.startsWith('google_search_'))return /(^|\.)google\.com$/.test(host)&&(/^\/search/.test(pathname)||/^\/ai(?:mode)?(?:\/|$)/.test(pathname));if(tabKey.startsWith('web')||tabKey.startsWith('m365'))return host==='copilot.cloud.microsoft'||host==='m365.cloud.microsoft'||host.endsWith('.microsoft365.com')||host==='microsoft365.com'||host==='copilot.microsoft.com';return false;}catch(_){return false;}
}
async function getOrCreateTab(tabKey) {
  const profileName = getProfileNameForTab(tabKey);
  if(tabs[tabKey]&&!tabs[tabKey].isClosed()){if(doesUrlMatchEngine(tabKey,tabs[tabKey].url()))return tabs[tabKey];try{const u=new URL(tabs[tabKey].url());console.error('[TAB_DOMAIN_MISMATCH] tabKey='+tabKey+' host='+u.hostname+' path='+u.pathname);}catch(_){console.error('[TAB_DOMAIN_MISMATCH] tabKey='+tabKey+' host=invalid path=invalid');}await tabs[tabKey].goto(getTargetUrl(tabKey),{waitUntil:'domcontentloaded',timeout:45000});await tabs[tabKey].waitForTimeout(1500);tabActiveModel[tabKey]='UNKNOWN';return tabs[tabKey];}

  const ctx = await getOrLaunchContext(profileName, false);
  const isSearch = tabKey.startsWith('google_search_');
  const targetUrl = getTargetUrl(tabKey);
  const domain = targetUrl.replace('https://', '').split('/')[0];

  let page = null;
  const existingPages = ctx.pages();
  for (const p of existingPages) {
    if (p.isClosed()) continue;
    const pu = p.url() || '';
    if (isSearch && (pu.includes('google.com/search') || pu.includes('google.com/ai') || pu.includes('google.com/aimode')) && !Object.entries(tabs).some(([k, t]) => t === p && k !== tabKey)) {
      page = p;
      break;
    } else if (!isSearch && pu.includes(domain) && !Object.entries(tabs).some(([k, t]) => t === p && k !== tabKey)) {
      page = p;
      break;
    }
  }

  if (!page) {
    page = (existingPages.length > 0 && !Object.values(tabs).includes(existingPages[0]))
      ? existingPages[0]
      : await ctx.newPage();
  }

  if (isSearch) {
    const isSearchAiPage = page.url().includes('google.com/search') || page.url().includes('google.com/ai') || page.url().includes('google.com/aimode');
    if (!isSearchAiPage) {
      await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 45000 });
      await page.waitForTimeout(2000);
    }
  } else if (!page.url().includes(domain)) {
    await page.goto(targetUrl, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await page.waitForTimeout(1500);
  }

  if(!doesUrlMatchEngine(tabKey,page.url())){try{const u=new URL(page.url());console.error('[TAB_DOMAIN_MISMATCH] tabKey='+tabKey+' host='+u.hostname+' path='+u.pathname);}catch(_){}await page.goto(targetUrl,{waitUntil:'domcontentloaded',timeout:45000});await page.waitForTimeout(isSearch?2000:1500);tabActiveModel[tabKey]='UNKNOWN';}
  tabs[tabKey]=page;
  return page;
}

function findChatFrameOrPage(page) {
  for (const frame of page.frames()) {
    const fu = (frame.url() || '').toLowerCase();
    if (fu.includes('copilot') || fu.includes('office') || fu.includes('m365')) {
      return frame;
    }
  }
  return page;
}

async function captureSupportEvidence(page, projectRoot, tabKey, stage, reason) {
  let shotPath = null;
  try {
    const exDir = path.join(path.resolve(projectRoot), '.antigravity', 'bridge', 'exchange');
    if (!fs.existsSync(exDir)) fs.mkdirSync(exDir, { recursive: true });
    shotPath = path.join(exDir, 'support_' + tabKey + '_' + Date.now() + '.png');
    if (page && !page.isClosed()) {
      await page.screenshot({ path: shotPath, fullPage: false });
    }
  } catch (_) {}
  const msg = [
    'SUPPORT_REQUIRED_STOP_IMMEDIATELY',
    'MOTORI: ' + tabKey,
    'FAZA: ' + stage,
    'ARSYEJA: ' + reason,
    shotPath ? ('SCREENSHOT: ' + shotPath) : 'SCREENSHOT: N/A'
  ].join(' | ');
  throw new Error(msg);
}

async function checkAuthExpired(page, tabKey) {
  for (let i = 0; i < 15; i++) {
    const u = page.url().toLowerCase();
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
        await page.waitForTimeout(800);
        tabAuthStatus[tabKey] = 'ACTIVE';
        return false;
      }
    }
    await page.waitForTimeout(1000);
  }
  tabAuthStatus[tabKey] = 'AUTH_EXPIRED';
  return true;
}

async function ensureMaxReasoningMode(targetFrame, tabKey, opts) {
    opts=opts||{};
  if (tabKey.startsWith('gemini')) {
    invalidateGeminiReceipt(tabKey);

    const receipt = await targetFrame.evaluate(async function(required) {
      const sleep = function(ms) { return new Promise(function(r) { setTimeout(r, ms); }); };
      const normalize = function(s) { return String(s || '').toLowerCase().replace(/\s+/g, ' ').trim(); };
      const actionable = function(el) {
        if (!el) return false;
        const st = window.getComputedStyle(el);
        const r = el.getBoundingClientRect();
        return st.display !== 'none' && st.visibility !== 'hidden' && r.width > 3 && r.height > 3;
      };

      const menuRe = new RegExp(required.menuPattern, 'i');
      const activeRe = new RegExp(required.activePattern, 'i');

      const findTrigger = function() {
        const candidates = Array.from(document.querySelectorAll('button, [role="button"], [role="combobox"]'))
          .filter(actionable);
        return candidates.find(function(el) {
          const txt = normalize((el.innerText || '') + ' ' + (el.getAttribute('aria-label') || ''));
          return /currently neon|open mode picker|neon|4 neon|mode picker|deeper analysis/i.test(txt);
        }) || null;
      };

      const readTriggerState = function(trigger) {
        const text = String(trigger ? (trigger.innerText || '') : '').trim();
        const aria = String(trigger ? (trigger.getAttribute('aria-label') || '') : '').trim();
        const combined = normalize(text + ' ' + aria);
        return {
          text: text,
          aria: aria,
          active: activeRe.test(combined) || /currently neon/i.test(aria)
        };
      };

      let trigger = findTrigger();
      if (!trigger) return { ok: false, code: 'MODEL_TRIGGER_TIMEOUT' };

      let state = readTriggerState(trigger);
      if (!state.active) {
        trigger.click();
        await sleep(400);

        const menus = Array.from(document.querySelectorAll('[role="menu"], [role="listbox"], mat-menu-content, .cdk-overlay-pane'));
        const options = menus.flatMap(function(m) {
          return Array.from(m.querySelectorAll('[role="menuitemradio"], [role="menuitem"], [role="option"]'));
        }).filter(actionable);

        const neonOption = options.find(function(el) {
          const txt = normalize((el.innerText || '') + ' ' + (el.getAttribute('aria-label') || ''));
          return menuRe.test(txt);
        });

        if (!neonOption) {
          document.querySelectorAll('.cdk-overlay-backdrop').forEach(function(b) { b.click(); });
          return { ok: false, code: 'MODEL_OPTION_NOT_FOUND' };
        }

        neonOption.click();
        await sleep(600);
        document.querySelectorAll('.cdk-overlay-backdrop').forEach(function(b) { b.click(); });
        await sleep(300);

        trigger = findTrigger();
        if (!trigger) return { ok: false, code: 'MODEL_SELECTION_UNVERIFIED' };
        state = readTriggerState(trigger);
        if (!state.active) return { ok: false, code: 'MODEL_SELECTION_UNVERIFIED' };
      }

      let stablePolls = 0;
      for (let i = 0; i < 2; i++) {
        trigger = findTrigger();
        if (!trigger) return { ok: false, code: 'MODEL_STABILITY_FAILED' };
        state = readTriggerState(trigger);
        if (!state.active) return { ok: false, code: 'MODEL_STABILITY_FAILED' };
        stablePolls++;
        if (i < 1) await sleep(500);
      }

      return {
        ok: true,
        verified: true,
        family: required.family,
        modelLabel: required.modelLabel,
        displayLabel: required.displayLabel,
        reasoning: required.reasoning,
        reasoningSource: required.reasoningSource,
        stablePolls: stablePolls,
        thinkingSelectorRequired: false
      };
    }, {
      family: GEMINI_REQUIRED_MODEL.family,
      menuPattern: GEMINI_REQUIRED_MODEL.menuPattern,
      activePattern: GEMINI_REQUIRED_MODEL.activePattern,
      modelLabel: GEMINI_REQUIRED_MODEL.modelLabel,
      displayLabel: GEMINI_REQUIRED_MODEL.displayLabel,
      reasoning: GEMINI_REQUIRED_MODEL.reasoning,
      reasoningSource: GEMINI_REQUIRED_MODEL.reasoningSource
    });

    if (!receipt || !receipt.ok) {
      throw new Error(receipt && receipt.code ? receipt.code : 'MODEL_SELECTION_UNVERIFIED');
    }

    geminiModelReceipts[tabKey] = {
      verified: true,
      family: GEMINI_REQUIRED_MODEL.family,
      modelLabel: GEMINI_REQUIRED_MODEL.modelLabel,
      displayLabel: GEMINI_REQUIRED_MODEL.displayLabel,
      reasoning: GEMINI_REQUIRED_MODEL.reasoning,
      reasoningSource: GEMINI_REQUIRED_MODEL.reasoningSource,
      stablePolls: 2,
      thinkingSelectorRequired: false
    };

    tabActiveModel[tabKey] = GEMINI_REQUIRED_MODEL.modelLabel;
    tabDiscoveredModels[tabKey] = GEMINI_REQUIRED_MODEL.menuLabel;

    console.error('[MODEL_STATE_OBSERVED] tabKey=' + tabKey + ' model=' + GEMINI_REQUIRED_MODEL.modelLabel + ' reasoning=' + GEMINI_REQUIRED_MODEL.reasoning);
    console.error('[MODEL_STATE_VERIFIED] tabKey=' + tabKey + ' receipt=' + JSON.stringify(geminiModelReceipts[tabKey]));
    return GEMINI_REQUIRED_MODEL.modelLabel;
  }
  if (tabKey === 'web1' || tabKey === 'web2') {
    const required = COPILOT_REQUIRED_MODEL;
    const result = await targetFrame.evaluate(async function(contract) {
      const visible = function(el) { if (!el) return false; const s = getComputedStyle(el), r = el.getBoundingClientRect(); return s.display !== 'none' && s.visibility !== 'hidden' && r.width > 4 && r.height > 4; };
      const text = function(el) { return ((el && el.innerText) || '') + ' ' + ((el && el.getAttribute('aria-label')) || ''); };
      const selectors = 'button[aria-label*="model" i],button[aria-label*="mode" i],[data-testid*="model-switcher" i],[data-testid*="mode-selector" i],.fui-Dropdown';
      let button = Array.from(document.querySelectorAll(selectors)).find(visible) || null;
      if (!button) return { ok: false, reason: 'COPILOT_MODEL_SELECTOR_NOT_FOUND', active: '' };
      const exact = function(value) { return String(value || '').toLowerCase().includes(contract.modelLabel.toLowerCase()); };
      const requiredModelVisible = function(value) {
        const normalized = String(value || '').toLowerCase();
        return normalized.includes('gpt-5.6') && normalized.includes('sol think');
      };
      if (!requiredModelVisible(text(button))) {
        button.click();
        const subSelector = '[data-testid*="gptSubMenuModelTrigger-OpenAI"],[data-testid*="OpenAI"],[role="menuitem"][aria-haspopup="menu"],[role="menuitem"][aria-haspopup="true"],[role="menuitem"]';
        let subTriggers = [];
        for (let poll = 0; poll < 6; poll++) {
          await new Promise(function(resolve) { setTimeout(resolve, 250); });
          subTriggers = Array.from(document.querySelectorAll(subSelector)).filter(function(el) {
            if (!visible(el) || el.getAttribute('role') === 'menuitemradio') return false;
            const testId = String(el.getAttribute('data-testid') || '');
            const t = text(el).toLowerCase(); return !/-Magic|-Chat|-Reasoning/i.test(testId) && (/OpenAI/i.test(testId) || /openai/i.test(t) || (/\bgpt\b/i.test(t) && !/gpt-5/i.test(t)) || el.getAttribute('aria-haspopup') === 'menu' || el.getAttribute('aria-haspopup') === 'true');
          });
          if (subTriggers.length > 0) break;
        }
        const openAiTrigger = subTriggers.find(function(el) { return /openai/i.test(String(el.getAttribute('data-testid') || '') + ' ' + text(el)); }) || subTriggers[0] || null;
        if (!openAiTrigger) return { ok: false, reason: 'COPILOT_OPENAI_SUBMENU_NOT_FOUND', active: text(button).trim() };
        openAiTrigger.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }));
        openAiTrigger.dispatchEvent(new PointerEvent('pointerover', { bubbles: true }));
        openAiTrigger.click();
        await new Promise(function(resolve) { setTimeout(resolve, 400); });
        const options = Array.from(document.querySelectorAll('[role="option"],[role="menuitemradio"],[role="menuitem"],button')).filter(visible);
        const model = options.find(function(el) {
          const value = text(el).toLowerCase();
          return (value.includes('gpt-5.6') && (value.includes('sol think') || value.includes('think deeper'))) || value.includes(contract.modelLabel.toLowerCase()) || value.includes('5.6 sol think') || value.includes('sol think');
        });
        if (!model) return { ok: false, reason: 'COPILOT_REQUIRED_MODEL_UNAVAILABLE', active: text(button).trim() };
        model.click();
        await new Promise(function(resolve) { setTimeout(resolve, 500); });
        button = Array.from(document.querySelectorAll(selectors)).find(visible) || button;
      }
      if (!requiredModelVisible(text(button))) return { ok: false, reason: 'COPILOT_REQUIRED_MODEL_NOT_ACTIVE', active: text(button).trim() };
      const reasoningControls = Array.from(document.querySelectorAll('button,[role="option"],[role="menuitemradio"],[role="menuitem"]')).filter(visible);
      let reasoning = reasoningControls.find(function(el) { return String(text(el)).toLowerCase().includes(contract.reasoningLabel.toLowerCase()); });
      if (!reasoning) {
        const opener = reasoningControls.find(function(el) { return /reason|think/i.test(text(el)); });
        if (opener) { opener.click(); await new Promise(function(resolve) { setTimeout(resolve, 250); }); reasoning = Array.from(document.querySelectorAll('[role="option"],[role="menuitemradio"],[role="menuitem"],button')).filter(visible).find(function(el) { return String(text(el)).toLowerCase().includes(contract.reasoningLabel.toLowerCase()); }); }
      }
      if (!reasoning) {
        if (requiredModelVisible(text(button))) {
          return { ok: true, active: contract.modelLabel + ' · ' + contract.reasoningLabel };
        }
        return { ok: false, reason: 'COPILOT_REASONING_MODE_UNAVAILABLE', active: text(button).trim() };
      }
      if (reasoning.getAttribute('aria-checked') !== 'true' && !/selected|active/i.test(reasoning.className || '')) { reasoning.click(); await new Promise(function(resolve) { setTimeout(resolve, 250); }); }
      return { ok: true, active: contract.modelLabel + ' · ' + contract.reasoningLabel };
    }, required);
    if (!result.ok) throw new Error(result.reason + ': active=' + result.active);
    tabActiveModel[tabKey] = result.active;
    return result.active;
  }
  if (!tabKey.startsWith('gemini')) {
  const result = await targetFrame.evaluate(async function(arg) {
    const isGemini = arg.isGemini;
    const closeMenus = function() {
      document.querySelectorAll('.cdk-overlay-backdrop').forEach(function(b) { b.click(); });
      document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true }));
    };

    // 1. Gjej butonin e modelit ne DOM
    const sels = isGemini
      ? [
          'button[data-test-id*="model"]',
          'bard-mode-switcher button',
          'button[aria-label*="model" i]',
          'button[aria-label*="Thinking" i]',
          'button[aria-label*="Mode" i]',
          '.input-area-switch button',
          'button:has(.model-title)',
          'button:has(mat-icon[data-mat-icon-name*="spark"])'
        ]
      : [
          'button[aria-label*="Model Selector" i]',
          'button[aria-label*="mode" i]',
          'button[aria-label*="model" i]',
          'button[aria-label*="Think" i]',
          '[data-testid*="mode-selector"]',
          '[data-testid*="model-switcher"]',
          '.fui-Dropdown'
        ];

    let btn = null;
    for (const s of sels) {
      const el = document.querySelector(s);
      if (el && el.offsetParent !== null) { btn = el; break; }
    }

    if (!btn) {
      return { status: 'NO_BUTTON_FOUND', activeModel: 'Unknown' };
    }

    const curCombined = ((btn.innerText || '') + ' ' + (btn.getAttribute('aria-label') || '')).trim();
    const curDisplay = (btn.innerText || btn.getAttribute('aria-label') || 'Active').split('\n')[0].trim();

    // Universal Semantic Capability Scorer (Sipas CopilotTransport.cs - Baseline: 4 Neon / Deeper analysis e lart)
    const scoreModel = function(title, fullText, isDisabled) {
      if (isDisabled) return -10000;
      const combined = ((title || '') + ' ' + (fullText || '')).toLowerCase();
      let s = 100;

      // Bonus maksimal (+1200) për 4 Neon High / Neon
      if (combined.includes('neon') || combined.includes('4 neon high')) {
        s += 1200;
      } else
      // Bonus maksimal (+1000) për 4 Neon / Deeper analysis
      if (combined.includes('high') || combined.includes('think deeper') || combined.includes('thinking') ||
          combined.includes('deeper') || combined.includes('in-depth') || combined.includes('deep') ||
          combined.includes('reason') || combined.includes('thellë')) {
        s += 1000;
      }
      // Kategoria ELITE (+800): "4 Neon", "Neon", "Deeper analysis"
      else if (combined.includes('code & analysis') || combined.includes('code and analysis') ||
          combined.includes('argon') || combined.includes('4 argon')) {
        s += 800;
      }
      // Kategoria PRO / ADVANCED (+500): "Pro", "Advanced", "Precise", "Smart"
      else if (combined.includes('pro') || combined.includes('advanced') || combined.includes('precise') || combined.includes('smart')) {
        s += 500;
      }
      // Kategoria e shpejte (+200): pamjaftueshme per arsyetim te thelle
      else if (combined.includes('quick') || combined.includes('fast') || combined.includes('shpejt')) {
        s += 200;
      }

      // Penalizim i rëndë (-2000) për Low / Fast and efficient / Flash / Lite / Auto / Default
      if (combined.includes('low') || combined.includes('fast and efficient') ||
          combined.includes('flash') || combined.includes('lite') || combined.includes('mini') ||
          combined.includes('auto') || combined.includes('everyday') || combined.includes('default') || combined.includes('standard')) {
        s -= 2000;
      }
      return s;
    };

    // Për Copilot: nëse butoni aktual është tashmë ELITE (Score >= 800)
    if (!isGemini && scoreModel(curDisplay, curCombined, false) >= 800) {
      return { status: 'SUCCESS_ALREADY_ACTIVE', activeModel: curDisplay, summary: curDisplay + ' (Aktiv)' };
    }
    // Për Gemini: mos prano kurrë "ALREADY_ACTIVE" nëse nuk vërtetohet "Neon"
    if (isGemini) {
      const curLow = curCombined.toLowerCase();
      const isExplicitHigh = (curLow.includes('high') || curLow.includes('deeper') || curLow.includes('thinking')) && !curLow.includes('low') && !curLow.includes('fast');
      if (isExplicitHigh && scoreModel(curDisplay, curCombined, false) >= 800) {
        return { status: 'SUCCESS_ALREADY_ACTIVE', activeModel: curDisplay, summary: curDisplay + ' (Aktiv)' };
      }
    }

    // 2. Hap menynë me një click të vetëm. pointerdown + click mund ta bëjë Fluent UI toggle open -> close.
    btn.click();
    const visibleMenu = function(el) {
      if (!el || !el.isConnected) return false;
      const st = window.getComputedStyle(el);
      const r = el.getBoundingClientRect();
      return st.display !== 'none' && st.visibility !== 'hidden' && parseFloat(st.opacity || '1') > 0.05 && r.width > 4 && r.height > 4;
    };
    const modelMenuText = function(el) {
      return /auto|quick|think|gpt|deeper|precise|code/i.test((el.innerText || el.textContent || '') + ' ' + (el.getAttribute('aria-label') || ''));
    };
    let modelMenu = null;
    const menuDeadline = performance.now() + 5000;
    while (performance.now() < menuDeadline) {
      modelMenu = Array.from(document.querySelectorAll('[role="menu"]')).find(function(el) {
        return visibleMenu(el) && modelMenuText(el);
      }) || null;
      if (modelMenu) break;
      await new Promise(function(r) { setTimeout(r, 100); });
    }

    // Zgjedh nen-menyte vetem brenda menusë së modelit.
    const subTriggers = modelMenu ? Array.from(modelMenu.querySelectorAll('[data-testid*="gptSubMenuModelTrigger"], [role="menuitem"][aria-haspopup="menu"], [role="menuitem"][aria-haspopup="true"], [role="menuitem"][aria-haspopup="listbox"]')) : [];
    for (const sub of subTriggers) {
      try {
        const beforeCount = Array.from(document.querySelectorAll('[role="menu"]')).filter(visibleMenu).length;
        sub.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }));
        sub.dispatchEvent(new PointerEvent('pointerover', { bubbles: true }));
        await new Promise(function(r) { setTimeout(r, 250); });
        const afterHoverCount = Array.from(document.querySelectorAll('[role="menu"]')).filter(visibleMenu).length;
        if (afterHoverCount <= beforeCount) {
          sub.click();
          await new Promise(function(r) { setTimeout(r, 300); });
        }
      } catch (_) {}
    }

    // 3. Mbledh opsionet vetem nga menutë e dukshme, duke përfshirë submenu-në GPT.
    let visibleMenus = Array.from(document.querySelectorAll('[role="menu"]')).filter(visibleMenu);
    if (visibleMenus.length === 0) {
      btn.click();
      const reopenDeadline = performance.now() + 5000;
      while (performance.now() < reopenDeadline) {
        visibleMenus = Array.from(document.querySelectorAll('[role="menu"]')).filter(function(menu) { return visibleMenu(menu) && modelMenuText(menu); });
        if (visibleMenus.length) break;
        await new Promise(function(r) { setTimeout(r, 100); });
      }
    }
    const candidateNodes = visibleMenus.flatMap(function(menu) {
      return Array.from(menu.querySelectorAll('[role="menuitemradio"], [role="menuitemcheckbox"], [role="option"], [role="menuitem"], .mat-mdc-menu-item, .fui-MenuItem, [data-testid*="gptSubMenuModelTrigger-"]'));
    });

    const discovered = [];
    for (const node of candidateNodes) {
      if (node.getAttribute('aria-haspopup') === 'menu') continue;
      const rawText = (node.innerText || node.textContent || '').trim();
      const ariaLabel = (node.getAttribute('aria-label') || '').trim();
      const displayText = rawText || ariaLabel;
      if (!displayText) continue;

      const title = displayText.split('\n')[0].trim();
      const isChecked = node.getAttribute('aria-checked') === 'true'
        || node.classList.contains('is-checked')
        || node.classList.contains('fui-MenuItem--selected')
        || node.classList.contains('active');
      const isDisabled = node.getAttribute('aria-disabled') === 'true'
        || node.hasAttribute('disabled')
        || node.classList.contains('is-disabled')
        || node.classList.contains('mat-mdc-menu-item-disabled');

      if (!discovered.some(function(d) { return d.title.toLowerCase() === title.toLowerCase(); })) {
        discovered.push({
          el: node,
          title: title,
          fullText: displayText,
          isChecked: isChecked,
          isDisabled: isDisabled,
          score: scoreModel(title, displayText, isDisabled)
        });
      }
    }

    const modelListSummary = discovered.map(function(d) {
      return d.title + (d.isChecked ? ' (Aktiv)' : '') + (d.isDisabled ? ' (Çaktivizuar)' : '');
    }).join(' | ');

    if (discovered.length === 0) {
      closeMenus();
      const curScore = scoreModel(curDisplay, curCombined, false);
      if (curScore >= 800) return { status: 'SUCCESS_CURRENT', activeModel: curDisplay, summary: curDisplay };
      return { status: 'NO_OPTIONS_DISCOVERED', activeModel: curDisplay, summary: 'Nuk u zbulua asnje opsion ne menu' };
    }

    // Renditja sipas pikeve zbrese
    const sorted = discovered.slice().sort(function(a, b) { return b.score - a.score; });
    const target = sorted[0];

    // Verifikim i hekurt: Pragu minimal ELITE (Score >= 800: Code & analysis / 4 Argon e lart)
    if (!target || target.isDisabled || target.score < 800) {
      closeMenus();
      return {
        status: 'DISQUALIFIED_BELOW_BASELINE',
        activeModel: curDisplay,
        bestCandidate: target ? target.title : 'None',
        summary: modelListSummary
      };
    }

    if (target.isChecked) {
      closeMenus();
      return { status: 'SUCCESS_ALREADY_ACTIVE', activeModel: target.title, summary: modelListSummary };
    }

    // Klikim fizik i modelit me te mire
    target.el.scrollIntoView({ block: 'nearest' });
    target.el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    target.el.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }));
    target.el.click();
    await new Promise(function(r) { setTimeout(r, 400); });
    closeMenus();

    return { status: 'SUCCESS_SWITCHED', activeModel: target.title, summary: modelListSummary };
  }, { isGemini: tabKey.startsWith('gemini') }).catch(function(err) {
    return { status: 'EVALUATE_EXCEPTION', error: err.message };
  });

  if (result.status === 'DISQUALIFIED_BELOW_BASELINE') {
    throw new Error('CRITICAL_MODEL_LOCK_REJECTED ne [' + tabKey + ']: Modeli me i mire i gjetur [' + (result.bestCandidate || '') + '] nuk arrin nivelin baze "4 Neon" (Score < 800). Opsionet ne ekran: [' + result.summary + ']. Ndalohet kategorikisht vazhdimi me modele te uleta!');
  }

  if (result.status === 'NO_OPTIONS_DISCOVERED' || result.status === 'NO_BUTTON_FOUND') {
    const curLow = (result.activeModel || '').toLowerCase();
    if (curLow.includes('code & analysis') || curLow.includes('argon') || curLow.includes('think') || curLow.includes('pro')) {
      tabActiveModel[tabKey] = result.activeModel;
      return result.activeModel;
    }
    throw new Error('CRITICAL_MODEL_LOCK_FAILED ne [' + tabKey + ']: Nuk u arrit zbulimi i menusë dhe modeli aktual eshte [' + result.activeModel + ']. Refuzohet kalimi ne Default/Flash.');
  }

  if (result.status === 'EVALUATE_EXCEPTION') {
    throw new Error('MODEL_DISCOVERY_ERROR ne [' + tabKey + ']: ' + result.error);
  }

  tabActiveModel[tabKey] = result.activeModel;
  if (result.summary) {
    tabDiscoveredModels[tabKey] = result.summary;
  }
  console.error('[MODEL_DISCOVERY_SUCCESS] tabKey=' + tabKey + ' activeModel=' + result.activeModel + ' summary=[' + (result.summary || '') + ']');
  return result.activeModel;
  }

  const maxAttempts = 3;
  let lastObservation = { phase: 'READY', code: 'MODEL_TRIGGER_TIMEOUT' };
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    console.error('[MODEL_STATE_ATTEMPT] tabKey=' + tabKey + ' phase=GEMINI_MAX_REASONING attempt=' + attempt);
    const result = await targetFrame.evaluate(async function(arg) {
      const sleep = function(ms) { return new Promise(function(resolve) { setTimeout(resolve, ms); }); };
      const normalize = function(value) {
        return String(value || '').normalize('NFKC').toLowerCase().replace(/&/g, ' and ').replace(/\s+/g, ' ').trim();
      };
      const actionable = function(el) {
        if (!el || !el.isConnected || el.disabled || el.getAttribute('aria-disabled') === 'true') return false;
        const st = window.getComputedStyle(el);
        const r = el.getBoundingClientRect();
        return st.display !== 'none' && st.visibility !== 'hidden' && parseFloat(st.opacity || '1') > 0.05 && r.width > 4 && r.height > 4;
      };
      const selected = function(el) {
        if (!el) return false;
        const ariaChecked = el.getAttribute('aria-checked');
        if (ariaChecked === 'true') return true;
        if (ariaChecked === 'false') return false;
        const ariaSelected = el.getAttribute('aria-selected');
        if (ariaSelected === 'true') return true;
        if (ariaSelected === 'false') return false;
        const checked = el.querySelector('[aria-checked="true"], [aria-selected="true"], input:checked');
        if (checked) return true;
        const cls = normalize(el.className);
        if (/(^|\s)(selected|active|is-checked)(\s|$)/.test(cls)) return true;
        const semanticCheck = Array.from(el.querySelectorAll('[class*="check" i], [aria-label], [data-icon], [data-mat-icon-name], mat-icon')).some(function(icon) {
          if (!actionable(icon)) return false;
          const identity = normalize((icon.getAttribute('aria-label') || '') + ' ' + (icon.getAttribute('data-icon') || '') + ' ' + (icon.getAttribute('data-mat-icon-name') || '') + ' ' + (icon.textContent || '') + ' ' + (icon.className || ''));
          return /(^|[\s_-])(check|checkmark|done|tick|selected)([\s_-]|$)/.test(identity);
        });
        return semanticCheck;
      };
      const roots = function() {
        return Array.from(document.querySelectorAll('gem-menu, [role="menu"], [role="listbox"], .cdk-overlay-pane, [data-radix-menu-content]')).filter(actionable);
      };
      const mainMenuRoots = function() {
        return roots().filter(function(root) {
          return /argon|4 neon high|neon|code and analysis|quick answers|everyday help|deeper analysis/.test(normalize(root.innerText || root.textContent || ''));
        });
      };
      const close = function() {
        document.querySelectorAll('.cdk-overlay-backdrop').forEach(function(backdrop) { if (actionable(backdrop)) backdrop.click(); });
        const target = document.activeElement || document.body;
        target.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true }));
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true }));
      };
      const closeAndWait = async function() {
        const deadline = performance.now() + 2500;
        while (performance.now() < deadline) {
          close();
          if (roots().length === 0) return true;
          await sleep(100);
        }
        return roots().length === 0;
      };
      const click = function(el) {
        el.scrollIntoView({ block: 'nearest' });
        el.dispatchEvent(new MouseEvent('mouseenter', { bubbles: true }));
        el.dispatchEvent(new PointerEvent('pointerover', { bubbles: true }));
        el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
        el.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }));
        el.click();
      };
      const fail = function(code, phase, observation) {
        close();
        return { ok: false, code: code, phase: phase, observation: observation };
      };
      const wait = async function(probe, timeout) {
        const deadline = performance.now() + timeout;
        let stable = 0;
        let value = null;
        while (performance.now() < deadline) {
          value = probe();
          stable = value ? stable + 1 : 0;
          if (stable >= 2) return value;
          await sleep(250);
        }
        return null;
      };
      const composer = await wait(function() {
        return Array.from(document.querySelectorAll('div.ql-editor[contenteditable="true"], rich-textarea div[contenteditable="true"], [role="textbox"], textarea')).find(actionable) || null;
      }, 20000);
      if (!composer) return fail('MODEL_TRIGGER_TIMEOUT', 'READY', 'composer_not_ready');
      const findTrigger = function() {
        const candidates = Array.from(document.querySelectorAll('button[data-test-id*="model"], bard-mode-switcher button, button[aria-haspopup="menu"], button[aria-haspopup="true"], button[aria-label*="model" i], button[aria-label*="thinking" i], button[aria-label*="mode" i], .input-area-switch button, button:has(.model-title)')).filter(function(el) {
          if (!actionable(el) || el.closest('[role="menu"], [role="listbox"], .cdk-overlay-pane')) return false;
          const text = normalize((el.innerText || '') + ' ' + (el.getAttribute('aria-label') || ''));
          return /argon|neon|4 neon high|code and analysis|model|mode|thinking|deeper analysis|everyday help/.test(text);
        });
        const ranked = candidates.map(function(el) {
          const a = el.getBoundingClientRect();
          const b = composer.getBoundingClientRect();
          const distance = Math.hypot((a.left + a.width / 2) - (b.left + b.width / 2), (a.top + a.height / 2) - (b.top + b.height / 2));
          const text = normalize((el.innerText || '') + ' ' + (el.getAttribute('aria-label') || ''));
          const semantics = /4\s*neon\s*high|(^|\s)neon(\s|$)/.test(text) ? 3 : /argon|code and analysis/.test(text) ? 2 : 1;
          return { el: el, score: semantics * 100000 - distance, text: text };
        }).sort(function(a, b) { return b.score - a.score; });
        if (ranked.length > 1 && Math.abs(ranked[0].score - ranked[1].score) < 1) return { ambiguous: true };
        return ranked[0] || null;
      };
      const triggerResult = await wait(findTrigger, 20000);
      if (!triggerResult) return fail('MODEL_TRIGGER_TIMEOUT', 'DISCOVER_TRIGGER', 'trigger_not_found');
      if (triggerResult.ambiguous) return fail('MODEL_CONTROL_AMBIGUOUS', 'DISCOVER_TRIGGER', 'equal_ranked_controls');
      let trigger = triggerResult.el;
      click(trigger);
      let menuRoots = await wait(function() { const r = mainMenuRoots(); return r.length ? r : null; }, 5000);
      if (!menuRoots) return fail('MODEL_MENU_TIMEOUT', 'OPEN_MENU', triggerResult.text);
      const options = function() { return menuRoots.flatMap(function(root) { return Array.from(root.querySelectorAll('[role="menuitemradio"], [role="menuitemcheckbox"], [role="option"], [role="menuitem"], .mat-mdc-menu-item')); }).filter(actionable); };
      const requestedTier=arg.modelTier||'argon_high';
      if(requestedTier!=='neon'&&requestedTier!=='argon_high'&&requestedTier!=='pro_31')return fail('GEMINI_MODEL_TIER_BELOW_FLOOR','ENSURE_MODEL',String(requestedTier));
      if(requestedTier==='pro_31'){
        const tierPattern=/3\.1 pro|detailed research/i;
        let tierOption=options().find(function(el){return tierPattern.test(normalize((el.innerText||'')+' '+(el.getAttribute('aria-label')||'')));});
        if(!tierOption)return fail('GEMINI_MODEL_TIER_NOT_FOUND','ENSURE_MODEL',requestedTier);
        if(!selected(tierOption)){click(tierOption);await sleep(350);}
        await closeAndWait();
        trigger=(await wait(function(){const r=findTrigger();return r&&!r.ambiguous?r.el:null;},5000));
        if(!trigger)return fail('MODEL_TRIGGER_TIMEOUT','VERIFY_TIER',requestedTier);
        click(trigger);menuRoots=await wait(function(){const r=mainMenuRoots();return r.length?r:null;},5000);
        if(!menuRoots)return fail('MODEL_MENU_TIMEOUT','VERIFY_TIER',requestedTier);
        tierOption=options().find(function(el){return tierPattern.test(normalize((el.innerText||'')+' '+(el.getAttribute('aria-label')||'')));});
        const tierSelected=Boolean(tierOption&&selected(tierOption));close();
        if(!tierSelected)return fail('GEMINI_MODEL_TIER_UNVERIFIED','VERIFY_TIER',requestedTier);
        const summary='3.1 Pro · Detailed research';
        return {ok:true,status:'GEMINI_MODEL_TIER_VERIFIED',model:{label:summary,selected:true},reasoning:{label:'n/a',selected:true,lowSelected:false},summary:summary};
      }
      let neonHigh = options().find(function(el) {
        const t = normalize((el.innerText || '') + ' ' + (el.getAttribute('aria-label') || ''));
        return /4\s*neon\s*high/.test(t);
      });
      if (!neonHigh) {
        return {
          ok: false,
          code: 'MODEL_OPTION_NOT_FOUND',
          phase: 'ENSURE_MODEL',
          observation: 'required_model=4 Neon high ; visible=' + menuRoots.map(function(r){ return normalize(r.innerText).slice(0,200); }).join(' | ')
        };
      }
      if (!selected(neonHigh)) {
        click(neonHigh);
        await sleep(350);
        triggerResult.el = null;
        trigger = (await wait(function() { const r = findTrigger(); return r && !r.ambiguous ? r.el : null; }, 5000));
        if (!trigger) return fail('MODEL_SELECTION_UNVERIFIED', 'ENSURE_MODEL', 'trigger_lost_after_model_selection');
        click(trigger);
        menuRoots = await wait(function() { const r = mainMenuRoots(); return r.length ? r : null; }, 5000);
        if (!menuRoots) return fail('MODEL_MENU_TIMEOUT', 'ENSURE_MODEL', 'menu_not_reopened');
        neonHigh = options().find(function(el) {
          const t = normalize((el.innerText || '') + ' ' + (el.getAttribute('aria-label') || ''));
          return /4\s*neon\s*high/.test(t);
        });
        if (!neonHigh || !selected(neonHigh)) {
          return fail('MODEL_SELECTION_UNVERIFIED', 'ENSURE_MODEL', '4_neon_high_missing_after_rerender');
        }
      }
      let thinking = options().find(function(el) {
        return ['menu', 'true', 'listbox'].includes(el.getAttribute('aria-haspopup')) &&
          /thinking level|reasoning level|thinking/.test(normalize((el.innerText || '') + ' ' + (el.getAttribute('aria-label') || '')));
      });
      if (!thinking) {
        close();
        return fail('GEMINI_THINKING_TRIGGER_NOT_FOUND', 'ENSURE_REASONING', 'reasoning_selector_missing');
      }
      click(thinking);
      const submenu = await wait(function() {
        return roots().find(function(root) { const t = normalize(root.innerText); return /(^|\s)low(\s|$)/.test(t) && /(^|\s)high(\s|$)|extra thorough/.test(t); }) || null;
      }, 5000);
      if (!submenu) return fail('GEMINI_THINKING_SUBMENU_TIMEOUT', 'ENSURE_REASONING', normalize(thinking.innerText));
      const requestedLow=false;let high = Array.from(submenu.querySelectorAll('[role="menuitemradio"], [role="option"], [role="menuitem"]')).filter(actionable).find(function(el) { return /(^|\s)high(\s|$)|extra thorough/.test(normalize((el.innerText || '') + ' ' + (el.getAttribute('aria-label') || ''))); });
      const lowOption=Array.from(submenu.querySelectorAll('[role="menuitemradio"],[role="option"],[role="menuitem"]')).filter(actionable).find(function(el){return /(^|\s)low(\s|$)|fast and efficient/.test(normalize((el.innerText||'')+' '+(el.getAttribute('aria-label')||'')));});if(requestedLow&&!lowOption)return fail('GEMINI_LOW_NOT_FOUND','ENSURE_REASONING',normalize(submenu.innerText));if (!high) return fail('GEMINI_HIGH_NOT_FOUND', 'ENSURE_REASONING', normalize(submenu.innerText));
      const desired=high;if(!selected(desired)){click(desired);await sleep(350);}
      await closeAndWait();
      trigger = (await wait(function() { const r = findTrigger(); return r && !r.ambiguous ? r.el : null; }, 5000));
      if (!trigger) return fail('MODEL_TRIGGER_TIMEOUT', 'VERIFY', 'trigger_missing');
      click(trigger);
      menuRoots = await wait(function() { const r = mainMenuRoots(); return r.length ? r : null; }, 5000);
      if (!menuRoots) return fail('MODEL_MENU_TIMEOUT', 'VERIFY', 'verification_menu_missing');
      neonHigh = options().find(function(el) {
        const t = normalize((el.innerText || '') + ' ' + (el.getAttribute('aria-label') || ''));
        return /4\s*neon\s*high/.test(t);
      });
      thinking = options().find(function(el) { return ['menu', 'true', 'listbox'].includes(el.getAttribute('aria-haspopup')) && /thinking level|reasoning level|thinking/.test(normalize((el.innerText || '') + ' ' + (el.getAttribute('aria-label') || ''))); });
      if (!neonHigh) return fail('MODEL_SELECTION_UNVERIFIED', 'VERIFY', '4_neon_high_missing');
      if (!selected(neonHigh)) return fail('MODEL_SELECTION_UNVERIFIED', 'VERIFY', '4_neon_high_not_selected');
      if (!thinking) return fail('GEMINI_THINKING_TRIGGER_NOT_FOUND', 'VERIFY', 'thinking_missing');
      click(thinking);
      const verifySubmenu = await wait(function() { return roots().find(function(root) { return /(^|\s)low(\s|$)/.test(normalize(root.innerText)) && /(^|\s)high(\s|$)|extra thorough/.test(normalize(root.innerText)); }) || null; }, 5000);
      if (!verifySubmenu) return fail('GEMINI_THINKING_SUBMENU_TIMEOUT', 'VERIFY', 'verification_submenu_missing');
      const levelOptions = Array.from(verifySubmenu.querySelectorAll('[role="menuitemradio"], [role="option"], [role="menuitem"]')).filter(actionable);
      high = levelOptions.find(function(el) { return /(^|\s)high(\s|$)|extra thorough/.test(normalize((el.innerText || '') + ' ' + (el.getAttribute('aria-label') || ''))); });
      const low = levelOptions.find(function(el) { return /(^|\s)low(\s|$)|fast and efficient/.test(normalize((el.innerText || '') + ' ' + (el.getAttribute('aria-label') || ''))); });
      const highSelected = Boolean(high && selected(high));
      const lowSelected = Boolean(low && selected(low));
      close();
      if (!highSelected||lowSelected) return fail('GEMINI_HIGH_UNVERIFIED', 'VERIFY', 'high=' + highSelected + ',low=' + lowSelected);
      const observedModel = (neonHigh.innerText || GEMINI_REQUIRED_MODEL.label).split('\n')[0].trim();
      if (normalize(observedModel) !== normalize(GEMINI_REQUIRED_MODEL.label)) {
        return fail('MODEL_SELECTION_UNVERIFIED', 'VERIFY', observedModel);
      }
      return {
        ok: true,
        status: 'GEMINI_MAX_REASONING_VERIFIED',
        model: {
          label: GEMINI_REQUIRED_MODEL.label,
          selected: true
        },
        reasoning: {
          label: GEMINI_REQUIRED_MODEL.reasoning,
          selected: true,
          lowSelected: false
        },
        summary: '4 Neon high'
      };
    },{reasoningLevel:'high',modelTier:opts.modelTier||'neon'}).catch(function(err) { return {ok:false,code:'MODEL_SELECTION_UNVERIFIED',phase:'EVALUATE',observation:err.message}; });
    if (result.ok) {
      let stablePolls = 0;
      while (stablePolls < 2) {
        const poll = await targetFrame.evaluate(function() {
          const text = String(document.body.innerText || '');
          return /4\s*neon\s*high/i.test(text);
        }).catch(function(){ return false; });
        if (!poll) {
          throw new Error('GEMINI_MODEL_STABILITY_FAILED');
        }
        stablePolls++;
        if (stablePolls < 2) {
          await new Promise(function(resolve){ setTimeout(resolve, 500); });
        }
      }
      geminiModelReceipts[tabKey] = {
        verified: true,
        family: GEMINI_REQUIRED_MODEL.family,
        modelLabel: GEMINI_REQUIRED_MODEL.label,
        displayLabel: GEMINI_REQUIRED_MODEL.display,
        reasoning: GEMINI_REQUIRED_MODEL.reasoning,
        stablePolls: 2
      };
      tabActiveModel[tabKey] = GEMINI_REQUIRED_MODEL.label;
      tabDiscoveredModels[tabKey] = GEMINI_REQUIRED_MODEL.label;
      console.error('[MODEL_STATE_OBSERVED] model=' + result.model.label + ' reasoning=' + result.reasoning.label + ' evidence=selected:true,lowSelected:false');
      console.error('[MODEL_STATE_VERIFIED] tabKey=' + tabKey + ' receipt=' + JSON.stringify(geminiModelReceipts[tabKey]));
      return GEMINI_REQUIRED_MODEL.label;
    }
    lastObservation = result;
    console.error('[MODEL_STATE_FAILED] tabKey=' + tabKey + ' code=' + result.code + ' attempt=' + attempt + ' lastObservation=' + JSON.stringify({ phase: result.phase, observation: result.observation }));
    await targetFrame.evaluate(async function() {
      const actionableRoot = function(el) { const st = window.getComputedStyle(el); const r = el.getBoundingClientRect(); return st.display !== 'none' && st.visibility !== 'hidden' && r.width > 4 && r.height > 4; };
      const deadline = performance.now() + 2500;
      while (performance.now() < deadline) {
        document.querySelectorAll('.cdk-overlay-backdrop').forEach(function(backdrop) { if (actionableRoot(backdrop)) backdrop.click(); });
        const target = document.activeElement || document.body;
        target.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true }));
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true }));
        const open = Array.from(document.querySelectorAll('gem-menu, [role="menu"], [role="listbox"], .cdk-overlay-pane, [data-radix-menu-content]')).some(actionableRoot);
        if (!open) return;
        await new Promise(function(resolve) { setTimeout(resolve, 100); });
      }
    }).catch(function() {});
    await new Promise(function(resolve) { setTimeout(resolve, 100); });
  }
  throw new Error((lastObservation.code || 'GEMINI_HIGH_UNVERIFIED') + ' ne [' + tabKey + '] attempts=' + maxAttempts + ' lastObservation=' + JSON.stringify({ phase: lastObservation.phase, observation: lastObservation.observation }));
}

const PACK_MODES = Object.freeze({PLANNING_FULL:'PLANNING_FULL',CODING_FOCUSED:'CODING_FOCUSED',REVIEW_FOCUSED:'REVIEW_FOCUSED',RETRY_COMPACT:'RETRY_COMPACT'});
const KIB=1024;
const ABSOLUTE_BUNDLE_CEILING_BYTES=512*KIB;
const CONTEXT_BUDGET_BYTES=Object.freeze({PLANNING_FULL:480*1024,CODING_FOCUSED:384*1024,REVIEW_FOCUSED:320*1024,RETRY_COMPACT:256*1024});
const PACK_BUDGETS=CONTEXT_BUDGET_BYTES;
const ABSOLUTE_BUNDLE_CEILING=ABSOLUTE_BUNDLE_CEILING_BYTES;
const TEXT_BUNDLE_DENIED_DIRECTORIES=new Set(['__pycache__','.git','.svn','.hg','node_modules','bin','obj','dist','build','coverage','.cache','cache','tmp','temp','.venv','venv']);
const TEXT_BUNDLE_DENIED_EXTENSIONS=new Set(['.pyc','.pyo','.pyd','.dll','.exe','.com','.msi','.so','.dylib','.a','.lib','.o','.obj','.db','.sqlite','.sqlite3','.mdb','.zip','.7z','.rar','.tar','.gz','.bz2','.xz','.png','.jpg','.jpeg','.gif','.bmp','.webp','.ico','.tif','.tiff','.mp3','.wav','.flac','.aac','.ogg','.mp4','.mov','.avi','.mkv','.webm','.pdf','.woff','.woff2','.ttf','.otf','.eot','.class','.jar','.war','.rvt','.rfa','.ifc','.dwg','.dxf']);

function inspectTextBuffer(buffer){
  if(!Buffer.isBuffer(buffer))buffer=Buffer.from(buffer||[]);const total=buffer.length,nulCount=buffer.reduce(function(n,b){return n+(b===0?1:0);},0),utf16Bom=total>=2&&((buffer[0]===0xff&&buffer[1]===0xfe)||(buffer[0]===0xfe&&buffer[1]===0xff));let text='',utf8Valid=true;try{text=new TextDecoder('utf-8',{fatal:true}).decode(buffer);}catch(_){utf8Valid=false;}let controlCount=0;if(utf8Valid)for(const ch of text){const cp=ch.codePointAt(0);if((cp>=1&&cp<=8)||cp===11||(cp>=14&&cp<=31)||cp===127)controlCount++;}const controlRatio=total===0?0:controlCount/total;return {isText:nulCount===0&&!utf16Bom&&controlRatio<=0.02&&utf8Valid,nulCount:nulCount,controlCount:controlCount,controlRatio:controlRatio,utf8Valid:utf8Valid,utf16Bom:utf16Bom,text:utf8Valid?text:''};
}
function detectUnpairedSurrogates(text){for(let i=0;i<text.length;i++){const c=text.charCodeAt(i);if(c>=0xd800&&c<=0xdbff){if(i+1>=text.length||text.charCodeAt(i+1)<0xdc00||text.charCodeAt(i+1)>0xdfff)return true;i++;}else if(c>=0xdc00&&c<=0xdfff)return true;}return false;}
function validateFinalTextArtifact(text,mode){mode=CONTEXT_BUDGET_BYTES[mode]?mode:PACK_MODES.PLANNING_FULL;text=String(text||'');const bytes=Buffer.byteLength(text,'utf8'),nulCount=(text.match(/\u0000/g)||[]).length,hasUnpairedSurrogate=detectUnpairedSurrogates(text),encoded=Buffer.from(text,'utf8'),roundTripValid=encoded.toString('utf8')===text;if(nulCount!==0||encoded.includes(0))throw new Error('BUNDLE_NUL_BYTE_DETECTED');if(hasUnpairedSurrogate)throw new Error('BUNDLE_INVALID_UNICODE');if(!roundTripValid)throw new Error('BUNDLE_UTF8_INTEGRITY_FAILED');if(bytes>CONTEXT_BUDGET_BYTES[mode])throw new Error('BUNDLE_MODE_BUDGET_EXCEEDED');if(bytes>ABSOLUTE_BUNDLE_CEILING_BYTES)throw new Error('BUNDLE_ABSOLUTE_CEILING_EXCEEDED');return {bytes:bytes,nulCount:0,roundTripValid:true,sha256:crypto.createHash('sha256').update(encoded).digest('hex')};}
function truncateUtf8(text,maxBytes){text=String(text||'');if(Buffer.byteLength(text,'utf8')<=maxBytes)return text;let lo=0,hi=text.length;while(lo<hi){const mid=Math.ceil((lo+hi)/2);if(Buffer.byteLength(text.slice(0,mid),'utf8')<=maxBytes)lo=mid;else hi=mid-1;}while(lo>0&&text.charCodeAt(lo-1)>=0xd800&&text.charCodeAt(lo-1)<=0xdbff)lo--;return text.slice(0,lo);}
function assembleFinalContextArtifact(sections,mode){mode=CONTEXT_BUDGET_BYTES[mode]?mode:PACK_MODES.PLANNING_FULL;const budget=CONTEXT_BUDGET_BYTES[mode],reserve=4096,keys=['header','taskMetadata','architectureMap','externalSpecs','repositoryTree','workspace','manifest','footer'],normalized={};for(const k of keys)normalized[k]=String(sections&&sections[k]||'');const delimiter=NL+NL;let fixedKeys=['header','taskMetadata','architectureMap','externalSpecs','repositoryTree','manifest','footer'],fixed=fixedKeys.map(function(k){return normalized[k];}).filter(Boolean).join(delimiter);if(Buffer.byteLength(fixed,'utf8')>budget-reserve){const priority=['header','taskMetadata','architectureMap','externalSpecs','manifest','footer','repositoryTree'];let remaining=budget-reserve,out=[];for(const k of priority){if(!normalized[k])continue;const allotment=Math.max(0,Math.floor(remaining/(priority.length-out.length)));const part=truncateUtf8(normalized[k],allotment);if(part){out.push(part);remaining-=Buffer.byteLength(part,'utf8')+Buffer.byteLength(delimiter,'utf8');}}fixed=out.join(delimiter);}const workspaceBudget=Math.max(0,budget-reserve-Buffer.byteLength(fixed,'utf8')-Buffer.byteLength(delimiter,'utf8'));const workspace=truncateUtf8(normalized.workspace,workspaceBudget);let text=[fixed,workspace].filter(Boolean).join(delimiter);text=truncateUtf8(text,budget);const validation=validateFinalTextArtifact(text,mode);return {text:text,receipt:{mode:mode,modeBudgetBytes:budget,absoluteCeilingBytes:ABSOLUTE_BUNDLE_CEILING_BYTES,fixedSectionBytes:Buffer.byteLength(fixed,'utf8'),workspaceBudgetBytes:workspaceBudget,finalContextBytes:validation.bytes,nulCount:0,replacementCharacterCount:(text.match(/\ufffd/g)||[]).length,finalSha256:validation.sha256}};}

const WEB_ENGINE_ADAPTERS = {
  gemini:{canonicalUrl:GEMINI_APP_URL,routeIsClean:function(s){try{return new URL(s.url).hostname==='gemini.google.com'&&new URL(s.url).pathname.replace(/\/+$/,'')==='/app'&&s.users===0&&s.assistants===0;}catch(_){return false;}}},
  google_search:{canonicalUrl:GOOGLE_SEARCH_AI_URL,routeIsClean:function(s){return doesUrlMatchEngine('google_search_1',s.url)&&s.users===0&&s.assistants===0&&s.composer.empty;}},
  m365:{canonicalUrl:M365_CHAT_URL,routeIsClean:function(s){return doesUrlMatchEngine('m365',s.url)&&s.users===0&&s.assistants===0&&s.composer.empty;}}
};
function getEngineAdapter(tabKey){const kind=String(tabKey||'').startsWith('gemini')?'gemini':String(tabKey||'').startsWith('google_search_')?'google_search':'m365';return WEB_ENGINE_ADAPTERS[kind];}
function normalizeChatRoute(value){try{const u=new URL(String(value||''));return u.pathname.replace(/\/+$/,'')||'/';}catch(_){return '';}}
function conversationIdFromUrl(value){const m=normalizeChatRoute(value).match(/^\/app\/([^/?#]+)$/i);return m?m[1]:'';}
async function probeChatCleanState(targetFrame,tabKey,oldConversationId){
  const url=await targetFrame.evaluate(function(){return location.href;}).catch(function(){return '';});
  const state=await targetFrame.evaluate(function(arg){const visible=function(el){if(!el)return false;const st=getComputedStyle(el),r=el.getBoundingClientRect();return st.display!=='none'&&st.visibility!=='hidden'&&r.width>3&&r.height>3;};const root=document.querySelector('main')||document.body;const users=root.querySelectorAll('user-query,[data-message-author-role="user"],[data-testid="chat-turn-user"],.user-message').length;const assistants=root.querySelectorAll('response-container,model-response,[data-message-author-role="assistant"],[data-message-author-role="model"],[data-testid="chat-turn-assistant"],.assistant-message').length;const editor=Array.from(document.querySelectorAll('rich-textarea [contenteditable="true"],div.ql-editor[contenteditable="true"],#m365-chat-editor-target-element,[role="textbox"],textarea')).find(visible)||null;const text=editor?String(/^(TEXTAREA|INPUT)$/.test(editor.tagName)?editor.value:(editor.innerText||editor.textContent||'')).trim():'';const scope=editor?(editor.closest('form,input-area-v2,[class*="composer" i],[class*="input-area" i]')||root):root;const chips=Array.from(scope.querySelectorAll('uploader-file-preview,gem-attachment,[class*="attachment" i],[class*="chip" i]')).filter(visible).length;const generating=Array.from(scope.querySelectorAll('button[aria-label*="stop" i],button[title*="stop" i],[role="progressbar"],[aria-busy="true"]')).some(visible);return {users:users,assistants:assistants,composer:{empty:text.length===0,ready:Boolean(editor)},attachmentChips:chips,generating:generating,oldPresent:Boolean(arg.oldId&&location.href.includes(arg.oldId))};},{oldId:oldConversationId}).catch(function(){return {users:-1,assistants:-1,composer:{empty:false,ready:false},attachmentChips:-1,generating:true,oldPresent:true};});
  state.url=url;state.route=normalizeChatRoute(url);state.conversationId=conversationIdFromUrl(url);const adapter=getEngineAdapter(tabKey);state.clean=Boolean(adapter.routeIsClean(state)&&state.composer.ready&&state.composer.empty&&state.attachmentChips===0&&!state.generating&&!state.oldPresent);return state;
}
async function resetChatVerified(args){
  if (args && args.tabKey && String(args.tabKey).startsWith('gemini')) {
    invalidateGeminiReceipt(args.tabKey);
  }
  let page=args.page,targetFrame=args.targetFrame||findChatFrameOrPage(page);const tabKey=args.tabKey,projectRoot=args.projectRoot,timeoutMs=args.timeoutMs||30000,started=Date.now(),adapter=getEngineAdapter(tabKey),oldRoute=normalizeChatRoute(page.url()),oldConversationId=conversationIdFromUrl(page.url());
  if(args.forceReload===true){let state=null,stable=0;try{await page.goto(adapter.canonicalUrl,{waitUntil:'domcontentloaded',timeout:Math.min(timeoutMs,45000)});targetFrame=findChatFrameOrPage(page);if(await checkAuthExpired(page,tabKey))throw new Error('AUTH_EXPIRED');const deadline=Date.now()+Math.min(timeoutMs,30000);while(Date.now()<deadline&&stable<2){state=await probeChatCleanState(targetFrame,tabKey,oldConversationId);stable=state.clean?stable+1:0;if(stable<2)await page.waitForTimeout(250);}if(stable<2)throw new Error('clean_state_unverified');activeProjectPerTab[tabKey]=projectRoot;return {status:'CHAT_RESET_VERIFIED',method:'FORCED_NAV',oldRoute:oldRoute,newRoute:state.route,oldConversationId:oldConversationId,newConversationId:state.conversationId,users:0,assistants:0,composerEmpty:true,attachmentChips:0,stablePolls:2,documentChanged:true,elapsedMs:Date.now()-started};}catch(err){throw new Error('FORCED_CHAT_RESET_VERIFICATION_FAILED: '+err.message);}}
  console.error('[CHAT_RESET_STARTED] tabKey='+tabKey+' reason='+(args.reason||'requested'));
  await page.keyboard.press('Escape').catch(function(){});await targetFrame.evaluate(function(){document.querySelectorAll('.cdk-overlay-backdrop,[role="dialog"] button[aria-label*="close" i]').forEach(function(x){try{x.click();}catch(_){}});}).catch(function(){});
  const sels=tabKey.startsWith('gemini')?'a[aria-label*="New chat" i],button[aria-label*="New chat" i],[data-test-id="new-chat-button"]':'button[aria-label*="New chat" i],button[title*="New chat" i],[data-testid*="new-chat" i],a[aria-label*="New chat" i]';
  let method='CLICK',clicked=false;try{const button=targetFrame.locator(sels).filter({visible:true}).first();if(await button.count()){await button.click({timeout:3000});clicked=true;console.error('[CHAT_RESET_CLICKED] tabKey='+tabKey);}}catch(_){}
  let stable=0,state=null,clickDeadline=Date.now()+5000;while(clicked&&Date.now()<clickDeadline){state=await probeChatCleanState(targetFrame,tabKey,oldConversationId);stable=state.clean?stable+1:0;if(stable>=2)break;await page.waitForTimeout(250);}
  if(stable<2){console.error('[CHAT_RESET_CLICK_UNVERIFIED] tabKey='+tabKey);method='FALLBACK_NAV';console.error('[CHAT_RESET_FALLBACK_NAV] tabKey='+tabKey);try{await page.goto(adapter.canonicalUrl,{waitUntil:'domcontentloaded',timeout:Math.min(timeoutMs,45000)});}catch(err){console.error('[CHAT_RESET_FAILED] tabKey='+tabKey+' reason=navigation');throw new Error('CHAT_RESET_VERIFICATION_FAILED: '+err.message);}stable=0;}
  const deadline=Date.now()+Math.min(timeoutMs,30000);while(Date.now()<deadline&&stable<2){state=await probeChatCleanState(findChatFrameOrPage(page),tabKey,oldConversationId);stable=state.clean?stable+1:0;if(stable<2)await page.waitForTimeout(250);}
  if(stable<2){console.error('[CHAT_RESET_FAILED] tabKey='+tabKey);throw new Error('CHAT_RESET_VERIFICATION_FAILED');}
  activeProjectPerTab[tabKey]=projectRoot;const receipt={status:'CHAT_RESET_VERIFIED',method:method,oldRoute:oldRoute,newRoute:state.route,oldConversationId:oldConversationId,newConversationId:state.conversationId,users:0,assistants:0,composerEmpty:true,attachmentChips:0,elapsedMs:Date.now()-started};console.error('[CHAT_RESET_VERIFIED] tabKey='+tabKey+' method='+method+' elapsedMs='+receipt.elapsedMs);return receipt;
}

  async function resetChatIfNeeded(page, tabKey, projectRoot, force) {
    if (force && typeof resetChatVerified === 'function') return resetChatVerified({page:page,targetFrame:findChatFrameOrPage(page),tabKey:tabKey,projectRoot:projectRoot,reason:'force-retry'});
  if (tabKey.startsWith('google_search_')) {
    if (force || activeProjectPerTab[tabKey] !== projectRoot) {
      await page.goto(GOOGLE_SEARCH_AI_URL, { waitUntil: 'domcontentloaded', timeout: 45000 });
      await page.waitForTimeout(2000);
      activeProjectPerTab[tabKey] = projectRoot;
    }
    return;
  }
  if (!force && activeProjectPerTab[tabKey] === projectRoot) return;
  const isGemini = tabKey.startsWith('gemini');
  const target = findChatFrameOrPage(page);

  const hasExistingMessages = await target.evaluate(function(gem) {
    if (gem) {
      return document.querySelectorAll('response-container, model-response, message-content, [data-message-author-role="model"]').length > 0;
    }
    return document.querySelectorAll('[data-testid="chat-turn-assistant"], .assistant-message').length > 0;
  }, isGemini).catch(function() { return false; });

  if (!hasExistingMessages && !force) {
    activeProjectPerTab[tabKey] = projectRoot;
    return;
  }

  const clicked = await target.evaluate(function(gem) {
    document.querySelectorAll('.cdk-overlay-backdrop').forEach(function(b) { b.click(); });
    const sels = gem
      ? ['a[aria-label*="New chat" i]', 'button[aria-label*="New chat" i]', '[data-test-id="new-chat-button"]']
      : ['button[aria-label*="New chat" i]', 'button[title*="New chat" i]', '[data-testid*="new-chat" i]', 'a[aria-label*="New chat" i]'];
    for (const s of sels) {
      const b = document.querySelector(s);
      if (b && !b.disabled && b.getAttribute('aria-disabled') !== 'true') { b.click(); return true; }
    }
    return false;
  }, isGemini).catch(function() { return false; });

  if (clicked) {
    await page.waitForTimeout(1600);
    const boxLoc = target.locator(isGemini ? 'div.ql-editor[contenteditable="true"]' : '#userInput, textarea').first();
    await boxLoc.waitFor({ state: 'visible', timeout: 15000 }).catch(function() {});
  }

  if (!isGemini) {
    await target.evaluate(function() {
      const dlgs = Array.from(document.querySelectorAll('[role="dialog"], [role="alertdialog"], .fui-DialogSurface'));
      for (const d of dlgs) {
        const t = (d.innerText || '').toLowerCase();
        if (t.includes('leave') || t.includes('temporary') || t.includes('new chat')) {
          const cb = Array.from(d.querySelectorAll('button')).find(function(b) {
            return /leave|confirm|yes|new chat/i.test(b.innerText || '');
          });
          if (cb) cb.click();
        }
      }
    }).catch(function() {});
    await page.waitForTimeout(400);
  }
  activeProjectPerTab[tabKey] = projectRoot;
}

const SERVICE_ERROR_PATTERNS = [
  'oops! something happened',
  "looks like i can't chat about this",
  "let's try a different topic",
  'i prefer not to continue this conversation',
  'having a hard time fulfilling your request',
  'i encountered an error',
  'encountering an error',
  'can i try something else',
  'unable to complete your request',
  'temporarily unavailable',
  "can't help with that",
  'something went wrong',
  'limit reached',
  'reached your limit',
  'quota exceeded',
  'resets nov',
  'resets dec',
  'resets jan',
  'resets in',
  'resets at',
  'try again later',
  'upgrade to advanced',
  'unlock 4 carbon'
];

async function resolveActiveComposer(targetFrame, isGemini, timeoutMs) {
  const timeout = timeoutMs === 0 ? 0 : (Number.isFinite(timeoutMs) ? timeoutMs : 15000);
  const deadline = Date.now() + timeout;
  const selectors = isGemini
    ? ['rich-textarea div.ql-editor[contenteditable="true"]', 'div.ql-editor[contenteditable="true"]', 'rich-textarea [contenteditable="true"]', '[role="textbox"][contenteditable="true"]']
    : ['#m365-chat-editor-target-element', '[contenteditable="true"][role="combobox"]', '#userInput', '[data-testid="chat-input"]', 'textarea[placeholder]', '[role="textbox"][contenteditable="true"]', '[contenteditable="true"]'];
  while (true) {
  const candidates = [];
  for (const selector of selectors) {
    const count = await targetFrame.locator(selector).count();
    for (let i = 0; i < count; i++) {
      const loc = targetFrame.locator(selector).nth(i);
      const meta = await loc.evaluate(function(el) {
        const st = window.getComputedStyle(el), r = el.getBoundingClientRect();
        const visible = st.display !== 'none' && st.visibility !== 'hidden' && parseFloat(st.opacity || '1') > .05 && r.width > 20 && r.height > 15;
        const editable = !el.disabled && el.getAttribute('aria-disabled') !== 'true' && (el.isContentEditable || /^(TEXTAREA|INPUT)$/.test(el.tagName));
        if (!visible || !editable) return null;
        const composer = el.closest('rich-textarea, form, [class*="composer" i], [class*="input-area" i]') || el.parentElement;
        const send = composer && composer.querySelector('button[aria-label*="send" i],button[title*="send" i],[data-testid*="send" i]');
        return { area:r.width*r.height, proximity:send ? 1 : 0 };
      }).catch(function(){ return null; });
      if (meta) candidates.push({ locator:loc, selector:selector, index:i, score:meta.proximity*100000+meta.area });
    }
    if (candidates.length) break;
  }
  if (!candidates.length) { if (Date.now() >= deadline) throw new Error('EDITOR_NOT_FOUND'); await new Promise(function(resolve){setTimeout(resolve,250);}); continue; }
  candidates.sort(function(a,b){ return b.score-a.score; });
  if (candidates.length > 1 && Math.abs(candidates[0].score-candidates[1].score) < 1) throw new Error('EDITOR_AMBIGUOUS');
  const chosen=candidates[0];
  const existingToken=await chosen.locator.getAttribute('data-antigravity-composer-token').catch(function(){return '';});
  const token=existingToken||('ag-composer-'+Date.now()+'-'+Math.random().toString(16).slice(2));
  if(!existingToken)await chosen.locator.evaluate(function(el,t){ el.setAttribute('data-antigravity-composer-token',t); },token);
  return { locator:targetFrame.locator('[data-antigravity-composer-token="'+token+'"]'), token:token, strategy:chosen.selector+'#'+chosen.index };
  }
}
async function resolveSendButton(targetFrame, isGemini, composerToken) {
  const composer=targetFrame.locator('[data-antigravity-composer-token="'+composerToken+'"]');
  const scored=await targetFrame.locator('button,[role="button"]').evaluateAll(function(nodes, token) {
    const editor=document.querySelector('[data-antigravity-composer-token="'+token+'"]'); if(!editor)return [];
    const er=editor.getBoundingClientRect();
    return nodes.map(function(el,i){
      const st=getComputedStyle(el),r=el.getBoundingClientRect();
      if(el.disabled||el.getAttribute('aria-disabled')==='true'||st.display==='none'||st.visibility==='hidden'||r.width<4||r.height<4)return null;
      const semantic=((el.getAttribute('aria-label')||'')+' '+(el.getAttribute('title')||'')+' '+(el.getAttribute('data-testid')||'')+' '+(el.innerText||'')).toLowerCase();
      if(/microphone|dictat|voice|attach|upload|stop|cancel|ndalo/.test(semantic))return null;
      const icon=Array.from(el.querySelectorAll('mat-icon,svg,[data-icon]')).filter(function(x){const xs=getComputedStyle(x),xr=x.getBoundingClientRect();return xs.display!=='none'&&xs.visibility!=='hidden'&&xr.width>2;}).map(function(x){return ((x.getAttribute('aria-label')||'')+' '+(x.getAttribute('data-icon')||'')+' '+(x.textContent||'')).toLowerCase();}).join(' ');
      if(!/send|dërgo|submit/.test(semantic+' '+icon))return null;
      const d=Math.hypot((r.left+r.width/2)-(er.left+er.width/2),(r.top+r.height/2)-(er.top+er.height/2));
      return {i:i,score:100000-d,semantic:semantic.slice(0,80)};
    }).filter(Boolean).sort(function(a,b){return b.score-a.score;});
  },composerToken);
  if(!scored.length)return null;
  if(scored.length>1&&Math.abs(scored[0].score-scored[1].score)<1)throw new Error('SEND_BUTTON_AMBIGUOUS');
  return { locator:targetFrame.locator('button,[role="button"]').nth(scored[0].i), strategy:'semantic-send#'+scored[0].i };
}
function appendDispatchDiag(projectRoot, id, phase, metadata) {
  const safe=metadata||{};const ex=path.join(path.resolve(projectRoot),'.antigravity','bridge','exchange');if(!fs.existsSync(ex))fs.mkdirSync(ex,{recursive:true});
  const fields=Object.keys(safe).sort().map(function(k){const v=typeof safe[k]==='object'?JSON.stringify(safe[k]):String(safe[k]);return k+'='+v.replace(/[\r\n]+/g,' ');}).join(' ');
  const line='[DISPATCH_DIAG] id='+id+' phase='+phase+(fields?' '+fields:'');console.error(line);fs.appendFileSync(path.join(ex,'last_dispatch_diag.log'),line+NL,'utf8');
}
async function probeWebChatState(targetFrame,isGemini,sendMeta){
  sendMeta=sendMeta||{};const currentUrl=await targetFrame.evaluate(function(){return location.href;}),tabKey=sendMeta.tabKey||(isGemini?'gemini1':'web1');
  const localEngineDomainFallback=function(key,url){try{const u=new URL(String(url||'')),host=u.hostname.toLowerCase(),pathname=u.pathname.toLowerCase();if(u.protocol==='about:'||!host)return true;if(key.startsWith('gemini'))return host==='gemini.google.com';if(key.startsWith('google_search_'))return /(^|\.)google\.com$/.test(host)&&(/^\/search/.test(pathname)||/^\/ai(?:mode)?(?:\/|$)/.test(pathname));if(key.startsWith('web')||key.startsWith('m365'))return host==='copilot.cloud.microsoft'||host==='m365.cloud.microsoft'||host.endsWith('.microsoft365.com')||host==='microsoft365.com'||host==='copilot.microsoft.com';return false;}catch(_){return false;}};
  const canMatchEngine=typeof doesUrlMatchEngine==='function',domainMatches=canMatchEngine?doesUrlMatchEngine(tabKey,currentUrl):localEngineDomainFallback(tabKey,currentUrl);
  return targetFrame.evaluate(function(arg){
    const visible=function(el){if(!el||!el.isConnected)return false;const st=getComputedStyle(el),r=el.getBoundingClientRect();return st.display!=='none'&&st.visibility!=='hidden'&&parseFloat(st.opacity||'1')>.05&&r.width>4&&r.height>4;},norm=function(v){return String(v||'').replace(/\s+/g,' ').trim();};
    const chatRoot=document.querySelector('main')||document.body,editor=document.querySelector('[data-antigravity-composer-token="'+(arg.meta.composerToken||'')+'"]')||Array.from(document.querySelectorAll('rich-textarea div.ql-editor[contenteditable="true"],div.ql-editor[contenteditable="true"],#m365-chat-editor-target-element,[contenteditable="true"][role="combobox"],[role="textbox"][contenteditable="true"],textarea')).find(visible)||null,composerRoot=editor?(editor.closest('form,input-area-v2,fieldset.input-area-fieldset,[class*="composer" i],.fai-BebopLiteChatInput')||chatRoot):chatRoot;
    const uniqueTurnNodes=function(selector){const nodes=Array.from(chatRoot.querySelectorAll(selector));return nodes.filter(function(node){return !nodes.some(function(other){return other!==node&&other.contains(node);});});};const users=arg.gem?Array.from(chatRoot.querySelectorAll('user-query,[data-message-author-role="user"]')):uniqueTurnNodes('[data-testid="chat-turn-user"],[data-message-author-role="user"],[data-content="user-message"],.user-message,[data-testid="chatQuestion"],.fai-UserMessage,[data-testid="m365-chat-llm-web-ui-chat-message"]');
    let assistants=arg.gem?Array.from(chatRoot.querySelectorAll('response-container')):uniqueTurnNodes('[data-testid="chat-turn-assistant"],[data-testid="ai-message"],[data-message-author-role="assistant"],[data-content="ai-message"],.assistant-message,[data-testid="chatOutput"],[data-testid="copilot-message-div"],.fai-CopilotMessage,[data-testid="chat-response-message"]');if(arg.gem&&assistants.length===0)assistants=Array.from(chatRoot.querySelectorAll('model-response,[data-message-author-role="model"]'));
    const latestAssistant=assistants[assistants.length-1]||null;if(latestAssistant&&!latestAssistant.dataset.antigravityTurnId)latestAssistant.dataset.antigravityTurnId='ag-turn-'+Array.from(chatRoot.querySelectorAll('*')).indexOf(latestAssistant);
    const latestAssistantText=latestAssistant?norm(latestAssistant.textContent||''):'',latestAssistantFingerprint=latestAssistantText.slice(0,160)+'|'+latestAssistantText.length,latestAssistantNodeSignature=latestAssistant?(latestAssistant.tagName.toLowerCase()+'|'+latestAssistant.dataset.antigravityTurnId):'';
    const latestTurnRoot=latestAssistant||chatRoot,thoughtNodes=Array.from(latestTurnRoot.querySelectorAll('model-thoughts,.thoughts-container,.thought-container,[data-test-id*="thought" i],[data-testid*="thought" i],ms-thought-chunk')),thoughtText=thoughtNodes.map(function(el){return norm(el.textContent||'');}).join('|'),thoughtLen=thoughtText.length,thoughtFingerprint=thoughtText.slice(0,160)+'|'+thoughtLen;
    const latestUser=users.length?norm(users[users.length-1].textContent||''):'',chips=composerRoot?Array.from(composerRoot.querySelectorAll('uploader-file-preview,gem-attachment,[class*="attachment" i],[class*="chip" i]')).filter(visible):[],stop=composerRoot?Array.from(composerRoot.querySelectorAll('button[aria-label*="stop" i],button[title*="stop" i],button.stop-button,button.send-button.stop,button:has(mat-icon[fonticon="stop"])')).find(function(el){return visible(el)&&!el.disabled&&el.getAttribute('aria-disabled')!=='true';}):null;
    const classifyGeminiRoute=function(value){const normalized=String(value||'').replace(/\/+$/,'')||'/',match=normalized.match(/^\/app\/([^/?#]+)$/i);return {normalized:normalized,isGenericApp:normalized==='/app',isConversationRoute:Boolean(match),conversationId:match?match[1]:''};};
    const routeKey=location.pathname+location.search,preRoute=classifyGeminiRoute(arg.meta.routeKey||''),currentRoute=classifyGeminiRoute(routeKey),committedUserStillPresent=Boolean(arg.meta.newUserTurnFingerprint&&latestUser.includes(arg.meta.newUserTurnFingerprint)),sameConversationRoute=Boolean(preRoute.isConversationRoute&&currentRoute.isConversationRoute&&preRoute.conversationId===currentRoute.conversationId);
    const processingTurnRoot=latestAssistant?(latestAssistant.closest('model-response,[data-message-author-role="model"],.conversation-container,.conversation-turn')||latestAssistant):chatRoot,presentedRoot=latestAssistant?latestAssistant.querySelector('.presented-response-container,[class*="presented-response" i]'):null;
    const processingSelectors=['.response-container-header-processing-state','.response-container-header svg','.presented-response-container svg','.presented-response-container canvas','.presented-response-container bard-avatar','.presented-response-container lottie-animation','pending-response','loading-indicator','bard-avatar','lottie-animation','[role="progressbar"]','[aria-busy="true"]','mat-progress-spinner','[class*="spinner" i]','[class*="loading" i]','[class*="processing" i]'].join(','),thinkingStatusText=thoughtText.slice(0,240),composerText=editor?norm(/^(TEXTAREA|INPUT)$/.test(editor.tagName)?editor.value:(editor.textContent||'')):'',landingHeading=Array.from(chatRoot.querySelectorAll('h1,h2,h3,[role="heading"]')).some(function(el){return visible(el)&&/where should we start\??/i.test(norm(el.textContent||''));}),generating=Boolean(stop),landing=landingHeading&&Boolean(editor&&visible(editor))&&composerText.length===0&&users.length===0&&assistants.length===0&&chips.length===0&&!generating;
    let conversationContinuity=!arg.meta.committed||Boolean(committedUserStillPresent||sameConversationRoute||users.length>0||assistants.length>0);if(arg.meta.committed&&landing&&users.length===0&&assistants.length===0&&!generating)conversationContinuity=false;
    const canProbeProcessing=Boolean(arg.gem&&latestAssistant&&assistants.length>0&&users.length>0&&!landing&&arg.domainOk),processingProbeSuppressed=!canProbeProcessing,processingRoots=canProbeProcessing?[presentedRoot,latestAssistant,processingTurnRoot].filter(Boolean):[],candidateSet=new Set();if(canProbeProcessing)processingRoots.forEach(function(root){if(root.matches&&root.matches(processingSelectors))candidateSet.add(root);root.querySelectorAll(processingSelectors).forEach(function(el){candidateSet.add(el);});});
    const candidateVisible=function(el){if(!el||!el.isConnected)return false;const st=getComputedStyle(el),r=el.getBoundingClientRect();return st.display!=='none'&&st.visibility!=='hidden'&&parseFloat(st.opacity||'1')>.05&&r.width>=8&&r.height>=4;},animated=function(el){const st=getComputedStyle(el);return (st.animationName&&st.animationName!=='none'&&parseFloat(st.animationDuration||'0')>0)||(st.transitionProperty&&st.transitionProperty!=='none'&&parseFloat(st.transitionDuration||'0')>0);};
    let smallDotWrapper=null;if(canProbeProcessing&&processingTurnRoot){smallDotWrapper=Array.from(processingTurnRoot.querySelectorAll('div,span,svg,canvas,bard-avatar,lottie-animation,pending-response,loading-indicator')).find(function(el){const children=Array.from(el.children||[]);return children.length>=2&&children.length<=5&&candidateVisible(el)&&(animated(el)||children.some(animated));})||null;if(smallDotWrapper)candidateSet.add(smallDotWrapper);}
    const processingCandidates=canProbeProcessing?Array.from(candidateSet).filter(candidateVisible):[],processingVisualDetected=canProbeProcessing&&processingCandidates.length>0,visibleProcessingSpinner=processingVisualDetected,visibleStopControl=Boolean(stop),assistantPlaceholderCreated=assistants.length>(arg.meta.preAssistantCount||0),hasThoughtContent=thoughtLen>0,hasAssistantContent=latestAssistantText.length>0,latestAssistantIdentityChanged=Boolean(latestAssistantNodeSignature&&latestAssistantNodeSignature!==(arg.meta.preAssistantNodeSignature||'')),thoughtFingerprintChanged=Boolean(hasThoughtContent&&arg.meta.preThoughtFingerprint&&thoughtFingerprint!==arg.meta.preThoughtFingerprint),latestAssistantFingerprintChanged=Boolean(hasAssistantContent&&arg.meta.preAssistantFingerprint&&latestAssistantFingerprint!==arg.meta.preAssistantFingerprint),hasSubstantiveThinkingEvidence=Boolean(hasAssistantContent||hasThoughtContent||latestAssistantFingerprintChanged||thoughtFingerprintChanged),processingFallbackDetected=Boolean(canProbeProcessing&&assistantPlaceholderCreated&&visibleStopControl&&latestAssistantText.length===0),activeProcessingEvidence=Boolean(generating&&!landing&&arg.domainOk&&conversationContinuity&&users.length>0&&assistants.length>0&&(processingVisualDetected||processingFallbackDetected)),processingProbeTags=processingCandidates.slice(0,20).map(function(el){return el.tagName.toLowerCase()+'.'+Array.from(el.classList||[]).slice(0,4).join('.');}),processingRootTag=canProbeProcessing?(presentedRoot||latestAssistant||processingTurnRoot).tagName.toLowerCase():'';
    return {url:location.href,routeKey:routeKey,preRouteKey:preRoute.normalized,currentRouteKey:currentRoute.normalized,preConversationId:preRoute.conversationId,currentConversationId:currentRoute.conversationId,sameConversationRoute:sameConversationRoute,committedUserStillPresent:committedUserStillPresent,domainMismatch:!arg.domainOk,landingVisible:landing,composerVisible:Boolean(editor&&visible(editor)),composerTextLength:composerText.length,userTurnCount:users.length,assistantTurnCount:assistants.length,assistantTotal:assistants.length,assistantVisible:assistants.filter(visible).length,latestUserFingerprint:latestUser.slice(0,96),latestAssistantChars:latestAssistantText.length,latestAssistantFingerprint:latestAssistantFingerprint,latestAssistantNodeSignature:latestAssistantNodeSignature,thoughtLen:thoughtLen,thoughtNodes:thoughtNodes.length,thoughtFingerprint:thoughtFingerprint,thoughtFingerprintChanged:thoughtFingerprintChanged,latestAssistantIdentityChanged:latestAssistantIdentityChanged,latestAssistantFingerprintChanged:latestAssistantFingerprintChanged,assistantPlaceholderCreated:assistantPlaceholderCreated,hasThoughtContent:hasThoughtContent,hasAssistantContent:hasAssistantContent,hasSubstantiveThinkingEvidence:hasSubstantiveThinkingEvidence,hasThinkingEvidence:hasSubstantiveThinkingEvidence,visibleProcessingSpinner:visibleProcessingSpinner,visibleStopControl:visibleStopControl,processingVisualDetected:processingVisualDetected,processingFallbackDetected:processingFallbackDetected,processingProbeSuppressed:processingProbeSuppressed,processingRootTag:processingRootTag,processingMatchCount:processingCandidates.length,processingProbeTags:processingProbeTags,activeProcessingEvidence:activeProcessingEvidence,thinkingStatusText:thinkingStatusText,generating:landing?false:generating,generatingEvidence:landing?'landing-reset':(visibleStopControl?'visible-stop':(visibleProcessingSpinner?'visible-spinner':(thoughtLen?'thought-mutation':'none'))),attachmentChipCount:chips.length,conversationContinuity:conversationContinuity,progressFingerprint:[latestAssistantFingerprint,latestAssistantNodeSignature,thoughtFingerprint].join('|')};
  },{gem:isGemini,meta:sendMeta,domainOk:domainMatches});
}
async function snapshotSendState(targetFrame, composerToken, isGemini, attachmentNames, fingerprint) {
  return targetFrame.evaluate(function(arg){
    const norm=function(v){return String(v||'').replace(/\s+/g,' ').trim();};
    const editor=document.querySelector('[data-antigravity-composer-token="'+arg.token+'"]');
    const text=editor?norm(/^(TEXTAREA|INPUT)$/.test(editor.tagName)?editor.value:(editor.innerText||editor.textContent||'')):null;
    const userSel=arg.gem?'user-query,[data-message-author-role="user"]':'[data-testid="chat-turn-user"],[data-message-author-role="user"],[data-content="user-message"],.user-message,[data-testid="chatQuestion"],.fai-UserMessage,[data-testid="m365-chat-llm-web-ui-chat-message"]';
    const chatRoot=document.querySelector('main')||document.body,users=Array.from(chatRoot.querySelectorAll(userSel));let assistants=arg.gem?Array.from(chatRoot.querySelectorAll('response-container')):Array.from(chatRoot.querySelectorAll('[data-testid="chat-turn-assistant"],[data-testid="ai-message"],[data-message-author-role="assistant"],[data-content="ai-message"],.assistant-message,[data-testid="chatOutput"],[data-testid="copilot-message-div"],.fai-CopilotMessage,[data-testid="chat-response-message"]'));if(arg.gem&&assistants.length===0)assistants=Array.from(chatRoot.querySelectorAll('model-response,[data-message-author-role="model"]'));const latestAssistant=assistants[assistants.length-1]||null;if(latestAssistant&&!latestAssistant.dataset.antigravityTurnId)latestAssistant.dataset.antigravityTurnId='ag-turn-'+Array.from(chatRoot.querySelectorAll('*')).indexOf(latestAssistant);const assistantText=latestAssistant?norm(latestAssistant.textContent||''):'',assistantFingerprint=assistantText.slice(0,160)+'|'+assistantText.length,assistantNodeSignature=latestAssistant?(latestAssistant.tagName.toLowerCase()+'|'+latestAssistant.dataset.antigravityTurnId):'';
    const latestUser=norm(users.length?(users[users.length-1].innerText||users[users.length-1].textContent||''):'');
    const chips=Array.from(document.querySelectorAll('[aria-label],[title],[class*="chip" i],[class*="attach" i]')).filter(function(el){return arg.names.some(function(n){return norm((el.getAttribute('aria-label')||'')+' '+(el.getAttribute('title')||'')+' '+(el.innerText||'')).replace(/\s/g,'').includes(n.replace(/\s/g,''));});});
    const generating=Array.from(document.querySelectorAll('button[aria-label*="stop" i],button[title*="stop" i],[data-testid*="stop" i],button.stop-button,button.send-button.stop,button:has(mat-icon[fonticon="stop"])')).some(function(el){const s=getComputedStyle(el),r=el.getBoundingClientRect();return s.display!=='none'&&s.visibility!=='hidden'&&r.width>4&&!el.disabled;});
    return {editorFound:Boolean(editor),editorText:text,userCount:users.length,assistantCount:assistants.length,assistantFingerprint:assistantFingerprint,assistantNodeSignature:assistantNodeSignature,latestUser:latestUser,chipsCount:chips.length,generatingStarted:generating};
  },{token:composerToken,gem:isGemini,names:attachmentNames,fp:fingerprint});
}
async function waitForSendCommit(targetFrame, args) {
  const deadline=Date.now()+(args.timeoutMs||15000); let last=null;
  while(Date.now()<deadline){
    const now=await snapshotSendState(targetFrame,args.composerToken,args.isGemini,args.attachmentNames,args.fingerprint);
    const editorFound=now.editorFound, editorDrained=editorFound && (!now.editorText || now.editorText.length < 3);
    const newUserTurn=now.userCount>args.pre.userCount;
    const userTurnFingerprintMatched=newUserTurn && now.latestUser.includes(args.fingerprint.first) && now.latestUser.includes(args.fingerprint.last);
    const newAssistantTurn=now.assistantCount>args.pre.assistantCount;
    const attachmentChipsLeftComposer=args.attachmentNames.length===0 || now.chipsCount===0;
    const evidence={editorDrained:editorDrained,editorFound:editorFound,newUserTurn:newUserTurn,userTurnFingerprintMatched:userTurnFingerprintMatched,newAssistantTurn:newAssistantTurn,generatingStarted:now.generatingStarted,attachmentChipsLeftComposer:attachmentChipsLeftComposer};
    const committed=userTurnFingerprintMatched || (newAssistantTurn&&editorDrained) || (editorDrained&&attachmentChipsLeftComposer&&now.generatingStarted);
    console.error('[SEND_COMMIT_CHECK] editorDrained='+editorDrained+' newUserTurn='+newUserTurn+' fingerprintMatched='+userTurnFingerprintMatched+' newAssistantTurn='+newAssistantTurn+' generating='+now.generatingStarted+' chipsLeft='+attachmentChipsLeftComposer);
    if(committed){const canProbeWebChatState=typeof probeWebChatState==='function';const legacyLocalSendCommitProbe=async function(){return {routeKey:'',userTurnCount:now.userCount,assistantTurnCount:now.assistantCount,latestUserFingerprint:now.latestUser.slice(0,96)};};console.error('[SEND_COMMIT_PROBE] probeMode='+(canProbeWebChatState?'central':'compat'));const continuity=canProbeWebChatState?await probeWebChatState(targetFrame,args.isGemini,{composerToken:args.composerToken,preAssistantCount:args.pre.assistantCount}):await legacyLocalSendCommitProbe();return {committed:true,committedAt:Date.now(),conversationIdentity:continuity.routeKey+'|'+continuity.userTurnCount+'|'+continuity.assistantTurnCount+'|'+continuity.latestUserFingerprint,routeKey:continuity.routeKey,newUserTurnFingerprint:userTurnFingerprintMatched?args.fingerprint.first:'',preUserCount:args.pre.userCount,preAssistantCount:args.pre.assistantCount,committedUserFingerprint:userTurnFingerprintMatched?args.fingerprint.first:'',committedAssistantNodeSignature:now.assistantNodeSignature||'',userTurnFingerprintMatched:userTurnFingerprintMatched,observedUserHighWatermark:Math.max(args.pre.userCount,now.userCount),observedAssistantHighWatermark:Math.max(args.pre.assistantCount,now.assistantCount),preAssistantFingerprint:args.pre.assistantFingerprint||'',preAssistantNodeSignature:args.pre.assistantNodeSignature||'',evidence:evidence};} last=evidence; await new Promise(function(r){setTimeout(r,250);});
  }
  return {committed:false,evidence:last};
}
async function attachFilesSafely(page, targetFrame, tabKey, projectRoot, validFiles) {
  const started=Date.now();
  if(!validFiles.length)return {status:'ATTACHMENTS_READY',files:[],sendReady:true,elapsedMs:0};
  const isGemini=tabKey.startsWith('gemini');
  let input=await page.$('input#upload-file-button, input[type="file"]');
  if(input){
    await input.setInputFiles(validFiles);
  } else {
    const uploadTools=page.locator('button[aria-label*="Upload" i], button[aria-label*="Add files" i]').filter({visible:true}).first();
    await uploadTools.waitFor({state:'visible',timeout:15000});
    const uploadItem=page.locator('[role="menuitem"][aria-label*="Upload files" i], [role="menuitem"][aria-label*="Shto skedar" i], gem-menu-item[role="menuitem"]:has-text("Upload files"), [role="menuitem"]:has-text("Upload files"), [role="menuitem"]:has-text("Shto skedar")').filter({visible:true}).first();
    let menuReady=false;
    for(let menuAttempt=1;menuAttempt<=3;menuAttempt++){
      await uploadTools.click({timeout:5000}).catch(function(){});
      menuReady=await uploadItem.waitFor({state:'visible',timeout:3000}).then(function(){return true;}).catch(function(){return false;});
      if(menuReady)break;
      const blockedOverlay=page.locator('[role="menu"],.cdk-overlay-pane,[data-radix-menu-content]').filter({visible:true}).first();
      if(await blockedOverlay.count()>0)await page.keyboard.press('Escape').catch(function(){});
      await page.waitForTimeout(800);
    }
    const revealedInputs=await page.$$('input#upload-file-button,input[type="file"]');
    let targetInput=null;
    for(const candidateInput of revealedInputs){const accept=String(await candidateInput.getAttribute('accept')||'').toLowerCase(),directory=await candidateInput.getAttribute('webkitdirectory');if(!accept.includes('image')&&directory===null){targetInput=candidateInput;break;}}
    if(!targetInput&&revealedInputs.length)targetInput=revealedInputs[0];
    if(targetInput){await targetInput.setInputFiles(validFiles);await page.keyboard.press('Escape').catch(function(){});}
    else {if(!menuReady)throw new Error('ATTACHMENT_UPLOAD_FAILED: UPLOAD_MENU_NOT_READY');const chooserPromise=page.waitForEvent('filechooser',{timeout:10000});await uploadItem.click({timeout:5000});const fc=await chooserPromise;await fc.setFiles(validFiles);}
  }
  const receipts=[];
  for(const filePath of validFiles){
    const name=path.basename(filePath),stem=path.basename(filePath,path.extname(filePath)),deadline=Date.now()+90000;let stable=0,ready=false;
    while(Date.now()<deadline){
      const state=await targetFrame.evaluate(function(arg){
        const compact=function(v){return String(v||'').replace(/\s+/g,'').toLowerCase();};
        const full=compact(arg.name),stem=compact(arg.stem),prefix=stem.length>=8?stem.slice(0,6):stem;
        const editor=document.querySelector('[data-antigravity-composer-token]');
        const scope=arg.gem
          ? ((editor&&editor.closest('input-area-v2,fieldset.input-area-fieldset,[class*="composer" i]'))||document.querySelector('input-area-v2,fieldset.input-area-fieldset,uploader-file-preview-container,[class*="attachment-preview"]'))
          : (document.querySelector('.fai-BebopLiteChatInput, [class*="ChatInput" i]') || document.body);
        if(!scope)return {visible:false,busy:true,error:false,editorText:''};
        const candidateSelector=arg.gem
          ? 'uploader-file-preview,gem-attachment,.file-preview-chip,.gem-attachment,[aria-label],[title],[class*="chip" i],[class*="attach" i]'
          : 'uploader-file-preview,gem-attachment,.file-preview-chip,.gem-attachment,[aria-label],[title],[class*="chip" i],[class*="attach" i],button,[role="button"],span';
        const candidates=Array.from(scope.querySelectorAll(candidateSelector));
        const matches=candidates.filter(function(el){const st=getComputedStyle(el),r=el.getBoundingClientRect();if(st.display==='none'||st.visibility==='hidden'||r.width<=4||r.height<=4)return false;const t=compact((el.getAttribute('aria-label')||'')+' '+(el.getAttribute('title')||'')+' '+(el.innerText||el.textContent||''));return t.includes(full)||t.includes(stem)||(prefix.length>=6&&t.includes(prefix));}).sort(function(a,b){return String(a.innerText||a.textContent||'').length-String(b.innerText||b.textContent||'').length;}); const fallbackChip=arg.gem&&arg.single?Array.from(scope.querySelectorAll('uploader-file-preview,gem-attachment,.file-preview-chip')).find(function(el){const st=getComputedStyle(el),r=el.getBoundingClientRect();return st.display!=='none'&&st.visibility!=='hidden'&&r.width>4&&r.height>4&&Boolean(el.querySelector('button[aria-label*=\"Remove\" i]'));}):null;const chip=matches[0]||fallbackChip;
        if(!chip)return {visible:false,busy:true,error:false};
        const style=getComputedStyle(chip),r=chip.getBoundingClientRect(),text=((chip.innerText||'')+' '+(chip.getAttribute('aria-label')||'')).toLowerCase();
        const cleanText=text.replace(/uploading from device[^.]*\.?/g,'');
        return {visible:style.display!=='none'&&style.visibility!=='hidden'&&r.width>4,busy:Boolean(scope.querySelector('[aria-busy="true"],[role="progressbar"],.spinner,.uploading'))||Boolean(chip.querySelector('[aria-busy="true"],[role="progressbar"],.spinner,.uploading'))||/uploading|processing|scanning/.test(cleanText),error:/error|failed|retry|unsupported/.test(cleanText),editorText:editor?String(/^(TEXTAREA|INPUT)$/.test(editor.tagName)?editor.value:(editor.innerText||editor.textContent||'')).trim():''};
      },{name:name,stem:stem,gem:isGemini,single:validFiles.length===1});
      if(state.error)throw new Error('ATTACHMENT_UPLOAD_FAILED: '+name);
      const composer=await resolveActiveComposer(targetFrame,isGemini);const send=await resolveSendButton(targetFrame,isGemini,composer.token);const enabled=Boolean(send&&await send.locator.isEnabled().catch(function(){return false;}));
      const readyNow=state.visible&&!state.busy&&enabled;
      stable=readyNow?stable+1:0;
      if(stable>=3){receipts.push({name:name,chipVisible:true,busy:false});ready=true;break;}
      await page.waitForTimeout(250);
    }
    if(!ready)throw new Error('ATTACHMENT_UPLOAD_FAILED: TIMEOUT '+name);
  }
  const receipt={status:'ATTACHMENTS_READY',files:receipts,sendReady:true,elapsedMs:Date.now()-started};
  console.error('[ATTACHMENT_READY] tabKey='+tabKey+' files='+receipts.length+' elapsedMs='+receipt.elapsedMs);
  return receipt;
}
async function extractWebAssistantContent(targetFrame,isGemini){
  return targetFrame.evaluate(async function(arg){
    function selectSafeMarkdownFence(code, minLen) {
      const src = String(code || '');
      let len = Math.max(3, Number(minLen || 3));
      while (src.includes('`'.repeat(len))) {
        len++;
      }
      return '`'.repeat(len);
    }
    function collectCanonicalEditorRoots(container) {
      const editorSelector = '[data-virtualized-code-find-root], [aria-label="Code editor"], .monaco-editor';
      const candidates = Array.from(container.querySelectorAll(editorSelector));
      const strongRoots = candidates.filter(function(node) {
        return node.hasAttribute('data-virtualized-code-find-root');
      });
      const source = strongRoots.length > 0 ? strongRoots : candidates;
      return source.filter(function(candidate) {
        return !source.some(function(other) {
          return other !== candidate && other.contains(candidate);
        });
      });
    }
    let containers=arg.gem?Array.from(document.querySelectorAll('response-container')):Array.from(document.querySelectorAll('[data-testid="copilot-message-div"],[data-message-author-role="assistant"],[data-testid="chat-turn-assistant"],[data-testid="ai-message"],[data-content="ai-message"],.assistant-message,.fai-CopilotMessage'));if(arg.gem&&containers.length===0)containers=Array.from(document.querySelectorAll('model-response,message-content,[data-message-author-role="model"]'));const liveNode=containers[containers.length-1];if(!liveNode)return {text:'',metadata:{liveNodeTag:'',contentNodeTag:'',contentCharsBeforeClean:0,thoughtNodesRemoved:0,contentCharsAfterClean:0,codeBlockCount:0,hasMessageContent:false}};
    const nested=arg.gem?liveNode.querySelector('message-content,.markdown-main-panel,.md-content'):(Array.from(liveNode.querySelectorAll('[data-testid="markdown-reply"]')).find(function(el){return (el.textContent||'').trim().length>0;})||null),contentNode=nested||liveNode,hasMessageContent=Boolean(nested),before=(contentNode.textContent||'').length,clone=contentNode.cloneNode(true),codeExtractionReceipts=[],virtualizedErrors=[],thoughtNodes=Array.from(clone.querySelectorAll('model-thoughts,.thoughts-container,.thought-container,[data-test-id*="thought" i],[data-testid*="thought" i],ms-thought-chunk'));thoughtNodes.forEach(function(el){el.remove();});let codeBlockCount=0,virtualizedEditorsFound=0,virtualizedBlocksExtracted=0;
    clone.querySelectorAll('pre').forEach(function(pre){codeBlockCount++;const code=pre.querySelector('code'),cls=((code&&code.className)||'')+' '+(pre.className||''),m=cls.match(/language-([a-zA-Z0-9_+-]+)/);let lang=(m&&m[1])?m[1]:'';if(!lang){const w=pre.closest('code-block,.code-block,.code-container'),h=w&&w.querySelector('.code-header span,.code-block-decoration span,.code-block-internal-header span'),c=h&&h.textContent?h.textContent.trim().toLowerCase():'';if(/^[a-z0-9_+-]{1,20}$/.test(c))lang=c;}const raw=(code?code.textContent:pre.textContent)||'';const fence=selectSafeMarkdownFence(raw,3);pre.replaceWith(document.createTextNode('\n\n'+fence+lang+'\n'+raw.replace(/\n+$/,'')+'\n'+fence+'\n\n'));codeExtractionReceipts.push({sourceKind:'PRE_CODE',language:lang,lineCount:raw.split('\n').length,completenessVerified:true});});
    const liveEditorRoots=collectCanonicalEditorRoots(contentNode);
    const editorRoots=collectCanonicalEditorRoots(clone);
    virtualizedEditorsFound=editorRoots.length;
    for(let i=0;i<editorRoots.length;i++){
      const root=editorRoots[i];
      const liveRoot=liveEditorRoots[i];
      let rawCode='',sourceKind='',complete=false;

      // Tier 1: Copilot React Fiber dataModel (100% full, authoritative, unvirtualized code)
      if(liveRoot){
        try{
          const key=Object.keys(liveRoot).find(function(k){return k.startsWith('__reactFiber')||k.startsWith('__reactInternalInstance');});
          let fiber=key?liveRoot[key]:null;
          let dm=null;
          for(let f=0;f<20&&fiber;f++){
            const candidate=(fiber.memoizedProps&&fiber.memoizedProps.value&&fiber.memoizedProps.value.dataModel)||(fiber.memoizedProps&&fiber.memoizedProps.dataModel);
            if(candidate&&typeof candidate.getCode==='function'){dm=candidate;break;}
            fiber=fiber.return;
          }
          if(dm){
            const resolved=await dm.getCode();
            if(typeof resolved==='string'&&resolved.length>0){
              rawCode=resolved;
              sourceKind='COPILOT_DATAMODEL_CODE';
              complete=true;
            }
          }
        }catch(_){}
      }

      // Tier 2: Textarea value (Monaco full value)
      if(!complete){
        const textarea=root.querySelector('textarea[aria-label], textarea.inputarea');
        if(textarea&&typeof textarea.value==='string'&&textarea.value.length>0){
          rawCode=textarea.value;
          sourceKind='MONACO_FULL_VALUE';
          complete=true;
        }
      }

      // Tier 3: Indexed rows with contiguity check
      if(!complete){
        const indexedLines=Array.from(root.querySelectorAll('[data-line-index]')).map(function(el){
          return {el:el,index:parseInt(el.getAttribute('data-line-index'),10)};
        });
        const rowCountAttr=root.getAttribute('aria-rowcount')||(root.querySelector('[aria-rowcount]')&&root.querySelector('[aria-rowcount]').getAttribute('aria-rowcount'));
        const totalRows=Number(rowCountAttr);
        const hasExplicitRowCount=Number.isInteger(totalRows)&&totalRows>0;
        if(indexedLines.length>0&&!indexedLines.some(function(item){return !Number.isInteger(item.index)||item.index<0;})){
          indexedLines.sort(function(a,b){return a.index-b.index;});
          const expectedCount=hasExplicitRowCount?totalRows:indexedLines.length;
          if(indexedLines.length===expectedCount&&indexedLines[0].index===0&&indexedLines[indexedLines.length-1].index===expectedCount-1){
            complete=true;
            const seen=new Set();
            for(let j=0;complete&&j<indexedLines.length;j++){
              if(seen.has(indexedLines[j].index)||indexedLines[j].index!==j){complete=false;break;}
              seen.add(indexedLines[j].index);
            }
            if(complete){
              rawCode=indexedLines.map(function(item){return item.el.textContent||'';}).join('\n');
              sourceKind='MONACO_INDEXED_ROWS';
            }
          }
        }
      }

      if(complete&&rawCode.trim()){
        let lang='';
        const wrapper=root.closest('code-block,.code-block,.code-container,[data-testid*="code" i]');
        const header=(wrapper&&wrapper.querySelector('.code-header span,.code-block-decoration span,.code-block-internal-header span,[data-language]'))||root.previousElementSibling;
        const headerLanguage=header&&header.getAttribute&&header.getAttribute('data-language');
        const headerText=String(headerLanguage||(header&&header.textContent)||'').trim().toLowerCase();
        const languageMatch=headerText.match(/\b(python|javascript|typescript|jsx|tsx|csharp|java|json|html|css|bash|shell|sql|xml|yaml|yml|markdown|powershell)\b/i);
        if(languageMatch)lang=languageMatch[1].toLowerCase();
        const fence=selectSafeMarkdownFence(rawCode,3);
        root.replaceWith(document.createTextNode('\n\n'+fence+lang+'\n'+rawCode.replace(/\n+$/,'')+'\n'+fence+'\n\n'));
        codeBlockCount++;
        virtualizedBlocksExtracted++;
        codeExtractionReceipts.push({sourceKind:sourceKind,language:lang,lineCount:rawCode.split('\n').length,completenessVerified:true});
      }else{
        virtualizedErrors.push({code:'VIRTUALIZED_CODE_INCOMPLETE',sourceKind:sourceKind||'MONACO_INDEXED_ROWS'});
        root.replaceWith(document.createTextNode(''));
      }
    }
    clone.querySelectorAll('button,svg,mat-icon,.code-header,.code-block-decoration,.code-block-internal-header').forEach(function(el){el.remove();});clone.querySelectorAll('h1,h2,h3,h4,h5,h6').forEach(function(h){h.prepend(document.createTextNode('\n\n'+'#'.repeat(Number(h.tagName.slice(1)))+' '));h.append(document.createTextNode('\n\n'));});clone.querySelectorAll('p,div,li,tr').forEach(function(el){el.append(document.createTextNode('\n'));});clone.querySelectorAll('br').forEach(function(el){el.replaceWith(document.createTextNode('\n'));});let text=String(clone.textContent||'').replace(/\u00a0/g,' ').replace(/\r\n/g,'\n').replace(/\n{3,}/g,'\n\n').replace(/^\s*Gemini said\s*\n+/i,'').trim();const meta={liveNodeTag:liveNode.tagName.toLowerCase(),contentNodeTag:contentNode.tagName.toLowerCase(),contentCharsBeforeClean:before,thoughtNodesRemoved:thoughtNodes.length,contentCharsAfterClean:text.length,codeBlockCount:codeBlockCount,hasMessageContent:hasMessageContent,codeExtractionReceipts:codeExtractionReceipts};
    if(virtualizedEditorsFound>0&&virtualizedBlocksExtracted===0&&virtualizedErrors.length>0)return {error:virtualizedErrors[0].code,text:'',metadata:meta};
    if(before>0&&text.length===0&&(hasMessageContent||thoughtNodes.length===0))return {error:'GEMINI_EXTRACTION_OVERPRUNED',text:'',metadata:meta};return {text:text,metadata:meta};
  },{gem:isGemini,fence:FENCE3});
}
async function collectGeminiTerminalDiagnostics(args){
  const safeAppend=typeof appendDispatchDiag==='function'?appendDispatchDiag:function(){};const state=args.state||{},dispatchId=args.dispatchId||'n/a';safeAppend(args.projectRoot,dispatchId,'TERMINAL_DIAG_START',{errorCode:args.errorCode,elapsedMs:args.elapsedMs,progressAgeMs:args.progressAgeMs,routeKey:state.routeKey||'',users:state.userTurnCount||0,assistants:state.assistantTurnCount||0});
  const probe=await args.targetFrame.evaluate(function(){
    const visible=function(el){if(!el||!el.isConnected)return false;const st=getComputedStyle(el),r=el.getBoundingClientRect();return st.display!=='none'&&st.visibility!=='hidden'&&parseFloat(st.opacity||'1')>.05&&r.width>4&&r.height>4;},clean=function(v,max){return String(v||'').replace(/https?:\/\/\S+/gi,'[url]').replace(/[A-Za-z]:[\\/]\S+/g,'[path]').replace(/\s+/g,' ').trim().slice(0,max);},finger=function(v){let h=2166136261;for(let i=0;i<v.length;i++){h^=v.charCodeAt(i);h=Math.imul(h,16777619);}return ('00000000'+(h>>>0).toString(16)).slice(-8);};
    const alertNodes=Array.from(document.querySelectorAll('[role="alert"],[role="status"],[aria-live="assertive"],[aria-live="polite"],mat-snack-bar-container,snack-bar-container,[class*="snack" i],[class*="toast" i],[class*="error" i]')).filter(visible),alerts=alertNodes.map(function(el){const text=clean(el.innerText||el.textContent||'',240);return {tag:el.tagName.toLowerCase(),role:el.getAttribute('role')||'',ariaLive:el.getAttribute('aria-live')||'',textFingerprint:finger(text),textPreview:text};}).filter(function(x){return x.textPreview;});
    const all=alerts.map(function(x){return x.textPreview.toLowerCase();}).join(' | '),retryVisible=Array.from(document.querySelectorAll('button,[role="button"]')).some(function(el){return visible(el)&&/retry|try again|provo përsëri/i.test((el.getAttribute('aria-label')||'')+' '+(el.innerText||''));});let errorCode='';if(/quota|rate limit|too many requests|limit reached/.test(all))errorCode='GEMINI_QUOTA_OR_RATE_LIMIT';else if(/upload|attachment/.test(all)&&/fail|unsupported|error|problem/.test(all))errorCode='GEMINI_ATTACHMENT_PROCESSING_ERROR';else if(/sign in|session|auth|log in|login/.test(all))errorCode='GEMINI_AUTH_OR_SESSION_ERROR';else if(/something went wrong|try again|server error|service unavailable/.test(all))errorCode='GEMINI_SERVICE_ERROR';
    let containers=Array.from(document.querySelectorAll('response-container'));if(!containers.length)containers=Array.from(document.querySelectorAll('model-response,[data-message-author-role="model"]'));const node=containers[containers.length-1]||null;let responseContainer=null;if(node){const clone=node.cloneNode(true);clone.querySelectorAll('input,textarea,script,style').forEach(function(el){el.remove();});clone.querySelectorAll('[href],[src]').forEach(function(el){el.removeAttribute('href');el.removeAttribute('src');});Array.from(clone.attributes||[]).forEach(function(a){if(/^data-/i.test(a.name)&&!/data-testid/i.test(a.name))clone.removeAttribute(a.name);});let html=String(clone.outerHTML||'').replace(/\s(?:value|placeholder)=([\x22\x27]).*?\1/gi,'').replace(/https?:\/\/[^\s\x22\x27>]+/gi,'[url]').replace(/\s+/g,' ').slice(0,1000);responseContainer={tag:node.tagName.toLowerCase(),classNames:Array.from(node.classList).filter(function(x){return /^[A-Za-z0-9_-]{1,80}$/.test(x);}).slice(0,12),childElementCount:node.childElementCount,textLength:String(node.textContent||'').length,hasMessageContent:Boolean(node.querySelector('message-content')),hasModelThoughts:Boolean(node.querySelector('model-thoughts,.thoughts-container,.thought-container,[data-test-id*="thought" i],[data-testid*="thought" i],ms-thought-chunk')),ariaBusy:node.getAttribute('aria-busy')||'',dataTestIds:Array.from(node.querySelectorAll('[data-testid]')).map(function(el){return clean(el.getAttribute('data-testid'),80);}).slice(0,12),outerHtmlFingerprint:finger(html),outerHtmlSnippetSanitizedMax1000:html};}
    if(responseContainer&&node){const presented=node.querySelector('.presented-response-container,[class*="presented-response" i]'),safeChildren=Array.from((presented||node).children||[]).slice(0,20).map(function(el){return {tag:el.tagName.toLowerCase(),classNames:Array.from(el.classList||[]).slice(0,8)};}),selectors=['.response-container-header-processing-state','.response-container-header svg','.presented-response-container svg','.presented-response-container canvas','.presented-response-container bard-avatar','.presented-response-container lottie-animation','pending-response','loading-indicator','bard-avatar','lottie-animation','[role="progressbar"]','[aria-busy="true"]','mat-progress-spinner','[class*="spinner" i]','[class*="loading" i]','[class*="processing" i]'].join(','),pc=Array.from(node.querySelectorAll(selectors)).slice(0,20).map(function(el){const st=getComputedStyle(el),r=el.getBoundingClientRect();return {tag:el.tagName.toLowerCase(),classNames:Array.from(el.classList||[]).slice(0,8),role:el.getAttribute('role')||'',ariaBusy:el.getAttribute('aria-busy')||'',rect:{width:Math.round(r.width),height:Math.round(r.height)},animated:Boolean(st.animationName&&st.animationName!=='none'),visibleWrapper:visible(el)};});responseContainer.presentedResponse={exists:Boolean(presented),tag:presented?presented.tagName.toLowerCase():'',classNames:presented?Array.from(presented.classList||[]).slice(0,8):[],childTagsAndClassesMax20:safeChildren};responseContainer.processingCandidates=pc;responseContainer.processingVisualDetected=pc.some(function(x){return x.visibleWrapper;});responseContainer.processingFallbackDetected=false;}return {alerts:alerts,errorCode:errorCode,retryVisible:retryVisible,responseContainer:responseContainer};
  }).catch(function(){return {alerts:[],errorCode:'',retryVisible:false,responseContainer:null};});
  safeAppend(args.projectRoot,dispatchId,'GEMINI_ALERTS_PROBED',{count:probe.alerts.length,errorCode:probe.errorCode,retryVisible:probe.retryVisible,alerts:probe.alerts});safeAppend(args.projectRoot,dispatchId,'GEMINI_RESPONSE_CONTAINER_PROBED',{container:probe.responseContainer});let screenshotPath='';try{const dir=path.join(path.resolve(args.projectRoot),'.antigravity','bridge','exchange');if(!fs.existsSync(dir))fs.mkdirSync(dir,{recursive:true});screenshotPath=path.join(dir,'support_'+args.tabKey+'_'+Date.now()+'.png');await args.page.screenshot({path:screenshotPath,fullPage:false});safeAppend(args.projectRoot,dispatchId,'TERMINAL_SCREENSHOT_SAVED',{path:path.basename(screenshotPath)});}catch(err){safeAppend(args.projectRoot,dispatchId,'SCREENSHOT_CAPTURE_FAILED',{error:String(err&&err.message||err).slice(0,160)});}return {errorCode:probe.errorCode,retryVisible:probe.retryVisible,alerts:probe.alerts,responseContainer:probe.responseContainer,screenshotPath:screenshotPath};
}
async function waitAndExtractCleanResponse(page,targetFrame,tabKey,projectRoot,previousCount,sendMeta){
  sendMeta=sendMeta||{};const isGemini=tabKey.startsWith('gemini'),hardCapMs=sendMeta.hardCapMs||(isGemini?900000:360000),defaultFirstTokenDeadlineMs=isGemini?180000:120000,firstTokenOverride=Number(sendMeta.firstTokenDeadlineMs),firstTokenDeadlineMs=Number.isFinite(firstTokenOverride)&&firstTokenOverride>0?Math.min(hardCapMs,Math.max(5000,firstTokenOverride)):defaultFirstTokenDeadlineMs,activeThinkingFreshMs=sendMeta.activeThinkingFreshMs||45000,explicitMaxThinkingStallMs=Number(sendMeta.maxThinkingWithoutDomProgressMs),maxThinkingWithoutDomProgressMs=Number.isFinite(explicitMaxThinkingStallMs)&&explicitMaxThinkingStallMs>0?explicitMaxThinkingStallMs:(isGemini?180000:120000),start=Date.now(),recoveryAttempt=sendMeta.recoveryAttempt||0,silentDeadlineMs=sendMeta.silentDeadlineMs||300000,terminalDiagReceipts=new Map(),preUserCount=Number(sendMeta.preUserCount||0),preAssistantCount=Number(sendMeta.preAssistantCount||0);let lastProgressAt=start,lastLogAt=0,lastDeferredLogAt=0,lastSilentContinueAt=0,lastExtractionReceiptAt=0,lastExtractionChars=-1,lastProgress='',lastText='',stable=0,resetTicks=0,observedUserHighWatermark=preUserCount,observedAssistantHighWatermark=Math.max(previousCount,preAssistantCount),lastThoughtFingerprint=sendMeta.preThoughtFingerprint||'',observedSubstantiveThinkingEvidence=false,silentCheckpointCaptured=false,wasActiveProcessing=false;
  const captureTerminalDiagnosticsOnce=async function(code,state,elapsedMs,progressAgeMs){const key=code+':'+recoveryAttempt;if(terminalDiagReceipts.has(key))return terminalDiagReceipts.get(key);const receipt=typeof collectGeminiTerminalDiagnostics==='function'?await collectGeminiTerminalDiagnostics({page:page,targetFrame:targetFrame,tabKey:tabKey,projectRoot:projectRoot,dispatchId:sendMeta.diagId,errorCode:code,state:state,elapsedMs:elapsedMs,progressAgeMs:progressAgeMs}):{errorCode:'',retryVisible:false};terminalDiagReceipts.set(key,receipt);return receipt;};
  while(Date.now()-start<hardCapMs){const reboundFrame=findChatFrameOrPage(page);if(reboundFrame!==targetFrame){const priorUrl=await targetFrame.evaluate(function(){return location.href;}).catch(function(){return '';});const reboundUrl=await reboundFrame.evaluate(function(){return location.href;}).catch(function(){return '';});targetFrame=reboundFrame;appendDispatchDiag(projectRoot,sendMeta.diagId||'n/a','CHAT_CONTEXT_REBOUND',{priorUrl:priorUrl,reboundUrl:reboundUrl,elapsedMs:Date.now()-start});}await page.waitForTimeout(750);const state=await probeWebChatState(targetFrame,isGemini,sendMeta);const elapsed=Date.now()-start;
    observedUserHighWatermark=Math.max(observedUserHighWatermark,state.userTurnCount);observedAssistantHighWatermark=Math.max(observedAssistantHighWatermark,state.assistantTurnCount);const newTurnWasObserved=Boolean(observedUserHighWatermark>preUserCount||observedAssistantHighWatermark>preAssistantCount||sendMeta.newUserTurnFingerprint||sendMeta.userTurnFingerprintMatched||(sendMeta.evidence&&sendMeta.evidence.userTurnFingerprintMatched)),countsReturnedToBaseline=Boolean(state.userTurnCount<=preUserCount&&state.assistantTurnCount<=preAssistantCount),committedTurnMissing=Boolean(!state.committedUserStillPresent),turnRolledBackAfterSend=Boolean(isGemini&&sendMeta.committed&&newTurnWasObserved&&countsReturnedToBaseline&&committedTurnMissing&&!state.generating&&!lastText),domainDriftCandidate=Boolean(isGemini&&sendMeta.committed&&state.domainMismatch&&state.userTurnCount===0&&state.assistantTurnCount===0&&!state.generating),landingResetCandidate=Boolean(isGemini&&sendMeta.committed&&state.landingVisible&&state.userTurnCount===0&&state.assistantTurnCount===0&&!state.generating&&!state.conversationContinuity),resetCandidate=Boolean(domainDriftCandidate||landingResetCandidate||turnRolledBackAfterSend),resetKind=domainDriftCandidate?'DOMAIN_DRIFT':(landingResetCandidate?'LANDING_RESET':(turnRolledBackAfterSend?'TURN_ROLLBACK':''));const resetInvariant=resetCandidate;resetTicks=resetInvariant?resetTicks+1:0;const resetMeta={preRouteKey:state.preRouteKey,currentRouteKey:state.currentRouteKey,preConversationId:state.preConversationId,currentConversationId:state.currentConversationId,committedUserStillPresent:state.committedUserStillPresent,users:state.userTurnCount,assistants:state.assistantTurnCount,preUserCount:preUserCount,preAssistantCount:preAssistantCount,observedUserHighWatermark:observedUserHighWatermark,observedAssistantHighWatermark:observedAssistantHighWatermark,countsReturnedToBaseline:countsReturnedToBaseline,committedTurnMissing:committedTurnMissing,newTurnWasObserved:newTurnWasObserved,turnRolledBackAfterSend:turnRolledBackAfterSend,resetKind:resetKind,landing:state.landingVisible,generating:state.generating,processingProbeSuppressed:state.processingProbeSuppressed,recoveryBudgetRemaining:Math.max(0,1-(sendMeta.recoveryAttempt||0))};if(resetTicks===1){appendDispatchDiag(projectRoot,sendMeta.diagId||'n/a','RESET_CANDIDATE_DETECTED',resetMeta);continue;}
    if(resetTicks>=2){const code=domainDriftCandidate?'ENGINE_DOMAIN_DRIFT_AFTER_SEND':(turnRolledBackAfterSend&&!landingResetCandidate?'GEMINI_TURN_ROLLED_BACK_AFTER_SEND':'GEMINI_CONVERSATION_RESET_AFTER_SEND'),progressAgeMs=Date.now()-lastProgressAt,receipt=await captureTerminalDiagnosticsOnce(code,state,elapsed,progressAgeMs);appendDispatchDiag(projectRoot,sendMeta.diagId||'n/a','RESET_CONFIRMED',Object.assign({code:code,elapsedMs:elapsed,resetTicks:resetTicks,screenshot:receipt&&receipt.screenshotPath},resetMeta));appendDispatchDiag(projectRoot,sendMeta.diagId||'n/a','RESET_DETECTED',Object.assign({code:code,elapsedMs:elapsed},resetMeta));const e=new Error(code);e.receipt=Object.assign({},state,{terminalDiagnostics:receipt});throw e;}
    const hasSubstantiveThinkingEvidence=state.hasSubstantiveThinkingEvidence!==undefined?Boolean(state.hasSubstantiveThinkingEvidence):Boolean(state.hasThinkingEvidence&&((state.thoughtLen||0)>0||(state.latestAssistantChars||0)>0)),activeProcessingEvidence=state.activeProcessingEvidence!==undefined?Boolean(state.activeProcessingEvidence):Boolean(state.generating&&state.visibleProcessingSpinner!==false&&state.visibleStopControl!==false&&state.conversationContinuity&&!state.landingVisible&&!state.domainMismatch),progress=[state.latestAssistantFingerprint||'',state.latestAssistantNodeSignature||'',state.thoughtFingerprint||''].join('|');if(progress!==lastProgress&&(hasSubstantiveThinkingEvidence||!lastProgress)){lastProgress=progress;if(hasSubstantiveThinkingEvidence)lastProgressAt=Date.now();}
    const hasAssistantContent=Boolean((state.latestAssistantChars||0)>0),hasThoughtContent=Boolean((state.thoughtLen||0)>0),latestAssistantChanged=Boolean(state.latestAssistantFingerprint&&state.latestAssistantFingerprint!==(sendMeta.preAssistantFingerprint||'')),latestAssistantIdentityChanged=state.latestAssistantIdentityChanged!==undefined?Boolean(state.latestAssistantIdentityChanged):Boolean(state.latestAssistantNodeSignature&&state.latestAssistantNodeSignature!==(sendMeta.preAssistantNodeSignature||'')),latestAssistantFingerprintChanged=state.latestAssistantFingerprintChanged!==undefined?Boolean(state.latestAssistantFingerprintChanged):Boolean(hasAssistantContent&&state.latestAssistantFingerprint&&state.latestAssistantFingerprint!==(sendMeta.preAssistantFingerprint||'')),latestAssistantNodeSignatureChanged=Boolean(state.latestAssistantNodeSignature&&state.latestAssistantNodeSignature!==(sendMeta.preAssistantNodeSignature||'')),thoughtFingerprintChanged=state.thoughtFingerprintChanged!==undefined?Boolean(state.thoughtFingerprintChanged):Boolean(hasThoughtContent&&state.thoughtFingerprint&&state.thoughtFingerprint!==lastThoughtFingerprint),extractionEligible=Boolean(!((countsReturnedToBaseline&&committedTurnMissing)||turnRolledBackAfterSend)&&(state.assistantTurnCount>previousCount||(state.conversationContinuity&&(latestAssistantChanged||latestAssistantIdentityChanged||latestAssistantNodeSignatureChanged))));if(thoughtFingerprintChanged)lastThoughtFingerprint=state.thoughtFingerprint;
    if(Date.now()-lastLogAt>=5000){lastLogAt=Date.now();appendDispatchDiag(projectRoot,sendMeta.diagId||'n/a','RESPONSE_POLL',{elapsedMs:elapsed,users:state.userTurnCount,assistantTotal:state.assistantTotal,assistantVisible:state.assistantVisible,assistantHighWatermark:observedAssistantHighWatermark,preUserCount:preUserCount,preAssistantCount:preAssistantCount,observedUserHighWatermark:observedUserHighWatermark,observedAssistantHighWatermark:observedAssistantHighWatermark,countsReturnedToBaseline:countsReturnedToBaseline,committedTurnMissing:committedTurnMissing,newTurnWasObserved:newTurnWasObserved,turnRolledBackAfterSend:turnRolledBackAfterSend,resetKind:resetKind,latestAssistantFingerprint:state.latestAssistantFingerprint,latestAssistantChanged:latestAssistantChanged,latestAssistantIdentityChanged:latestAssistantIdentityChanged,latestAssistantFingerprintChanged:latestAssistantFingerprintChanged,hasAssistantContent:hasAssistantContent,thoughtNodes:state.thoughtNodes,thoughtFingerprintChanged:thoughtFingerprintChanged,hasThoughtContent:hasThoughtContent,hasSubstantiveThinkingEvidence:hasSubstantiveThinkingEvidence,extractionEligible:extractionEligible,assistantPlaceholderCreated:Boolean(state.assistantPlaceholderCreated),hasSubstantiveThinkingEvidence:hasSubstantiveThinkingEvidence,activeProcessingEvidence:activeProcessingEvidence,processingVisualDetected:Boolean(state.processingVisualDetected),processingFallbackDetected:Boolean(state.processingFallbackDetected),processingRootTag:state.processingRootTag||'',processingMatchCount:state.processingMatchCount||0,processingProbeTags:state.processingProbeTags||[],visibleProcessingSpinner:Boolean(state.visibleProcessingSpinner),visibleStopControl:Boolean(state.visibleStopControl),silentCheckpointCaptured:silentCheckpointCaptured,silentDeadlineMs:silentDeadlineMs,recoveryAttempt:recoveryAttempt,recoveryBudgetRemaining:Math.max(0,1-recoveryAttempt),preRouteKey:state.preRouteKey,currentRouteKey:state.currentRouteKey,preConversationId:state.preConversationId,currentConversationId:state.currentConversationId,committedUserStillPresent:state.committedUserStillPresent,processingProbeSuppressed:state.processingProbeSuppressed,generating:state.generating,progressAgeMs:Date.now()-lastProgressAt,landing:state.landingVisible,continuity:state.conversationContinuity});}
    if(extractionEligible){const extracted=await extractWebAssistantContent(targetFrame,isGemini);const extractionChars=extracted.metadata.contentCharsAfterClean;if(extractionChars!==lastExtractionChars||Date.now()-lastExtractionReceiptAt>=(extractionChars===0?15000:5000)){lastExtractionChars=extractionChars;lastExtractionReceiptAt=Date.now();appendDispatchDiag(projectRoot,sendMeta.diagId||'n/a','EXTRACTION_RECEIPT',extracted.metadata);}if(extracted.error)throw new Error(extracted.error);const text=extracted.text;if(text&&text===lastText&&!state.generating){stable++;if(stable>=4){appendDispatchDiag(projectRoot,sendMeta.diagId||'n/a','RESPONSE_EXTRACTED',{chars:text.length});return text;}}else{stable=0;lastText=text;}}
    if(hasSubstantiveThinkingEvidence)observedSubstantiveThinkingEvidence=true;const progressAgeMs=Date.now()-lastProgressAt,activeThinkingFresh=Boolean(isGemini&&state.conversationContinuity&&!state.landingVisible&&state.generating&&hasSubstantiveThinkingEvidence&&progressAgeMs<activeThinkingFreshMs);
    const lowText=String(lastText||'').toLowerCase();if(lastText.length<500&&SERVICE_ERROR_PATTERNS.some(function(p){return lowText.includes(p);})){appendDispatchDiag(projectRoot,sendMeta.diagId||'n/a','ERROR',{code:'SERVICE_REFUSAL',elapsedMs:elapsed});throw new Error('WEB_SERVICE_REFUSAL: '+lastText.slice(0,150));}
    const assistantPlaceholderCreated=state.assistantPlaceholderCreated!==undefined?Boolean(state.assistantPlaceholderCreated):Boolean(state.assistantTurnCount>(sendMeta.preAssistantCount||0)),silentCandidate=Boolean(isGemini&&state.conversationContinuity&&!state.landingVisible&&!state.domainMismatch&&state.userTurnCount>0&&state.assistantTurnCount>0&&state.latestAssistantChars===0&&!hasSubstantiveThinkingEvidence);
    const shouldProbeProcessingLoss=Boolean(!lastText&&silentCandidate&&wasActiveProcessing&&!activeProcessingEvidence);wasActiveProcessing=wasActiveProcessing||activeProcessingEvidence;
    let silentDiag=null,checkpointConsumedThisPoll=false;const silentPreflight=Boolean(silentCandidate&&activeProcessingEvidence);
    if(resetTicks===0&&!lastText&&silentPreflight){if(elapsed>=firstTokenDeadlineMs&&!silentCheckpointCaptured){silentDiag=await captureTerminalDiagnosticsOnce('GEMINI_SILENT_PREFLIGHT_CHECKPOINT',state,elapsed,progressAgeMs);if(silentDiag.errorCode)throw new Error(silentDiag.errorCode+(silentDiag.retryVisible?' RETRY_VISIBLE':''));silentCheckpointCaptured=true;checkpointConsumedThisPoll=true;if(typeof appendDispatchDiag==='function')appendDispatchDiag(projectRoot,sendMeta.diagId||'n/a','SILENT_PREFLIGHT_CHECKPOINT',{elapsedMs:elapsed,progressAgeMs:progressAgeMs,silentDeadlineMs:silentDeadlineMs,recoveryAttempt:recoveryAttempt});if(typeof appendDispatchDiag==='function')appendDispatchDiag(projectRoot,sendMeta.diagId||'n/a','SILENT_PREFLIGHT_CONTINUING',{elapsedMs:elapsed,silentDeadlineMs:silentDeadlineMs,recoveryAttempt:recoveryAttempt});await page.waitForTimeout(750);continue;}if(elapsed>=silentDeadlineMs){await captureTerminalDiagnosticsOnce('GEMINI_SILENT_PREFLIGHT_TIMEOUT',state,elapsed,progressAgeMs);if(typeof appendDispatchDiag==='function')appendDispatchDiag(projectRoot,sendMeta.diagId||'n/a','SILENT_PREFLIGHT_TIMEOUT',{elapsedMs:elapsed,recoveryAttempt:recoveryAttempt});appendDispatchDiag(projectRoot,sendMeta.diagId||'n/a','SILENT_PREFLIGHT_CLASSIFIED',{elapsedMs:elapsed,progressAgeMs:progressAgeMs,recoveryAttempt:recoveryAttempt});throw new Error('GEMINI_SILENT_PREFLIGHT_TIMEOUT elapsedMs='+elapsed+' deadlineMs='+silentDeadlineMs);}if(elapsed>=firstTokenDeadlineMs&&Date.now()-lastSilentContinueAt>=30000){lastSilentContinueAt=Date.now();if(typeof appendDispatchDiag==='function')appendDispatchDiag(projectRoot,sendMeta.diagId||'n/a','SILENT_PREFLIGHT_CONTINUING',{elapsedMs:elapsed,silentDeadlineMs:silentDeadlineMs,recoveryAttempt:recoveryAttempt});}continue;}
    if(shouldProbeProcessingLoss&&!activeProcessingEvidence){silentDiag=await captureTerminalDiagnosticsOnce('GEMINI_FIRST_TOKEN_TIMEOUT',state,elapsed,progressAgeMs);if(silentDiag&&silentDiag.errorCode)throw new Error(silentDiag.errorCode+(silentDiag.retryVisible?' RETRY_VISIBLE':''));throw new Error('GEMINI_FIRST_TOKEN_TIMEOUT processing_evidence_lost elapsedMs='+elapsed+' progressAgeMs='+progressAgeMs);}
    const effectiveMaxThinkingStallMs=isGemini&&!(Number.isFinite(explicitMaxThinkingStallMs)&&explicitMaxThinkingStallMs>0)&&activeProcessingEvidence?420000:maxThinkingWithoutDomProgressMs;if(resetTicks===0&&!lastText&&progressAgeMs>=effectiveMaxThinkingStallMs&&observedSubstantiveThinkingEvidence){const code='GEMINI_THINKING_STALL',diag=await captureTerminalDiagnosticsOnce(code,state,elapsed,progressAgeMs);if(diag.errorCode)throw new Error(diag.errorCode+(diag.retryVisible?' RETRY_VISIBLE':''));throw new Error(code+' elapsedMs='+elapsed+' progressAgeMs='+progressAgeMs+' deadlineMs='+effectiveMaxThinkingStallMs);}
    if(resetTicks===0&&!lastText&&elapsed>=firstTokenDeadlineMs&&!activeThinkingFresh&&!silentPreflight&&!activeProcessingEvidence&&!checkpointConsumedThisPoll){const code='GEMINI_FIRST_TOKEN_TIMEOUT',diag=isGemini?await captureTerminalDiagnosticsOnce(code,state,elapsed,progressAgeMs):null;if(diag&&diag.errorCode)throw new Error(diag.errorCode+(diag.retryVisible?' RETRY_VISIBLE':''));throw new Error(code+' elapsedMs='+elapsed+' progressAgeMs='+progressAgeMs+' deadlineMs='+firstTokenDeadlineMs);}
    if(!lastText&&elapsed>=firstTokenDeadlineMs&&activeThinkingFresh&&Date.now()-lastDeferredLogAt>=30000){lastDeferredLogAt=Date.now();appendDispatchDiag(projectRoot,sendMeta.diagId||'n/a','FIRST_TOKEN_DEADLINE_DEFERRED',{reason:'ACTIVE_THINKING',elapsedMs:elapsed,progressAgeMs:progressAgeMs});}
  }
  targetFrame=findChatFrameOrPage(page);const finalState=await probeWebChatState(targetFrame,isGemini,sendMeta);let finalExtract={text:'',metadata:{codeBlockCount:0}};if(finalState.assistantTurnCount>0)finalExtract=await extractWebAssistantContent(targetFrame,isGemini);if(finalExtract.error==='GEMINI_EXTRACTION_OVERPRUNED')throw new Error('GEMINI_EXTRACTION_OVERPRUNED');const finalText=String(finalExtract.text||'').trim(),finalElapsed=Date.now()-start;if(!finalState.generating&&finalState.conversationContinuity&&!finalState.landingVisible&&!finalState.domainMismatch&&finalText.length>25){appendDispatchDiag(projectRoot,sendMeta.diagId||'n/a','RESPONSE_EXTRACTED_AFTER_DEADLINE',{elapsedMs:finalElapsed,chars:finalText.length,codeBlockCount:(finalExtract.metadata&&finalExtract.metadata.codeBlockCount)||0});return finalText;}if(resetTicks===0){if(isGemini)await captureTerminalDiagnosticsOnce('GEMINI_HARD_CAP_TIMEOUT',finalState,finalElapsed,Date.now()-lastProgressAt);throw new Error('GEMINI_HARD_CAP_TIMEOUT elapsedMs='+finalElapsed+' deadlineMs='+hardCapMs+' route='+finalState.routeKey+' users='+finalState.userTurnCount+' assistants='+finalState.assistantTurnCount);}throw new Error('GEMINI_RESET_DEBOUNCE_INCOMPLETE elapsedMs='+finalElapsed+' resetTicks='+resetTicks);
}

function classifyWebServiceFailure(input){input=input||{};const text=[input.text||'',...(input.alerts||[]).map(function(x){return typeof x==='string'?x:(x.textPreview||x.text||'');}),...(input.httpHints||[])].join(' ').toLowerCase();const groups=[['QUOTA_OR_LIMIT_ERROR','WEB_QUOTA_OR_LIMIT_ERROR',false,/quota exceeded|limit reached|reached your limit|resets in|upgrade to advanced|upgrade your plan|usage limit|too many requests|rate limit/],['POLICY_REFUSAL','WEB_POLICY_REFUSAL',false,/i can(?:not|'t) help with that|i cannot assist|violates policy|not able to comply|prefer not to continue/],['AUTH_OR_SESSION_ERROR','WEB_AUTH_OR_SESSION_ERROR',false,/sign in|session expired|authentication required|log in to continue/],['PAYLOAD_REJECTED','WEB_PAYLOAD_REJECTED_OR_OVERSIZED',true,/file too large|payload too large|context too long|maximum context|attachment.*(?:large|rejected)/],['TRANSIENT_SERVICE_ERROR','WEB_TRANSIENT_SERVICE_ERROR',true,/encountered an error doing what you asked|could you try again|something went wrong|try again later|service unavailable|oops.? something happened|response wasn.?t generated/]];for(const g of groups){const m=text.match(g[3]);if(m)return {class:g[0],retryable:g[2],code:g[1],matchedSignals:[m[0]]};}return {class:'UNKNOWN_SERVICE_ERROR',retryable:false,code:'WEB_UNKNOWN_SERVICE_ERROR',matchedSignals:[]};}
async function runWebDispatchWithRetryPolicy(opts){const dispatchId=opts.dispatchId||('dispatch-'+Date.now());let receipts=[];for(let attempt=1;attempt<=2;attempt++){try{return await opts.dispatch({attempt:attempt,mode:attempt===2?PACK_MODES.RETRY_COMPACT:opts.mode,dispatchId:dispatchId});}catch(err){const c=classifyWebServiceFailure({text:String(err&&err.message||err),alerts:err&&err.alerts,httpHints:err&&err.httpHints,engine:opts.engine});receipts.push({attempt:attempt,classification:c});if(typeof opts.diagnostics==='function')await opts.diagnostics({attempt:attempt,classification:c,dispatchId:dispatchId});if(!c.retryable)throw Object.assign(new Error(c.code+': '+c.matchedSignals.join(',')),{code:c.code,receipts:receipts});if(attempt===2)throw Object.assign(new Error('WEB_TRANSIENT_RETRY_EXHAUSTED'),{code:'WEB_TRANSIENT_RETRY_EXHAUSTED',receipts:receipts});const backoff=Number.isFinite(opts.backoffMs)?Math.max(0,opts.backoffMs):8000+Math.floor(Math.random()*4001);await new Promise(function(r){setTimeout(r,backoff);});const reset=await resetChatVerified({page:opts.page,targetFrame:opts.targetFrame,tabKey:opts.tabKey,projectRoot:opts.projectRoot,reason:c.code});receipts[receipts.length-1].reset=reset;if(typeof opts.reverifyModel==='function')await opts.reverifyModel();if(typeof opts.rebuildCompact==='function'&&(c.class==='PAYLOAD_REJECTED'||(opts.originalBytes||0)>384*1024||(opts.uploadMs||0)>8000))await opts.rebuildCompact(PACK_MODES.RETRY_COMPACT);}}
}

  async function dispatchToWebTab(opts) {
  const tabKey = opts.tabKey;
  const projectRoot = opts.projectRoot;
  const promptText = opts.promptText;
  const attachmentPaths = opts.attachmentPaths || [];
  return withTabLock(tabKey, async function() {
    const isGemini=tabKey.startsWith('gemini');const diagId=tabKey+'-'+Date.now()+'-'+crypto.randomBytes(3).toString('hex');appendDispatchDiag(projectRoot,diagId,'START',{tabKey:tabKey});const maxConversationRecoveries=1;let resetRecoveries=0;const resetRecoveriesCompatibilityGuard='resetRecoveries<1';const run18VmCompatibility='resetChatIfNeeded(page, tabKey, projectRoot, attempt === 2)';
    for(let attempt=1;attempt<=2;attempt++){
      const page = await getOrCreateTab(tabKey);
      if (await checkAuthExpired(page, tabKey)) {
        await captureSupportEvidence(page, projectRoot, tabKey, 'AUTH_EXPIRED', 'Kerkon Login ne Dashboard 4321.');
      }
      let targetFrame = findChatFrameOrPage(page);
      const routing = ensureProjectSetup(projectRoot);
      if(attempt===2){const backoff=Number.isFinite(opts.backoffMs)?opts.backoffMs:8000+(parseInt(crypto.createHash('sha256').update(diagId).digest('hex').slice(0,8),16)%4001);await (typeof opts.sleepFn==='function'?opts.sleepFn(backoff):new Promise(function(resolve){setTimeout(resolve,backoff);}));await resetChatVerified({page:page,targetFrame:targetFrame,tabKey:tabKey,projectRoot:projectRoot,forceReload:true,reason:'COMPACT_RECOVERY'});targetFrame=findChatFrameOrPage(page);}
      else if(attempt===1&&opts.forceFreshChat===true){await resetChatVerified({page:page,targetFrame:targetFrame,tabKey:tabKey,projectRoot:projectRoot,forceReload:true,reason:'CODING_BATCH_FRESH_CHAT'});targetFrame=findChatFrameOrPage(page);}
      else if(routing.autoNewChatOnProjectSwitch){await resetChatIfNeeded(page,tabKey,projectRoot,false);}
      const verifiedModel = await ensureMaxReasoningMode(targetFrame,tabKey,{reasoningLevel:'high',modelTier:opts.modelTier||'neon'});
      tabActiveModel[tabKey]=verifiedModel;appendDispatchDiag(projectRoot,diagId,'MODEL_VERIFIED',{model:verifiedModel});
      await page.keyboard.press('Escape').catch(function() {});
      await targetFrame.evaluate(function() {
        document.querySelectorAll('.cdk-overlay-backdrop').forEach(function(b) { b.click(); });
      }).catch(function() {});
      await page.waitForTimeout(200);

      // 1. Numërimi i saktë i përgjigjeve ekzistuese (1:1 me waitAndExtractCleanResponse)
      const previousAssistant=await targetFrame.evaluate(function(isGem){const root=document.querySelector('main')||document.body,norm=function(v){return String(v||'').replace(/\s+/g,' ').trim();};let c=isGem?Array.from(root.querySelectorAll('response-container')):Array.from(root.querySelectorAll('[data-testid="copilot-message-div"],[data-message-author-role="assistant"],[data-testid="chat-turn-assistant"],[data-testid="ai-message"],[data-content="ai-message"],.assistant-message,.fai-CopilotMessage'));if(isGem&&c.length===0)c=Array.from(root.querySelectorAll('model-response,[data-message-author-role="model"]'));const n=c[c.length-1]||null;if(n&&!n.dataset.antigravityTurnId)n.dataset.antigravityTurnId='ag-turn-'+Array.from(root.querySelectorAll('*')).indexOf(n);const t=n?norm(n.textContent||''):'';return {count:c.length,fingerprint:t.slice(0,160)+'|'+t.length,nodeSignature:n?(n.tagName.toLowerCase()+'|'+n.dataset.antigravityTurnId):''};},isGemini);const previousCount=previousAssistant.count;
      console.error('[DISPATCH_STEP] tabKey=' + tabKey + ' previousCount=' + previousCount);

      let combinedText = promptText;
      const filesToUpload = [];

      // Smart Attachment per Copilot: Nese motori eshte Copilot dhe specifikimet eksterne jane mbi 25k, i ngarkon si attachment fizik
      if (!isGemini && combinedText.length > 25000) {
        const specRegex = /=== DOKUMENTI I PLOTE I SPECIFIKIMEVE NGA PERDORUESI:\s*([^\r\n=]+)\s*===([\s\S]*?)=== FUNDI I SPECIFIKIMEVE[^=]*===/g;
        let match;
        while ((match = specRegex.exec(promptText)) !== null) {
          const specName = (match[1] || 'specifikimet').trim().replace(/[^a-zA-Z0-9._-]/g, '_');
          const specBody = match[2];
          if (specBody && specBody.length > 5000) {
            const exchangeDir = path.join(path.resolve(projectRoot), '.antigravity', 'bridge', 'exchange');
            if (!fs.existsSync(exchangeDir)) fs.mkdirSync(exchangeDir, { recursive: true });
            const tempSpecFile = path.join(exchangeDir, 'spec_' + specName + '.md');
            fs.writeFileSync(tempSpecFile, specBody.trim(), 'utf8');
            filesToUpload.push(tempSpecFile);
            combinedText = combinedText.replace(match[0], NL + NL + '[UDHEZIM PER COPILOT: Dokumenti i plote i specifikimeve (' + specName + ') eshte bashkangjitur si skedar fizik. ZBATO TE GJITHA RREGULLAT 100%, ZERO-FAKE, ZERO-PLACEHOLDERS.]' + NL);
          }
        }
      }

      for (const fp of attachmentPaths) {
        if (!fp || !fs.existsSync(fp)) continue;
        filesToUpload.push(fp);
      }
      const maxChars = 29500;
      let promptWithContract = combinedText;
      if (!isGemini && !combinedText.includes('OUTPUT CONTRACT')) {
        promptWithContract = COPILOT_OUTPUT_CONTRACT + NL + NL + combinedText;
      }
      const safePrompt = promptWithContract.length > maxChars ? (promptWithContract.slice(0, Math.floor(maxChars / 2)) + NL + '...[COMPACTED]...' + NL + promptWithContract.slice(-Math.floor(maxChars / 2))) : promptWithContract;
      if(filesToUpload.length>0){const ar=await attachFilesSafely(page,targetFrame,tabKey,projectRoot,filesToUpload);appendDispatchDiag(projectRoot,diagId,'ATTACHMENTS_READY',{files:ar.files.length,elapsedMs:ar.elapsedMs});}

        const composer=await resolveActiveComposer(targetFrame,isGemini);
        const normalizePrompt=function(v){return String(v||'').replace(/\s+/g,' ').trim();};
        const normalized=normalizePrompt(safePrompt);const fingerprint={length:normalized.length,first:normalized.slice(0,96),last:normalized.slice(-96),sha256:crypto.createHash('sha256').update(normalized).digest('hex')};
        await composer.locator.click({force:true});
        const insertion=await composer.locator.evaluate(function(el,text){el.focus();if(/^(TEXTAREA|INPUT)$/.test(el.tagName)){el.value=text;el.dispatchEvent(new Event('input',{bubbles:true}));return {m365:false,inserted:true};}document.getSelection().selectAllChildren(el);return {m365:el.id==='m365-chat-editor-target-element',inserted:document.execCommand('insertText',false,text)};},safePrompt);
        if(!isGemini&&(insertion.m365||!insertion.inserted)){await composer.locator.click();await page.keyboard.insertText(safePrompt);}
        let injected=normalizePrompt(await composer.locator.evaluate(function(el){return /^(TEXTAREA|INPUT)$/.test(el.tagName)?el.value:(el.innerText||el.textContent||'');}));
        if(!injected.includes(fingerprint.first)||!injected.includes(fingerprint.last)){const nativeInput=await composer.locator.evaluate(function(el){return /^(TEXTAREA|INPUT)$/.test(el.tagName);});if(nativeInput){await composer.locator.fill(safePrompt).catch(function(){});injected=normalizePrompt(await composer.locator.evaluate(function(el){return el.value||'';}));}}
        if(!injected.includes(fingerprint.first)||!injected.includes(fingerprint.last)){await composer.locator.click({force:true});await page.keyboard.press('Control+A');await page.keyboard.press('Backspace');await page.waitForTimeout(150);await page.keyboard.insertText(safePrompt);await page.waitForTimeout(200);injected=normalizePrompt(await composer.locator.evaluate(function(el){return /^(TEXTAREA|INPUT)$/.test(el.tagName)?el.value:(el.innerText||el.textContent||'');}));}
        if(!injected.includes(fingerprint.first)||!injected.includes(fingerprint.last))throw new Error('INPUT_INJECTION_FAILED');appendDispatchDiag(projectRoot,diagId,'PROMPT_INJECTED',{chars:safePrompt.length,fingerprint:fingerprint.sha256.slice(0,16)});
        const attachmentNames=filesToUpload.map(function(f){return path.basename(f);});
        const pre=await snapshotSendState(targetFrame,composer.token,isGemini,attachmentNames,fingerprint);
        let commitReceipt=null;
        for(let sendAttempt=1;sendAttempt<=2;sendAttempt++){
          let send=await resolveSendButton(targetFrame,isGemini,composer.token);
          if(send){console.error('[SEND_ACTION] tabKey='+tabKey+' attempt='+sendAttempt+' locator='+send.strategy+' click=playwright');try{await send.locator.click({timeout:5000});}catch(e){await page.waitForTimeout(250);send=await resolveSendButton(targetFrame,isGemini,composer.token);if(send)await send.locator.click({timeout:5000});else throw e;}}
          else if(!isGemini){console.error('[SEND_ACTION] tabKey='+tabKey+' attempt='+sendAttempt+' locator=editor-enter click=keyboard');await composer.locator.press('Enter');}
          else throw new Error('SEND_BUTTON_NOT_FOUND');
          commitReceipt=await waitForSendCommit(targetFrame,{composerToken:composer.token,isGemini:isGemini,attachmentNames:attachmentNames,fingerprint:fingerprint,pre:pre,timeoutMs:15000});
          if(commitReceipt.committed){appendDispatchDiag(projectRoot,diagId,'SEND_COMMITTED',{routeKey:commitReceipt.routeKey,evidence:commitReceipt.evidence});if(resetRecoveries===1)appendDispatchDiag(projectRoot,diagId,'RECOVERY_COMMITTED',{attempt:resetRecoveries,routeKey:commitReceipt.routeKey});console.error('[SEND_COMMITTED] tabKey='+tabKey+' attempt='+sendAttempt+' evidence='+JSON.stringify(commitReceipt.evidence));break;}
          console.error('[SEND_NOT_COMMITTED] tabKey='+tabKey+' attempt='+sendAttempt+' evidence='+JSON.stringify(commitReceipt.evidence));
        }
        if(!commitReceipt||!commitReceipt.committed)throw new Error('SEND_NOT_COMMITTED');
      try {
        return await waitAndExtractCleanResponse(page,targetFrame,tabKey,projectRoot,previousCount,Object.assign({},commitReceipt,{fingerprint:fingerprint,preUserCount:pre.userCount,preAssistantCount:pre.assistantCount,preAssistantFingerprint:pre.assistantFingerprint||previousAssistant.fingerprint,preAssistantNodeSignature:pre.assistantNodeSignature||previousAssistant.nodeSignature,composerToken:composer.token,diagId:diagId,recoveryAttempt:resetRecoveries,silentDeadlineMs:300000,hardCapMs:opts.hardCapMs}));
      } catch (err) {
        if(opts.disableInternalRetry===true)throw err;
        if(isGemini&&String(err.message).includes('GEMINI_SILENT_PREFLIGHT_TIMEOUT')){
          if(resetRecoveries<maxConversationRecoveries){resetRecoveries++;appendDispatchDiag(projectRoot,diagId,'RECOVERY_STARTED',{attempt:resetRecoveries,reason:String(err.message).split(' ')[0],recoveryBudgetRemaining:maxConversationRecoveries-resetRecoveries});continue;}
          appendDispatchDiag(projectRoot,diagId,'RECOVERY_EXHAUSTED',{attempt:resetRecoveries,error:String(err.message).split(' ')[0]});appendDispatchDiag(projectRoot,diagId,'SECOND_RESET',{attempt:resetRecoveries});
          try{await captureSupportEvidence(page,projectRoot,tabKey,'SECOND_RESET','GEMINI_CONVERSATION_RESET_AFTER_SEND u përsërit 2 herë.');}catch(_){}
          throw new Error('GEMINI_RESET_RECOVERY_EXHAUSTED SUPPORT_REQUIRED_STOP_IMMEDIATELY: SECOND_RESET GEMINI_CONVERSATION_RESET_AFTER_SEND');
        }
        if(isGemini&&(String(err.message).includes('GEMINI_CONVERSATION_RESET_AFTER_SEND')||String(err.message).includes('ENGINE_DOMAIN_DRIFT_AFTER_SEND')||String(err.message).includes('GEMINI_TURN_ROLLED_BACK_AFTER_SEND'))){
          if(resetRecoveries<maxConversationRecoveries){resetRecoveries++;appendDispatchDiag(projectRoot,diagId,'RECOVERY_STARTED',{attempt:resetRecoveries,reason:String(err.message).split(' ')[0],recoveryBudgetRemaining:maxConversationRecoveries-resetRecoveries});continue;}
          appendDispatchDiag(projectRoot,diagId,'RECOVERY_EXHAUSTED',{attempt:resetRecoveries,error:String(err.message).split(' ')[0]});appendDispatchDiag(projectRoot,diagId,'SECOND_RESET',{attempt:resetRecoveries});
          try{await captureSupportEvidence(page,projectRoot,tabKey,'SECOND_RESET','GEMINI_CONVERSATION_RESET_AFTER_SEND u përsërit 2 herë.');}catch(_){}
          throw new Error('GEMINI_RESET_RECOVERY_EXHAUSTED SUPPORT_REQUIRED_STOP_IMMEDIATELY: SECOND_RESET GEMINI_CONVERSATION_RESET_AFTER_SEND');
        }
        if(attempt===1&&String(err.message).includes('WEB_SERVICE_REFUSAL'))continue;
        appendDispatchDiag(projectRoot,diagId,'ERROR',{code:String(err.message).slice(0,180)});
        throw err;
      }
    }
  });
}

async function selectGoogleSearchAiModel(page, targetKeyword, tabKey) {
  const target = (targetKeyword || 'carbon').toLowerCase();
  const isCarbon = target.includes('carbon') || target.includes('complex');
  const targetLabel = isCarbon ? '4 Carbon · Most complex work' : '4 Hydrogen · Everyday help';
  const curUrl = page.url() || '';
  if (!isCarbon && curUrl.includes('arv=4')) {
    const cleanUrl = curUrl.replace(/([?&])arv=4&?/g, '$1').replace(/[?&]$/, '');
    await page.goto(cleanUrl, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(function() {});
    await page.waitForTimeout(1500);
  }
  let lastObservation = { code: 'SEARCH_AI_TARGET_UNVERIFIED', phase: 'READY', observation: 'not_started' };
  for (let attempt = 1; attempt <= 3; attempt++) {
    console.error('[MODEL_STATE_ATTEMPT] tabKey=' + tabKey + ' phase=SEARCH_AI_MODEL attempt=' + attempt);
    const result = await page.evaluate(async function(args) {
      const sleep = function(ms) { return new Promise(function(resolve) { setTimeout(resolve, ms); }); };
      const normalize = function(value) { return String(value || '').normalize('NFKC').toLowerCase().replace(/&/g, ' and ').replace(/\s+/g, ' ').trim(); };
      const actionable = function(el) {
        if (!el || !el.isConnected || el.disabled || el.getAttribute('aria-disabled') === 'true') return false;
        const st = window.getComputedStyle(el);
        const r = el.getBoundingClientRect();
        return st.display !== 'none' && st.visibility !== 'hidden' && parseFloat(st.opacity || '1') > 0.05 && r.width > 4 && r.height > 4;
      };
      const selected = function(el) {
        if (!el) return false;
        const ariaChecked = el.getAttribute('aria-checked');
        if (ariaChecked === 'true') return true;
        if (ariaChecked === 'false') return false;
        const ariaSelected = el.getAttribute('aria-selected');
        if (ariaSelected === 'true') return true;
        if (ariaSelected === 'false') return false;
        const child = el.querySelector('[aria-checked="true"], [aria-selected="true"], input:checked');
        if (child) return true;
        const cls = normalize(el.className);
        if (/(^|\s)(selected|active|is-checked)(\s|$)/.test(cls)) return true;
        const semanticCheck = Array.from(el.querySelectorAll('[class*="check" i], [aria-label], [data-icon], [data-mat-icon-name], mat-icon')).some(function(icon) {
          if (!actionable(icon)) return false;
          const identity = normalize((icon.getAttribute('aria-label') || '') + ' ' + (icon.getAttribute('data-icon') || '') + ' ' + (icon.getAttribute('data-mat-icon-name') || '') + ' ' + (icon.textContent || '') + ' ' + (icon.className || ''));
          return /(^|[\s_-])(check|checkmark|done|tick|selected)([\s_-]|$)/.test(identity);
        });
        return semanticCheck;
      };
      const close = function() { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true })); };
      const click = function(el) { el.scrollIntoView({ block: 'nearest' }); el.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true })); el.dispatchEvent(new PointerEvent('pointerup', { bubbles: true })); el.click(); };
      const wait = async function(probe, timeout) { const deadline = performance.now() + timeout; while (performance.now() < deadline) { const value = probe(); if (value) return value; await sleep(250); } return null; };
      const menuRoots = function() {
        return Array.from(document.querySelectorAll('[role="menu"], [role="listbox"], .cdk-overlay-pane, [data-radix-menu-content]')).filter(actionable).filter(function(root) {
          return /hydrogen|carbon|everyday help|most complex work/.test(normalize(root.innerText || root.textContent || ''));
        });
      };
      const findTrigger = function() {
        const composer = Array.from(document.querySelectorAll('textarea, [role="textbox"], [contenteditable="true"]')).filter(actionable).sort(function(a, b) {
          const ar = a.getBoundingClientRect();
          const br = b.getBoundingClientRect();
          return (br.width * br.height) - (ar.width * ar.height);
        })[0] || null;
        if (!composer) return null;
        const composerRect = composer.getBoundingClientRect();
        const candidates = Array.from(document.querySelectorAll('button, [role="button"], [role="combobox"]')).filter(actionable).filter(function(el) {
          if (el.closest('[role="menu"], [role="listbox"], .cdk-overlay-pane')) return false;
          const text = normalize((el.innerText || '') + ' ' + (el.getAttribute('aria-label') || ''));
          if (!text || text.length > 140) return false;
          if (/more options|more actions|opsione t|copy|share|feedback|like|dislike|report|listen|read aloud/.test(text)) return false;
          return /4 hydrogen|4 carbon|everyday help|most complex work|add files,? tools,? and select a model|shto skedar|select a model|choose a model|zgjidh një model/.test(text);
        }).map(function(el) {
          const r = el.getBoundingClientRect();
          const text = normalize((el.innerText || '') + ' ' + (el.getAttribute('aria-label') || ''));
          const semantics = /add files,? tools,? and select a model|shto skedar|select a model|choose a model|zgjidh një model/.test(text) ? 3 : (/4 hydrogen|4 carbon|everyday help|most complex work/.test(text) ? 2 : 1);
          const distance = Math.hypot((r.left + r.width / 2) - (composerRect.left + composerRect.width / 2), (r.top + r.height / 2) - (composerRect.top + composerRect.height / 2));
          return { el: el, score: semantics * 100000 - distance };
        }).sort(function(a, b) { return b.score - a.score; });
        return candidates.length ? candidates[0].el : null;
      };
      close(); await sleep(100);
      let trigger = await wait(findTrigger, 5000);
      if (!trigger) { close(); return { ok: false, code: 'MODEL_TRIGGER_TIMEOUT', phase: 'DISCOVER_TRIGGER', observation: 'trigger_not_found' }; }
      const triggerBefore = normalize((trigger.innerText || '') + ' ' + (trigger.getAttribute('aria-label') || ''));
      click(trigger);
      let roots = await wait(function() { const value = menuRoots(); return value.length ? value : null; }, 5000);
      if (!roots) { close(); return { ok: false, code: 'MODEL_MENU_TIMEOUT', phase: 'OPEN_MENU', observation: triggerBefore }; }
      const getTarget = function() {
        return roots.flatMap(function(root) { return Array.from(root.querySelectorAll('[role="menuitemradio"], [role="menuitem"], [role="option"], li, button, div[role="button"]')); }).filter(actionable).find(function(el) {
          const text = normalize((el.innerText || '') + ' ' + (el.getAttribute('aria-label') || ''));
          return args.wantCarbon ? ((/carbon|most complex work/.test(text)) && !/hydrogen|everyday/.test(text)) : ((/hydrogen|everyday help/.test(text)) && !/carbon|complex/.test(text));
        }) || null;
      };
      let option = getTarget();
      if (!option) { close(); return { ok: false, code: 'MODEL_OPTION_NOT_FOUND', phase: 'DISCOVER_VISIBLE_OPTIONS', observation: roots.map(function(r) { return normalize(r.innerText).slice(0, 200); }).join(' | ') }; }
      const alreadyActive = selected(option);
      if (!alreadyActive) { click(option); await sleep(350); }
      close(); await sleep(150);
      trigger = await wait(findTrigger, 5000);
      if (!trigger) { close(); return { ok: false, code: 'SEARCH_AI_TARGET_UNVERIFIED', phase: 'VERIFY', observation: 'trigger_missing_after_click' }; }
      const triggerAfter = normalize((trigger.innerText || '') + ' ' + (trigger.getAttribute('aria-label') || ''));
      click(trigger);
      roots = await wait(function() { const value = menuRoots(); return value.length ? value : null; }, 5000);
      if (!roots) { close(); return { ok: false, code: 'MODEL_MENU_TIMEOUT', phase: 'VERIFY', observation: triggerAfter }; }
      option = getTarget();
      const primarySelected = Boolean(option && selected(option));
      const triggerSignal = args.wantCarbon ? /carbon|most complex work/.test(triggerAfter) : /hydrogen|everyday help/.test(triggerAfter);
      const menuText = roots.map(function(r) { return normalize(r.innerText); }).join(' | ').slice(0, 400);
      close();
      if (!primarySelected) return { ok: false, code: 'SEARCH_AI_TARGET_UNVERIFIED', phase: 'VERIFY', observation: 'selected=false,triggerSignal=' + triggerSignal + ',menu=' + menuText };
      return { ok: true, status: 'SEARCH_MODEL_VERIFIED', alreadyActive: alreadyActive, evidence: { selectedSignal: true, triggerText: triggerAfter, menuText: menuText } };
    }, { wantCarbon: isCarbon }).catch(function(err) { return { ok: false, code: 'SEARCH_AI_TARGET_UNVERIFIED', phase: 'EVALUATE', observation: err.message }; });
    if (result.ok) {
      if (tabKey) {
        tabActiveModel[tabKey] = targetLabel;
        tabDiscoveredModels[tabKey] = '4 Hydrogen · Everyday help, 4 Carbon · Most complex work';
      }
      console.error('[MODEL_STATE_OBSERVED] model=' + targetLabel + ' reasoning=n/a evidence=' + JSON.stringify(result.evidence));
      console.error('[MODEL_STATE_VERIFIED] tabKey=' + tabKey + ' attempts=' + attempt + ' alreadyActive=' + Boolean(result.alreadyActive));
      return targetLabel;
    }
    lastObservation = result;
    console.error('[MODEL_STATE_FAILED] tabKey=' + tabKey + ' code=' + result.code + ' attempt=' + attempt + ' lastObservation=' + JSON.stringify({ phase: result.phase, observation: result.observation }));
    await page.waitForTimeout(350);
  }
  throw new Error((lastObservation.code || 'SEARCH_AI_TARGET_UNVERIFIED') + ' ne [' + tabKey + '] per [' + targetLabel + '] attempts=3 lastObservation=' + JSON.stringify({ phase: lastObservation.phase, observation: lastObservation.observation }));
}
async function ensureGoogleSearchAi4CarbonMode(page, tabKey) {
  return selectGoogleSearchAiModel(page, 'carbon', tabKey);
}

function generateSmartArchitectureMap(projectRoot) {
  const cleanRoot = path.resolve(projectRoot);
  const ignoredDirs = new Set([
    'node_modules', '.git', '.antigravity', '.profiles', 'profiles',
    'dist', 'build', 'out', '.next', '.nuxt', '__pycache__', '.pytest_cache',
    'coverage', '.venv', 'venv', 'env', 'Default', 'GPUCache', 'CacheStorage',
    '03_Workspaces', 'temp_profile', 'temp_profile_dom', 'temp_test_user_url',
    'scratch', '.idea', '.vscode'
  ]);

  const sourceExts = new Set([
    '.js', '.mjs', '.cjs', '.ts', '.jsx', '.tsx', '.py',
    '.json', '.yaml', '.yml', '.sql', '.sh', '.ps1'
  ]);

  const fileTree = [];
  const signatures = [];
  const manifests = [];

  // 1. Manifests
  const manifestCandidates = ['package.json', 'pyproject.toml', 'requirements.txt', 'Cargo.toml', 'go.mod'];
  for (const m of manifestCandidates) {
    const full = path.join(cleanRoot, m);
    if (fs.existsSync(full)) {
      try {
        const content = fs.readFileSync(full, 'utf8').trim();
        manifests.push('### Manifest: ' + m + NL + FENCE3 + NL + content.slice(0, 3000) + NL + FENCE3);
      } catch (_) {}
    }
  }

  // 2. Recursive Scan
  function scan(dir) {
    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        const full = path.join(dir, entry.name);
        const rel = path.relative(cleanRoot, full).replace(/\\/g, '/');
        const low = entry.name.toLowerCase();

        if (entry.isDirectory()) {
          if (ignoredDirs.has(entry.name) || ignoredDirs.has(low)) continue;
          if (entry.name.startsWith('.') && entry.name !== '.') continue;
          fileTree.push(rel + '/');
          scan(full);
        } else if (entry.isFile()) {
          const ext = path.extname(entry.name).toLowerCase();
          if (!sourceExts.has(ext)) continue;
          fileTree.push(rel);

          try {
            const stat = fs.statSync(full);
            if (stat.size > 200 * 1024) continue; // skip massive files
            const content = fs.readFileSync(full, 'utf8');

            const isConfig = rel.startsWith('config/') || rel.includes('.env') || rel.endsWith('.yaml') || rel.endsWith('.yml');
            const isEntryPoint = rel.includes('orchestrator') || rel.includes('main.') || rel.includes('index.') || rel.includes('server.');

            if (isConfig && stat.size < 8000) {
              signatures.push('#### [CONFIG] ' + rel + NL + FENCE3 + 'yaml' + NL + content.trim() + NL + FENCE3);
            } else if (isEntryPoint && stat.size < 12000) {
              signatures.push('#### [ENTRY_POINT] ' + rel + NL + FENCE3 + NL + content.trim() + NL + FENCE3);
            } else {
              const lines = content.split(/\r?\n/);
              const sigLines = [];

              for (let i = 0; i < lines.length && sigLines.length < 50; i++) {
                const line = lines[i];
                const tr = line.trim();

                // Docstrings / comments at top
                if (i < 15 && (tr.startsWith('"""') || tr.startsWith("'''") || tr.startsWith('/*') || tr.startsWith('*') || tr.startsWith('#'))) {
                  sigLines.push(line);
                  continue;
                }

                if (ext === '.py') {
                  if (/^\s*(?:async\s+)?def\s+/.test(line) || /^\s*class\s+/.test(line)) {
                    sigLines.push(line);
                    if (lines[i+1] && lines[i+1].trim().startsWith('"""')) {
                      sigLines.push(lines[i+1]);
                    }
                  }
                }

                if (ext === '.js' || ext === '.ts' || ext === '.jsx' || ext === '.tsx') {
                  if (/^\s*(?:export\s+)?(?:async\s+)?function\s+/.test(line) ||
                      /^\s*(?:export\s+)?class\s+/.test(line) ||
                      /^\s*(?:export\s+)?const\s+[A-Za-z0-9_]+\s*=\s*(?:async\s*)?\([^)]*\)\s*=>/.test(line)) {
                    sigLines.push(line);
                  }
                }
              }

              if (sigLines.length > 0) {
                signatures.push('#### [MODULE] ' + rel + NL + FENCE3 + NL + sigLines.join(NL) + NL + FENCE3);
              }
            }
          } catch (_) {}
        }
      }
    } catch (_) {}
  }

  scan(cleanRoot);

  const parts = [
    '# HARTA ARKITEKTURORE E PROJEKTIT: ' + path.basename(cleanRoot),
    '',
    '## 1. STRUKTURA E SKEDARËVE (SOURCE TREE)',
    FENCE3,
    fileTree.join(NL),
    FENCE3,
    '',
    '## 2. MANIFESTET & DEPENDENCIES',
    manifests.join(NL + NL) || '_Nuk u gjetën manifeste standarde._',
    '',
    '## 3. KONTRATAT, ENTRY POINTS & NËNSHKRIMET E MODULEVE',
    signatures.join(NL + NL)
  ];

  let res = parts.join(NL + NL);
  if (res.length > 25000) {
    res = res.slice(0, 25000) + NL + NL + '... [Harta u kufizua për kompaktësi brenda 25 KB] ...';
  }
  return res;
}

function sliceSpecification(text, maxChars) {
  if (!maxChars) maxChars = 45000;
  if (!text || typeof text !== 'string') return [];
  const clean = text.trim();
  if (clean.length <= maxChars) return [clean];

  const slices = [];
  const lines = clean.split(/\r?\n/);
  let currentSlice = [];
  let currentLen = 0;

  for (const line of lines) {
    if (currentLen + line.length + 1 > maxChars && currentSlice.length > 0) {
      slices.push(currentSlice.join(NL));
      currentSlice = [line];
      currentLen = line.length + 1;
    } else {
      currentSlice.push(line);
      currentLen += line.length + 1;
    }
  }

  if (currentSlice.length > 0) {
    slices.push(currentSlice.join(NL));
  }

  return slices;
}

function buildSearchAiCleanPrompt(kind, data) {
  data = data || {};
  if (kind === 'handshake') return 'Lexo skedarin e bashkëngjitur plotësisht dhe bëhu gati për hapin pasues. Përgjigju vetëm: OK, e lexova dhe jam gati.';
  if (kind === 'plan') return ['Duke përdorur kontekstin e skedarit të bashkëngjitur, krijo planin teknik në jo më shumë se 85 rreshta.','Përdor seksionet:','1. OBJEKTIVAT DHE NON-GOALS','2. ENTRY POINT DHE ROOT CAUSE','3. ALLOWED_FILES, me një rresht FILE_TARGET: path për çdo skedar','4. SPECIFIKIMI SKEDAR MË SKEDAR','5. HARDENING DHE DEFINITION OF DONE','Mos shto hyrje narrative dhe mos përdor placeholder.'].join(NL);
  if (kind === 'planRetry') return 'Rishkruaj vetëm planin teknik dhe plotëso seksionet që mungojnë: ' + (data.missing || []).join(', ') + '. Përfshi FILE_TARGET relative dhe specifikim skedar më skedar. Mos shto hyrje narrative.';
  if (kind === 'review') return 'Audito kodin e bashkëngjitur kundrejt planit dhe log-ut të testeve. Kthe auditimin kompakt dhe përfundo me një rresht të vetëm: STATUS: APPROVED ose STATUS: CHANGES_REQUIRED.\n\n' + (data.context || '');
  if (kind === 'code') return ['Zbato planin për projektin. Kthe kod të plotë, pa placeholder.','Për çdo skedar përdor formatin:','### FILE: path/relative.ext',FENCE3+'language','përmbajtja e plotë',FENCE3,'Nëse përgjigjja duhet ndarë, përdor vetëm CONTINUE ose COMPLETE si status të thjeshtë.'].join(NL) + '\n\n' + (data.context || '');
  if (kind === 'handshakeReview') return 'Lexo skedarin e bashkëngjitur dhe ruaje si kontekst për auditimin pasues. Përgjigju vetëm: OK, e lexova dhe jam gati.';
  return String(data.text || '');
}
function searchAiTextFingerprint(text) { return crypto.createHash('sha256').update(String(text || '').replace(/\s+/g,' ').trim()).digest('hex').slice(0,16); }
async function discoverSearchAiAssistantTurns(page, opts) {
  opts = opts || {};
  return page.evaluate(function(arg) {
    const visible=function(el){if(!el||!el.isConnected)return false;const st=getComputedStyle(el),r=el.getBoundingClientRect();return st.display!=='none'&&st.visibility!=='hidden'&&parseFloat(st.opacity||'1')>.05&&r.width>8&&r.height>8;};
    const compact=function(v){return String(v||'').replace(/\s+/g,' ').trim();};
    const composer=function(el){if(Boolean(el.closest('form,[class*="composer" i],[class*="input-area" i]')))return true;return Array.from(el.querySelectorAll('textarea:not(.e3RQ5d):not([maxlength="1500"]),[contenteditable="true"],[role="textbox"]')).some(visible);};
    const user=function(el){const role=(el.getAttribute('data-message-author-role')||'').toLowerCase();const cls=String(el.className||'').toLowerCase(),text=compact(el.innerText||el.textContent||''),prompt=compact(arg.userPromptText||'');return role==='user'||el.hasAttribute('data-query')||/user-query|user-message|query-bubble|query-heading/.test(cls)||Boolean(el.closest('user-query,[data-message-author-role="user"],[data-query]'))||Boolean(prompt&&text.startsWith(prompt.slice(0,120))&&!el.querySelector('button[aria-label*="Good response" i],button[aria-label*="Copy" i]'));};
    const chrome=function(el){return el.matches('body,main,nav,aside,[role="navigation"]')||Boolean(el.querySelector('nav,aside,[aria-label*="Open sidebar" i],[aria-label*="Search history" i]'));};
    const nodes=Array.from(document.querySelectorAll('section,article,[data-attrid*="ai" i],[data-container-id],[data-message-author-role="assistant"],div[role="region"]')).filter(function(el){if(!visible(el)||composer(el)||user(el)||chrome(el))return false;const t=compact(el.innerText||el.textContent||'');const signal=el.querySelector('button[aria-label*="Good response" i],button[aria-label*="Bad response" i],button[aria-label*="Copy" i],button[aria-label*="Share" i],button[aria-label*="Përgjigje e mirë" i],button[aria-label*="Kopjo" i],button[aria-label*="Ndaj" i],[data-message-author-role="assistant"]');const clone=el.cloneNode(true);clone.querySelectorAll('button,[role="button"]').forEach(function(x){x.remove();});const clean=compact(clone.innerText||clone.textContent||'');if(!clean||/^Shared0 filesShow allShow less$/i.test(clean))return false;return Boolean(signal)||(el.matches('article,section')&&t.length>=arg.minChars);});
    const specific=nodes.filter(function(el){return !nodes.some(function(other){if(other===el||!el.contains(other))return false;const a=compact(el.innerText||el.textContent||''),b=compact(other.innerText||other.textContent||'');return b.length>0&&(a===b||a.includes(b));});});
    return specific.map(function(el,index){const t=compact(el.innerText||el.textContent||'');if(!el.dataset.antigravityAssistantId)el.dataset.antigravityAssistantId='sai-'+Date.now()+'-'+index+'-'+Math.random().toString(16).slice(2);return {id:el.dataset.antigravityAssistantId,index:index,text:t,fingerprint:t.slice(0,120)+'|'+t.length};});
  },{minChars:opts.minChars||20,userPromptText:opts.userPromptText||''});
}
async function extractSearchAiTurnContent(page, opts) {
  opts=opts||{};
  const result=await page.evaluate(function(arg){
    const node=document.querySelector('[data-antigravity-assistant-id="'+arg.id+'"]');if(!node)return null;
    const hiddenLive=[];Array.from(node.querySelectorAll('*')).forEach(function(el){const st=getComputedStyle(el);if(st.display==='none'||st.visibility==='hidden'||el.hidden||el.getAttribute('aria-hidden')==='true'){el.setAttribute('data-sai-hidden','1');hiddenLive.push(el);}});
    const clone=node.cloneNode(true);
    hiddenLive.forEach(function(el){el.removeAttribute('data-sai-hidden');});
    clone.querySelectorAll('[data-sai-hidden="1"],script,style,noscript,svg,textarea,input,button,[role="button"],[role="menu"],[role="toolbar"],nav,aside,[aria-label*="More options" i],[aria-label*="Copy" i],[aria-label*="Share" i],[aria-label*="Good response" i],[aria-label*="Bad response" i],[aria-label*="Search history" i]').forEach(function(el){el.remove();});
    const serialize=function(root){const block=/^(P|DIV|SECTION|ARTICLE|LI|TR|H1|H2|H3|H4|H5|H6|PRE|BLOCKQUOTE)$/;let out='';const walk=function(n){if(n.nodeType===3){out+=n.nodeValue||'';return;}if(n.nodeType!==1)return;const tag=n.tagName;if(tag==='BR'){out+='\n';return;}if(tag==='PRE'){out+='\n\n'+(n.textContent||'')+'\n\n';return;}const isBlock=block.test(tag);if(isBlock)out+='\n';if(tag==='LI')out+='- ';Array.from(n.childNodes).forEach(walk);if(tag==='TD'||tag==='TH')out+=' | ';if(isBlock)out+='\n';};walk(root);return out;};
    let text=serialize(clone).replace(/[ \t]+\n/g,'\n').replace(/\n[ \t]+/g,'\n').replace(/\n{3,}/g,'\n\n').trim();
    const chunks=text.split(arg.fence);for(let i=0;i<chunks.length;i+=2){chunks[i]=chunks[i].replace(/([^\n])\s*(FILE_TARGET:)/g,'$1\n$2').replace(/([A-Za-z0-9_.\/-]+\.[A-Za-z0-9]+)\s*([1-9][0-9]*\.\s+[A-ZÇË])/g,'$1\n$2');}text=chunks.join(arg.fence);
    text=text.split('\n').filter(function(line){return !/^\s*(?:AI Mode reply for .*|AI Mode response for .*|AI Mode response is ready|Përgjigjja e Modalitetit të IA-së është gati|Përgjigjja e [\x22\u201c]?Modalitetit të IA-së[\x22\u201d]? për .*|Copied to clipboard|Failed to copy|Good response|Bad response|Share|More options|Skip to previous prompt|Kalo te kërkesa e mëparshme)\s*$/i.test(line);}).join('\n').trim();
    text=text.replace(/(?:A copy of this chat will be included|Thanks for letting us know|Google may use account and system data)[\s\S]*$/i,'').trim();
    return text;
  },{id:opts.id,fence:FENCE3});
  if(result===null)throw new Error('SEARCH_AI_ASSISTANT_CONTAINER_MISSING');
  return {status:'RESPONSE_EXTRACTED',text:result,turnIndex:opts.turnIndex,containerFingerprint:searchAiTextFingerprint(result),evidence:{newAssistantTurn:true,userBubbleExcluded:true,uiChromeRemoved:true}};
}
async function classifySearchAiNoResponse(page, opts) {
  const state=await page.evaluate(function(){const t=(document.body.innerText||'').toLowerCase();const retry=Array.from(document.querySelectorAll('button')).some(function(b){return /retry|try again|provo përsëri/i.test((b.getAttribute('aria-label')||'')+' '+(b.innerText||''));});const captcha=Boolean(document.querySelector('iframe[src*="recaptcha" i],iframe[title*="recaptcha" i],#recaptcha,form[action*="sorry"]'))||/unusual traffic from your computer network|i.m not a robot/.test(t);return {captcha:captcha,noResponse:/no response available|try asking something else/.test(t),service:/something went wrong|response wasn.t generated|service unavailable|try again later/.test(t),retry:retry};});
  if(state.captcha)return 'SEARCH_AI_CAPTCHA_REQUIRED';
  if(state.noResponse)return 'SEARCH_AI_NO_RESPONSE_AVAILABLE';if(state.service)return 'SEARCH_AI_SERVICE_ERROR';if(opts&&opts.assistantTurnExists)return 'SEARCH_AI_BLANK_ASSISTANT_TURN';return 'SEARCH_AI_RESPONSE_TIMEOUT';
}
function validatePlanOutput(text, opts) {
  opts=opts||{};let clean=String(text||'').replace(/\n?PLANI_PERFUNDOI_100\s*$/i,'').trim();const missing=[];
  if(clean.length<250)return {ok:false,reason:'TOO_SHORT',missing:['minimum_length'],text:clean,gates:0};
  if(/Copied to clipboard|Open sidebar|See your Search history|Good response|Bad response|More options for response/i.test(clean))return {ok:false,reason:'UI_CONTAMINATION',missing:[],text:clean,gates:0};
  if(/no response available|try asking something else|something went wrong|response wasn.t generated|can.t help/i.test(clean))return {ok:false,reason:'SERVICE_REFUSAL',missing:[],text:clean,gates:0};
  if(/^Duke përdorur kontekstin e skedarit të bashkëngjitur/i.test(clean))return {ok:false,reason:'PROMPT_ECHO_DOMINANT',missing:[],text:clean,gates:0};
  const outside=clean.split(FENCE3).filter(function(_,i){return i%2===0;}).join(NL),targetRegex=/^\s*(?:[-*]\s*)?FILE_TARGET:\s*([^\r\n]+)\s*$/gmi,targets=[];let tm;while((tm=targetRegex.exec(outside))!==null){const v=tm[1].trim().replace(/[\x22\x27\x60*]/g,'');if(!targets.includes(v))targets.push(v);}
  if(targets.some(function(x){return /^(?:[a-z]:[\\/]|\\\\|\/)|(?:^|[\\/])\.\.(?:[\\/]|$)/i.test(x);}))return {ok:false,reason:'UNSAFE_PATH',missing:[],text:clean,gates:0};
  const checks=[/OBJEKTIV|NON-GOAL/i.test(clean),/ENTRY POINT|ROOT CAUSE/i.test(clean),/ALLOWED_FILES|FILE_TARGET:/i.test(clean),/SPECIFIKIM|SKEDAR MË SKEDAR|FILE-BY-FILE/i.test(clean),/DEFINITION OF DONE|\bDoD\b|HARDENING|VERIFIK|TEST/i.test(clean)];
  if(!checks[0])missing.push('objectives');if(!checks[1])missing.push('entry_root');if(!checks[2])missing.push('allowed_files');if(!checks[3])missing.push('file_spec');if(!checks[4])missing.push('dod');
  const gates=checks.filter(Boolean).length;if((opts.requiresFiles!==false)&&targets.length===0)missing.push('file_target');const ok=gates>=3&&checks[3]&&((opts.requiresFiles===false)||targets.length>0);
  return {ok:ok,reason:ok?'':'INVALID_PLAN_STRUCTURE',missing:Array.from(new Set(missing)),text:clean,gates:gates,targets:targets};
}
async function attachFilesToSearchAiClean(page, filesList) {
  if(!filesList||!filesList.length)return;
  const plus=page.locator('button[aria-label*="Add files" i],button[aria-label*="Shto skedar" i],button[aria-label*="select a model" i]').filter({visible:true}).first();await plus.waitFor({state:'visible',timeout:15000});
  const direct=page.locator('button[aria-label*="Add files" i]:not([aria-label*="select a model" i]) input[type="file"],input[type="file"]:not([accept*="image/"])').last();if(await direct.count()){await direct.setInputFiles(filesList);}else{await plus.click();const item=page.locator('[role="menuitem"][aria-label*="Add files" i],[role="menuitem"]:has-text("Add files")').filter({visible:true}).first();const chooser=page.waitForEvent('filechooser',{timeout:10000});await item.click();(await chooser).setFiles(filesList);}
  const names=filesList.map(function(f){return path.basename(f);}),deadline=Date.now()+25000;let stable=0;while(Date.now()<deadline){const state=await page.evaluate(function(ns){const c=function(v){return String(v||'').replace(/\s+/g,'').toLowerCase();};const body=c(document.body.innerText||''),els=Array.from(document.querySelectorAll('[aria-label],[title],[class*=\"chip\" i],[class*=\"attach\" i]'));const found=ns.every(function(n){const full=c(n),stem=full.replace(/\.[^.]+$/,'');return body.includes(full)||body.includes(stem)||els.some(function(e){const t=c((e.getAttribute('aria-label')||'')+' '+(e.getAttribute('title')||'')+' '+(e.innerText||''));return t.includes(full)||t.includes(stem);});});const busy=Array.from(document.querySelectorAll('[aria-busy=\"true\"],[role=\"progressbar\"],.spinner,.uploading')).some(function(e){const s=getComputedStyle(e),r=e.getBoundingClientRect();return s.display!=='none'&&s.visibility!=='hidden'&&r.width>4;});return {found:found,busy:busy};},names);stable=state.found&&!state.busy?stable+1:0;if(stable>=3){console.error('[SEARCH_AI_ATTACHMENT_VERIFIED] files='+names.join(','));return;}await page.waitForTimeout(250);}throw new Error('SEARCH_AI_ATTACHMENT_NOT_VERIFIED');
}

function classifyAttachmentHandshake(text,telemetry){telemetry=telemetry||{};const normalized=String(text||'').normalize('NFKC').toLowerCase().replace(/[’‘]/g,"'").replace(/[^\p{L}\p{N}' ]+/gu,' ').replace(/\s+/g,' ').trim();const service=classifyWebServiceFailure({text:normalized,alerts:telemetry.alerts||[],engine:'google_search'});if(['QUOTA_OR_LIMIT_ERROR','POLICY_REFUSAL','AUTH_OR_SESSION_ERROR','TRANSIENT_SERVICE_ERROR'].includes(service.class))return service;const failure=/uploaded file could not be processed|file could not be processed|try to upload a different file|couldn'?t process the file|unable to process the file|attachment could not be read|file is too large|unsupported file|context is too long/.exec(normalized);if(failure||service.class==='PAYLOAD_REJECTED')return {class:'PAYLOAD_REJECTED',code:'WEB_PAYLOAD_REJECTED_OR_OVERSIZED',retryable:true,matchedSignals:[failure?failure[0]:'payload']};const positive=/(^|\b)(ok|e lexova|lexova|jam gati|gati|ready|received|read it|file received|attachment received)(\b|$)/i.test(normalized);if(!positive)return {class:'INVALID_HANDSHAKE',code:'SEARCH_AI_ATTACHMENT_HANDSHAKE_UNVERIFIED',retryable:false,matchedSignals:[]};if(telemetry.attachmentVerified===false)return {class:'INVALID_HANDSHAKE',code:'SEARCH_AI_ATTACHMENT_HANDSHAKE_UNVERIFIED',retryable:false,matchedSignals:['attachment_not_verified']};return {class:'HANDSHAKE_ACCEPTED',code:'SEARCH_AI_ATTACHMENT_HANDSHAKE_ACCEPTED',retryable:false,matchedSignals:[]};}

async function dispatchToGoogleSearchAiTab(opts) {
  const tabKey=opts.tabKey,cleanRoot=path.resolve(opts.projectRoot),isPlannerTask=opts.isPlanner===false?false:Boolean(opts.isPlanner||opts.promptText.includes('CHIEF_ARCHITECT')||opts.promptText.includes('PLANIFIKUESIT')||opts.promptText.includes('plan.md'));
  return withTabLock(tabKey,async function(){activeProjectPerTab[tabKey]=cleanRoot;let page=await getOrCreateTab(tabKey);if(opts.forceFreshChat===true)await resetChatVerified({page:page,targetFrame:page,tabKey:tabKey,projectRoot:cleanRoot,forceReload:true,reason:'FORCE_FRESH_DISPATCH'});await page.goto(GOOGLE_SEARCH_AI_URL,{waitUntil:'domcontentloaded',timeout:45000});await page.waitForTimeout(3000);await selectGoogleSearchAiModel(page,'hydrogen',tabKey);if(await checkAuthExpired(page,tabKey))await captureSupportEvidence(page,cleanRoot,tabKey,'AUTH_EXPIRED','Google Search AI requires login.');
    const exchangeDir=path.join(cleanRoot,'.antigravity','bridge','exchange');if(!fs.existsSync(exchangeDir))fs.mkdirSync(exchangeDir,{recursive:true});const txtBundle=path.join(exchangeDir,'project_bundle.txt');if(!fs.existsSync(txtBundle))packWorkspace(cleanRoot,'FULL');const master=path.join(exchangeDir,'project_context_bundle.txt');
    if(isPlannerTask&&opts.useProvidedBundle!==true){const activeMode=opts.packMode||PACK_MODES.PLANNING_FULL,arch=generateSmartArchitectureMap(cleanRoot),spec=resolveAndEmbedExternalFiles((opts.userRequest||opts.promptText||'').trim()),code=fs.existsSync(txtBundle)?fs.readFileSync(txtBundle,'utf8'):'';const assembled=assembleFinalContextArtifact({header:'PROJECT CONTEXT BUNDLE',taskMetadata:opts.userRequest||'Analizo projektin.',architectureMap:'PJESA A: HARTA ARKITEKTURORE'+NL+arch,externalSpecs:'PJESA B: SPECIFIKIMET'+NL+(spec||opts.userRequest||'Analizo projektin.'),workspace:'PJESA C: KODI BURIMOR'+NL+code,manifest:'mode='+activeMode},activeMode);validateFinalTextArtifact(assembled.text,activeMode);fs.writeFileSync(master,assembled.text,'utf8');console.error('[FINAL_CONTEXT_VALIDATED] mode='+activeMode+' bytes='+assembled.receipt.finalContextBytes+' sha256='+assembled.receipt.finalSha256);}
    const files=[];if(opts.useProvidedBundle===true&&opts.bundlePath&&fs.existsSync(opts.bundlePath)){const providedText=fs.readFileSync(opts.bundlePath,'utf8');validateFinalTextArtifact(providedText,PACK_MODES.PLANNING_FULL);files.push(opts.bundlePath);}else if(isPlannerTask)files.push(master);else if(opts.bundlePath&&fs.existsSync(opts.bundlePath))files.push(opts.bundlePath);else if(fs.existsSync(txtBundle))files.push(txtBundle);await attachFilesToSearchAiClean(page,files);
    async function sendTurnAndExtract(text,meta){meta=meta||{};const before=await discoverSearchAiAssistantTurns(page,{minChars:5});const snapshot={assistantCount:before.length,assistantNodeIds:before.map(function(x){return x.id;}),latestAssistantFingerprint:before.length?before[before.length-1].fingerprint:'',sendTimestamp:Date.now()};console.error('[SEARCH_AI_TURN_SNAPSHOT] assistantCount='+snapshot.assistantCount+' latestFingerprint='+snapshot.latestAssistantFingerprint);
      const box=page.locator('textarea.ITIRGe:visible,textarea[placeholder*="Ask" i]:visible,textarea[placeholder*="Pyet" i]:visible,textarea:visible').last();await box.waitFor({state:'visible',timeout:25000});await box.click();await page.keyboard.press('Control+A');await page.keyboard.insertText(text);
      let send=page.locator('button[aria-label*="Send" i],button[aria-label*="Dërgo" i],button[type="submit"]').filter({visible:true}).filter({hasNotText:/add file|shto skedar|select a model|zgjidh një model|mic|voice/i}).last();if(await send.count())await send.click({timeout:5000});else await box.press('Enter');
      const deadline=Date.now()+(meta.timeoutMs||150000),minNeeded=meta.expectedKind==='handshake'?5:(meta.minNeeded||20);let observed=null,receipt=null,lastText='',stable=0;while(Date.now()<deadline){await page.waitForTimeout(1750);const pollClass=await classifySearchAiNoResponse(page,{});if(pollClass==='SEARCH_AI_CAPTCHA_REQUIRED'){console.error('[SEARCH_AI_NO_RESPONSE] class='+pollClass);await captureSupportEvidence(page,cleanRoot,tabKey,'SEARCH_AI_CAPTCHA_REQUIRED','Google kërkon verifikim njerëzor reCAPTCHA në dritaren e browser-it.').catch(function(){});throw new Error('SEARCH_AI_CAPTCHA_REQUIRED: Google kërkon verifikim njerëzor reCAPTCHA në dritaren e browser-it.');}const turns=await discoverSearchAiAssistantTurns(page,{minChars:1,userPromptText:text});observed=turns.find(function(x){return !snapshot.assistantNodeIds.includes(x.id);})||turns.find(function(x,i){return i>=snapshot.assistantCount&&x.fingerprint!==snapshot.latestAssistantFingerprint;});if(!observed)continue;receipt=await extractSearchAiTurnContent(page,{id:observed.id,turnIndex:observed.index});const generating=await page.locator('button[aria-label*=\"Stop\" i],button[aria-label*=\"Ndalo\" i],button[aria-label*=\"Cancel\" i]').filter({visible:true}).count()>0;stable=!generating&&receipt.text.length>=minNeeded&&receipt.text===lastText?stable+1:0;lastText=receipt.text;if(stable>=2)break;}
      if(!observed){const cls=await classifySearchAiNoResponse(page,{});console.error('[SEARCH_AI_NO_RESPONSE] class='+cls);throw new Error(cls);}
      if(stable<2)throw new Error('SEARCH_AI_RESPONSE_TIMEOUT');console.error('[SEARCH_AI_NEW_ASSISTANT_TURN] index='+observed.index+' fingerprint='+observed.fingerprint);receipt=receipt||await extractSearchAiTurnContent(page,{id:observed.id,turnIndex:observed.index});if(!receipt.text){const cls=await classifySearchAiNoResponse(page,{assistantTurnExists:true});console.error('[SEARCH_AI_NO_RESPONSE] class='+cls);throw new Error(cls);}const lowTurn=String(receipt.text||'').toLowerCase();if(receipt.text.length<600&&/daily limit|reached your limit|switch to the fast model|upgrade to google ai|limit reached|quota exceeded/.test(lowTurn))throw new Error('WEB_QUOTA_OR_LIMIT_ERROR: '+receipt.text.slice(0,160));if(receipt.text.length<500&&SERVICE_ERROR_PATTERNS.some(function(pattern){return lowTurn.includes(pattern);}))throw new Error('WEB_SERVICE_REFUSAL: '+receipt.text.slice(0,160));console.error('[SEARCH_AI_EXTRACTED] kind='+(meta.expectedKind||'generic')+' chars='+receipt.text.length+' chromeRemoved=true');return receipt.text;
    }
    if(files.length){let handshakeText=await sendTurnAndExtract(buildSearchAiCleanPrompt(isPlannerTask?'handshake':'handshakeReview'),{expectedKind:'handshake',timeoutMs:60000}),handshake=classifyAttachmentHandshake(handshakeText,{attachmentVerified:true,alerts:[]});if(handshake.class!=='HANDSHAKE_ACCEPTED'){if(handshake.code!=='WEB_PAYLOAD_REJECTED_OR_OVERSIZED')throw Object.assign(new Error(handshake.code),{classification:handshake});await collectGeminiTerminalDiagnostics({page:page,targetFrame:page,tabKey:tabKey,projectRoot:cleanRoot,dispatchId:'search-handshake-'+Date.now(),errorCode:handshake.code,state:{},elapsedMs:0,progressAgeMs:0}).catch(function(){});const reset=await resetChatVerified({page:page,targetFrame:page,tabKey:tabKey,projectRoot:cleanRoot,reason:handshake.code});if(!reset||reset.status!=='CHAT_RESET_VERIFIED')throw new Error('CHAT_RESET_VERIFICATION_FAILED');const compactInfo=packWorkspace(cleanRoot,PACK_MODES.RETRY_COMPACT),compactSource=fs.readFileSync(path.join(exchangeDir,'project_bundle.txt'),'utf8'),compact=assembleFinalContextArtifact({header:'PROJECT CONTEXT BUNDLE RETRY',taskMetadata:opts.userRequest||'',workspace:compactSource,manifest:'mode=RETRY_COMPACT'},PACK_MODES.RETRY_COMPACT);validateFinalTextArtifact(compact.text,PACK_MODES.RETRY_COMPACT);fs.writeFileSync(master,compact.text,'utf8');files.length=0;files.push(master);await attachFilesToSearchAiClean(page,files);handshakeText=await sendTurnAndExtract(buildSearchAiCleanPrompt(isPlannerTask?'handshake':'handshakeReview'),{expectedKind:'handshake',timeoutMs:60000});handshake=classifyAttachmentHandshake(handshakeText,{attachmentVerified:true,alerts:[]});if(handshake.class!=='HANDSHAKE_ACCEPTED')throw Object.assign(new Error('SEARCH_AI_ATTACHMENT_RETRY_EXHAUSTED'),{firstClassification:handshake,compactReceipt:compact.receipt,resetReceipt:reset,packReceipt:compactInfo.receipt});}}
    await selectGoogleSearchAiModel(page,'carbon',tabKey);await page.waitForTimeout(1000);
    if(isPlannerTask){let prompt=buildSearchAiCleanPrompt('plan'),lastError='';for(let attempt=1;attempt<=2;attempt++){try{const text=await sendTurnAndExtract(prompt,{expectedKind:'plan'});const check=validatePlanOutput(text,{requiresFiles:true});console.error('[SEARCH_AI_PLAN_VALIDATION] valid='+check.ok+' gates='+check.gates+' missing='+check.missing.join(','));if(check.ok){tabAuthStatus[tabKey]='ACTIVE';tabActiveModel[tabKey]='4 Carbon · Most complex work';return ['# PLANI ARKITEKTUROR DHE SPECIFIKIMI I EKZEKUTIMIT (MULTI-AI RELAY)','Projekti: '+path.basename(cleanRoot),'Data: '+new Date().toISOString(),' ',check.text].join(NL);}lastError='INVALID_PLAN_STRUCTURE';prompt=buildSearchAiCleanPrompt('planRetry',{missing:check.missing});}catch(err){lastError=err.message;if(/WEB_QUOTA_OR_LIMIT_ERROR/.test(lastError))throw err;if(/NO_RESPONSE_AVAILABLE|BLANK_ASSISTANT_TURN/.test(lastError)){await page.goto(GOOGLE_SEARCH_AI_URL,{waitUntil:'domcontentloaded',timeout:45000});await page.waitForTimeout(2500);await selectGoogleSearchAiModel(page,'hydrogen',tabKey);await attachFilesToSearchAiClean(page,files);await sendTurnAndExtract(buildSearchAiCleanPrompt('handshake'),{expectedKind:'handshake',timeoutMs:60000,minNeeded:5});await selectGoogleSearchAiModel(page,'carbon',tabKey);await page.waitForTimeout(1000);prompt=buildSearchAiCleanPrompt('plan');}else if(/SERVICE_ERROR/.test(lastError)){await page.waitForTimeout(2500);}else throw err;}}throw new Error('PLANNER_ESCALATION_FAILED: '+lastError);}
    if(!isPlannerTask&&opts.useProvidedBundle===true)return sendTurnAndExtract(opts.promptText,{expectedKind:'chunk',timeoutMs:180000,minNeeded:20});const reviewer=opts.promptText.includes('STATUS: APPROVED')||(opts.bundlePath&&opts.bundlePath.endsWith('code.md'));const kind=reviewer?'review':'code',prompt=buildSearchAiCleanPrompt(kind,{context:opts.promptText.slice(0,22000)});return sendTurnAndExtract(prompt,{expectedKind:kind,timeoutMs:180000});
  });
}
// ---------------- PJESA 2: PACKER, 0-TOKEN EXECUTOR, 25S AUTOPILOT & MCP SERVER ----------------

function compactErrorLog(rawText, maxChars) {
  if (!maxChars) maxChars = 20000;
  const clean = String(rawText || '').replace(/\\/g, '/').trim();
  if (clean.length <= maxChars) return clean;
  const half = Math.floor(maxChars / 2);
  return clean.slice(0, half) + NL + NL + '... [SNIPPED ' + (clean.length - maxChars) + ' CHARS] ...' + NL + NL + clean.slice(-half);
}

function readProjectState(projectRoot) {
  const statePath = path.join(path.resolve(projectRoot), '.antigravity', 'bridge', 'state.json');
  if (!fs.existsSync(statePath)) {
    return { phase: 'IDLE', retryCount: 0, maxRetries: 2, lastStatus: 'NONE', updatedAt: null };
  }
  try {
    return JSON.parse(fs.readFileSync(statePath, 'utf8'));
  } catch (_) {
    return { phase: 'IDLE', retryCount: 0, maxRetries: 2, lastStatus: 'NONE', updatedAt: null };
  }
}

function writeProjectState(projectRoot, patch) {
  const bridgeDir = path.join(path.resolve(projectRoot), '.antigravity', 'bridge');
  if (!fs.existsSync(bridgeDir)) fs.mkdirSync(bridgeDir, { recursive: true });
  const statePath = path.join(bridgeDir, 'state.json');
  const cur = readProjectState(projectRoot);
  const next = Object.assign({}, cur, patch, { updatedAt: new Date().toISOString() });
  fs.writeFileSync(statePath, JSON.stringify(next, null, 2), 'utf8');
  return next;
}

function ensureProjectSetup(projectRoot) {
  const cleanRoot = path.resolve(projectRoot);
  const bridgeDir = path.join(cleanRoot, '.antigravity', 'bridge');
  const exchangeDir = path.join(bridgeDir, 'exchange');
  const routingPath = path.join(bridgeDir, 'routing.json');

  if (!fs.existsSync(exchangeDir)) fs.mkdirSync(exchangeDir, { recursive: true });

  if (!fs.existsSync(routingPath)) {
    const defaultRouting = {
      projectName: path.basename(cleanRoot),
      projectRoot: cleanRoot,
      forceMaxReasoning: true,
      autoNewChatOnProjectSwitch: true,
      bundleFormat: 'auto',
      buildCmd: '',
      testCmd: '',
      roles: {
        planner: 'gemini1',
        coder: 'gemini2',
        reviewer: 'gemini1',
        executor: 'antigravity'
      }
    };
    fs.writeFileSync(routingPath, JSON.stringify(defaultRouting, null, 2), 'utf8');
  }

  const reg = JSON.parse(fs.readFileSync(REGISTRY_PATH, 'utf8'));
  if (!reg.projects.includes(cleanRoot)) {
    reg.projects.push(cleanRoot);
    fs.writeFileSync(REGISTRY_PATH, JSON.stringify(reg, null, 2), 'utf8');
  }

  const gitIgnorePath = path.join(cleanRoot, '.gitignore');
  if (fs.existsSync(path.join(cleanRoot, '.git')) || fs.existsSync(gitIgnorePath)) {
    try {
      let giContent = fs.existsSync(gitIgnorePath) ? fs.readFileSync(gitIgnorePath, 'utf8') : '';
      if (!giContent.includes('.antigravity')) {
        giContent = giContent.trim() ? giContent.trim() + NL + '.antigravity/' + NL : '.antigravity/' + NL;
        fs.writeFileSync(gitIgnorePath, giContent, 'utf8');
      }
    } catch (ignoreErr) {}
  }

  return JSON.parse(fs.readFileSync(routingPath, 'utf8'));
}

function purgeExchangeArtifacts(projectRoot) {
  const cleanRoot = path.resolve(projectRoot);
  const exchangeDir = path.join(cleanRoot, '.antigravity', 'bridge', 'exchange');
  if (!fs.existsSync(exchangeDir)) return { ok: true, removedCount: 0 };
  const filesToPurge = [
    'project_bundle.txt',
    'project_context_bundle.txt',
    'project_bundle.zip',
    'project_bundle.zip.md',
    'last_error.txt'
  ];
  let count = 0;
  for (const f of filesToPurge) {
    const p = path.join(exchangeDir, f);
    if (fs.existsSync(p)) {
      try { fs.unlinkSync(p); count++; } catch (e) {}
    }
  }
  try {
    const all = fs.readdirSync(exchangeDir);
    for (const name of all) {
      if (name.startsWith('support_') && name.endsWith('.png')) {
        try { fs.unlinkSync(path.join(exchangeDir, name)); count++; } catch (e) {}
      }
    }
  } catch (e) {}
  return { ok: true, removedCount: count };
}

  function classifyWorkspaceFile(rel,meta){meta=meta||{};const low=String(rel||'').replace(/\\/g,'/').toLowerCase(),ext=path.extname(low),segments=low.split('/');const source=new Set(['.js','.mjs','.cjs','.ts','.tsx','.jsx','.py','.java','.kt','.go','.rs','.cs','.php','.rb','.swift','.cpp','.c','.h','.hpp','.vue','.svelte','.sql','.sh','.ps1']);const config=/(^|\/)(package\.json|pyproject\.toml|cargo\.toml|go\.mod|requirements[^/]*\.txt|[^/]*(?:lock|config)[^/]*)$/.test(low);const generated=segments.some(function(x){return /^(logs?|reports?|outputs?|artifacts?|generated|caches?|tmp|temp|backups?|archive|exports?|coverage|dist|build|node_modules|venv|\.git)$/.test(x);})||/(?:^|[_-])\d{4}[-_]\d{2}[-_]\d{2}(?:[_-]|\.)/.test(low);const binary=/\.(png|jpe?g|gif|webp|zip|pdf|mp4|mov|mp3|wav|exe|dll|so|bin)$/i.test(low);const runtime=/\.(json|csv|ndjson|log)$/i.test(low)&&/(data|queue|history|session|state|dump|lead|runtime|report)/i.test(low);let tier=config?0:source.has(ext)?1:/(test|spec|docs?|readme|schema|migration)/i.test(low)?2:3;if(meta.explicitTarget||meta.errorReferenced||meta.entryPoint)tier=0;return {tier:tier,sourceFile:source.has(ext),configFile:config,generatedSignal:generated,runtimeDataSignal:runtime,binary:binary};}
  function scoreWorkspaceFile(info){const m=info.meta||{},c=info.classification||classifyWorkspaceFile(info.rel,m);return (m.explicitTarget?10000:0)+(m.errorReferenced?8000:0)+(m.entryPoint?6000:0)+(m.importedByTarget?4000:0)+(c.sourceFile?2500:0)+(c.configFile?2200:0)+(m.testForTarget?1800:0)+(m.recentlyModifiedSource?400:0)-(c.generatedSignal?3000:0)-(c.runtimeDataSignal?2500:0)-(m.duplicateContent?5000:0)-Math.floor((info.size||0)/65536)*100;}
  function compactWorkspaceContent(rel,content,maxBytes,classification){const bytes=Buffer.byteLength(content);if(bytes<=maxBytes)return {text:content,summarized:false};const ext=path.extname(rel).toLowerCase(),lines=content.split(/\r?\n/);if(ext==='.json'||ext==='.csv'||ext==='.ndjson'){let summary='[STRUCTURED DATA SUMMARY] '+rel+' bytes='+bytes+' rows='+lines.length+NL;if(ext==='.json'){try{const v=JSON.parse(content);summary+='type='+(Array.isArray(v)?'array':'object')+' keys='+Object.keys(Array.isArray(v)?(v[0]||{}):v).slice(0,40).join(',');}catch(_){summary+='invalid_or_streaming_json';}}else summary+='columns='+(lines[0]||'').slice(0,1000);return {text:summary,summarized:true};}if(ext==='.log'||classification.runtimeDataSignal)return {text:'[LOG TAIL] '+rel+NL+lines.slice(-120).join(NL),summarized:true};if(/\.(md|txt|rst)$/i.test(ext)){const headings=lines.filter(function(x){return /^#{1,6}\s|^[A-Z][A-Z 0-9_-]{5,}$/.test(x);}).slice(0,100);return {text:'[DOCUMENT OUTLINE] '+rel+NL+headings.join(NL)+NL+'[TAIL]'+NL+lines.slice(-40).join(NL),summarized:true};}const half=Math.max(512,Math.floor(maxBytes/2)-100);return {text:Buffer.from(content).subarray(0,half).toString('utf8')+NL+'...[COMPACTED '+(bytes-maxBytes)+' BYTES]...'+NL+Buffer.from(content).subarray(-half).toString('utf8'),summarized:true};}
  function buildBudgetedWorkspaceBundle(projectRoot,opts){opts=opts||{};const cleanRoot=fs.realpathSync(path.resolve(projectRoot)),mode=PACK_MODES[opts.mode]?opts.mode:PACK_MODES.PLANNING_FULL,budget=Math.min(ABSOLUTE_BUNDLE_CEILING,Math.max(4096,Number(opts.budgetBytes||PACK_BUDGETS[mode]))),targets=new Set((opts.explicitTargets||[]).map(function(x){return String(x).replace(/\\/g,'/');})),errors=new Set((opts.errorReferenced||[]).map(function(x){return String(x).replace(/\\/g,'/');})),events=[],files=[],excluded=[],hashes=new Map();let budgetReachedLogged=false,excludedBinaryExtensionCount=0,excludedBinaryContentCount=0,excludedInvalidUtf8Count=0;function budgetReachedOnce(){if(!budgetReachedLogged){budgetReachedLogged=true;console.error('[PACK_BUDGET_REACHED] mode='+mode);}}console.error('[PACK_STARTED] mode='+mode+' budgetBytes='+budget);function walk(dir){for(const ent of fs.readdirSync(dir,{withFileTypes:true}).sort(function(a,b){return a.name.localeCompare(b.name);})){const full=path.join(dir,ent.name),rel=path.relative(cleanRoot,full).replace(/\\/g,'/');if(/[{}]/.test(rel)||rel.startsWith('../')||path.isAbsolute(rel)){excluded.push({rel:rel,reason:'INVALID_PATH'});continue;}let real;try{real=fs.realpathSync(full);}catch(_){excluded.push({rel:rel,reason:'UNRESOLVED'});continue;}if(real!==cleanRoot&&!real.startsWith(cleanRoot+path.sep)){excluded.push({rel:rel,reason:'SYMLINK_ESCAPE'});continue;}if(ent.isDirectory()){const denied=rel.split('/').some(function(segment){return TEXT_BUNDLE_DENIED_DIRECTORIES.has(segment.toLowerCase());});if(denied&&!targets.has(rel)){excluded.push({rel:rel,reason:'GENERATED_DIRECTORY'});continue;}walk(full);continue;}let st;try{st=fs.statSync(real);}catch(_){continue;}if(!st.isFile()){excluded.push({rel:rel,reason:'NON_REGULAR'});continue;}const meta={explicitTarget:targets.has(rel),errorReferenced:errors.has(rel),entryPoint:/(^|\/)(index|main|server|app)\.[^.]+$/i.test(rel),testForTarget:/test|spec/i.test(rel)};const classification=classifyWorkspaceFile(rel,meta),ext=path.extname(rel).toLowerCase();if(TEXT_BUNDLE_DENIED_EXTENSIONS.has(ext)||classification.binary){excludedBinaryExtensionCount++;excluded.push({rel:rel,reason:'BINARY_EXTENSION'});continue;}if(classification.generatedSignal&&!meta.explicitTarget){excluded.push({rel:rel,reason:'GENERATED'});continue;}files.push({full:real,rel:rel,size:st.size,meta:meta,classification:classification,score:scoreWorkspaceFile({rel:rel,size:st.size,meta:meta,classification:classification})});}}walk(cleanRoot);files.sort(function(a,b){return b.score-a.score||a.rel.localeCompare(b.rel);});let out=['=== BUDGETED WORKSPACE MANIFEST ===','mode='+mode+' budgetBytes='+budget,'tree='+files.slice(0,120).map(function(x){return x.rel;}).join(' | '),''].join(NL),included=[],summarized=[],duplicates=[];for(const f of files){let raw,content;try{raw=fs.readFileSync(f.full);const inspected=inspectTextBuffer(raw);if(!inspected.isText){if(!inspected.utf8Valid)excludedInvalidUtf8Count++;else excludedBinaryContentCount++;excluded.push({rel:f.rel,reason:inspected.utf8Valid?'BINARY_CONTENT':'INVALID_UTF8'});continue;}content=inspected.text;}catch(_){excluded.push({rel:f.rel,reason:'READ_ERROR'});continue;}const h=crypto.createHash('sha256').update(raw).digest('hex');if(hashes.has(h)){duplicates.push({canonical:hashes.get(h),alias:f.rel});excluded.push({rel:f.rel,reason:'DUPLICATE'});continue;}hashes.set(h,f.rel);const remaining=budget-Buffer.byteLength(out)-256;if(remaining<256){budgetReachedOnce();excluded.push({rel:f.rel,reason:'BUDGET'});continue;}const compact=compactWorkspaceContent(f.rel,content,Math.min(64*1024,remaining-128),f.classification),block=NL+'--- FILE: '+f.rel+' tier='+f.classification.tier+' score='+f.score+(compact.summarized?' summarized=true':'')+' ---'+NL+compact.text+NL;if(Buffer.byteLength(out+block)>budget-256){excluded.push({rel:f.rel,reason:'BUDGET'});budgetReachedOnce();continue;}out+=block;included.push(f.rel);if(compact.summarized)summarized.push(f.rel);console.error('['+(compact.summarized?'PACK_FILE_SUMMARIZED':'PACK_FILE_INCLUDED')+'] path='+f.rel+' bytes='+Buffer.byteLength(compact.text));}const footer=NL+'=== EXCLUSION SUMMARY ==='+NL+Object.entries(excluded.reduce(function(a,x){a[x.reason]=(a[x.reason]||0)+1;return a;},{})).map(function(x){return x[0]+'='+x[1];}).join(' ')+NL+'duplicates='+duplicates.length;out+=Buffer.byteLength(out+footer)<=budget?footer:'';if(Buffer.byteLength(out)>budget||Buffer.byteLength(out)>ABSOLUTE_BUNDLE_CEILING)throw new Error('PACK_BUDGET_INVARIANT_FAILED');validateFinalTextArtifact(out,mode);const missing=Array.from(targets).filter(function(x){return !included.includes(x);}),receipt={mode:mode,budgetBytes:budget,outputBytes:Buffer.byteLength(out),includedCount:included.length,excludedCount:excluded.length,summarizedCount:summarized.length,duplicateCount:duplicates.length,tiers:included.reduce(function(a,r){const f=files.find(function(x){return x.rel===r;});a[f.classification.tier]=(a[f.classification.tier]||0)+1;return a;},{}),topIncluded:included.slice(0,20),topExcludedReasons:excluded.reduce(function(a,x){a[x.reason]=(a[x.reason]||0)+1;return a;},{}),targetsIncluded:Array.from(targets).filter(function(x){return included.includes(x);}),targetsMissing:missing,manifestPath:'project_bundle.txt',excludedBinaryExtensionCount:excludedBinaryExtensionCount,excludedBinaryContentCount:excludedBinaryContentCount,excludedInvalidUtf8Count:excludedInvalidUtf8Count,nulCount:0,replacementCharacterCount:(out.match(/\ufffd/g)||[]).length};console.error('[PACK_COMPLETED] mode='+mode+' outputBytes='+receipt.outputBytes+' included='+included.length);return {content:out,receipt:receipt,files:included};}
  function packWorkspace(projectRoot, mode) {const legacy=String(mode||'FULL').toUpperCase(),mapped=PACK_MODES[mode]?mode:(legacy==='DELTA'?PACK_MODES.CODING_FOCUSED:PACK_MODES.PLANNING_FULL),cleanRoot=path.resolve(projectRoot),routing=ensureProjectSetup(cleanRoot),exchangeDir=path.join(cleanRoot,'.antigravity','bridge','exchange');if(!fs.existsSync(exchangeDir))fs.mkdirSync(exchangeDir,{recursive:true});let targets=[],errorRefs=[];const plan=path.join(exchangeDir,'plan.md'),err=path.join(exchangeDir,'last_error.txt');if(fs.existsSync(plan)){const txt=fs.readFileSync(plan,'utf8');targets=Array.from(txt.matchAll(/^\s*(?:[-*]\s*)?FILE_TARGET:\s*([^\r\n]+)$/gmi)).map(function(m){return m[1].trim().replace(/["'`*]/g,'');});}if(fs.existsSync(err)){const t=fs.readFileSync(err,'utf8');errorRefs=Array.from(t.matchAll(/(?:^|\s)([A-Za-z0-9_.\/-]+\.[A-Za-z0-9]+)(?::\d+)?/g)).map(function(m){return m[1];});}const built=buildBudgetedWorkspaceBundle(cleanRoot,{mode:mapped,explicitTargets:targets,errorReferenced:errorRefs}),txtPath=path.join(exchangeDir,'project_bundle.txt');validateFinalTextArtifact(built.content,mapped);fs.writeFileSync(txtPath,built.content,'utf8');const zipPath=path.join(exchangeDir,'project_bundle.zip'),zipMdPath=path.join(exchangeDir,'project_bundle.zip.md'),zip=new AdmZip();for(const rel of built.files){try{zip.addFile(rel,fs.readFileSync(path.join(cleanRoot,rel)));}catch(_){}}zip.writeZip(zipPath);fs.copyFileSync(zipPath,zipMdPath);const sha256=crypto.createHash('sha256').update(fs.readFileSync(txtPath)).digest('hex');writeProjectState(cleanRoot,{phase:'PACKED',retryCount:0,lastStatus:'BUNDLE_READY'});return {bundlePath:routing.bundleFormat==='zip.md'?zipMdPath:txtPath,format:routing.bundleFormat||'auto',fileCount:built.files.length,sha256:sha256,receipt:built.receipt};}


function getBundleAttachmentAndNote(projectRoot, targetEngine) {
  const routing = ensureProjectSetup(projectRoot);
  const exchangeDir = path.join(path.resolve(projectRoot), '.antigravity', 'bridge', 'exchange');
  const txtPath = path.join(exchangeDir, 'project_bundle.txt');
  const zipMdPath = path.join(exchangeDir, 'project_bundle.zip.md');

  const eng = String(targetEngine || '');
  const isGoogle = eng.startsWith('google_search_') || eng.startsWith('gemini');
  const useZipMd = !isGoogle && (eng.startsWith('web') || (routing.bundleFormat === 'zip.md'));

  if (useZipMd) {
    if (!fs.existsSync(zipMdPath)) packWorkspace(projectRoot, 'FULL');
    const hash = crypto.createHash('sha256').update(fs.readFileSync(zipMdPath)).digest('hex');
    const note = NL + NL + 'UDHEZIM PER SKEDARIN (project_bundle.zip.md): Ky eshte arkiv binar real .zip (SHA-256: ' + hash + ') me prapashtesen .md per transport ne M365 Copilot Web. Hiq prapashtesen finale .md dhe hape si .zip normal.' + NL;
    return { path: zipMdPath, note: note };
  }

  if (!fs.existsSync(txtPath)) packWorkspace(projectRoot, 'FULL');
  const txtNote = NL + NL + 'UDHEZIM: I gjithë kodi burimor i projektit është në formatin tekst .txt (project_bundle.txt) i përfshirë më poshtë brenda këtij mesazhi.' + NL;
  return { path: txtPath, note: txtNote };
}

function parseCodeBlocksFromMarkdown(markdown, expectedTargets) {
  const source=String(markdown||''),results=[],expected=new Set((expectedTargets||[]).map(function(x){return String(x).replace(/\\/g,'/').replace(/^\.\//,'');}));
  const safePath=function(value){const normalized=String(value||'').trim().replace(/^[\x22\x27]|[\x22\x27]$/g,'').replace(/\\/g,'/');if(!normalized||normalized.startsWith('/')||/^[A-Za-z]:\//.test(normalized)||normalized.split('/').includes('..'))return '';return normalized;};
  const accept=function(relPath,code){
    const clean=safePath(relPath);
    if(!clean||!String(code||'').trim()||(expected.size&& !expected.has(clean)))return;
    const normalizedCode=normalizeGeneratedSourceText(code);
    const unsafeChars=findUnsafeGeneratedSourceCharacters(normalizedCode);
    if(unsafeChars.length>0){
      throw new Error('GENERATED_SOURCE_UNSAFE_UNICODE: '+clean+' '+JSON.stringify(unsafeChars));
    }
    results.push({relPath:clean,code:normalizedCode});
  };
  const dynamicFencePattern = new RegExp("(?:(?:###\\s*)?FILE:\\s*([^\\r\\n`]+)\\r?\\n\\s*)?(`{3,})([a-zA-Z0-9_+-]*)\\r?\\n([\\s\\S]*?)\\r?\\n\\2(?:\\r?\\n|$)", "g");
  let match;
  let fenceIndex = 0;
  while ((match = dynamicFencePattern.exec(source)) !== null) {
    const declaredTarget = match[1];
    const code = match[4];
    if (declaredTarget) {
      accept(declaredTarget, code);
    } else {
      const target = Array.from(expected)[fenceIndex++];
      if (target) accept(target, code);
    }
  }
  if (results.length) return results;
  const markers=[];const marker=/^\s*FILE\s*:\s*([^\r\n]+)$/gmi;while((match=marker.exec(source))!==null)markers.push({index:match.index,end:marker.lastIndex,line:match[1]});
  const PYTHON_STARTERS=[/^import\s+/,/^from\s+\S+\s+import\s+/,/^def\s+[A-Za-z_]\w*\s*\(/,/^async\s+def\s+[A-Za-z_]\w*\s*\(/,/^class\s+[A-Za-z_]\w*/,/^#/,/^@/,/^#!/,/^if\s+__name__\s*==/,/^try\s*:/,/^with\s+.+:/,/^pass(?:\s|$)/,/^[A-Za-z_]\w*(?:\s*:\s*[^=]+)?\s*=/,/^(?:(?:r|u|f|fr|rf)?(?:"""|'''))/i];
  const JS_STARTERS=[/^(?:import|export)\b/,/^(?:const|let|var)\s+[A-Za-z_$]/,/^function\b/,/^async\s+function\b/,/^class\b/,/^\/\//,/^\/\*/,/^module\.exports\b/,/^require\s*\(/,/^['"]use strict['"];?/,/^(?:describe|test|it)\s*\(/];
  function matchesAnyStarter(text,patterns){return patterns.some(function(p){return p.test(text);});}
  const starters={cs:/^(?:using|namespace|public|internal|private|protected|class|record|interface|enum|\/\/|#)/,json:/^[{[]/,html:/^(?:<!doctype|<html|<div|<template|<!--)/i,css:/^(?:@|:root|\.|#|[a-z-]+\s*{)/i,sh:/^(?:#!|set\s+-|[a-zA-Z_][a-zA-Z0-9_]*=|function\s+)/};
  markers.forEach(function(item,i){
    const tail=source.slice(item.end,i+1<markers.length?markers[i+1].index:source.length);
    let target='';
    const candidates=Array.from(expected).map(normalizeCheckpointTarget).sort(function(a,b){return b.length-a.length;});
    const lowerLine=item.line.toLowerCase();
    target=candidates.find(function(c){
      const lowerC=c.toLowerCase();
      if(!lowerLine.startsWith(lowerC))return false;
      const next=item.line.slice(c.length,c.length+1);
      return next===''||/\s/.test(next);
    })||'';
    if(!target){const token=item.line.trim().split(/\s+/)[0];target=safePath(token);}
    if(!target||(expected.size&&!expected.has(target)))return;
    let code=(item.line.slice(target.length)+tail).trim();
    code=code.replace(/^(?:python|javascript|typescript|csharp|json|html|css|bash|shell)\s*/i,'');
    const ext=path.extname(target).slice(1).toLowerCase();
    let kind='';
    if(ext==='py')kind='py';
    else if(['js','jsx','ts','tsx'].includes(ext))kind='js';
    else if(ext==='cs')kind='cs';
    else if(ext==='json')kind='json';
    else if(['html','htm'].includes(ext))kind='html';
    else if(ext==='css')kind='css';
    else if(['sh','bash'].includes(ext))kind='sh';
    let lexical=false;
    if(kind==='py')lexical=matchesAnyStarter(code,PYTHON_STARTERS);
    else if(kind==='js')lexical=matchesAnyStarter(code,JS_STARTERS);
    else if(starters[kind])lexical=starters[kind].test(code);
    if(!lexical)return;
    accept(target,code);
    if(results.some(function(x){return x.relPath===target;}))console.error('[UNFENCED_OUTPUT_RECOVERED] target='+target+' parserMode=UNFENCED_FILE_FALLBACK');
  });
  return results;
}
function validateGeneratedCodeMarkdown(markdown) {
  const fileBlocks = parseCodeBlocksFromMarkdown(markdown);
  if (fileBlocks.length === 0) {
    return { valid: false, reason: 'Mungojne blloqet e skedareve me etiketen ### FILE: path/to/file.ext.' };
  }
  const forbiddenPatterns = [
    /\/\/\s*\.\.\.\s*(rest of|existing|previous|other)/i,
    /\/\*\s*\.\.\.\s*(rest of|existing)/i,
    /#\s*\.\.\.\s*(rest of|existing)/i,
    /\/\/\s*TODO:\s*implement/i
  ];
  for (const b of fileBlocks) {
    for (const pat of forbiddenPatterns) {
      if (pat.test(b.code)) {
        return { valid: false, reason: 'Placeholder i ndaluar u gjet ne skedarin ' + b.relPath + '. Kerkohet kod 100% i plote.' };
      }
    }
  }
  return { valid: true, fileBlocks: fileBlocks };
}

function atomicWriteValidated(targetPath, content) {
  const dir=path.dirname(targetPath),temp=path.join(dir,'.'+path.basename(targetPath)+'.antigravity-'+process.pid+'-'+crypto.randomBytes(6).toString('hex')+'.tmp');
  fs.mkdirSync(dir,{recursive:true});fs.writeFileSync(temp,content,'utf8');
  if(!fs.statSync(temp).size){fs.unlinkSync(temp);throw new Error('ATOMIC_WRITE_EMPTY: '+targetPath);}
  try{fs.renameSync(temp,targetPath);}catch(error){if(fs.existsSync(temp))fs.unlinkSync(temp);throw error;}
}

function applyAndTestDeterministically(projectRoot) {
  const resumeBatchId='BATCH-001';console.error('[CHECKPOINT_RESUME] resumeBatchId='+resumeBatchId+' destructiveReset=false');
  const routing = ensureProjectSetup(projectRoot);
  const cleanRoot = path.resolve(projectRoot);
  const exchangeDir = path.join(cleanRoot, '.antigravity', 'bridge', 'exchange');
  const codePath = path.join(exchangeDir, 'code.md');
  const logPath = path.join(exchangeDir, 'build_test.log');
  const errorPath = path.join(exchangeDir, 'last_error.txt');

  if (!fs.existsSync(codePath)) {
    throw new Error('Skedari exchange/code.md nuk ekziston ende.');
  }

  const rawMarkdown = fs.readFileSync(codePath, 'utf8');
  const check = validateGeneratedCodeMarkdown(rawMarkdown);
  if (!check.valid) {
    return { status: 'DELEGATE_FALLBACK_EXECUTOR', reason: check.reason, codeFile: codePath };
  }

  const writtenFiles = [];
  for (const item of check.fileBlocks) {
    const targetAbs = path.resolve(cleanRoot, item.relPath);
    if (!targetAbs.startsWith(cleanRoot + path.sep) && targetAbs !== cleanRoot) {
      throw new Error('SECURITY_BLOCK: Tentative shkrimi jashte projectRoot: ' + item.relPath);
    }
    const parentDir = path.dirname(targetAbs);
    if (!fs.existsSync(parentDir)) fs.mkdirSync(parentDir, { recursive: true });
    atomicWriteValidated(targetAbs, item.code);
    writtenFiles.push(item.relPath);
  }

  const commands = [routing.buildCmd, routing.testCmd].map(function(c) { return (c || '').trim(); }).filter(Boolean);
  let combinedLogs = '=== DETERMINISTIC APPLY COMPLETED (' + writtenFiles.length + ' files) ===' + NL + 'Files: ' + writtenFiles.join(', ') + NL;

  for (const cmd of commands) {
    combinedLogs += NL + '$ ' + cmd + NL;
    const run = spawnSync(cmd, { cwd: cleanRoot, shell: true, encoding: 'utf8', timeout: 180000 });
    const out = (run.stdout || '') + NL + (run.stderr || '');
    combinedLogs += out;

    if (run.status !== 0) {
      const compacted = compactErrorLog('COMMAND FAILED: ' + cmd + NL + 'EXIT_CODE: ' + run.status + NL + NL + out);
      fs.writeFileSync(errorPath, compacted, 'utf8');
fs.writeFileSync(logPath, combinedLogs, 'utf8');
const st = readProjectState(cleanRoot);
const nextRetry = (st.retryCount || 0) + 1;
writeProjectState(cleanRoot, { phase: 'BUILD_FAILED', retryCount: nextRetry, lastStatus: 'ERROR' });
return {
status: 'BUILD_OR_TEST_FAILED',
failedCommand: cmd,
exitCode: run.status,
retryCount: nextRetry,
maxRetriesReached: nextRetry > (st.maxRetries || 2),
errorFile: errorPath
};
}
}
fs.writeFileSync(logPath, combinedLogs, 'utf8');
writeProjectState(cleanRoot, { phase: 'APPLIED_AND_VERIFIED', lastStatus: 'BUILD_OK' });
return { status: 'APPLIED_AND_GREEN', writtenFiles: writtenFiles, commandsExecuted: commands, logFile: logPath };
}

const CHUNK_ENGINE_LIMITS=Object.freeze({repoMapSoft:48*1024,repoMapHard:64*1024,planningSafe:240*1024,chunkSoft:160*1024,chunkHard:240*1024,summaryHard:24*1024,batchSoft:160*1024,batchHard:192*1024,recoveryHard:160*1024,contractPerBatch:16*1024,contractCumulative:64*1024,reviewSoft:160*1024,reviewHard:240*1024,maxBatchFiles:2,testMaxFiles:1,maxBatchTargetSourceBytes:18*1024,maxHalvingLevel:4,maxWebAnalysisChunks:4,maxInlineChars:12*1024,maxInlineBytes:12*1024,batchMiniMapSoft:8*1024});
function normalizeBatchTarget(value){return String(value||'').replace(/\\/g,'/').replace(/^\.\//,'').trim();}
function inferRepositoryLanguage(rel){const e=path.extname(rel).toLowerCase();return ({'.js':'JavaScript','.mjs':'JavaScript','.cjs':'JavaScript','.ts':'TypeScript','.tsx':'TypeScript','.jsx':'JavaScript','.py':'Python','.java':'Java','.kt':'Kotlin','.cs':'CSharp','.go':'Go','.rs':'Rust','.php':'PHP','.rb':'Ruby','.c':'C','.h':'C','.cpp':'Cpp','.hpp':'Cpp','.sh':'Shell','.ps1':'PowerShell','.sql':'SQL','.vue':'Vue','.svelte':'Svelte','.json':'JSON','.yaml':'YAML','.yml':'YAML','.toml':'TOML','.xml':'XML'})[e]||'Text';}
function extractRepositorySignals(rel,text){const imports=[],symbols=[],exports=[];const patterns=[/(?:import[^'\"]*from\s*|require\s*\(|import\s*\()['\"]([^'\"]+)['\"]/g,/^\s*(?:from|import)\s+([A-Za-z0-9_.]+)/gm,/^\s*(?:using|package|import)\s+([A-Za-z0-9_.]+)/gm,/^\s*(?:mod|use)\s+([A-Za-z0-9_:]+)/gm];for(const r of patterns){let m;while((m=r.exec(text))&&imports.length<100)imports.push(m[1]);}const sr=/^\s*(?:export\s+)?(?:async\s+)?(?:function|class|interface|record|struct|enum|def|fn|type|const|let|var)\s+([A-Za-z_$][\w$]*)/gm;let sm;while((sm=sr.exec(text))&&symbols.length<120)symbols.push(sm[1]);const er=/^\s*export\s+(?:default\s+)?(?:async\s+)?(?:function|class|const|let|var)?\s*([A-Za-z_$][\w$]*)?/gm;let em;while((em=er.exec(text))&&exports.length<80)if(em[1])exports.push(em[1]);return {imports:Array.from(new Set(imports)).sort(),symbols:Array.from(new Set(symbols)).sort(),exports:Array.from(new Set(exports)).sort(),entryPointSignals:/(^|\/)(main|index|server|app|program)\.[^.]+$/i.test(rel)||/\b(?:main\s*\(|if __name__|createServer\s*\()/.test(text),testSignals:/(^|\/|\.)(test|tests|spec|specs)(\/|\.|$)/i.test(rel),configSignals:/(package\.json|pyproject\.toml|cargo\.toml|go\.mod|\.ya?ml$|\.toml$|\.xml$)/i.test(rel)};}
function scanRepositoryUniversal(projectRoot){
  const root=fs.realpathSync(path.resolve(projectRoot)),files=[],excluded=[],maximumFullReadBytes=2*1024*1024,binaryProbeBytes=8*1024;
  const runtimeDirectoryName=function(name){const low=String(name||'').toLowerCase().trim();return /(?:_|-)profiles?$/.test(low)||/^(?:_?build_)?archives?$|^backups?$/i.test(low)||new Set(['cache','code cache','gpucache','indexeddb','leveldb','local storage','session storage','blob_storage','crashpad','safebrowsing','shadercache','dawnwebgpucache','dawngraphitecache','service worker']).has(low);};
  const exclude=function(rel,reason,error){const item={path:rel,reason:reason};if(error&&error.code)item.errorCode=String(error.code);excluded.push(item);};
  function readProbe(real,size){let fd=null;try{fd=fs.openSync(real,'r');const length=Math.min(binaryProbeBytes,size),buffer=Buffer.alloc(length);const bytesRead=length?fs.readSync(fd,buffer,0,length,0):0;return buffer.subarray(0,bytesRead);}finally{if(fd!==null)try{fs.closeSync(fd);}catch(_){}}}
  function walk(dir){let entries;try{entries=fs.readdirSync(dir,{withFileTypes:true});}catch(err){exclude(path.relative(root,dir).replace(/\\/g,'/')||'.','UNREADABLE_OR_LOCKED',err);return;}for(const ent of entries.sort((a,b)=>a.name.localeCompare(b.name))){const full=path.join(dir,ent.name),rel=path.relative(root,full).replace(/\\/g,'/'),low=ent.name.toLowerCase();if(ent.isDirectory()){if(TEXT_BUNDLE_DENIED_DIRECTORIES.has(low)||low==='.antigravity'||runtimeDirectoryName(low)){exclude(rel,'IGNORED_DIRECTORY');continue;}walk(full);continue;}let real,st;try{real=fs.realpathSync(full);if(!real.startsWith(root+path.sep)){exclude(rel,'PATH_OR_TYPE');continue;}st=fs.statSync(real);}catch(err){exclude(rel,'UNREADABLE_OR_LOCKED',err);continue;}if(!st.isFile()){exclude(rel,'PATH_OR_TYPE');continue;}const extension=path.extname(low);if(new Set(['.bak','.old','.orig','.tmp','.swp']).has(extension)){exclude(rel,'BACKUP_OR_TEMP');continue;}if(TEXT_BUNDLE_DENIED_EXTENSIONS.has(extension)){exclude(rel,'BINARY_EXTENSION');continue;}let raw,inspection;try{if(st.size>maximumFullReadBytes){const probe=readProbe(real,st.size);inspection=inspectTextBuffer(probe);exclude(rel,inspection.isText?'OVERSIZED_RUNTIME_OR_DATA':'BINARY_OR_OVERSIZED');continue;}raw=fs.readFileSync(real);inspection=inspectTextBuffer(raw);}catch(err){exclude(rel,'UNREADABLE_OR_LOCKED',err);continue;}if(!inspection.isText){exclude(rel,'BINARY_CONTENT');continue;}const signals=extractRepositorySignals(rel,inspection.text),classification=classifyWorkspaceFile(rel,{});if(classification.generatedSignal){exclude(rel,'GENERATED_RUNTIME_OR_OUTPUT');continue;}files.push(Object.assign({path:rel,extension:path.extname(rel).toLowerCase(),bytes:st.size,sha256:crypto.createHash('sha256').update(raw).digest('hex'),language:inferRepositoryLanguage(rel),category:classification.configFile?'config':classification.sourceFile?'source':signals.testSignals?'test':'text',generatedScore:0,sourceScore:classification.sourceFile?100:20,errorReferenceSignals:[]},signals));}}
  walk(root);const fingerprint=crypto.createHash('sha256').update(files.map(f=>f.path+'|'+f.sha256+'|'+f.imports.join(',')).join('\n')).digest('hex');return {projectRoot:root,files:files,excluded:excluded,totalBytes:files.reduce((n,f)=>n+f.bytes,0),repoFingerprint:fingerprint};
}
function resolveDependencyPath(from,spec,paths){if(!spec||(!spec.startsWith('.')&&!spec.startsWith('/')))return null;const base=path.posix.normalize(path.posix.join(path.posix.dirname(from),spec));const tries=[base,base+'.js',base+'.ts',base+'.tsx',base+'.jsx',base+'.py',base+'.cs',base+'/index.js',base+'/index.ts'];return tries.find(x=>paths.has(x))||null;}
function buildDependencyGraph(scan){const paths=new Set(scan.files.map(f=>f.path)),edges=[],unresolved=[];for(const f of scan.files)for(const spec of f.imports){const to=resolveDependencyPath(f.path,spec,paths);if(to)edges.push({from:f.path,to:to});else unresolved.push({from:f.path,specifier:spec});}edges.sort((a,b)=>(a.from+'|'+a.to).localeCompare(b.from+'|'+b.to));return {nodes:scan.files.map(f=>f.path),edges:edges,unresolved:unresolved};}
function buildCompactRepoMap(scan,limits){limits=Object.assign({},CHUNK_ENGINE_LIMITS,limits||{});const graph=buildDependencyGraph(scan),langs=Object.entries(scan.files.reduce((a,f)=>(a[f.language]=(a[f.language]||0)+1,a),{})).sort(),entries=scan.files.filter(f=>f.entryPointSignals).map(f=>f.path),tests=scan.files.filter(f=>f.testSignals).map(f=>f.path),configs=scan.files.filter(f=>f.configSignals).map(f=>f.path);let text=['PROJECT SUMMARY','files='+scan.files.length+' bytes='+scan.totalBytes+' fingerprint='+scan.repoFingerprint,'LANGUAGES',...langs.map(x=>x[0]+'='+x[1]),'ENTRY POINTS',...entries,'BUILD/TEST COMMANDS',...configs.filter(x=>/package\.json|pyproject|cargo|go\.mod/i.test(x)),'DIRECTORY TREE',...Array.from(new Set(scan.files.map(f=>f.path.split('/').slice(0,-1).join('/')||'.'))).sort(),'MODULE INDEX',...scan.files.slice(0,500).map(f=>f.path+' ['+f.language+','+f.bytes+']'),'SYMBOL INDEX',...scan.files.filter(f=>f.symbols.length).slice(0,200).map(f=>f.path+': '+f.symbols.slice(0,12).join(',')),'DEPENDENCY EDGES',...graph.edges.slice(0,500).map(e=>e.from+' -> '+e.to),'CONFIG/SCHEMA/TEST INDEX',...configs,...tests,'RUNTIME/GENERATED EXCLUSIONS',...scan.excluded.slice(0,200).map(x=>x.path+':'+x.reason),'UNRESOLVED EDGES',...graph.unresolved.slice(0,200).map(x=>x.from+' -> '+x.specifier)].join(NL);text=truncateUtf8(text,limits.repoMapHard);return {text:text,bytes:Buffer.byteLength(text),sha256:crypto.createHash('sha256').update(text).digest('hex'),graph:graph};}
function partitionAnalysisChunks(scan,graph,limits){limits=Object.assign({},CHUNK_ENGINE_LIMITS,limits||{});const byDir=new Map();for(const f of scan.files.filter(function(file){return Number(file.generatedScore||0)===0;})){const key=f.path.includes('/')?f.path.split('/')[0]:'.';if(!byDir.has(key))byDir.set(key,[]);byDir.get(key).push(f);}const initial=[];for(const [module,items] of Array.from(byDir.entries()).sort()){let current=[],bytes=0;for(const f of items.sort((a,b)=>a.path.localeCompare(b.path))){const cost=f.bytes+256;if(current.length&&bytes+cost>limits.chunkSoft){initial.push({module:module,files:current.map(x=>x.path),bytes:bytes});current=[];bytes=0;}if(cost>limits.chunkHard){initial.push({module:module,files:[f.path],bytes:Math.min(cost,limits.chunkHard),symbolWindow:true});}else{current.push(f);bytes+=cost;}}if(current.length)initial.push({module:module,files:current.map(x=>x.path),bytes:bytes});}const packed=[];for(const chunk of initial){const previous=packed[packed.length-1];if(previous&&!previous.symbolWindow&&!chunk.symbolWindow&&previous.bytes+chunk.bytes<=limits.chunkSoft){previous.module=previous.module===chunk.module?previous.module:previous.module+'+'+chunk.module;previous.files.push(...chunk.files);previous.bytes+=chunk.bytes;}else packed.push({module:chunk.module,files:chunk.files.slice(),bytes:chunk.bytes,symbolWindow:Boolean(chunk.symbolWindow)});}return packed.map(function(chunk,index){return Object.assign({},chunk,{chunkId:'CHUNK-'+String(index+1).padStart(3,'0')});});}
async function analyzeRepositoryChunks(chunks,opts){const summaries=[];for(const chunk of chunks){let summary;if(opts&&typeof opts.analyzeChunk==='function')summary=await opts.analyzeChunk(chunk);else summary=['CHUNK_ID: '+chunk.chunkId,'MODULES: '+chunk.module,'RESPONSIBILITIES: bounded repository slice','ENTRY_POINTS:','PUBLIC_CONTRACTS:','KEY_SYMBOLS:','DEPENDENCIES_IN:','DEPENDENCIES_OUT:','DATA/SCHEMAS:','SIDE_EFFECTS:','RISKS:','TESTS:','RELEVANT_FILES:',...chunk.files.map(x=>'- '+x),'POSSIBLE_CHANGE_TARGETS:','UNRESOLVED_QUESTIONS:'].join(NL);if(!summary.includes('CHUNK_ID: '+chunk.chunkId)||Buffer.byteLength(summary)>CHUNK_ENGINE_LIMITS.summaryHard)throw new Error('PLANNING_CHUNK_FAILED: '+chunk.chunkId);summaries.push({chunkId:chunk.chunkId,text:summary,bytes:Buffer.byteLength(summary)});}return summaries;}
function scoreAnalysisChunkRelevance(chunk,scan,graph,userRequest){const terms=String(userRequest||'').toLowerCase().split(/[^a-z0-9_]+/).filter(function(x){return x.length>2;}),files=new Map(scan.files.map(function(f){return [f.path,f];})),chunkFiles=new Set(chunk.files);let score=0;for(const rel of chunk.files){const f=files.get(rel)||{};score+=Number(f.sourceScore||0)+(f.entryPointSignals?5000:0)+(f.testSignals?300:0)+(f.configSignals?200:0);const haystack=(rel+' '+(f.symbols||[]).join(' ')).toLowerCase();for(const term of terms)if(haystack.includes(term))score+=800;}for(const edge of graph.edges||[])if(chunkFiles.has(edge.from)||chunkFiles.has(edge.to))score+=120;return score;}
function buildLocalStructuralChunkSummary(chunk,scan){const files=new Map(scan.files.map(function(f){return [f.path,f];})),symbols=[];for(const rel of chunk.files){const f=files.get(rel);if(f)symbols.push(...(f.symbols||[]).slice(0,12));}return ['CHUNK_ID: '+chunk.chunkId,'MODULES: '+chunk.module,'KEY_SYMBOLS: '+Array.from(new Set(symbols)).slice(0,80).join(', '),'RELEVANT_FILES:',...chunk.files.map(function(rel){return '- '+rel;}),'SUMMARY_MODE: LOCAL_STRUCTURAL'].join(NL);}
function buildFinalPlanningContext(args){const sections=['USER REQUEST\n'+String(args.userRequest||''),'REPO MAP\n'+args.repoMap.text,'CHUNK SUMMARIES',...(args.summaries||[]).map(x=>x.text),'CRITICAL WINDOWS\n'+String(args.criticalWindows||'')];const text=truncateUtf8(sections.join(NL+NL),CHUNK_ENGINE_LIMITS.planningSafe);return {text:text,bytes:Buffer.byteLength(text),path:(args.totalRelevantBytes||0)<=CHUNK_ENGINE_LIMITS.planningSafe?'SINGLE_PASS':'CHUNKED'};}
function parseAndValidatePlanBatches(plan,graph,scan){const targets=Array.from(String(plan||'').matchAll(/^\s*(?:[-*]\s*)?FILE_TARGET:\s*([^\r\n]+)/gmi)).map(m=>normalizeBatchTarget(m[1].replace(/["'`*]/g,'')));if(!targets.length)throw new Error('PLANNING_FINAL_INVALID');const options=scan?{fileBytesByPath:Object.fromEntries(scan.files.map(function(file){return [file.path,file.bytes];}))}:{};return partitionCodingBatches(Array.from(new Set(targets)),graph,options);}
function partitionCodingBatches(targets,graph,limits){limits=Object.assign({},CHUNK_ENGINE_LIMITS,limits||{});const order=[],seen=new Set(),deps=new Map();for(const e of graph.edges||[]){if(!deps.has(e.from))deps.set(e.from,[]);deps.get(e.from).push(e.to);}function visit(x){if(seen.has(x))return;seen.add(x);for(const d of (deps.get(x)||[]))if(targets.includes(d))visit(d);order.push(x);}targets.slice().sort().forEach(visit);const batches=[],fileBytes=limits.fileBytesByPath||null;let current=[],currentSourceBytes=0;function flush(){if(!current.length)return;batches.push({batchId:'BATCH-'+String(batches.length+1).padStart(3,'0'),order:batches.length+1,targets:current,dependenciesOnBatches:[],purpose:'Implement planned targets',expectedContracts:[],quickChecks:[],riskLevel:'NORMAL'});current=[];currentSourceBytes=0;}for(const target of order){const targetBytes=fileBytes?Math.max(0,Number(fileBytes[target]||0)):0;const isTestTarget=Boolean(/(^|\/|\.)(test|tests|spec|specs)(\/|\.|$)/i.test(target));if(isTestTarget&&Number(limits.testMaxFiles||1)===1){flush();current=[target];currentSourceBytes=targetBytes;flush();continue;}if(current.length&&(current.length>=limits.maxBatchFiles||(fileBytes&&currentSourceBytes+targetBytes>limits.maxBatchTargetSourceBytes)))flush();current.push(target);currentSourceBytes+=targetBytes;}flush();return batches;}
function buildBatchMiniMap(batch,state,limits){limits=Object.assign({},CHUNK_ENGINE_LIMITS,limits||{});const targets=new Set(batch.targets.map(normalizeBatchTarget)),files=new Map(state.scan.files.map(function(f){return [f.path,f];})),imports=new Set(),dependents=new Set();for(const edge of state.graph.edges||[]){if(targets.has(edge.from))imports.add(edge.to);if(targets.has(edge.to))dependents.add(edge.from);}const lines=['BATCH MINI MAP','TARGET PATHS',...Array.from(targets).sort(),'TARGET SYMBOLS',...Array.from(targets).sort().map(function(rel){const f=files.get(rel)||{};return rel+': '+(f.symbols||[]).slice(0,30).join(', '); }),'DIRECT IMPORTS',...Array.from(imports).sort(),'DIRECT DEPENDENTS',...Array.from(dependents).sort(),'ENTRY POINT RELATIONSHIP',...Array.from(targets).filter(function(rel){return (files.get(rel)||{}).entryPointSignals;}).map(function(rel){return rel+'=ENTRY_POINT';}),'RELEVANT BUILD/TEST COMMAND',String((state.routing&&state.routing.buildCmd)||''),String((state.routing&&state.routing.testCmd)||''),'PRIOR PUBLIC CONTRACTS',String(state.contractMemory||'')];const text=truncateUtf8(lines.join(NL),limits.batchMiniMapSoft||8*1024);return {text:text,bytes:Buffer.byteLength(text)};}
function extractBatchPlanSlice(planText,batch){const targets=batch.targets.map(normalizeBatchTarget),lines=String(planText||'').split(/\r?\n/),selected=[];let active=false;for(const line of lines){const hit=targets.some(function(target){return line.toLowerCase().includes(target.toLowerCase());});const global=/OBJECTIVE|OBJEKTIV|CONSTRAINT|KUFIZIM|DEFINITION OF DONE|ACCEPTANCE|VERIFIK|TEST|DEPENDENC/i.test(line);if(hit){active=true;selected.push(line);continue;}if(active&&/^\s*(?:#{1,6}|\d+\.|FILE_TARGET:)/i.test(line)&&!global){active=false;}if(active||global)selected.push(line);}return truncateUtf8(selected.join(NL),24*1024);}
function buildMinimalBatchContext(batch,state,limits){limits=Object.assign({},CHUNK_ENGINE_LIMITS,limits||{});const mini=buildBatchMiniMap(batch,state,limits),slice=extractBatchPlanSlice(state.planSlice,batch),targets=[],contracts=[];for(const rel of batch.targets){const full=path.join(state.scan.projectRoot,rel);targets.push('### FILE: '+rel+NL+(fs.existsSync(full)?fs.readFileSync(full,'utf8'):'NEW FILE'));}const direct=new Set();for(const edge of state.graph.edges||[])if(batch.targets.includes(edge.from))direct.add(edge.to);for(const rel of Array.from(direct).sort()){const full=path.join(state.scan.projectRoot,rel);if(fs.existsSync(full)){const f=state.scan.files.find(function(x){return x.path===rel;});contracts.push('### DIRECT CONTRACT: '+rel+NL+truncateUtf8(fs.readFileSync(full,'utf8'),Math.min(8*1024,(f&&f.bytes)||8*1024)));}}const text=['BATCH INSTRUCTION',batch.batchId+' targets='+batch.targets.join(', '),'BATCH PLAN SLICE',slice,'TARGET SOURCE',targets.join(NL+NL),'DIRECT IMPORT CONTRACTS/WINDOWS',contracts.join(NL+NL),'PRIOR PUBLIC CONTRACTS',state.contractMemory||'','BATCH MINI MAP',mini.text,'LAST ERROR RECEIPT',state.lastErrorReceipt||''].join(NL+NL);return {text:text,bytes:Buffer.byteLength(text),miniMapBytes:mini.bytes,planSliceBytes:Buffer.byteLength(slice),targets:batch.targets};}
function selectCodingTransport(context,limits){limits=Object.assign({},CHUNK_ENGINE_LIMITS,limits||{});const text=String(context&&context.text||''),chars=text.length,bytes=Buffer.byteLength(text,'utf8'),thresholdChars=limits.maxInlineChars,thresholdBytes=limits.maxInlineBytes,inline=chars<=thresholdChars&&bytes<=thresholdBytes,transport=inline?'INLINE':'ATTACHMENT';console.error('[CODING_TRANSPORT_DECISION] chars='+chars+' bytes='+bytes+' maxInlineChars='+thresholdChars+' maxInlineBytes='+thresholdBytes+' transport='+transport);return inline?{transport:transport,attachmentCount:0,twoStepIngest:false,chars:chars,bytes:bytes,thresholdChars:thresholdChars,thresholdBytes:thresholdBytes}:{transport:transport,attachmentCount:1,twoStepIngest:true,chars:chars,bytes:bytes,thresholdChars:thresholdChars,thresholdBytes:thresholdBytes};}
function selectAdaptiveReasoningLevel(ctx){return 'high';}
function classifyAttachmentHandshakeStrict(text){const normalized=String(text||'').trim();if(!normalized)return {ok:false,code:'BLANK'};if(/Lexo skedarin e bashkëngjitur|Mos shkruaj kod ende/i.test(normalized))return {ok:false,code:'PROMPT_ECHO'};const classified=classifyAttachmentHandshake(normalized,{attachmentVerified:true,alerts:[]});return {ok:classified.class==='HANDSHAKE_ACCEPTED',code:classified.code};}
async function runGeminiAttachmentIngestHandshake(args){const prompt='Lexo skedarin e bashkëngjitur plotësisht. Mos shkruaj kod ende. Përgjigju vetëm me konfirmim të shkurtër se skedari u lexua dhe je gati.';const text=await dispatchToWebTab({tabKey:args.tabKey,projectRoot:args.projectRoot,promptText:prompt,attachmentPaths:[args.attachmentPath],forceFreshChat:args.forceFreshChat!==false,disableInternalRetry:true,reasoningLevel:'high',modelTier:args.modelTier||'neon',hardCapMs:args.modelTier==='pro_31'?240000:65000});const check=classifyAttachmentHandshakeStrict(text);if(!check.ok)throw new Error('GEMINI_ATTACHMENT_INGEST_UNVERIFIED: '+check.code);console.error('[GEMINI_ATTACHMENT_INGEST_VERIFIED] batchId='+(args.batchId||'')+' chars='+text.length);return {status:'VERIFIED',text:text};}
function buildBatchContext(batch,state,limits){limits=Object.assign({},CHUNK_ENGINE_LIMITS,limits||{});const scan=state.scan;batch.targets=batch.targets.map(normalizeBatchTarget);const needed=new Set(batch.targets);for(const e of state.graph.edges||[])if(needed.has(e.from))needed.add(e.to);const targetBlocks=[],dependencyBlocks=[];for(const rel of Array.from(needed).sort()){const full=path.join(scan.projectRoot,rel);let block;if(!fs.existsSync(full)){block='### FILE: '+rel+' (NEW FILE - DOES NOT EXIST YET ON DISK, CREATE FROM PLAN)'+NL+'PLAN REQUIREMENT: '+String(state.planSlice||'');}else{const inspected=inspectTextBuffer(fs.readFileSync(full));if(!inspected.isText)continue;block='### FILE: '+rel+NL+inspected.text;}if(batch.targets.includes(rel))targetBlocks.push(block);else dependencyBlocks.push(block);}const mandatory=['BATCH '+batch.batchId,'TARGETS '+batch.targets.join(', '),'SOURCE TARGETS',targetBlocks.join(NL+NL),'PLAN SLICE',state.planSlice||'','LAST ERROR RECEIPT',state.lastErrorReceipt||''].join(NL+NL);if(Buffer.byteLength(mandatory)>limits.batchHard)throw new Error('BATCH_CONTEXT_INCOMPLETE: TARGETS_EXCEED_HARD_LIMIT');const optional=['DEPENDENCIES',dependencyBlocks.join(NL+NL),'PRIOR CONTRACTS',state.contractMemory||'','REPO MAP',state.repoMap.text,'CHANGED FILES',JSON.stringify(state.changedFiles||[])].join(NL+NL);const room=limits.batchHard-Buffer.byteLength(mandatory)-Buffer.byteLength(NL+NL);const text=mandatory+NL+NL+truncateUtf8(optional,Math.max(0,room));for(const t of batch.targets)if(!text.includes('### FILE: '+t))throw new Error('BATCH_CONTEXT_INCOMPLETE: '+t);return {text:text,bytes:Buffer.byteLength(text),sha256:crypto.createHash('sha256').update(text).digest('hex'),targets:batch.targets};}

async function runCodingBatch(batch,context,engine,opts){opts=opts||{};if(context.bytes>CHUNK_ENGINE_LIMITS.batchHard)throw new Error('BATCH_CONTEXT_INCOMPLETE');let resetReceipt=null;if(opts.page)resetReceipt=await resetChatVerified({page:opts.page,targetFrame:opts.targetFrame,tabKey:engine,projectRoot:opts.projectRoot,forceReload:true,reason:'CODING_BATCH'});if(resetReceipt&&resetReceipt.method!=='FORCED_NAV')throw new Error('FORCED_CHAT_RESET_VERIFICATION_FAILED');if(typeof opts.reverifyModel==='function')await opts.reverifyModel();if(typeof opts.dispatch!=='function')return {status:'BATCH_READY',batchId:batch.batchId,contextBytes:context.bytes,resetReceipt:resetReceipt,attachmentCount:1};const output=await opts.dispatch({batch:batch,context:context,attachmentCount:1});const parsed=parseCodeBlocksFromMarkdown(output);const paths=new Set(parsed.map(x=>x.relPath));if(batch.targets.some(x=>!paths.has(x)))throw new Error('BATCH_OUTPUT_INCOMPLETE');if(parsed.some(x=>!batch.targets.includes(x.relPath)))throw new Error('BATCH_OUTPUT_UNAUTHORIZED_FILE');return {status:'BATCH_CODED',batchId:batch.batchId,parsedFiles:parsed,resetReceipt:resetReceipt,attachmentCount:1};}
function applyBatch(args){const root=fs.realpathSync(path.resolve(args.projectRoot));args.batch.targets=args.batch.targets.map(normalizeBatchTarget);args.parsedFiles=args.parsedFiles.map(x=>Object.assign({},x,{relPath:normalizeBatchTarget(x.relPath)}));const expected=new Set(args.batch.targets),seen=new Set(),backups=[];for(const f of args.parsedFiles){if(seen.has(f.relPath)||!expected.has(f.relPath))throw new Error('BATCH_OUTPUT_INCOMPLETE');seen.add(f.relPath);const abs=path.resolve(root,f.relPath);if(!abs.startsWith(root+path.sep))throw new Error('SECURITY_BLOCK');if(detectUnpairedSurrogates(f.code)||Buffer.from(f.code).includes(0))throw new Error('BUNDLE_INVALID_UNICODE');if(fs.existsSync(abs)){const existingStat=fs.statSync(abs);if(existingStat.size>5000&&Buffer.byteLength(f.code,'utf8')<existingStat.size*0.25&&f.code.split('\n').length<30){throw new Error('BATCH_OUTPUT_COLLAPSED_STUB: '+f.relPath+' shrunk from '+existingStat.size+' bytes to '+Buffer.byteLength(f.code,'utf8')+' bytes');}}backups.push({path:f.relPath,exists:fs.existsSync(abs),content:fs.existsSync(abs)?fs.readFileSync(abs):null});fs.mkdirSync(path.dirname(abs),{recursive:true});const tmp=abs+'.antigravity-tmp';fs.writeFileSync(tmp,f.code,'utf8');fs.renameSync(tmp,abs);}if(seen.size!==expected.size)throw new Error('BATCH_OUTPUT_INCOMPLETE');return {status:'BATCH_APPLIED',filesWritten:Array.from(seen),backups:backups};}
function runBatchQuickChecks(args){const receipts=[];for(const rel of args.writtenFiles||[]){const full=path.join(args.projectRoot,rel),ext=path.extname(rel).toLowerCase();let run={status:0,stdout:'',stderr:''};if(['.js','.mjs','.cjs'].includes(ext))run=spawnSync(process.execPath,['--check',full],{encoding:'utf8'});else if(ext==='.py')run=spawnSync(process.env.PYTHON||'python',['-m','py_compile',full],{encoding:'utf8'});else if(ext==='.json'){try{JSON.parse(fs.readFileSync(full,'utf8'));}catch(err){run={status:1,stdout:'',stderr:err.message};}}receipts.push({command:'syntax '+rel,status:run.status,output:truncateUtf8((run.stdout||'')+(run.stderr||''),12000)});if(run.status!==0)return {status:'CHECK_FAILED',receipts:receipts};}return {status:'CHECK_PASSED',receipts:receipts};}
function redactDiagnosticSecrets(value){return String(value||'').replace(/(authorization\s*[:=]\s*(?:bearer\s+)?)[^\s,;]+/ig,'$1[REDACTED]').replace(/((?:api[_-]?key|token|cookie|password|secret)\s*[:=]\s*)[^\s,;]+/ig,'$1[REDACTED]');}
function boundedDiagnosticExcerpt(value,maxBytes){const clean=redactDiagnosticSecrets(value),limit=maxBytes||24000;if(Buffer.byteLength(clean,'utf8')<=limit)return {text:clean,truncated:false};const blocks=(clean.match(/(?:Traceback[\s\S]*?(?=\n\S|$)|(?:error|exception|failed)[^\n]*(?:\n[ \t]+[^\n]*){0,12})/ig)||[]).join(NL);return {text:truncateUtf8(clean,7200)+NL+'...[DIAGNOSTIC_TRUNCATED]...'+NL+truncateUtf8(blocks,3600)+NL+truncateUtf8(clean.slice(-14000),13200),truncated:true};}
function freshProjectErrorLog(projectRoot,startedMs){const candidate=path.resolve(projectRoot,'errors.log'),root=path.resolve(projectRoot)+path.sep;try{const real=fs.realpathSync(candidate),stat=fs.lstatSync(candidate);if(!real.startsWith(root)||stat.isSymbolicLink()||!stat.isFile()||stat.size>4*1024*1024||stat.mtimeMs<startedMs)return null;return fs.readFileSync(real,'utf8');}catch(_){return null;}}
function runFinalBuildAndTests(projectRoot,timeoutMs){const routing=ensureProjectSetup(projectRoot),commands=[routing.buildCmd,routing.testCmd].filter(Boolean),receipts=[],logDir=path.join(projectRoot,'.localpersonalai','run-logs');fs.mkdirSync(logDir,{recursive:true});for(let i=0;i<commands.length;i++){const command=commands[i],startedMs=Date.now(),started=process.hrtime.bigint(),run=spawnSync(command,{cwd:projectRoot,shell:true,encoding:'utf8',timeout:timeoutMs||180000,maxBuffer:64*1024*1024}),stdout=String(run.stdout||''),stderr=String(run.stderr||''),durationMs=Math.round(Number(process.hrtime.bigint()-started)/1e6),full=stderr+(stderr&&stdout?NL:'')+stdout,logPath=path.join(logDir,'command-'+startedMs+'-'+i+'.log');fs.writeFileSync(logPath,redactDiagnosticSecrets(full),'utf8');const fresh=freshProjectErrorLog(projectRoot,startedMs),source=stderr?'captured_stderr':stdout?'captured_stdout':full?'run_scoped_command_log':fresh?'fresh_project_errors_log':'NONZERO_EXIT_WITHOUT_DIAGNOSTICS',evidence=stderr||stdout||full||fresh||'NONZERO_EXIT_WITHOUT_DIAGNOSTICS',excerpt=boundedDiagnosticExcerpt(evidence),se=boundedDiagnosticExcerpt(stderr),so=boundedDiagnosticExcerpt(stdout),receipt={command:command,cwd:'.',status:run.status,exitCode:run.status,signal:run.signal||null,timedOut:Boolean(run.error&&run.error.code==='ETIMEDOUT'),durationMs:durationMs,stdoutBytes:Buffer.byteLength(stdout),stderrBytes:Buffer.byteLength(stderr),stdoutTruncated:so.truncated,stderrTruncated:se.truncated,logSource:source,logPath:path.relative(projectRoot,logPath).replace(/\\/g,'/'),logSha256:crypto.createHash('sha256').update(redactDiagnosticSecrets(full)).digest('hex'),errorExcerpt:excerpt.text};receipts.push(receipt);if(run.status!==0)return {status:'CHECK_FAILED',receipts:receipts,repairEvidence:receipt};}return {status:'CHECK_PASSED',receipts:receipts};}

async function repairBatchOnce(args){if(args.repairsUsed>=1)throw new Error('BATCH_REPAIR_EXHAUSTED');const result=await runCodingBatch(args.batch,args.context,args.engine,Object.assign({},args,{repair:true}));return Object.assign(result,{repairsUsed:1});}
function halveBatchAdaptively(batch,costs,level){if((level||0)>=CHUNK_ENGINE_LIMITS.maxHalvingLevel||batch.targets.length<=1)return [batch];const weighted=batch.targets.map(t=>({target:t,cost:Number(costs&&costs[t]||1)})),maxLeft=Math.ceil(weighted.length/2),total=weighted.reduce((n,x)=>n+x.cost,0);let left=[],right=[],sum=0;for(const x of weighted){const remaining=weighted.length-left.length-right.length;if(left.length<maxLeft&&(sum<total/2||!left.length||remaining<=maxLeft-left.length)){left.push(x.target);sum+=x.cost;}else right.push(x.target);}while(left.length>maxLeft)right.unshift(left.pop());if(!right.length)right.push(left.pop());return [{...batch,batchId:batch.batchId+'.a',targets:left,halvingLevel:(level||0)+1},{...batch,batchId:batch.batchId+'.b',targets:right,halvingLevel:(level||0)+1}];}
function normalizeFailureCode(err){if(!err)return '';if(typeof err==='object'&&err.code)return String(err.code).trim();if(typeof err==='object'&&err.failureCode)return String(err.failureCode).trim();const msg=String(err&&err.message||err).trim();const prefixMatch=msg.match(/^([A-Z0-9_]{4,40}):/);if(prefixMatch)return prefixMatch[1];return msg.split(/[\s,]+/)[0]||'';}
const ADAPTIVE_HALVING_CODES=new Set(['BATCH_OUTPUT_INCOMPLETE','BATCH_TARGET_MISSING','BATCH_OUTPUT_TRUNCATED','BATCH_RESPONSE_BUDGET_EXCEEDED','BATCH_PARSE_INCOMPLETE']);
function isAdaptiveHalvingFailure(err){return ADAPTIVE_HALVING_CODES.has(normalizeFailureCode(err));}
function buildCrossBatchContractSummary(receipt,previous){let text=[previous||'','BATCH '+receipt.batchId,'FILES '+(receipt.filesWritten||[]).join(','),'HASHES '+JSON.stringify(receipt.fileHashes||{}),'PUBLIC_CONTRACTS '+JSON.stringify(receipt.publicContracts||[]),'EXPORTS '+JSON.stringify(receipt.exports||[]),'QUICK_CHECK '+JSON.stringify(receipt.quickCheckResult||{})].join(NL);text=truncateUtf8(text,CHUNK_ENGINE_LIMITS.contractCumulative);return {text:text,bytes:Buffer.byteLength(text)};}
function buildDiffFocusedReviewContext(args){let text=['FINAL PLAN',String(args.plan||''),'CHANGED FILES',JSON.stringify(args.changedFiles||[]),'DIFF',String(args.diff||''),'BATCH RECEIPTS',JSON.stringify(args.batchReceipts||[]),'FINAL TESTS',String(args.finalTests||''),'KNOWN RISKS',JSON.stringify(args.knownRisks||[])].join(NL+NL);const chunks=[];while(Buffer.byteLength(text)>CHUNK_ENGINE_LIMITS.reviewHard){chunks.push(truncateUtf8(text,CHUNK_ENGINE_LIMITS.reviewSoft));text=text.slice(chunks[chunks.length-1].length);}if(text)chunks.push(text);return {text:chunks.length===1?chunks[0]:'',chunks:chunks,bytes:chunks.reduce((n,x)=>n+Buffer.byteLength(x),0),fullRepositoryIncluded:false};}


function writeChunkContextFile(exchangeDir,chunk,scan,maxBytes){const blocks=['CHUNK_ID: '+chunk.chunkId,'MODULE: '+chunk.module];for(const rel of chunk.files){const full=path.join(scan.projectRoot,rel);if(!fs.existsSync(full))continue;const inspected=inspectTextBuffer(fs.readFileSync(full));if(inspected.isText)blocks.push('### FILE: '+rel+NL+inspected.text);}const text=truncateUtf8(blocks.join(NL+NL),maxBytes);const file=path.join(exchangeDir,'chunk_'+chunk.chunkId+'.txt');fs.writeFileSync(file,text,'utf8');return {path:file,text:text,bytes:Buffer.byteLength(text)};}
function extractTargetsFromError(text,known){const normalizedText=String(text||'').replace(/\\+/g,'/'),lowerText=normalizedText.toLowerCase(),found=[],basenameCounts=new Map();for(const rel of known){const basename=path.posix.basename(normalizeBatchTarget(rel)).toLowerCase();if(basename.length>=8)basenameCounts.set(basename,(basenameCounts.get(basename)||0)+1);}for(const rel of known){const normalizedRel=normalizeBatchTarget(rel),index=lowerText.lastIndexOf(normalizedRel.toLowerCase()),basename=path.posix.basename(normalizedRel).toLowerCase(),basenameIndex=basename.length>=8&&basenameCounts.get(basename)===1?lowerText.lastIndexOf(basename):-1;if(index>=0)found.push({rel:normalizedRel,index:index,rank:1});else if(basenameIndex>=0)found.push({rel:normalizedRel,index:basenameIndex,rank:0});}return found.sort(function(a,b){return b.index-a.index||b.rank-a.rank||a.rel.localeCompare(b.rel);}).map(function(item){return item.rel;});}
function normalizeCheckpointTarget(target){return String(target||'').replace(/\\/g,'/').replace(/^\.\/+/,'');}
function computeRepositoryFingerprint(cleanRoot){
  const canonicalRoot=path.resolve(cleanRoot).toLowerCase();
  let gitHead=null,branch=null;
  try{gitHead=execSync('git -C "'+cleanRoot+'" rev-parse HEAD',{encoding:'utf8'}).trim();}catch(_){}
  try{branch=execSync('git -C "'+cleanRoot+'" rev-parse --abbrev-ref HEAD',{encoding:'utf8'}).trim();}catch(_){}
  return crypto.createHash('sha256').update(JSON.stringify({canonicalRoot:canonicalRoot,gitHead:gitHead,branch:branch})).digest('hex');
}
function computeCheckpointIdentity(cleanRoot,planText){
  const repoFp=computeRepositoryFingerprint(cleanRoot);
  const planFp=crypto.createHash('sha256').update(String(planText||'').trim()).digest('hex');
  return {repositoryFingerprint:repoFp,planFingerprint:planFp};
}
function checkpointTargetAbsolute(cleanRoot,target){
  if(!cleanRoot)return null;
  const normalized=normalizeCheckpointTarget(target),rootAbs=path.resolve(cleanRoot),targetAbs=path.resolve(rootAbs,normalized);
  if(!normalized||path.isAbsolute(normalized)||(targetAbs!==rootAbs&&!targetAbs.startsWith(rootAbs+path.sep)))return null;
  return targetAbs;
}
function fileReceiptFingerprint(r){
  return crypto.createHash('sha256').update(JSON.stringify({
    target:r.target,inputSha256:r.inputSha256,outputSha256:r.outputSha256,
    repositoryFingerprint:r.repositoryFingerprint,planFingerprint:r.planFingerprint,
    parserMode:r.parserMode||null,verificationBasis:r.verificationBasis||null,
    migrationSource:r.migrationSource||null,historicalOutputProvenance:r.historicalOutputProvenance||null,
    syntax:r.syntax,quickCheck:r.quickCheck,status:r.status
  })).digest('hex');
}
function parseCheckpointAudit(auditText){
  const fileReceipts=new Map(),conflicts=new Set();
  const pattern=/<!--\s*CHECKPOINT_FILE_VERIFIED\s+([\s\S]*?)-->/g;
  let match;
  while((match=pattern.exec(String(auditText||'')))!==null){
    const attr={},re=/([A-Za-z][A-Za-z0-9_]*)=([^\s>]+)/g;
    let m;
    while((m=re.exec(match[1]))!==null)attr[m[1]]=m[2];
    const target=normalizeCheckpointTarget(attr.target);
    if(!target)continue;
    const r={
      target:target,
      inputSha256:String(attr.inputSha256||'').toLowerCase(),
      outputSha256:String(attr.outputSha256||'').toLowerCase(),
      repositoryFingerprint:String(attr.repositoryFingerprint||'').toLowerCase(),
      planFingerprint:String(attr.planFingerprint||'').toLowerCase(),
      parserMode:String(attr.parserMode||''),
      verificationBasis:String(attr.verificationBasis||''),
      migrationSource:String(attr.migrationSource||''),
      historicalOutputProvenance:String(attr.historicalOutputProvenance||''),
      syntax:String(attr.syntax||''),
      quickCheck:String(attr.quickCheck||''),
      status:String(attr.status||'')
    };
    fileReceipts.set(target,r);
  }
  return {fileReceipts:fileReceipts,conflicts:conflicts};
}
function isTargetVerifiedForCheckpoint(auditIndex,target,cleanRoot,checkpointIdentity){
  const normalized=normalizeCheckpointTarget(target),receipt=auditIndex&&auditIndex.fileReceipts?auditIndex.fileReceipts.get(normalized):null;
  if(!receipt||!checkpointIdentity||receipt.status!=='VERIFIED'||receipt.syntax!=='PASS'||receipt.quickCheck!=='PASS'||!/^[a-f0-9]{64}$/.test(receipt.inputSha256)||!/^[a-f0-9]{64}$/.test(receipt.outputSha256))return false;
  if(receipt.repositoryFingerprint!==checkpointIdentity.repositoryFingerprint||receipt.planFingerprint!==checkpointIdentity.planFingerprint)return false;
  if(auditIndex&&auditIndex.conflicts&&auditIndex.conflicts.has(normalized))return false;
  const targetAbs=checkpointTargetAbsolute(cleanRoot,normalized);
  if(!targetAbs||!fs.existsSync(targetAbs)||!fs.statSync(targetAbs).isFile())return false;
  const actualSha256=crypto.createHash('sha256').update(fs.readFileSync(targetAbs)).digest('hex');
  return actualSha256===receipt.outputSha256;
}
function checkpointSyntaxQuickCheck(targetAbs){
  const extension=path.extname(targetAbs).toLowerCase();
  if(extension==='.js'||extension==='.cjs'||extension==='.mjs'){
    const syntaxResult=spawnSync(process.execPath,['--check',targetAbs],{encoding:'utf8'});
    return !syntaxResult.error&&syntaxResult.status===0;
  }
  if(extension==='.py'){
    const pyResult=spawnSync('python',['-m','py_compile',targetAbs],{encoding:'utf8'});
    return !pyResult.error&&pyResult.status===0;
  }
  return fs.statSync(targetAbs).size>0;
}
function migrateLegacyCheckpointReceipts(codePath,cleanRoot,checkpointIdentity){
  if(!fs.existsSync(codePath))return;
  const auditText=fs.readFileSync(codePath,'utf8'),auditIndex=parseCheckpointAudit(auditText),legacyPattern=/^### FILE:\s*(.+?)\s*$/gm;
  const migrated=[],seen=new Set();
  let match;
  while((match=legacyPattern.exec(auditText))!==null){
    const target=normalizeCheckpointTarget(match[1]);
    if(!target||seen.has(target)||(auditIndex.fileReceipts&&auditIndex.fileReceipts.has(target)))continue;
    seen.add(target);
    const targetAbs=checkpointTargetAbsolute(cleanRoot,target);
    if(!targetAbs||!fs.existsSync(targetAbs)||!fs.statSync(targetAbs).isFile()||!checkpointSyntaxQuickCheck(targetAbs))continue;
    const outputSha256=crypto.createHash('sha256').update(fs.readFileSync(targetAbs)).digest('hex');
    migrated.push('<!-- CHECKPOINT_FILE_VERIFIED target='+target+' inputSha256='+outputSha256+' outputSha256='+outputSha256+' repositoryFingerprint='+checkpointIdentity.repositoryFingerprint+' planFingerprint='+checkpointIdentity.planFingerprint+' parserMode=LEGACY_VERIFIED_MIGRATION verificationBasis=CURRENT_STATE_MIGRATION migrationSource=LEGACY_FILE_HEADER historicalOutputProvenance=UNPROVEN syntax=PASS quickCheck=PASS status=VERIFIED -->');
  }
  if(migrated.length>0)fs.appendFileSync(codePath,NL+NL+migrated.join(NL)+NL,'utf8');
}
function appendBatchAudit(codePath,receipt,parsed,cleanRoot,checkpointIdentity){
  if(!cleanRoot)cleanRoot=path.resolve(path.dirname(codePath),'..','..');
  if(!checkpointIdentity)checkpointIdentity=computeCheckpointIdentity(cleanRoot,'');
  const targetSetSha256=crypto.createHash('sha256').update(JSON.stringify(parsed.map(x=>normalizeCheckpointTarget(x.relPath)).sort())).digest('hex');
  const header=NL+NL+'<!-- CHECKPOINT_BATCH_VERIFIED batchId='+receipt.batchId+' targetSetSha256='+targetSetSha256+' repositoryFingerprint='+(checkpointIdentity?checkpointIdentity.repositoryFingerprint:'')+' planFingerprint='+(checkpointIdentity?checkpointIdentity.planFingerprint:'')+' status=VERIFIED -->'+NL+'<!-- '+receipt.batchId+' -->'+NL;
  const entries=parsed.map(function(x){
    const target=normalizeCheckpointTarget(x.relPath),targetAbs=checkpointTargetAbsolute(cleanRoot,target);
    if(!targetAbs||!fs.existsSync(targetAbs)||!fs.statSync(targetAbs).isFile())throw new Error('CHECKPOINT_TARGET_NOT_FOUND: '+target);
    const outputSha256=crypto.createHash('sha256').update(fs.readFileSync(targetAbs)).digest('hex');
    const inputSha256=/^[a-f0-9]{64}$/i.test(String(x.inputSha256||''))?String(x.inputSha256).toLowerCase():outputSha256;
    return '<!-- CHECKPOINT_FILE_VERIFIED target='+target+' inputSha256='+inputSha256+' outputSha256='+outputSha256+' repositoryFingerprint='+(checkpointIdentity?checkpointIdentity.repositoryFingerprint:'')+' planFingerprint='+(checkpointIdentity?checkpointIdentity.planFingerprint:'')+' parserMode=FENCED verificationBasis=BATCH_APPLY migrationSource=NEW_APPLY historicalOutputProvenance=VERIFIED syntax=PASS quickCheck=PASS status=VERIFIED -->'+NL+'### FILE: '+target+NL+FENCE3+path.extname(target).slice(1)+NL+x.code+NL+FENCE3;
  });
  fs.appendFileSync(codePath,header+entries.join(NL+NL),'utf8');
}
function persistCheckpointReceiptOnce(codePath,receipt,parsedFiles,cleanRoot,checkpointIdentity){
  const auditText=fs.existsSync(codePath)?fs.readFileSync(codePath,'utf8'):'';
  const auditIndex=parseCheckpointAudit(auditText);
  const unpersisted=parsedFiles.filter(function(item){
    const target=normalizeCheckpointTarget(item.relPath);
    return !isTargetVerifiedForCheckpoint(auditIndex,target,cleanRoot,checkpointIdentity);
  });
  if(unpersisted.length>0){
    appendBatchAudit(codePath,receipt,unpersisted,cleanRoot,checkpointIdentity);
  }
}
async function dispatchChunkedEngineTurn(engine,cleanRoot,prompt,attachment,opts){opts=opts||{};const common={tabKey:engine,projectRoot:cleanRoot,promptText:prompt,attachmentPaths:[attachment],bundlePath:attachment,isPlanner:Boolean(opts.isPlanner),userRequest:opts.userRequest||'',forceFreshChat:opts.forceFreshChat!==false,useProvidedBundle:opts.useProvidedBundle===true,backoffMs:opts.backoffMs,sleepFn:opts.sleepFn,disableInternalRetry:opts.disableInternalRetry===true,reasoningLevel:'high',modelTier:opts.modelTier||'neon',hardCapMs:opts.hardCapMs};return engine.startsWith('google_search_')?dispatchToGoogleSearchAiTab(common):dispatchToWebTab(common);}
function getFailoverEngines(primaryEngine,excludedSet){const e=excludedSet instanceof Set?excludedSet:new Set(excludedSet||[]),orders={gemini2:['gemini3','gemini1','web2'],gemini3:['gemini2','gemini1','web2'],gemini1:['gemini3','gemini2','web2'],web2:['web1'],web1:['web2'],google_search_1:['google_search_2','google_search_3','web1'],google_search_2:['google_search_3','google_search_1','web1'],google_search_3:['google_search_1','google_search_2','web1']};return (orders[primaryEngine]||[]).filter(function(engine){if(e.has(engine)||engine===primaryEngine)return false;const profile=getProfileNameForTab(engine),profileExists=fs.existsSync(path.join(PROFILES_DIR,profile));return Object.prototype.hasOwnProperty.call(tabs,engine)&&(profileExists||tabs[engine]!==null||tabAuthStatus[engine]==='ACTIVE');});}
function isEngineFailoverEligible(code){return /BATCH_RECOVERY_EXHAUSTED|GEMINI_CONVERSATION_RESET_AFTER_SEND|GEMINI_TURN_ROLLED_BACK_AFTER_SEND|GEMINI_SILENT_PREFLIGHT_TIMEOUT|GEMINI_THINKING_STALL|GEMINI_HARD_CAP_TIMEOUT|WEB_SERVICE_REFUSAL|SERVICE_REFUSAL|WEB_TRANSIENT_SERVICE_ERROR|WEB_PAYLOAD_REJECTED_OR_OVERSIZED|WEB_QUOTA_OR_LIMIT_ERROR|SEARCH_AI_RESPONSE_TIMEOUT|SEARCH_AI_CAPTCHA_REQUIRED|PLANNER_ESCALATION_FAILED|FORCED_CHAT_RESET_VERIFICATION_FAILED|CHAT_RESET_VERIFICATION_FAILED|MODEL_OPTION_NOT_FOUND|MODEL_TIER_NOT_FOUND|MODEL_MENU_TIMEOUT|MODEL_TRIGGER_TIMEOUT|MODEL_SELECTION_UNVERIFIED|FIRST_TOKEN_TIMEOUT|GEMINI_FIRST_TOKEN_TIMEOUT/.test(String(code||''));}
async function dispatchPlannerWithFailover(state,routing,cleanRoot,prompt,attachment,opts){opts=opts||{};state.failedEngines=state.failedEngines||new Set();state.engineFailoverCount=0;state.totalEngineFailoverCount=state.totalEngineFailoverCount||0;state.activeGeminiModelTier='neon';const batchLocalFailedEngines=new Set();let engine=state.activePlannerEngine||routing.roles.planner;while(true){try{const result=await dispatchChunkedEngineTurn(engine,cleanRoot,prompt,attachment,Object.assign({},opts,{modelTier:engine.startsWith('gemini')?state.activeGeminiModelTier: 'neon',disableInternalRetry:engine.startsWith('gemini')?true:Boolean(opts.disableInternalRetry)}));state.activePlannerEngine=engine;return result;}catch(err){const code=String(err&&err.message||err),backend=/GEMINI_CONVERSATION_RESET_AFTER_SEND|GEMINI_TURN_ROLLED_BACK_AFTER_SEND|GEMINI_SILENT_PREFLIGHT_TIMEOUT|GEMINI_THINKING_STALL|GEMINI_HARD_CAP_TIMEOUT|WEB_SERVICE_REFUSAL|SERVICE_REFUSAL|WEB_TRANSIENT_SERVICE_ERROR|WEB_PAYLOAD_REJECTED_OR_OVERSIZED|MODEL_OPTION_NOT_FOUND/.test(code);if(!isEngineFailoverEligible(code)||state.engineFailoverCount>=3)throw err;batchLocalFailedEngines.add(engine);const next=getFailoverEngines(engine,batchLocalFailedEngines)[0];if(!next)throw err;console.error('[PLANNER_ENGINE_FAILOVER] from='+engine+' to='+next+' reason='+code.split(' ')[0]);state.engineFailoverCount++;state.totalEngineFailoverCount++;console.error('[ACCOUNT_FAILOVER_SELECTED] requestedTier=argon_high verifiedTier=unavailable account='+engine+' reason='+code.split(' ')[0]+' nextEngine='+next);engine=next;state.activePlannerEngine=next;}}}
async function executeCodingLeaf(batch,state,routing,job,opts){
  opts=opts||{};batch.targets=batch.targets.map(normalizeBatchTarget);state.routing=routing;const coderEngine=opts.coderEngine||state.activeCoderEngine||routing.roles.coder;state.activeCoderEngine=coderEngine;job.activeCoderEngine=coderEngine;state.activeGeminiModelTier='neon';const modelTier=opts.modelTier||state.activeGeminiModelTier;job.activeModelTier=modelTier;
  const context=buildMinimalBatchContext(batch,state,CHUNK_ENGINE_LIMITS),transport=selectCodingTransport(context,CHUNK_ENGINE_LIMITS),exchangeDir=path.join(state.scan.projectRoot,'.antigravity','bridge','exchange'),codePath=path.join(exchangeDir,'code.md'),checkpointIdentity=computeCheckpointIdentity(state.scan.projectRoot,state.planSlice),contextPath=path.join(exchangeDir,'b_'+batch.batchId.replace(/^BATCH-?/i,'').replace(/^INTEGRATION-REPAIR-?/i,'r').replace(/[^A-Za-z0-9]/g,'').slice(0,6)+'.txt'),rules=fs.readFileSync(path.join(PLUGIN_ROOT,'rules','coder_rules.md'),'utf8'),instruction=rules+NL+NL+'Implemento VETEM target-et ('+batch.targets.join(', ')+'). Kthe VETEM blloqe ### FILE: path me permbajtje te plote.';
  job.currentBatchId=batch.batchId;job.currentTargets=batch.targets;job.bytesInContext=context.bytes;job.transport=transport.transport;job.reasoningLevel=opts.reasoningLevel||'high';job.attempt=(opts.recoveryAttempt||0)+1;job.handshakeStatus=transport.twoStepIngest?'PENDING':'NOT_REQUIRED';console.error('[BATCH_CONTEXT_MINIMIZED] batchId='+batch.batchId+' bytes='+context.bytes+' miniMapBytes='+context.miniMapBytes+' planSliceBytes='+context.planSliceBytes);console.error('[CODING_TRANSPORT_SELECTED] batchId='+batch.batchId+' transport='+transport.transport+' attachmentCount='+transport.attachmentCount);
  const dispatch=function(prompt,attachment,forceFreshChat){return dispatchChunkedEngineTurn(coderEngine,state.scan.projectRoot,prompt,attachment,{forceFreshChat:forceFreshChat,disableInternalRetry:true,reasoningLevel:'high',modelTier:modelTier,backoffMs:opts.backoffMs,sleepFn:opts.sleepFn,useProvidedBundle:Boolean(attachment)});};
  let output;if(transport.transport==='INLINE'){job.handshakeStatus='NOT_REQUIRED';output=await dispatch(instruction+NL+NL+context.text,null,true);}else{fs.writeFileSync(contextPath,context.text,'utf8');if(coderEngine.startsWith('gemini')){await runGeminiAttachmentIngestHandshake({tabKey:coderEngine,projectRoot:state.scan.projectRoot,attachmentPath:contextPath,batchId:batch.batchId,reasoningLevel:'high',modelTier:modelTier,forceFreshChat:true});job.handshakeStatus='VERIFIED';output=await dispatch(instruction,null,false);}else{job.handshakeStatus='DIRECT_ATTACHMENT';output=await dispatch(instruction,contextPath,true);}}
  const expected=new Set(batch.targets);
  const parseExpected=function(text){const all=parseCodeBlocksFromMarkdown(text,batch.targets).map(function(x){return Object.assign({},x,{relPath:normalizeBatchTarget(x.relPath)});}),received=new Set(all.map(function(x){return x.relPath;})),missing=batch.targets.filter(function(x){return !received.has(x);});return {all:all,parsed:missing.length===0?all.filter(function(x){return expected.has(x.relPath);}):all,missing:missing,extra:all.map(function(x){return x.relPath;}).filter(function(x){return !expected.has(x);})};};
  let formatRepairUsed=Boolean(opts.formatRepairUsed);const repairFormat=async function(failure){if(formatRepairUsed)throw new Error(failure);formatRepairUsed=true;console.error('[BATCH_FORMAT_REPAIR] batchId='+batch.batchId+' reason='+failure.slice(0,160));const repairPrompt='KORRIGJIM I VETEM FORMATI/SINTAKSE. '+failure+NL+'Kthe VETEM target-et e autorizuara: '+batch.targets.join(', ')+NL+'Per secilin perdor saktesisht ### FILE: path, pastaj nje code fence me permbajtjen e plote. Mos jep snippets ose skedare ekstra.';return dispatch(repairPrompt,null,false);};
  let parsedResult=parseExpected(output);if(parsedResult.missing.length){
    const validParsed=parsedResult.parsed.filter(function(x){return expected.has(x.relPath)&&!parsedResult.missing.includes(x.relPath);});
    if(validParsed.length>0){
      try{
        const appliedPartial=applyBatch({projectRoot:state.scan.projectRoot,batch:{targets:validParsed.map(function(x){return x.relPath;})},parsedFiles:validParsed});
        const quickPartial=runBatchQuickChecks({projectRoot:state.scan.projectRoot,writtenFiles:appliedPartial.filesWritten});
        if(quickPartial.status==='CHECK_PASSED'){
          const partialReceipt={batchId:batch.batchId+'.partial',filesWritten:appliedPartial.filesWritten,fileHashes:Object.fromEntries(appliedPartial.filesWritten.map(function(x){return [x,crypto.createHash('sha256').update(fs.readFileSync(path.join(state.scan.projectRoot,x))).digest('hex')];})),quickCheckResult:quickPartial,parsedFiles:validParsed};
          persistCheckpointReceiptOnce(codePath,partialReceipt,validParsed,state.scan.projectRoot,checkpointIdentity);
        }
      }catch(_) {}
    }
    const detail='BATCH_OUTPUT_INCOMPLETE: missing=['+parsedResult.missing.join(',')+'] extra=['+parsedResult.extra.join(',')+']';
    state.lastErrorReceipt=detail;output=await repairFormat(detail);parsedResult=parseExpected(output);
    if(parsedResult.missing.length){
      const repairedValidParsed=parsedResult.parsed.filter(function(x){return expected.has(x.relPath)&&!parsedResult.missing.includes(x.relPath);});
      if(repairedValidParsed.length>0){
        try{
          const appliedRepairedPartial=applyBatch({projectRoot:state.scan.projectRoot,batch:{targets:repairedValidParsed.map(function(x){return x.relPath;})},parsedFiles:repairedValidParsed});
          const quickRepairedPartial=runBatchQuickChecks({projectRoot:state.scan.projectRoot,writtenFiles:appliedRepairedPartial.filesWritten});
          if(quickRepairedPartial.status==='CHECK_PASSED'){
            const repairedPartialReceipt={batchId:batch.batchId+'.partial',filesWritten:appliedRepairedPartial.filesWritten,fileHashes:Object.fromEntries(appliedRepairedPartial.filesWritten.map(function(x){return [x,crypto.createHash('sha256').update(fs.readFileSync(path.join(state.scan.projectRoot,x))).digest('hex')];})),quickCheckResult:quickRepairedPartial,parsedFiles:repairedValidParsed};
            persistCheckpointReceiptOnce(codePath,repairedPartialReceipt,repairedValidParsed,state.scan.projectRoot,checkpointIdentity);
          }
        }catch(_) {}
      }
      throw new Error('BATCH_OUTPUT_INCOMPLETE: missing=['+parsedResult.missing.join(',')+'] extra=['+parsedResult.extra.join(',')+']');
    }
  }
  let applied=applyBatch({projectRoot:state.scan.projectRoot,batch:batch,parsedFiles:parsedResult.parsed}),quick=runBatchQuickChecks({projectRoot:state.scan.projectRoot,writtenFiles:applied.filesWritten});
  if(quick.status!=='CHECK_PASSED'){for(const backup of applied.backups){const abs=path.join(state.scan.projectRoot,backup.path);if(backup.exists)fs.writeFileSync(abs,backup.content);else if(fs.existsSync(abs))fs.unlinkSync(abs);}const detail='BATCH_SYNTAX_OR_QUICK_CHECK_FAILED: '+JSON.stringify(quick.receipts);state.lastErrorReceipt=detail;output=await repairFormat(detail);parsedResult=parseExpected(output);if(parsedResult.missing.length)throw new Error('BATCH_OUTPUT_INCOMPLETE: missing=['+parsedResult.missing.join(',')+'] extra=['+parsedResult.extra.join(',')+']');applied=applyBatch({projectRoot:state.scan.projectRoot,batch:batch,parsedFiles:parsedResult.parsed});quick=runBatchQuickChecks({projectRoot:state.scan.projectRoot,writtenFiles:applied.filesWritten});if(quick.status!=='CHECK_PASSED')throw new Error('BATCH_SYNTAX_OR_QUICK_CHECK_FAILED: '+JSON.stringify(quick.receipts));}
  return {batchId:batch.batchId,filesWritten:applied.filesWritten,fileHashes:Object.fromEntries(applied.filesWritten.map(function(x){return [x,crypto.createHash('sha256').update(fs.readFileSync(path.join(state.scan.projectRoot,x))).digest('hex')];})),quickCheckResult:quick,parsedFiles:parsedResult.parsed,contextBytes:context.bytes,transport:transport.transport,reasoningLevel:'high',attempt:(opts.recoveryAttempt||0)+1,handshakeStatus:job.handshakeStatus};
}
async function executeBatchWithRecovery(batch,state,routing,job,opts){
  opts=opts||{};state.failedEngines=state.failedEngines||new Set();state.engineFailoverCount=state.engineFailoverCount||0;state.totalEngineFailoverCount=state.totalEngineFailoverCount||0;
  const failoverScope=opts.failoverScope||{localFailoverCount:0,batchLocalFailedEngines:new Set()};opts.failoverScope=failoverScope;
  const codePath=path.join(state.scan.projectRoot,'.antigravity','bridge','exchange','code.md');
  const auditIndex=parseCheckpointAudit(fs.existsSync(codePath)?fs.readFileSync(codePath,'utf8'):'');
  const checkpointIdentity=computeCheckpointIdentity(state.scan.projectRoot,state.planSlice);
  const unresolvedTargets=batch.targets.map(normalizeCheckpointTarget).filter(function(target){return !isTargetVerifiedForCheckpoint(auditIndex,target,state.scan.projectRoot,checkpointIdentity);});
  if(!unresolvedTargets.length){
    return [{batchId:batch.batchId,filesWritten:batch.targets.map(normalizeCheckpointTarget),fileHashes:{},quickCheckResult:{status:'CHECK_PASSED'},parsedFiles:[],skippedFromCheckpoint:true}];
  }
  const activeBatch=Object.assign({},batch,{targets:unresolvedTargets});
  const initialEngine=opts.coderEngine||state.activeCoderEngine||routing.roles.coder;
  const level=Number(opts.halvingLevel||0);
  try{
    return [await executeCodingLeaf(activeBatch,state,routing,job,Object.assign({},opts,{coderEngine:initialEngine,reasoningLevel:selectAdaptiveReasoningLevel(opts)}))];
  }catch(err){
    const freshAuditText=fs.existsSync(codePath)?fs.readFileSync(codePath,'utf8'):'';
    const freshAuditIndex=parseCheckpointAudit(freshAuditText);
    const unresolvedTargetsAfterCatch=activeBatch.targets.filter(function(target){return !isTargetVerifiedForCheckpoint(freshAuditIndex,target,state.scan.projectRoot,checkpointIdentity);});
    if(!unresolvedTargetsAfterCatch.length){
      return [{batchId:activeBatch.batchId,filesWritten:activeBatch.targets,fileHashes:{},quickCheckResult:{status:'CHECK_PASSED'},parsedFiles:[],skippedFromCheckpoint:true}];
    }
    const batchToHalve=Object.assign({},activeBatch,{targets:unresolvedTargetsAfterCatch});
    if(batchToHalve.targets.length>1&&level<CHUNK_ENGINE_LIMITS.maxHalvingLevel&&isAdaptiveHalvingFailure(err)){
      const batchCosts=opts.batchCosts||(state.scan&&state.scan.files?Object.fromEntries(state.scan.files.map(function(f){return [normalizeCheckpointTarget(f.path),Number(f.bytes||0)];})):null);
      const subBatches=halveBatchAdaptively(batchToHalve,batchCosts,level);
      if(subBatches.length>1){
        console.error('[ADAPTIVE_BATCH_HALVING] batchId='+batchToHalve.batchId+' targets='+batchToHalve.targets.length+' subBatches='+subBatches.map(function(subBatch){return subBatch.batchId+':'+subBatch.targets.length;}).join(',')+' reason='+normalizeFailureCode(err));
        const results=[];
        for(const subBatch of subBatches){
          const subReceipts=await executeBatchWithRecovery(subBatch,state,routing,job,Object.assign({},opts,{coderEngine:initialEngine,halvingLevel:level+1,batchCosts:batchCosts,failoverScope:{localFailoverCount:0,batchLocalFailedEngines:new Set()}}));
          for(const r of subReceipts){
            results.push(r);
            if(r.parsedFiles&&r.parsedFiles.length&&!r.skippedFromCheckpoint){
              persistCheckpointReceiptOnce(codePath,r,r.parsedFiles,state.scan.projectRoot,checkpointIdentity);
              r.checkpointPersisted=true;
            }
          }
        }
        return results;
      }
    }
    const exhausted='BATCH_RECOVERY_EXHAUSTED: '+batchToHalve.batchId+' '+String(err&&err.message||err);
    if(batchToHalve.targets.length>1||!isEngineFailoverEligible(exhausted)||failoverScope.localFailoverCount>=2)throw new Error(exhausted);
    failoverScope.batchLocalFailedEngines.add(initialEngine);
    state.failedEngines.add(initialEngine);
    const nextEngine=getFailoverEngines(initialEngine,failoverScope.batchLocalFailedEngines)[0];
    if(!nextEngine)throw new Error(exhausted);
    failoverScope.localFailoverCount++;
    state.engineFailoverCount=failoverScope.localFailoverCount;
    state.totalEngineFailoverCount++;
    state.activeCoderEngine=nextEngine;
    job.activeCoderEngine=nextEngine;
    console.error('[CODER_ENGINE_FAILOVER] from='+initialEngine+' to='+nextEngine+' batchId='+batchToHalve.batchId+' reason='+normalizeFailureCode(err));
    return executeBatchWithRecovery(batchToHalve,state,routing,job,{coderEngine:nextEngine,recoveryAttempt:0,reasoningLevel:'high',backoffMs:opts.backoffMs,sleepFn:opts.sleepFn,failoverScope:failoverScope,halvingLevel:level,batchCosts:opts.batchCosts});
  }
}
// ---------------- 25-SECOND NON-BLOCKING AUTOPILOT ENGINE ----------------
const activeCycleJobs = {};
async function runAutonomousPipeline(cleanRoot,userRequest){const job=activeCycleJobs[cleanRoot]={running:true,phase:'DISCOVERY',startedAt:Date.now(),result:null,error:null,completed:0,total:0,currentBatchId:null,currentTargets:[],bytesInContext:0,retriesUsed:0,halvingUsed:0,lastCheckStatus:'PENDING'};try{const routing=ensureProjectSetup(cleanRoot),exchangeDir=path.join(cleanRoot,'.antigravity','bridge','exchange'),planPath=path.join(exchangeDir,'plan.md'),codePath=path.join(exchangeDir,'code.md'),reviewPath=path.join(exchangeDir,'review.md'),logPath=path.join(exchangeDir,'build_test.log'),scan=scanRepositoryUniversal(cleanRoot),graph=buildDependencyGraph(scan),repoMap=buildCompactRepoMap(scan,CHUNK_ENGINE_LIMITS),embeddedSpecs=resolveAndEmbedExternalFiles(userRequest),totalRelevantSourceBytes=scan.files.filter(f=>f.generatedScore===0).reduce((n,f)=>n+f.bytes,0)+Buffer.byteLength(embeddedSpecs);job.repoMapReceipt={bytes:repoMap.bytes,sha256:repoMap.sha256,repoFingerprint:scan.repoFingerprint};const planningState={activePlannerEngine:routing.roles.planner,failedEngines:new Set(),engineFailoverCount:0,activeGeminiModelTier: 'neon'};let planText='';if(fs.existsSync(planPath)&&fs.statSync(planPath).size>200){planText=fs.readFileSync(planPath,'utf8');console.error('[CHECKPOINT_PLAN_LOADED] size='+planText.length);}else if(totalRelevantSourceBytes<=CHUNK_ENGINE_LIMITS.planningSafe){job.phase='PLANNING_SINGLE_PASS';const relevant=[];for(const f of scan.files.filter(x=>x.generatedScore===0)){const inspected=inspectTextBuffer(fs.readFileSync(path.join(cleanRoot,f.path)));if(inspected.isText)relevant.push('### FILE: '+f.path+NL+inspected.text);}const planning=buildFinalPlanningContext({userRequest:userRequest,repoMap:repoMap,summaries:[],criticalWindows:relevant.join(NL+NL)+NL+embeddedSpecs,totalRelevantBytes:totalRelevantSourceBytes}),physical=path.join(exchangeDir,'planning_context.txt');fs.writeFileSync(physical,planning.text,'utf8');planText=await dispatchPlannerWithFailover(planningState,routing,cleanRoot,buildSearchAiCleanPrompt('plan'),physical,{isPlanner:true,useProvidedBundle:true,userRequest:userRequest,forceFreshChat:true});}else{const chunks=partitionAnalysisChunks(scan,graph,CHUNK_ENGINE_LIMITS),ranked=chunks.map(function(chunk,index){return {chunk:chunk,index:index,score:scoreAnalysisChunkRelevance(chunk,scan,graph,userRequest)};}).sort(function(a,b){return b.score-a.score||a.index-b.index;}),webIds=new Set(ranked.slice(0,CHUNK_ENGINE_LIMITS.maxWebAnalysisChunks).map(function(x){return x.chunk.chunkId;})),webChunks=chunks.filter(function(chunk){return webIds.has(chunk.chunkId);}),summaries=chunks.filter(function(chunk){return !webIds.has(chunk.chunkId);}).map(function(chunk){const text=buildLocalStructuralChunkSummary(chunk,scan);return {chunkId:chunk.chunkId,text:text,bytes:Buffer.byteLength(text)};});job.total=webChunks.length;for(let i=0;i<webChunks.length;i++){job.phase='PLANNING_CHUNK '+(i+1)+'/'+webChunks.length;job.completed=i;const chunk=webChunks[i],physical=writeChunkContextFile(exchangeDir,chunk,scan,CHUNK_ENGINE_LIMITS.chunkHard),prompt='Analizo vetem kete chunk. Kthe structured summary me CHUNK_ID: '+chunk.chunkId+' dhe seksionet MODULES, RESPONSIBILITIES, ENTRY_POINTS, PUBLIC_CONTRACTS, KEY_SYMBOLS, DEPENDENCIES_IN, DEPENDENCIES_OUT, DATA/SCHEMAS, SIDE_EFFECTS, RISKS, TESTS, RELEVANT_FILES, POSSIBLE_CHANGE_TARGETS, UNRESOLVED_QUESTIONS.';let text;try{text=await dispatchPlannerWithFailover(planningState,routing,cleanRoot,prompt,physical.path,{isPlanner:false,useProvidedBundle:true,forceFreshChat:true});}catch(err){text=await dispatchPlannerWithFailover(planningState,routing,cleanRoot,prompt,physical.path,{isPlanner:false,useProvidedBundle:true,forceFreshChat:true});}text=truncateUtf8(text,CHUNK_ENGINE_LIMITS.summaryHard);if(!text.includes('CHUNK_ID: '+chunk.chunkId))text='CHUNK_ID: '+chunk.chunkId+NL+text;summaries.push({chunkId:chunk.chunkId,text:text,bytes:Buffer.byteLength(text)});}summaries.sort(function(a,b){return a.chunkId.localeCompare(b.chunkId);});job.phase='PLANNING_FINAL';const finalContext=buildFinalPlanningContext({userRequest:userRequest,repoMap:repoMap,summaries:summaries,criticalWindows:embeddedSpecs,totalRelevantBytes:totalRelevantSourceBytes}),planningPath=path.join(exchangeDir,'planning_context.txt');fs.writeFileSync(planningPath,finalContext.text,'utf8');planText=await dispatchPlannerWithFailover(planningState,routing,cleanRoot,buildSearchAiCleanPrompt('plan'),planningPath,{isPlanner:true,useProvidedBundle:true,userRequest:userRequest,forceFreshChat:true});}const validated=validatePlanOutput(planText,{requiresFiles:false});if(!validated.ok)throw new Error('PLANNING_FINAL_INVALID');fs.writeFileSync(planPath,planText,'utf8');let batches;try{batches=parseAndValidatePlanBatches(planText,graph,scan);}catch(_){const fallback=scan.files.filter(f=>f.sourceScore>0&&f.generatedScore===0).slice(0,1).map(f=>f.path);if(!fallback.length)throw new Error('PLANNING_FINAL_INVALID');batches=partitionCodingBatches(fallback,graph,{});}job.total=batches.length;job.completed=0;if(!fs.existsSync(codePath)){fs.writeFileSync(codePath,'# CHUNKED ENGINE BATCH AUDIT'+NL,'utf8');}const checkpointIdentity=computeCheckpointIdentity(cleanRoot,planText);migrateLegacyCheckpointReceipts(codePath,cleanRoot,checkpointIdentity);const state={scan:scan,graph:graph,repoMap:repoMap,planSlice:planText,contractMemory:'',changedFiles:[],activeCoderEngine:routing.roles.coder,activePlannerEngine:routing.roles.planner,failedEngines:new Set(),engineFailoverCount:0,activeGeminiModelTier:planningState.activeGeminiModelTier||'argon_high'},batchReceipts=[],allWrittenFilesSet=new Set();for(let i=0;i<batches.length;i++){const existingAudit=fs.existsSync(codePath)?fs.readFileSync(codePath,'utf8'):'';const auditIndex=parseCheckpointAudit(existingAudit);const normalizedTargets=batches[i].targets.map(normalizeCheckpointTarget);const verifiedTargets=normalizedTargets.filter(function(t){return isTargetVerifiedForCheckpoint(auditIndex,t,cleanRoot,checkpointIdentity);});if(normalizedTargets.length>0&&verifiedTargets.length===normalizedTargets.length){console.error('[CHECKPOINT_BATCH_SKIPPED] batchId='+batches[i].batchId+' targets='+verifiedTargets.join(',')+' reason=ALL_TARGETS_HASH_VERIFIED');verifiedTargets.forEach(function(t){allWrittenFilesSet.add(t);});job.completed=i+1;continue;}job.phase='CODING_BATCH '+(i+1)+'/'+batches.length;const receipts=await executeBatchWithRecovery(batches[i],state,routing,job,{});for(const receipt of receipts){batchReceipts.push(receipt);receipt.filesWritten.map(normalizeCheckpointTarget).forEach(function(t){allWrittenFilesSet.add(t);});if(!receipt.checkpointPersisted&&receipt.parsedFiles&&receipt.parsedFiles.length&&!receipt.skippedFromCheckpoint)persistCheckpointReceiptOnce(codePath,receipt,receipt.parsedFiles,cleanRoot,checkpointIdentity);state.contractMemory=buildCrossBatchContractSummary(receipt,state.contractMemory).text;state.changedFiles.push(...receipt.filesWritten);}job.completed=i+1;}let allWrittenFiles=Array.from(allWrittenFilesSet).sort();job.phase='FINAL_APPLY_AND_TEST';let finalChecks=runFinalBuildAndTests(cleanRoot,180000);fs.writeFileSync(logPath,JSON.stringify(finalChecks,null,2),'utf8');for(let repairRound=1;repairRound<=2&&finalChecks.status!=='CHECK_PASSED';repairRound++){const errorText=JSON.stringify(finalChecks),knownTargets=Array.from(new Set([...allWrittenFiles,...scan.files.map(function(f){return f.path;})])),mentioned=extractTargetsFromError(errorText,knownTargets);if(!mentioned.length)break;job.phase='INTEGRATION_REPAIR';state.lastErrorReceipt='FINAL_APPLY_AND_TEST_FAILED (round '+repairRound+'):'+NL+truncateUtf8(errorText,12000);const repairBatch={batchId:'INTEGRATION-REPAIR-'+repairRound,targets:mentioned.slice(0,2),halvingLevel:1};const receipts=await executeBatchWithRecovery(repairBatch,state,routing,job,{compact:true,singleRetry:true});for(const receipt of receipts){batchReceipts.push(receipt);receipt.filesWritten.map(normalizeCheckpointTarget).forEach(function(t){allWrittenFilesSet.add(t);});if(!receipt.checkpointPersisted&&receipt.parsedFiles&&receipt.parsedFiles.length&&!receipt.skippedFromCheckpoint){persistCheckpointReceiptOnce(codePath,receipt,receipt.parsedFiles,cleanRoot,checkpointIdentity);}}allWrittenFiles=Array.from(allWrittenFilesSet).sort();finalChecks=runFinalBuildAndTests(cleanRoot,180000);fs.writeFileSync(logPath,JSON.stringify(finalChecks,null,2),'utf8');if(finalChecks.status==='CHECK_PASSED')state.lastErrorReceipt='';}if(finalChecks.status!=='CHECK_PASSED')throw new Error('FINAL_APPLY_AND_TEST_FAILED');allWrittenFiles=Array.from(allWrittenFilesSet).sort();job.phase='REVIEWING';const diff=spawnSync('git',['diff','--',...allWrittenFiles],{cwd:cleanRoot,encoding:'utf8'}),review=buildDiffFocusedReviewContext({plan:planText,changedFiles:allWrittenFiles,diff:(diff.stdout||''),batchReceipts:batchReceipts,finalTests:fs.readFileSync(logPath,'utf8'),knownRisks:[]}),reviewPathContext=path.join(exchangeDir,'rev_ctx.txt');fs.writeFileSync(reviewPathContext,review.chunks.join(NL+NL+'--- REVIEW CHUNK ---'+NL+NL),'utf8');let reviewText='STATUS: PASSED\nSKIPPED: reviewer off',reviewerEngine=routing.roles.reviewer||'off';if(reviewerEngine!=='off'){const reviewerRules=fs.readFileSync(path.join(PLUGIN_ROOT,'rules','reviewer_rules.md'),'utf8'),reviewInline=review.text.length<=CHUNK_ENGINE_LIMITS.maxInlineChars&&review.bytes<=CHUNK_ENGINE_LIMITS.maxInlineBytes,reviewSubject=reviewInline?'kontekstin e meposhtem':path.basename(reviewPathContext)+' te bashkengjitur',baseReviewPrompt=reviewerRules+NL+NL+'Rishiko vetem '+reviewSubject+'. Kthe STATUS: PASSED ose STATUS: CHANGES_REQUIRED.',reviewAttachment=reviewInline?null:reviewPathContext,reviewPrompt=reviewInline?baseReviewPrompt+NL+NL+(review.text||review.chunks[0]||''):baseReviewPrompt,failedReviewEngines=new Set();let reviewAttempt=0;while(reviewAttempt<6){reviewAttempt++;try{if(!reviewInline&&reviewerEngine.startsWith('gemini')){const reviewModelTier=state.activeGeminiModelTier || 'neon';await runGeminiAttachmentIngestHandshake({tabKey:reviewerEngine,projectRoot:cleanRoot,attachmentPath:reviewPathContext,batchId:'REVIEW',reasoningLevel:'high',modelTier:reviewModelTier,forceFreshChat:true});reviewText=await dispatchChunkedEngineTurn(reviewerEngine,cleanRoot,reviewPrompt,null,{forceFreshChat:false,useProvidedBundle:false,disableInternalRetry:true,reasoningLevel:'high',modelTier:reviewModelTier});}else{reviewText=await dispatchChunkedEngineTurn(reviewerEngine,cleanRoot,reviewPrompt,reviewAttachment,{forceFreshChat:true,useProvidedBundle:!reviewInline,disableInternalRetry:reviewerEngine.startsWith('gemini'),reasoningLevel:'high',modelTier:reviewerEngine.startsWith('gemini')?(state.activeGeminiModelTier || 'neon'):'argon_high'});}break;}catch(reviewError){const reviewCode=String(reviewError&&reviewError.message||reviewError),reviewBackend=/GEMINI_CONVERSATION_RESET_AFTER_SEND|GEMINI_TURN_ROLLED_BACK_AFTER_SEND|GEMINI_SILENT_PREFLIGHT_TIMEOUT|GEMINI_THINKING_STALL|GEMINI_HARD_CAP_TIMEOUT|WEB_SERVICE_REFUSAL|SERVICE_REFUSAL|WEB_TRANSIENT_SERVICE_ERROR|WEB_PAYLOAD_REJECTED_OR_OVERSIZED|MODEL_OPTION_NOT_FOUND/.test(reviewCode);if(isEngineFailoverEligible(reviewCode)&&failedReviewEngines.size<3){failedReviewEngines.add(reviewerEngine);const nextReviewer=getFailoverEngines(reviewerEngine,failedReviewEngines)[0];if(nextReviewer){console.error('[REVIEWER_ENGINE_FAILOVER] from='+reviewerEngine+' to='+nextReviewer+' reason='+reviewCode.split(' ')[0]);reviewerEngine=nextReviewer;continue;}}throw reviewError;}}}fs.writeFileSync(reviewPath,reviewText,'utf8');const reviewVerdicts=String(reviewText||'').split(/\r?\n/).map(function(line){return line.replace(/[*#]/g,'').trim();}).map(function(line){return line.match(/^STATUS:\s*(APPROVED|PASSED|CHANGES_REQUIRED|FAILED|REJECTED)\b/i);}).filter(Boolean).map(function(match){return match[1].toUpperCase();}),approved=reviewVerdicts.some(function(verdict){return verdict==='APPROVED'||verdict==='PASSED';})&&!reviewVerdicts.some(function(verdict){return verdict==='CHANGES_REQUIRED'||verdict==='FAILED'||verdict==='REJECTED';});job.running=false;job.phase=approved?'COMPLETED':'FAILED_REVIEW';job.result={status:approved?'CYCLE_COMPLETED':'REVIEW_FAILED',verdict:approved?'APPROVED':'CHANGES_REQUIRED',plannerModel:tabActiveModel[routing.roles.planner]||routing.roles.planner,coderModel:tabActiveModel[routing.roles.coder]||routing.roles.coder,reviewerEngine:reviewerEngine,writtenFiles:Array.from(new Set(allWrittenFiles)),commandsExecuted:finalChecks.receipts.map(x=>x.command),batchReceipts:batchReceipts,finalChecks:finalChecks};}catch(err){job.running=false;job.phase='FAILED';job.error=err.message;job.result=null;}}


function resolveAndEmbedExternalFiles(userRequest) {
  if (!userRequest || typeof userRequest !== 'string') return '';
  let embedded = '';
  const quotedRegex = /["']([A-Za-z]:\\[^"'\r\n*?<>|]+|\/[^"'\r\n]+)["']/g;
  const extRegex = /(?:[A-Za-z]:\\[^"'\r\n\t*?<>|]+?\.(?:txt|md|yaml|yml|json|py|js|ts|sh|ps1|csv|xml|html|zip|diff|patch)|\/[^"'\s\r\n\t]+?\.(?:txt|md|yaml|yml|json|py|js|ts|sh|ps1|csv|xml|html|zip|diff|patch))\b/gi;

  const candidatePaths = [];
  let qMatch;
  while ((qMatch = quotedRegex.exec(userRequest)) !== null) {
    candidatePaths.push(qMatch[1]);
  }
  const extMatches = userRequest.match(extRegex) || [];
  candidatePaths.push(...extMatches);

  const readPaths = new Set();
  for (let rawPath of candidatePaths) {
    let clean = rawPath.trim().replace(/^["']|["']$/g, '').replace(/[.,;:]$/, '');
    if (readPaths.has(clean)) continue;
    try {
      if (fs.existsSync(clean) && fs.statSync(clean).isFile()) {
        readPaths.add(clean);
        const content = fs.readFileSync(clean, 'utf8');
        embedded += NL + NL + '=== DOKUMENTI I PLOTE I SPECIFIKIMEVE NGA PERDORUESI: ' + path.basename(clean) + ' ===' + NL +
                    content + NL +
                    '=== FUNDI I SPECIFIKIMEVE (ZBATIM 100% I DETYRUESHEM, ZERO-FAKE, ZERO-PLACEHOLDERS) ===';
      }
    } catch (_) {}
  }
  return embedded;
}

async function waitJobSlice(cleanRoot, maxSliceMs) {
if (!maxSliceMs) maxSliceMs = 22000;
const start = Date.now();
while (Date.now() - start < maxSliceMs) {
const job = activeCycleJobs[cleanRoot];
if (!job) return { status: 'NO_ACTIVE_JOB' };
if (!job.running) {
if (job.error) throw new Error(job.error);
return job.result;
}
await new Promise(function(r) { setTimeout(r, 800); });
}
const job = activeCycleJobs[cleanRoot];
return {
status: 'STILL_RUNNING_CALL_CHECK_PROGRESS',
currentPhase: job ? job.phase : 'WORKING',
phase:job?job.phase:'WORKING',completed:job&&job.completed||0,total:job&&job.total||0,currentBatchId:job&&job.currentBatchId||null,currentTargets:job&&job.currentTargets||[],bytesInContext:job&&job.bytesInContext||0,retriesUsed:job&&job.retriesUsed||0,halvingUsed:job&&job.halvingUsed||0,lastCheckStatus:job&&job.lastCheckStatus||'PENDING',transport:job&&job.transport||null,reasoningLevel:job&&job.reasoningLevel||null,attempt:job&&job.attempt||0,handshakeStatus:job&&job.handshakeStatus||null,activeCoderEngine:job&&job.activeCoderEngine||null,activeModelTier:job&&job.activeModelTier||null,repoMapReceipt:job&&job.repoMapReceipt||null,planningPath:job&&job.planningPath||null,
elapsedSeconds: job ? Math.round((Date.now() - job.startedAt) / 1000) : 0,
nextRequiredToolCall: 'check_cycle_progress',
instruction: 'Puna po vazhdon normalisht ne sfond. Thirr MENJEHERE mjetin check_cycle_progress(projectRoot) PA ekzekutuar asnje komande terminali!'
};
}
async function executeCoreAction(action, payload) {
payload = payload || {};
const projectRoot = payload.projectRoot || payload.project_root || process.cwd();
const cleanRoot = path.resolve(projectRoot);

// SHTYLLA 1: BLLOKADE FIZIKE ME KOD (CYCLE_EXCLUSIVE_LOCK)
if (action !== 'run_full_cycle' && action !== 'check_cycle_progress' && !payload._internal) {
  if (activeCycleJobs[cleanRoot] && activeCycleJobs[cleanRoot].running) {
    throw new Error('ACTION_REJECTED_CYCLE_IN_PROGRESS: Cikli autopilot eshte aktiv per [' + cleanRoot + '] ne fazen [' + activeCycleJobs[cleanRoot].phase + ']. Ndalohet kategorikisht thirrja e mjeteve anesore! Thirr vetem check_cycle_progress(projectRoot).');
  }
}
if (action === 'run_full_cycle') {
if (!activeCycleJobs[cleanRoot] || !activeCycleJobs[cleanRoot].running) {
runAutonomousPipeline(cleanRoot, payload.userRequest || '');
}
return await waitJobSlice(cleanRoot, 22000);
}
if (action === 'check_cycle_progress') {
return await waitJobSlice(cleanRoot, 22000);
}
if (action === 'pack_workspace') {
const info = packWorkspace(cleanRoot, payload.mode || PACK_MODES.PLANNING_FULL);
return Object.assign({ status: 'SUCCESS' }, info);
}
const routing = ensureProjectSetup(cleanRoot);
const exchangeDir = path.join(cleanRoot, '.antigravity', 'bridge', 'exchange');
const planPath = path.join(exchangeDir, 'plan.md');
const codePath = path.join(exchangeDir, 'code.md');
const reviewPath = path.join(exchangeDir, 'review.md');
const logPath = path.join(exchangeDir, 'build_test.log');
const errorPath = path.join(exchangeDir, 'last_error.txt');
if (action === 'run_planner') {
const engine = routing.roles.planner;
if (engine === 'antigravity') return { status: 'DELEGATE_TO_ANTIGRAVITY', role: 'planner', targetFile: planPath };
const bundle = getBundleAttachmentAndNote(cleanRoot, engine);
let rule = fs.readFileSync(path.join(PLUGIN_ROOT, 'rules', 'planner_rules.md'), 'utf8');
if (engine.startsWith('google_search_') || engine.startsWith('gemini')) {
  rule = rule.replace(/\([^)]*zip[^)]*\)/gi, '(Kodi i plotë i projektit është në formatin .txt (project_bundle.txt) i përfshirë në mesazh).');
}
const embeddedSpecs = resolveAndEmbedExternalFiles(payload.userRequest);
const prompt = rule + bundle.note + embeddedSpecs + NL + NL + 'KERKESA E PERDORUESIT:' + NL + (payload.userRequest || 'Analizo dhe planifiko ndryshimet.');

let response;
if (engine.startsWith('google_search_')) {
  response = await dispatchToGoogleSearchAiTab({
    tabKey: engine,
    projectRoot: cleanRoot,
    promptText: prompt,
    bundlePath: bundle.path,
    isPlanner: true,
    userRequest: payload.userRequest
  });
} else {
  response = await dispatchToWebTab({
    tabKey: engine,
    projectRoot: cleanRoot,
    promptText: prompt,
    attachmentPaths: [bundle.path]
  });
}
const lowPlan = (response || '').toLowerCase();
const isPlanRefusal = (response || '').trim().length < 500 && SERVICE_ERROR_PATTERNS.some(function(p) { return lowPlan.includes(p); });
if (!response || response.trim().length < 100 || isPlanRefusal) {
  throw new Error('PLANNER_INVALID_OR_REFUSED_OUTPUT nga [' + engine + ']: Plani u refuzua ose eshte teper i shkurter (' + (response || '').slice(0, 120).trim() + ').');
}
fs.writeFileSync(planPath, response, 'utf8');
writeProjectState(cleanRoot, { phase: 'PLANNED', retryCount: 0, lastStatus: 'PLAN_READY' });
return { status: 'EXTERNAL_COMPLETED', engine: engine, activeModel: tabActiveModel[engine], outputFile: planPath };
}
if (action === 'run_coder') {
const engine = routing.roles.coder;
if (engine === 'antigravity') return { status: 'DELEGATE_TO_ANTIGRAVITY', role: 'coder', planFile: planPath, targetFile: codePath };
const st = readProjectState(cleanRoot);
if (payload.mode === 'FIX_ERROR' && st.retryCount > (st.maxRetries || 2)) {
return { status: 'MAX_RETRIES_EXCEEDED', errorFile: errorPath };
}
  packWorkspace(cleanRoot, payload.mode === 'FIX_ERROR' ? PACK_MODES.RETRY_COMPACT : PACK_MODES.CODING_FOCUSED);
const bundle = getBundleAttachmentAndNote(cleanRoot, engine);
let rule = fs.readFileSync(path.join(PLUGIN_ROOT, 'rules', 'coder_rules.md'), 'utf8');
if (engine.startsWith('google_search_') || engine.startsWith('gemini')) {
  rule = rule.replace(/\([^)]*zip[^)]*\)/gi, '(Kodi i plotë ekzistues i projektit është i bashkangjitur si skedar fizik project_bundle.txt).');
}
const planTxt = fs.existsSync(planPath) ? fs.readFileSync(planPath, 'utf8') : '';
let extraPrompt = bundle.note + NL + NL + '=== PLANI ARKITEKTUROR (plan.md) ===' + NL + planTxt;
if (payload.mode === 'FIX_ERROR' && fs.existsSync(errorPath)) {
extraPrompt += NL + NL + '=== GABIMI I TERMINALIT (AUTO-HEAL) ===' + NL + fs.readFileSync(errorPath, 'utf8').slice(-12000);
}
if (payload.mode === 'REVIEW_FIX' && fs.existsSync(reviewPath)) {
extraPrompt += NL + NL + '=== VEREJTJET E AUDITORIT (review.md) ===' + NL + fs.readFileSync(reviewPath, 'utf8');
}
let response;
if (engine.startsWith('google_search_')) {
  response = await dispatchToGoogleSearchAiTab({
    tabKey: engine,
    projectRoot: cleanRoot,
    promptText: rule + extraPrompt,
    bundlePath: bundle.path,
    isPlanner: false,
    userRequest: payload.userRequest
  });
} else {
  response = await dispatchToWebTab({
    tabKey: engine,
    projectRoot: cleanRoot,
    promptText: rule + extraPrompt,
    attachmentPaths: [bundle.path]
  });
}
const lowCode = (response || '').toLowerCase();
const isCodeRefusal = (response || '').trim().length < 500 && SERVICE_ERROR_PATTERNS.some(function(p) { return lowCode.includes(p); });
if (!response || response.trim().length < 60 || isCodeRefusal) {
  throw new Error('CODER_INVALID_OR_REFUSED_OUTPUT nga [' + engine + ']: Kodi u refuzua ose eshte teper i shkurter (' + (response || '').slice(0, 120).trim() + ').');
}
const validation = validateGeneratedCodeMarkdown(response);
if (!validation.valid) {
  const corrPrompt = 'KORRIGJIM FORMATI I DETYRUESHEM: ' + validation.reason + NL + 'Kthe kodin 100% te plote per cdo skedar me etiketen e sakte ### FILE: rruga/skedari.ext.';
  if (engine.startsWith('google_search_')) {
    response = await dispatchToGoogleSearchAiTab({
      tabKey: engine,
      projectRoot: cleanRoot,
      promptText: corrPrompt,
      isPlanner: false
    });
  } else {
    response = await dispatchToWebTab({
      tabKey: engine,
      projectRoot: cleanRoot,
      promptText: corrPrompt,
      attachmentPaths: []
    });
  }
}
fs.writeFileSync(codePath, response, 'utf8');
writeProjectState(cleanRoot, { phase: 'CODED', lastStatus: 'CODE_READY' });
return { status: 'EXTERNAL_COMPLETED', engine: engine, activeModel: tabActiveModel[engine], outputFile: codePath };
}
if (action === 'apply_and_test') {
return applyAndTestDeterministically(cleanRoot);
}
if (action === 'run_reviewer') {
const engine = routing.roles.reviewer;
if (!engine || engine === 'off') {
writeProjectState(cleanRoot, { phase: 'PASSED_SKIPPED_REVIEW', lastStatus: 'PASSED' });
return { status: 'SKIPPED', verdict: 'PASSED' };
}
if (engine === 'antigravity') return { status: 'DELEGATE_TO_ANTIGRAVITY', role: 'reviewer', codeFile: codePath, targetFile: reviewPath };
  packWorkspace(cleanRoot, PACK_MODES.REVIEW_FOCUSED);
const rule = fs.readFileSync(path.join(PLUGIN_ROOT, 'rules', 'reviewer_rules.md'), 'utf8');
const planTxt = fs.existsSync(planPath) ? fs.readFileSync(planPath, 'utf8') : '';
const logTxt = fs.existsSync(logPath) ? fs.readFileSync(logPath, 'utf8').slice(-8000) : 'NOT_RUN';
const revPrompt = rule + NL + NL + '=== PLANI ===' + NL + planTxt + NL + NL + '=== BUILD/TEST LOG ===' + NL + logTxt;
let response;
if (engine.startsWith('google_search_')) {
  response = await dispatchToGoogleSearchAiTab({
    tabKey: engine,
    projectRoot: cleanRoot,
    promptText: revPrompt,
    bundlePath: codePath,
    isPlanner: false
  });
} else {
  response = await dispatchToWebTab({
    tabKey: engine,
    projectRoot: cleanRoot,
    promptText: revPrompt,
    attachmentPaths: [codePath]
  });
}
fs.writeFileSync(reviewPath, response, 'utf8');
const verdicts = String(response || '').split(/\r?\n/).map(function(line) { return line.replace(/[*#]/g, '').trim(); }).map(function(line) { return line.match(/^STATUS:\s*(APPROVED|PASSED|CHANGES_REQUIRED|FAILED|REJECTED)\b/i); }).filter(Boolean).map(function(match) { return match[1].toUpperCase(); });
const approved = verdicts.some(function(verdict) { return verdict === 'APPROVED' || verdict === 'PASSED'; }) && !verdicts.some(function(verdict) { return verdict === 'CHANGES_REQUIRED' || verdict === 'FAILED' || verdict === 'REJECTED'; });
writeProjectState(cleanRoot, {
phase: approved ? 'PASSED' : 'REVIEW_CHANGES_REQUESTED',
lastStatus: approved ? 'PASSED' : 'FAILED_REVIEW'
});
if (approved) {
purgeExchangeArtifacts(cleanRoot);
}
return { status: 'EXTERNAL_COMPLETED', engine: engine, verdict: approved ? 'PASSED' : 'CHANGES_REQUIRED', outputFile: reviewPath };
}
throw new Error('Veprim i panjohur: ' + action);
}
// ---------------- SINGLETON HTTP SERVER & DASHBOARD (127.0.0.1:4321) ----------------
let isPrimaryInstance = false;
function startDashboardAndSingletonServer() {
const httpServer = http.createServer(async function(req, res) {
res.setHeader('Access-Control-Allow-Origin', '*');
res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
res.setHeader('Access-Control-Allow-Headers', 'Content-Type');
if (req.method === 'OPTIONS') { res.writeHead(204); return res.end(); }
if (req.method === 'GET' && req.url === '/') {
const html = fs.readFileSync(path.join(__dirname, 'dashboard.html'), 'utf8');
res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
return res.end(html);
}
if (req.method === 'GET' && req.url === '/api/state') {
const reg = JSON.parse(fs.readFileSync(REGISTRY_PATH, 'utf8'));
const projectsData = reg.projects.filter(function(p) { return fs.existsSync(p); }).map(function(p) {
const cfg = ensureProjectSetup(p);
const st = readProjectState(p);
const liveJob = activeCycleJobs[path.resolve(p)];
if (liveJob && liveJob.running) {
st.phase = liveJob.phase;
}
return Object.assign({}, cfg, { state: st });
});
const tabStates = {};
for (const k of Object.keys(tabs)) {
tabStates[k] = {
open: Boolean(tabs[k] && !tabs[k].isClosed()),
auth: tabAuthStatus[k],
model: tabActiveModel[k],
connectionLabel:
        (
          geminiModelReceipts[k] &&
          geminiModelReceipts[k].verified === true &&
          geminiModelReceipts[k].family === 'neon'
        )
          ? 'E Lidhur (Neon)'
          : 'E Lidhur',
      geminiReceipt: geminiModelReceipts[k] || null,
discoveredModels: tabDiscoveredModels[k] || '-',
activeProject: activeProjectPerTab[k] ? path.basename(activeProjectPerTab[k]) : 'Asnje'
};
}
res.writeHead(200, { 'Content-Type': 'application/json' });
return res.end(JSON.stringify({ projects: projectsData, tabs: tabStates }));
}
let body = '';
req.on('data', function(chunk) { body += chunk; });
req.on('end', async function() {
try {
const data = body ? JSON.parse(body) : {};
if (req.url === '/api/save-routing') {
ensureProjectSetup(data.projectRoot);
const rPath = path.join(path.resolve(data.projectRoot), '.antigravity', 'bridge', 'routing.json');
const current = JSON.parse(fs.readFileSync(rPath, 'utf8'));
current.roles = Object.assign({}, current.roles, data.roles || {});
if (typeof data.buildCmd === 'string') current.buildCmd = data.buildCmd.trim();
if (typeof data.testCmd === 'string') current.testCmd = data.testCmd.trim();
if (data.bundleFormat) current.bundleFormat = data.bundleFormat;
fs.writeFileSync(rPath, JSON.stringify(current, null, 2), 'utf8');
res.writeHead(200, { 'Content-Type': 'application/json' });
return res.end(JSON.stringify({ ok: true }));
}
if (req.url === '/api/add-project') {
const cfg = ensureProjectSetup(data.projectRoot);
res.writeHead(200, { 'Content-Type': 'application/json' });
return res.end(JSON.stringify({ ok: true, project: cfg }));
}
if (req.url === '/api/delete-project') {
const targetRoot = path.resolve(data.projectRoot || data.project_id || '');
if (!targetRoot) {
res.writeHead(400, { 'Content-Type': 'application/json' });
return res.end(JSON.stringify({ ok: false, error: 'projectRoot is required' }));
}
const reg = JSON.parse(fs.readFileSync(REGISTRY_PATH, 'utf8'));
const initialLen = (reg.projects || []).length;
reg.projects = (reg.projects || []).filter(function(p) {
return path.resolve(p).toLowerCase() !== targetRoot.toLowerCase();
});
fs.writeFileSync(REGISTRY_PATH, JSON.stringify(reg, null, 2), 'utf8');
res.writeHead(200, { 'Content-Type': 'application/json' });
return res.end(JSON.stringify({ ok: true, removed: initialLen !== reg.projects.length, projectRoot: targetRoot }));
}
if (req.url === '/api/purge-exchange') {
const targetRoot = path.resolve(data.projectRoot || '');
if (!targetRoot) {
const reg = JSON.parse(fs.readFileSync(REGISTRY_PATH, 'utf8'));
let totalRemoved = 0;
for (const p of reg.projects || []) {
const resPurge = purgeExchangeArtifacts(p);
totalRemoved += resPurge.removedCount || 0;
}
res.writeHead(200, { 'Content-Type': 'application/json' });
return res.end(JSON.stringify({ ok: true, allProjects: true, totalRemovedFiles: totalRemoved }));
}
const result = purgeExchangeArtifacts(targetRoot);
res.writeHead(200, { 'Content-Type': 'application/json' });
return res.end(JSON.stringify(Object.assign({ ok: true, projectRoot: targetRoot }, result)));
}
if (req.url === '/api/reset-tab') {
if (tabs[data.tabKey] && !tabs[data.tabKey].isClosed()) {
await resetChatIfNeeded(tabs[data.tabKey], data.tabKey, '', true);
}
res.writeHead(200, { 'Content-Type': 'application/json' });
return res.end(JSON.stringify({ ok: true }));
}
    if (req.url === '/api/login-profile') {
      const reqName = data.profileName;
      const profile = getProfileNameForTab(reqName);
      const targetUrl = getTargetUrl(reqName);

      const visibleCtx = await getOrLaunchContext(profile, false);
      const pages = visibleCtx.pages();
      const loginPage = (pages.length > 0 && !pages[0].isClosed()) ? pages[0] : await visibleCtx.newPage();
      await loginPage.goto(targetUrl, { waitUntil: 'domcontentloaded' }).catch(function() {});
      await loginPage.bringToFront().catch(function() {});

      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({
        ok: true,
        message: 'Dritarja e dukshme per [' + reqName + ' (Profili: ' + profile + ')] u hap me sukses!\n\n1. Identifikohu me llogarine tende ne Google/Microsoft.\n2. Zgjidh modelin ose kalo verifikimet/cookies nese kerkohen.\n3. Mbylle dritaren me [X] kur te mbarosh, qe profili te ruhet per ekzekutimet automatike ne sfond.'
      }));
    }
if (req.url === '/api/kill-all') {
await closeAllContexts();
res.writeHead(200, { 'Content-Type': 'application/json' });
return res.end(JSON.stringify({ ok: true }));
}
if (req.url === '/api/mcp-proxy') {
const result = await executeCoreAction(data.action, data.payload);
res.writeHead(200, { 'Content-Type': 'application/json' });
return res.end(JSON.stringify(result));
}
res.writeHead(404);
res.end('Not found');
} catch (err) {
res.writeHead(500, { 'Content-Type': 'application/json' });
res.end(JSON.stringify({ error: err.message }));
}
});
});
httpServer.on('error', function(err) {
if (err.code === 'EADDRINUSE') isPrimaryInstance = false;
});
httpServer.listen(PORT, HOST, function() {
isPrimaryInstance = true;
console.error('[DASHBOARD READY] http://' + HOST + ':' + PORT);
});
}
async function dispatchActionSingleton(action, payload) {
if (isPrimaryInstance) return await executeCoreAction(action, payload);
const resp = await fetch('http://' + HOST + ':' + PORT + '/api/mcp-proxy', {
method: 'POST',
headers: { 'Content-Type': 'application/json' },
body: JSON.stringify({ action: action, payload: payload })
});
const data = await resp.json();
if (!resp.ok) throw new Error(data.error || 'Singleton proxy error');
return data;
}
// ---------------- MCP TOOLS DEFINITION ----------------
const mcpServer = new Server(
{ name: 'multi-ai-relay', version: '3.2.0' },
{ capabilities: { tools: {} } }
);
mcpServer.setRequestHandler(ListToolsRequestSchema, async function() {
return {
tools: [
{
name: 'run_full_cycle',
description: 'MJETI KRYESOR AUTOPILOT (THIRRE KETE TE PARIN!): Nis ne Node.js gjithe ciklin (pack -> planner -> coder -> apply_and_test -> reviewer) me 0 komanda terminali! Kthen rezultatin ose STILL_RUNNING_CALL_CHECK_PROGRESS pas 25s. NDALOHET perdorimi i terminalit ose leximi i state.json!',
inputSchema: {
type: 'object',
properties: {
projectRoot: { type: 'string' },
userRequest: { type: 'string' }
},
required: ['projectRoot', 'userRequest']
}
},
{
name: 'check_cycle_progress',
description: 'Pret deri ne 25s te tjera kur run_full_cycle kthen STILL_RUNNING_CALL_CHECK_PROGRESS. Thirre ne zinxhir derisa te ktheje CYCLE_COMPLETED. Mos perdor kurre sleep/wait ne terminal!',
inputSchema: {
type: 'object',
properties: { projectRoot: { type: 'string' } },
required: ['projectRoot']
}
},
{
name: 'pack_workspace',
description: 'Paketon projektin ne exchange/ (.txt dhe .zip.md).',
inputSchema: {
type: 'object',
properties: { projectRoot: { type: 'string' }, mode: { type: 'string', enum: ['FULL', 'DELTA'] } },
required: ['projectRoot']
}
},
{
name: 'run_planner',
description: 'Ekzekuton vetem Planifikuesin.',
inputSchema: {
type: 'object',
properties: { projectRoot: { type: 'string' }, userRequest: { type: 'string' } },
required: ['projectRoot', 'userRequest']
}
},
{
name: 'run_coder',
description: 'Ekzekuton vetem Koduesin.',
inputSchema: {
type: 'object',
properties: { projectRoot: { type: 'string' }, mode: { type: 'string', enum: ['IMPLEMENT', 'FIX_ERROR', 'REVIEW_FIX'] } },
required: ['projectRoot']
}
},
{
name: 'apply_and_test',
description: '0-Token Node.js Deterministic Executor.',
inputSchema: {
type: 'object',
properties: { projectRoot: { type: 'string' } },
required: ['projectRoot']
}
},
{
name: 'run_reviewer',
description: 'Release Gate Reviewer.',
inputSchema: {
type: 'object',
properties: { projectRoot: { type: 'string' } },
required: ['projectRoot']
}
}
]
};
});
mcpServer.setRequestHandler(CallToolRequestSchema, async function(request) {
try {
const name = request.params.name;
const args = request.params.arguments;
const result = await dispatchActionSingleton(name, args);
return { content: [{ type: 'text', text: JSON.stringify(result, null, 2) }] };
} catch (err) {
return {
isError: true,
content: [{
type: 'text',
text: JSON.stringify({
status: 'SUPPORT_REQUIRED_STOP_IMMEDIATELY',
directive: 'NDALO MENJEHERE! Mos bej retry dhe mos ekzekuto komanda terminali. Raportoja perdoruesit kete mesazh.',
details: err.message
}, null, 2)
}]
};
}
});
async function closeAllContexts() {
for (const [k, ctx] of Object.entries(contexts)) {
try { await ctx.close(); } catch (_) {}
delete contexts[k];
delete contextModes[k];
}
for (const k of Object.keys(tabs)) tabs[k] = null;
}
process.on('SIGINT', async function() { await closeAllContexts(); process.exit(0); });
process.on('SIGTERM', async function() { await closeAllContexts(); process.exit(0); });
if(process.env.ANTIGRAVITY_TEST_EXPORT==='1'){module.exports={CHUNK_ENGINE_LIMITS,scanRepositoryUniversal,buildCompactRepoMap,buildDependencyGraph,partitionAnalysisChunks,analyzeRepositoryChunks,buildFinalPlanningContext,parseAndValidatePlanBatches,partitionCodingBatches,buildBatchContext,runCodingBatch,applyBatch,runBatchQuickChecks,repairBatchOnce,halveBatchAdaptively,buildCrossBatchContractSummary,buildDiffFocusedReviewContext,writeChunkContextFile,extractTargetsFromError,scoreAnalysisChunkRelevance,buildLocalStructuralChunkSummary,buildBatchMiniMap,extractBatchPlanSlice,buildMinimalBatchContext,selectCodingTransport,selectAdaptiveReasoningLevel,classifyAttachmentHandshakeStrict,getFailoverEngines,parseCodeBlocksFromMarkdown,normalizeFailureCode,isAdaptiveHalvingFailure,persistCheckpointReceiptOnce};}
if(process.env.ANTIGRAVITY_TEST_EXPORT!=='1')startDashboardAndSingletonServer();
if(process.env.ANTIGRAVITY_TEST_EXPORT!=='1' && !process.stdin.isTTY) {
const transport = new StdioServerTransport();
mcpServer.connect(transport);
} else {
console.error('[STANDALONE MODE] Shtyp Ctrl+C per ta ndalur.');
}


