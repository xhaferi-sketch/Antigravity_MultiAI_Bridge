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

const GEMINI_APP_URL = 'https://' + 'gemini.' + 'google.com' + '/app';
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

async function getOrCreateTab(tabKey) {
  const profileName = getProfileNameForTab(tabKey);
  if (tabs[tabKey] && !tabs[tabKey].isClosed()) return tabs[tabKey];

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

  tabs[tabKey] = page;
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

async function ensureMaxReasoningMode(targetFrame, tabKey) {
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

    // Universal Semantic Capability Scorer (Sipas CopilotTransport.cs - Baseline: Code & analysis / 4 Argon e lart)
    const scoreModel = function(title, fullText, isDisabled) {
      if (isDisabled) return -10000;
      const combined = ((title || '') + ' ' + (fullText || '')).toLowerCase();
      let s = 100;

      // Kategoria ELITE (+800 deri +1000): "Code & analysis", "4 Argon", "Argon", "Thinking", "Think Deeper"
      if (combined.includes('code & analysis') || combined.includes('code and analysis') ||
          combined.includes('argon') || combined.includes('4 argon') ||
          combined.includes('think') || combined.includes('thinking') ||
          combined.includes('deeper') || combined.includes('reason') ||
          combined.includes('arsyet') || combined.includes('thellë')) {
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
      // Kategoria e skualifikuar (-1000): Flash, Lite, Auto, Default, Everyday
      if (combined.includes('flash') || combined.includes('lite') || combined.includes('mini') ||
          combined.includes('auto') || combined.includes('everyday') || combined.includes('default') || combined.includes('standard')) {
        s -= 1000;
      }
      return s;
    };

    // Nese butoni aktual eshte tashme ELITE (Score >= 800)
    if (scoreModel(curDisplay, curCombined, false) >= 800) {
      return { status: 'SUCCESS_ALREADY_ACTIVE', activeModel: curDisplay, summary: curDisplay + ' (Aktiv)' };
    }

    // 2. Hap menynë
    btn.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    btn.click();
    await new Promise(function(r) { setTimeout(r, 450); });

    // Zgjedh nen-menyte nese ekzistojne
    const subTriggers = Array.from(document.querySelectorAll('[data-testid*="gptSubMenuModelTrigger"], [role="menuitem"][aria-haspopup="menu"]'));
    for (const sub of subTriggers) {
      try {
        sub.dispatchEvent(new PointerEvent('pointerover', { bubbles: true }));
        sub.click();
        await new Promise(function(r) { setTimeout(r, 250); });
      } catch (_) {}
    }

    // 3. Mbledhja e te gjitha opsioneve nga DOM (Dynamic DOM Discovery)
    const candidateNodes = Array.from(document.querySelectorAll(
      '[role="menuitemradio"], [role="menuitemcheckbox"], [role="option"], [role="menuitem"], .mat-mdc-menu-item, .fui-MenuItem, [data-testid*="gptSubMenuModelTrigger-"]'
    ));

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
    target.el.click();
    await new Promise(function(r) { setTimeout(r, 400); });
    closeMenus();

    return { status: 'SUCCESS_SWITCHED', activeModel: target.title, summary: modelListSummary };
  }, { isGemini: tabKey.startsWith('gemini') }).catch(function(err) {
    return { status: 'EVALUATE_EXCEPTION', error: err.message };
  });

  if (result.status === 'DISQUALIFIED_BELOW_BASELINE') {
    throw new Error('CRITICAL_MODEL_LOCK_REJECTED ne [' + tabKey + ']: Modeli me i mire i gjetur [' + (result.bestCandidate || '') + '] nuk arrin nivelin baze "Code & analysis" / "4 Argon" (Score < 800). Opsionet ne ekran: [' + result.summary + ']. Ndalohet kategorikisht vazhdimi me modele te uleta!');
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

async function resetChatIfNeeded(page, tabKey, projectRoot, force) {
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

async function attachFilesSafely(page, targetFrame, tabKey, projectRoot, validFiles) {
  if (validFiles.length === 0) return;
  let totalBytes = 0;
  const payloads = [];
  for (const vf of validFiles) {
    const buf = fs.readFileSync(vf);
    totalBytes += buf.length;
    const ext = path.extname(vf).toLowerCase();
    payloads.push({
      name: path.basename(vf),
      mime: (ext === '.txt' || ext === '.md') ? 'text/plain' : 'application/octet-stream',
      b64: buf.toString('base64')
    });
  }
  const pasted = await targetFrame.evaluate(function(filesData) {
    const box = document.querySelector('rich-textarea div[contenteditable="true"], div.ql-editor[contenteditable="true"], #userInput, [role="textbox"], div[contenteditable="true"], textarea');
    if (!box) return false;
    box.focus();
    const dt = new DataTransfer();
    for (const f of filesData) {
      const bin = atob(f.b64);
      const bytes = new Uint8Array(bin.length);
      for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
      dt.items.add(new File([bytes], f.name, { type: f.mime }));
    }
    box.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, clipboardData: dt }));
    setTimeout(function() {
      const chips = document.querySelectorAll('[class*="file" i], [class*="attach" i], [class*="upload" i], [class*="chip" i]');
      if (chips.length === 0) {
        box.dispatchEvent(new DragEvent('dragover', { bubbles: true, cancelable: true, dataTransfer: dt }));
        box.dispatchEvent(new DragEvent('drop', { bubbles: true, cancelable: true, dataTransfer: dt }));
      }
    }, 350);
    return true;
  }, payloads).catch(function() { return false; });
  if (!pasted) await captureSupportEvidence(page, projectRoot, tabKey, 'CTRL_V_PASTE', 'Nuk u gjet kutia e chat-it.');
  const maxUploadMs = Math.min(90000, Math.max(20000, Math.ceil(totalBytes / 50000) * 1500));
  await page.waitForTimeout(1600);
  const upStart = Date.now();
  while (Date.now() - upStart < maxUploadMs) {
    const busy = await targetFrame.evaluate(function() {
      const sp = document.querySelectorAll('[aria-busy="true"], [role="progressbar"], .uploading, mat-progress-spinner, mat-spinner');
      for (const el of sp) if (el.offsetParent !== null) return true;
      return false;
    }).catch(function() { return false; });
    if (!busy) break;
    await page.waitForTimeout(900);
  }
}

async function waitAndExtractCleanResponse(page, targetFrame, tabKey, projectRoot, previousCount) {
  const hardCapMs = 360000;
  const thinkingGraceMs = 240000;
  const streamStallMs = 45000;
  const start = Date.now();
  let lastActivityAt = Date.now();
  let lastText = '';
  let lastRawLen = 0;
  let stableTicks = 0;

  while (Date.now() - start < hardCapMs) {
    await page.waitForTimeout(750);

    const state = await targetFrame.evaluate(function(arg) {
      const stopSelectors = [
        'button[aria-label*="Stop" i]',
        'button[aria-label*="Ndalo" i]',
        'button[title*="Stop" i]',
        '[data-testid*="stop" i]',
        'button.stop-button',
        'button.send-button.stop',
        'mat-icon[data-mat-icon-name="stop"]',
        '.stop-icon'
      ].join(', ');

      const stopEls = Array.from(document.querySelectorAll(stopSelectors));
      const isGenerating = stopEls.some(function(el) {
        const btn = el.closest('button') || el;
        if (btn.disabled || btn.getAttribute('aria-disabled') === 'true') return false;
        const st = window.getComputedStyle(btn);
        if (st.display === 'none' || st.visibility === 'hidden' || parseFloat(st.opacity || '1') <= 0.05) return false;
        const r = btn.getBoundingClientRect();
        return r.width > 4 && r.height > 4;
      });

      let containers = [];
      if (arg.isGemini) {
        containers = Array.from(document.querySelectorAll('response-container'));
        if (containers.length === 0) containers = Array.from(document.querySelectorAll('model-response, message-content, [data-message-author-role="model"]'));
      } else {
        containers = Array.from(document.querySelectorAll('[data-testid="chat-turn-assistant"], [data-testid*="message-assistant" i], .assistant-message, .fai-CopilotMessage, [data-content="ai-message"], div[class*="AssistantMessage" i]'));
      }

      if (containers.length <= arg.prevCount) {
        return { generating: isGenerating, hasNewTurn: false, rawLen: 0, text: '' };
      }

      const liveNode = containers[containers.length - 1];
      const contentNode = (arg.isGemini && liveNode.querySelector('message-content, .markdown-main-panel, .md-content'))
        ? liveNode.querySelector('message-content, .markdown-main-panel, .md-content')
        : liveNode;
      // Përdorim textContent për rawLen që të kapim rrjedhjen e token-ave edhe brenda Thinking blocks të palosur
      const rawLen = (liveNode.textContent || '').length;

      const latest = contentNode.cloneNode(true);

      // 1. Hiq blloqet e mendimit (Thinking)
      latest.querySelectorAll(
        'model-thoughts, .thoughts-container, .thought-container, [data-test-id*="thought" i], [data-testid*="thought" i], ms-thought-chunk'
      ).forEach(function(n) { n.remove(); });

      // 2. Konverto blloqet <pre> në Markdown Fences duke ruajtur gjuhën edhe nga header-i i Gemini
      latest.querySelectorAll('pre').forEach(function(pre) {
        const codeEl = pre.querySelector('code');
        const cls = (codeEl ? (codeEl.className || '') : '') + ' ' + (pre.className || '');
        const m = cls.match(/language-([a-zA-Z0-9_+-]+)/);
        let lang = m ? m[1] : '';

        if (!lang) {
          const wrapper = pre.closest('code-block, .code-block, .code-container');
          if (wrapper) {
            const hdr = wrapper.querySelector('.code-block-decoration span, .code-header span, .code-block-internal-header span');
            if (hdr && hdr.textContent) {
              const candidate = hdr.textContent.trim().toLowerCase();
              if (/^[a-z0-9_+-]{1,20}$/.test(candidate)) lang = candidate;
            }
          }
        }

        const raw = (codeEl ? codeEl.textContent : pre.textContent) || '';
        const rep = document.createTextNode('\n\n' + arg.fence + lang + '\n' + raw.replace(/\n+$/, '') + '\n' + arg.fence + '\n\n');
        pre.parentNode.replaceChild(rep, pre);
      });

      // 3. Pastro elementët dekorativë të UI-së pas konvertimit të <pre>
      latest.querySelectorAll(
        'details, button, .code-header, .code-block-decoration, .code-block-internal-header, .footnote, svg, mat-icon'
      ).forEach(function(n) { n.remove(); });

      // 3.5 Konverto h1-h6 në Markdown Headings (#..######)
      latest.querySelectorAll('h1, h2, h3, h4, h5, h6').forEach(function(h) {
        const level = parseInt(h.tagName.substring(1), 10) || 3;
        const prefix = '#'.repeat(level) + ' ';
        h.insertBefore(document.createTextNode('\n\n' + prefix), h.firstChild);
        h.appendChild(document.createTextNode('\n\n'));
      });

      // 4. Siguro ndarjen e paragrafëve dhe rreshtave kur lexohet nyja e klonuar
      latest.querySelectorAll('p, div, li, br, tr').forEach(function(el) {
        if (el.tagName === 'BR') {
          el.parentNode.replaceChild(document.createTextNode('\n'), el);
        } else {
          el.appendChild(document.createTextNode('\n'));
        }
      });

      let cleanText = (latest.textContent || '')
        .replace(/\r\n/g, '\n')
        .replace(/\n{3,}/g, '\n\n')
        .trim();

      if (cleanText.startsWith('Gemini said\n') || cleanText.startsWith('Gemini said\r\n')) {
        cleanText = cleanText.replace(/^Gemini said\r?\n+/, '').trim();
      }

      return { generating: isGenerating, hasNewTurn: true, rawLen: rawLen, text: cleanText };
    }, { isGemini: tabKey.startsWith('gemini'), prevCount: previousCount, fence: FENCE3 });

    let lastLogAt = Date.now();
    if (state.generating || state.text !== lastText || state.rawLen !== lastRawLen) {
      lastActivityAt = Date.now();
      lastRawLen = state.rawLen;
    }

    if (Date.now() - lastLogAt > 4000 || state.text !== lastText) {
      lastLogAt = Date.now();
      console.error('[WAIT_RESPONSE] elapsed=' + Math.floor((Date.now() - start)/1000) + 's generating=' + state.generating + ' hasNewTurn=' + state.hasNewTurn + ' rawLen=' + state.rawLen + ' textLen=' + state.text.length + ' lastTextSlice=' + JSON.stringify(state.text.slice(0, 40)));
    }

    if (!state.generating && state.hasNewTurn && state.text.length > 0) {
      const lowCheck = state.text.toLowerCase();
      if (SERVICE_ERROR_PATTERNS.some(function(p) { return lowCheck.includes(p); })) {
        await captureSupportEvidence(page, projectRoot, tabKey, 'QUOTA_OR_SERVICE_REFUSAL', state.text.slice(0, 150));
        throw new Error('QUOTA_OR_SERVICE_REFUSAL ne [' + tabKey + ']: ' + state.text.slice(0, 150));
      }
      if (state.text === lastText) {
        stableTicks++;
        if (stableTicks >= 4) {
          return state.text;
        }
      } else {
        stableTicks = 0;
        lastText = state.text;
      }
    } else {
      stableTicks = 0;
      if (state.text) lastText = state.text;
    }

    const limit = lastText.length === 0 ? thinkingGraceMs : streamStallMs;
    if (Date.now() - lastActivityAt > limit) {
      if (lastText && lastText.length > 25) return lastText;
      await captureSupportEvidence(page, projectRoot, tabKey, 'RESPONSE_STALL', 'Nuk erdhi pergjigje pas pritjes adaptive.');
    }
  }

  if (lastText && lastText.length > 25) return lastText;
  await captureSupportEvidence(page, projectRoot, tabKey, 'TIMEOUT', 'Gjenerimi kaloi 210s.');
}

async function dispatchToWebTab(opts) {
  const tabKey = opts.tabKey;
  const projectRoot = opts.projectRoot;
  const promptText = opts.promptText;
  const attachmentPaths = opts.attachmentPaths || [];
  return withTabLock(tabKey, async function() {
    const isGemini = tabKey.startsWith('gemini');
    for (let attempt = 1; attempt <= 2; attempt++) {
      const page = await getOrCreateTab(tabKey);
      if (await checkAuthExpired(page, tabKey)) {
        await captureSupportEvidence(page, projectRoot, tabKey, 'AUTH_EXPIRED', 'Kerkon Login ne Dashboard 4321.');
      }
      const targetFrame = findChatFrameOrPage(page);
      const routing = ensureProjectSetup(projectRoot);
      if (routing.autoNewChatOnProjectSwitch || attempt === 2) {
        await resetChatIfNeeded(page, tabKey, projectRoot, attempt === 2);
      }
      const verifiedModel = await ensureMaxReasoningMode(targetFrame, tabKey);
      tabActiveModel[tabKey] = verifiedModel;
      await page.keyboard.press('Escape').catch(function() {});
      await targetFrame.evaluate(function() {
        document.querySelectorAll('.cdk-overlay-backdrop').forEach(function(b) { b.click(); });
      }).catch(function() {});
      await page.waitForTimeout(200);

      // 1. Numërimi i saktë i përgjigjeve ekzistuese (1:1 me waitAndExtractCleanResponse)
      const previousCount = await targetFrame.evaluate(function(isGem) {
        let c = [];
        if (isGem) {
          c = Array.from(document.querySelectorAll('response-container'));
          if (c.length === 0) c = Array.from(document.querySelectorAll('model-response, message-content, [data-message-author-role="model"]'));
        } else {
          c = Array.from(document.querySelectorAll('[data-testid="chat-turn-assistant"], [data-testid*="message-assistant" i], .assistant-message, .fai-CopilotMessage, [data-content="ai-message"], div[class*="AssistantMessage" i]'));
        }
        return c.length;
      }, isGemini);
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
        if (isGemini && !fp.endsWith('.zip.md')) {
          combinedText += NL + NL + '=== FILE: ' + path.basename(fp) + ' ===' + NL + fs.readFileSync(fp, 'utf8');
        } else { filesToUpload.push(fp); }
      }
      const maxChars = isGemini ? 250000 : 29500;
      const safePrompt = combinedText.length > maxChars ? (combinedText.slice(0, Math.floor(maxChars / 2)) + NL + '...[COMPACTED]...' + NL + combinedText.slice(-Math.floor(maxChars / 2))) : combinedText;
      if (filesToUpload.length > 0) await attachFilesSafely(page, targetFrame, tabKey, projectRoot, filesToUpload);

      // 2. Selektori i unifikuar për editorin (Quill në Gemini / Lexical ose Textarea në Copilot)
      const editorSelector = isGemini
        ? 'div.ql-editor[contenteditable="true"], rich-textarea div[contenteditable="true"], div[contenteditable="true"][role="textbox"], div[aria-label*="Ask Gemini" i], div[aria-label*="Enter a prompt" i], textarea'
        : '#userInput, textarea[placeholder], div[contenteditable="true"][role="textbox"], [data-testid="chat-input"], div[contenteditable="true"], textarea';

      const boxLoc = targetFrame.locator(editorSelector).first();
      await boxLoc.waitFor({ state: 'visible', timeout: 25000 });
      await boxLoc.scrollIntoViewIfNeeded().catch(function() {});
      await boxLoc.click({ force: true });
      await page.waitForTimeout(100);

      // 3. Pastrim dhe Injektim i Sigurt me CDP (page.keyboard.insertText ruan të gjitha rreshtat dhe zgjon NgZone)
      await page.keyboard.press('Control+A');
      await page.keyboard.press('Backspace');
      await page.waitForTimeout(100);
      await page.keyboard.insertText(safePrompt);
      await page.waitForTimeout(450);

      // Verifikim në DOM që teksti u injektua
      const injectedLen = await targetFrame.evaluate(function(sel) {
        const el = document.querySelector(sel);
        if (!el) return 0;
        const val = (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT') ? el.value : (el.innerText || el.textContent || '');
        return val.trim().length;
      }, editorSelector);
      console.error('[DISPATCH_STEP] injectedLen=' + injectedLen + ' (promptLen=' + safePrompt.length + ')');

      // 6. Verifikimi Para-Dërgimit (Pre-Send Invariant)
      const verifyInjected = await targetFrame.evaluate(function(sel) {
        const el = document.querySelector(sel);
        if (!el) return 0;
        const val = (el.tagName === 'TEXTAREA' || el.tagName === 'INPUT') ? el.value : (el.innerText || el.textContent || '');
        return val.trim().length;
      }, editorSelector);
      console.error('[DISPATCH_STEP] verifyInjected=' + verifyInjected);

      if (verifyInjected === 0) {
        await captureSupportEvidence(page, projectRoot, tabKey, 'INPUT_INJECTION_FAILED', 'Editori mbeti bosh pas 3 niveleve te injektimit.');
        throw new Error('INPUT_INJECTION_FAILED ne [' + tabKey + ']: Teksti nuk u shkrua dot ne editorin Quill.');
      }

      // 7. Klikimi i Sigurt i Butonit "Send" (duke përjashtuar rreptësisht "Dictate" / "Mic") + Enter Fallback
      let sentConfirmed = false;
      for (let sendAttempt = 0; sendAttempt < 4 && !sentConfirmed; sendAttempt++) {
        const clickedSend = await targetFrame.evaluate(function(isGem) {
          const sendSelectors = isGem
            ? 'button[aria-label*="Send" i], button.send-button, .send-button button, .send-button-container button, button[aria-label*="Dërgo" i], button[mattooltip*="Send" i], button:has(mat-icon[data-mat-icon-name="send"]), button:has(mat-icon[fonticon="send"])'
            : 'button[aria-label*="Send" i], button[title*="Send" i], [data-testid*="send" i], button[type="submit"]';

          const candidates = Array.from(document.querySelectorAll(sendSelectors));
          for (let i = 0; i < candidates.length; i++) {
            const btn = candidates[i].closest('button') || candidates[i];
            if (btn.disabled || btn.getAttribute('aria-disabled') === 'true') continue;
            const label = ((btn.getAttribute('aria-label') || '') + ' ' + (btn.getAttribute('title') || '') + ' ' + (btn.className || '') + ' ' + (btn.innerHTML || '')).toLowerCase();
            if (label.includes('dictat') || label.includes('microphone') || label.includes('use mic') || label.includes('voice') || label.includes('attach') || label.includes('upload')) {
              continue;
            }
            const st = window.getComputedStyle(btn);
            if (st.display === 'none' || st.visibility === 'hidden' || parseFloat(st.opacity || '1') <= 0.05) continue;
            const r = btn.getBoundingClientRect();
            if (r.width > 4 && r.height > 4) {
              btn.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
              btn.click();
              return true;
            }
          }
          return false;
        }, isGemini);

        if (!clickedSend) {
          await boxLoc.focus().catch(function() {});
          await page.keyboard.press('Enter');
        }

        await page.waitForTimeout(1000);

        // 8. Drain & Generation Check: verifiko nëse filloi gjenerimi, ose kutia u zbraz, ose u shtua response turn
        sentConfirmed = await targetFrame.evaluate(function(arg) {
          const el = document.querySelector(arg.sel);
          const remaining = el
            ? ((el.tagName === 'TEXTAREA' || el.tagName === 'INPUT') ? el.value : (el.innerText || '')).trim().length
            : 0;

          // Stop button check (nëse filloi gjenerimi, u dërgua me 100% garanci)
          const stopSelectors = [
            'button[aria-label*="Stop" i]',
            'button[aria-label*="Ndalo" i]',
            'button[title*="Stop" i]',
            '[data-testid*="stop" i]',
            'button.stop-button',
            'button.send-button.stop',
            'mat-icon[data-mat-icon-name="stop"]',
            '.stop-icon'
          ].join(', ');
          const isGenerating = Array.from(document.querySelectorAll(stopSelectors)).some(function(s) {
            const b = s.closest('button') || s;
            if (b.disabled || b.getAttribute('aria-disabled') === 'true') return false;
            const st = window.getComputedStyle(b);
            return st.display !== 'none' && st.visibility !== 'hidden' && b.getBoundingClientRect().width > 4;
          });

          let c = [];
          if (arg.isGem) {
            c = Array.from(document.querySelectorAll('response-container'));
            if (c.length === 0) c = Array.from(document.querySelectorAll('model-response, message-content, [data-message-author-role="model"]'));
          } else {
            c = Array.from(document.querySelectorAll('[data-testid="chat-turn-assistant"], [data-testid*="message-assistant" i], .assistant-message, .fai-CopilotMessage, [data-content="ai-message"], div[class*="AssistantMessage" i]'));
          }

          return isGenerating || c.length > arg.prevCount || (remaining < Math.min(10, Math.floor(arg.origLen * 0.1)) && (isGenerating || c.length > arg.prevCount));
        }, { sel: editorSelector, isGem: isGemini, origLen: verifyInjected, prevCount: previousCount });
        console.error('[DISPATCH_STEP] sendAttempt=' + sendAttempt + ' clickedSend=' + clickedSend + ' sentConfirmed=' + sentConfirmed);
      }

      if (!sentConfirmed) {
        await captureSupportEvidence(page, projectRoot, tabKey, 'SEND_DISPATCH_FAILED', 'Teksti u shkrua por nuk u dergua pas klikimit te Send dhe Enter.');
        throw new Error('SEND_DISPATCH_FAILED ne [' + tabKey + ']: Mesazhi mbeti ne editor pa u derguar.');
      }

      try {
        return await waitAndExtractCleanResponse(page, targetFrame, tabKey, projectRoot, previousCount);
      } catch (err) {
        if (attempt === 1 && String(err.message).includes('WEB_SERVICE_REFUSAL')) continue;
        throw err;
      }
    }
  });
}

async function selectGoogleSearchAiModel(page, targetKeyword, tabKey) {
  const target = (targetKeyword || 'carbon').toLowerCase();
  const isCarbon = target.includes('carbon') || target.includes('complex');
  const targetLabel = isCarbon ? '4 Carbon · Most complex work' : '4 Hydrogen · Everyday help';

  try {
    const curUrl = page.url() || '';
    if (!isCarbon && curUrl.includes('arv=4')) {
      const cleanUrl = curUrl.replace(/([?&])arv=4&?/g, '$1').replace(/[?&]$/, '');
      await page.goto(cleanUrl, { waitUntil: 'domcontentloaded', timeout: 30000 }).catch(function() {});
      await page.waitForTimeout(1500);
    }

    const res = await page.evaluate(async function(args) {
      const wantCarbon = args.wantCarbon;

      // 1. Kontrollo nese modeli aktiv eshte tashme ai i duhuri
      const allButtons = Array.from(document.querySelectorAll('button, [role="button"], [role="combobox"]'));
      const modelBtn = allButtons.find(function(b) {
        const txt = ((b.innerText || '') + ' ' + (b.getAttribute('aria-label') || '')).toLowerCase();
        return (txt.includes('carbon') || txt.includes('hydrogen') || txt.includes('complex work') || txt.includes('everyday help') || txt.includes('everyday') || txt.includes('auto')) && b.offsetParent !== null;
      });

      if (modelBtn) {
        const curTxt = ((modelBtn.innerText || '') + ' ' + (modelBtn.getAttribute('aria-label') || '')).toLowerCase();
        const matches = wantCarbon 
          ? ((curTxt.includes('carbon') || curTxt.includes('complex')) && !curTxt.includes('hydrogen') && !curTxt.includes('everyday') && !curTxt.includes('auto'))
          : ((curTxt.includes('hydrogen') || curTxt.includes('everyday') || curTxt.includes('auto')) && !curTxt.includes('carbon') && !curTxt.includes('complex'));
        if (matches) {
          return { switched: true, alreadyActive: true, name: modelBtn.innerText || curTxt };
        }
      }

      // 2. Hap menynë me butonin [+] ose me butonin e modelit
      const triggerBtn = modelBtn || document.querySelector('button[aria-label*="Shto skedarë, vegla dhe zgjidh një model" i], button[aria-label*="Add files" i], button.OEueve');
      if (!triggerBtn) return { switched: false, reason: 'Trigger button not found' };

      triggerBtn.click();
      await new Promise(function(r) { setTimeout(r, 600); });

      // 3. Gjej artikullin e duhur te modelit (STRIKTISHT: 4 Hydrogen · Everyday help OSE 4 Carbon · Most complex work)
      const items = Array.from(document.querySelectorAll('[role="menuitemradio"], [role="menuitem"], [role="option"], li, button, div[role="button"]'));
      const chosenItem = items.find(function(it) {
        const txt = ((it.innerText || '') + ' ' + (it.getAttribute('aria-label') || '')).toLowerCase();
        if (wantCarbon) {
          return (txt.includes('carbon') || txt.includes('complex work') || txt.includes('most complex')) && !txt.includes('hydrogen') && !txt.includes('everyday');
        } else {
          return (txt.includes('hydrogen') || txt.includes('everyday help') || txt.includes('everyday') || txt.includes('auto')) && !txt.includes('carbon') && !txt.includes('complex');
        }
      });

      if (chosenItem) {
        chosenItem.click();
        await new Promise(function(r) { setTimeout(r, 500); });
        return { switched: true, alreadyActive: false, name: chosenItem.innerText };
      } else {
        document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true }));
        return { switched: false, reason: 'Target model not found in menu' };
      }
    }, { wantCarbon: isCarbon });

    if (tabKey) {
      tabActiveModel[tabKey] = targetLabel;
      tabDiscoveredModels[tabKey] = '4 Hydrogen · Everyday help, 4 Carbon · Most complex work';
    }

    console.error('[SEARCH_AI_MODEL_SELECT] tabKey=' + tabKey + ' -> ' + targetLabel + ' (sukses=' + res.switched + ', alreadyActive=' + res.alreadyActive + ')');
    return targetLabel;
  } catch (err) {
    if (tabKey) tabActiveModel[tabKey] = targetLabel;
    console.error('[SEARCH_AI_MODEL_SELECT_ERROR] ' + err.message);
    return targetLabel;
  }
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

async function dispatchToGoogleSearchAiTab(opts) {
  const { tabKey, projectRoot, promptText, bundlePath } = opts;
  const cleanRoot = path.resolve(projectRoot);

  return withTabLock(tabKey, async function() {
    activeProjectPerTab[tabKey] = cleanRoot;
    const page = await getOrCreateTab(tabKey);

    // Siguro qe jemi ne Google AI Mode
    const onAiPage = page.url().includes('google.com/search') || page.url().includes('google.com/ai') || page.url().includes('google.com/aimode');
    if (!onAiPage) {
      await page.goto(GOOGLE_SEARCH_AI_URL, { waitUntil: 'domcontentloaded', timeout: 45000 });
      await page.waitForTimeout(5000);
    } else {
      await page.waitForTimeout(2500);
    }

    const isPlannerTask = Boolean(
      opts.isPlanner || 
      promptText.includes('CHIEF_ARCHITECT') || 
      promptText.includes('PLANIFIKUESIT') ||
      promptText.includes('plan.md')
    );

    // Zgjedhja e Modelit Fillestar:
    // Planner-i niset ne 4 Hydrogen (Everyday help) per upload me Python Sandbox
    // Coder dhe Reviewer nisen direkt ne 4 Carbon (Most complex work)
    if (isPlannerTask) {
      await selectGoogleSearchAiModel(page, 'hydrogen', tabKey);
    } else {
      await selectGoogleSearchAiModel(page, 'carbon', tabKey);
    }

    if (await checkAuthExpired(page, tabKey)) {
      await captureSupportEvidence(page, cleanRoot, tabKey, 'AUTH_EXPIRED', 'Kerkon Login ne Google Search AI ne Dashboard (http://127.0.0.1:4321).');
    }

    const boxLoc = page.locator('textarea[placeholder="Ask anything"], textarea.ITIRGe, textarea').first();
    await boxLoc.waitFor({ state: 'visible', timeout: 25000 });

    const exchangeDir = path.join(cleanRoot, '.antigravity', 'bridge', 'exchange');
    const txtBundlePath = path.join(exchangeDir, 'project_bundle.txt');
    const zipBundlePath = path.join(exchangeDir, 'project_bundle.zip');
    if (!fs.existsSync(txtBundlePath) || !fs.existsSync(zipBundlePath)) {
      packWorkspace(cleanRoot, 'FULL');
    }

    const filesToAttach = [];
    let cleanPrompt = promptText;

    if (isPlannerTask) {
      // Ne 4 Hydrogen, bashkangjitim arkivin e pastruar .zip (ose .txt)
      if (fs.existsSync(zipBundlePath)) {
        filesToAttach.push(zipBundlePath);
      } else if (fs.existsSync(txtBundlePath)) {
        filesToAttach.push(txtBundlePath);
      }
    } else {
      if (fs.existsSync(txtBundlePath)) {
        filesToAttach.push(txtBundlePath);
      }
    }

    if (filesToAttach.length > 0) {
      console.error('[SEARCH_AI] Duke bashkangjitur skedarin: ' + filesToAttach.map(f => path.basename(f)).join(', '));
      const plusBtn = page.locator('button[aria-label*="Shto skedarë, vegla dhe zgjidh një model" i], button[aria-label*="Shto skedarë" i], button[aria-label*="Add files" i], button.OEueve').first();
      if (await plusBtn.count() > 0) {
        await plusBtn.click({ force: true }).catch(function() {});
        await page.waitForTimeout(600);
        const fileInput = page.locator('button[aria-label*="Shto skedarë" i] input[type="file"], input[type="file"]').first();
        if (await fileInput.count() > 0) {
          await fileInput.setInputFiles(filesToAttach).catch(function() {});
          await page.waitForTimeout(2500);
        }
      }
    }

    async function sendTurnAndExtract(textToSend, isPhase2, ignoreText, minNeeded) {
      if (!minNeeded) minNeeded = 60;
      console.error('[SEARCH_AI] tabKey=' + tabKey + ' -> Dërgimi i kërkesës (isPhase2=' + isPhase2 + ', length=' + textToSend.length + ')');

      const currentBox = page.locator('textarea[placeholder="Ask anything"], textarea.ITIRGe, textarea').first();
      await currentBox.waitFor({ state: 'visible', timeout: 25000 });
      await currentBox.click({ force: true }).catch(function() {});
      await page.keyboard.press('Control+A');
      await page.keyboard.press('Backspace');
      await page.waitForTimeout(100);

      // Injekto me Clipboard / Ctrl+V
      const pasteSuccess = await page.evaluate(async function(txt) {
        try {
          await navigator.clipboard.writeText(txt);
          return true;
        } catch (_) {
          return false;
        }
      }, textToSend).catch(function() { return false; });

      if (pasteSuccess) {
        await page.keyboard.press('Control+V');
      } else {
        await page.keyboard.insertText(textToSend);
      }

      // MONITORIMI I BUTONIT TE DERGIMIT: PO ISHTE DISABLE NUK KLIKOHET ENTER!
      console.error('[SEARCH_AI] Duke monitoruar butonin e dërgimit...');
      let sendReady = false;
      const sendStart = Date.now();
      while (Date.now() - sendStart < 20000) {
        const btnState = await page.evaluate(function() {
          const btn = document.querySelector('button[aria-label*="Dërgo" i], button[aria-label*="Send" i], button.OEueve, button[aria-label*="Kërko" i]');
          if (!btn) return { found: false, enabled: false };
          const dis = btn.disabled || btn.getAttribute('aria-disabled') === 'true';
          return { found: true, enabled: !dis };
        }).catch(function() { return { found: false, enabled: false }; });

        if (btnState.found && btnState.enabled) {
          sendReady = true;
          break;
        }
        await page.waitForTimeout(300);
      }

      if (!sendReady) {
        console.error('[SEARCH_AI_BUTTON_DISABLED] Butoni i dërgimit mbeti disabled.');
        await captureSupportEvidence(page, cleanRoot, tabKey, 'SUBMIT_BUTTON_DISABLED', 'Butoni i dërgimit mbeti disabled.');
        throw new Error('SUBMIT_BUTTON_DISABLED ne [' + tabKey + ']: Butoni i dërgimit është disabled ose nuk u aktivizua.');
      }

      const clicked = await page.evaluate(function() {
        const btn = document.querySelector('button[aria-label*="Dërgo" i], button[aria-label*="Send" i], button.OEueve, button[aria-label*="Kërko" i]');
        if (btn && !btn.disabled && btn.getAttribute('aria-disabled') !== 'true') {
          btn.click();
          return true;
        }
        return false;
      }).catch(function() { return false; });

      if (!clicked) {
        await page.keyboard.press('Enter');
      }

      // Monitoro gjenerimin
      const startWait = Date.now();
      let stableCount = 0;
      let lastLen = 0;
      let partText = '';

      while (Date.now() - startWait < 150000) {
        await page.waitForTimeout(2000);

        const errorText = await page.evaluate(function() {
          const bodyText = (document.body.innerText || '').toLowerCase();
          const errs = [
            'something went wrong',
            "response wasn't generated",
            "an ai response wasn't generated",
            'diçka shkoi keq',
            'nuk u krijua një përgjigje'
          ];
          for (const e of errs) {
            if (bodyText.includes(e)) return e;
          }
          return null;
        }).catch(function() { return null; });

        if (errorText) {
          if (partText && partText.length > 250) {
            console.error('[SEARCH_AI] Google shfaqi njoftim kufiri ne fund, por teksti u kap me sukses (' + partText.length + ' karaktere).');
            break;
          }
          console.error('[SEARCH_AI_GOOGLE_ERROR] Google AI shfaqi: ' + errorText);
          await captureSupportEvidence(page, cleanRoot, tabKey, 'GOOGLE_AI_SERVICE_ERROR', 'Google shfaqi: ' + errorText);
          throw new Error('GOOGLE_AI_SERVICE_ERROR nga [' + tabKey + ']: ' + errorText);
        }

        const currentExtraction = await page.evaluate(function(args) {
          const minLen = args.minLen;
          const isP2 = args.isP2;
          const ign = args.ign || '';

          // Kontrollo nese ka buton aktiv Stop gjate gjenerimit (Ndalo / Stop)
          const stopSelectors = [
            'button[aria-label*="Ndalo" i]',
            'button[aria-label*="Stop" i]',
            'button[aria-label*="Cancel" i]',
            'button.OEueve[aria-label*="Ndalo" i]'
          ].join(', ');
          const stopBtn = document.querySelector(stopSelectors);
          const isGenerating = Boolean(stopBtn && !stopBtn.disabled && stopBtn.getAttribute('aria-disabled') !== 'true');

          // Lexo nga me e fundit (reverse) per te marre gjithmone pergjigjen me te fresket
          const bzSections = Array.from(document.querySelectorAll('section.bzXtMb')).reverse();
          const fallbackSections = Array.from(document.querySelectorAll('section, div[role="region"], div')).reverse();
          const allSections = bzSections.length > 0 ? bzSections : fallbackSections;

          const markers = [
            'Përgjigjja e "Modalitetit të IA-së" për ',
            'Përgjigjja e Modalitetit të IA-së për ',
            'Përgjigjja e "Modalitetit të IA-së":',
            'Përgjigjja e Modalitetit të IA-së:',
            'AI Mode reply for ',
            'AI Mode response for '
          ];

          for (const sec of allSections) {
            const txt = sec.innerText || '';
            for (const m of markers) {
              const idx = txt.lastIndexOf(m);
              if (idx !== -1) {
                const after = txt.slice(idx + m.length);
                const nl = after.indexOf('\n');
                let ans = nl !== -1 ? after.slice(nl).trim() : after.trim();
                ans = ans
                  .replace(/Kalo te kërkesa e mëparshme[\s\S]*$/i, '')
                  .replace(/Skip to previous prompt[\s\S]*$/i, '')
                  .replace(/Something went wrong, and an AI response wasn't generated\.?[\s\S]*$/i, '')
                  .trim();

                // Nese isP2 eshte true dhe ign eshte dhene, injoro pergjigjen e meparshme
                if (isP2 && ign) {
                  if (ans === ign || (ign.length > 50 && ans.slice(0, 50) === ign.slice(0, 50))) {
                    continue;
                  }
                }

                if (ans.length > minLen) {
                  return {
                    text: ans,
                    len: ans.length,
                    isBusy: isGenerating
                  };
                }
              }
            }
          }

          return { text: '', len: 0, isBusy: isGenerating };
        }, { minLen: minNeeded, isP2: isPhase2, ign: ignoreText });

        if (currentExtraction.len > minNeeded && currentExtraction.len === lastLen) {
          stableCount++;
          // Sapo teksti eshte i stabilizuar per >= 2 kontrolle (4 sekonda) dhe nuk ka buton Stop:
          if (stableCount >= 2 && !currentExtraction.isBusy) {
            partText = currentExtraction.text;
            console.error('[SEARCH_AI] Përgjigja u kap dhe u stabilizua me sukses (' + partText.length + ' karaktere).');
            break;
          }
        } else {
          stableCount = 0;
          lastLen = currentExtraction.len;
          if (currentExtraction.len > minNeeded) partText = currentExtraction.text;
        }
      }

      if (!partText || partText.length < minNeeded) {
        await captureSupportEvidence(page, cleanRoot, tabKey, 'SEARCH_AI_EMPTY_RESPONSE', 'Modeli nuk ktheu përgjigje brenda kohës.');
        throw new Error('SEARCH_AI_EMPTY_RESPONSE nga [' + tabKey + ']: Modeli nuk ktheu përgjigje brenda kohës.');
      }

      return partText;
    }

    function validateFazaCompliance(text, fazaNum) {
      if (!text || text.trim().length < 60) {
        return { ok: false, reason: 'Teksti i kthyer është bosh ose tejet i shkurtër.' };
      }
      const low = text.toLowerCase();
      if (SERVICE_ERROR_PATTERNS.some(function(p) { return low.includes(p); })) {
        return { ok: false, reason: 'Përgjigja përmban gabim ose refuzim shërbimi.' };
      }
      const codeMissingPatterns = [
        'ngarko fizikisht',
        'ngjit përmbajtjen',
        'ngjit permbajtjen',
        'mungon paketa',
        'missing_artifact',
        'source_tree_missing',
        'nuk kam akses te skedarët',
        'nuk kam akses te skedaret'
      ];
      if (codeMissingPatterns.some(function(p) { return low.includes(p); })) {
        return { ok: false, reason: 'Modeli refuzoi analizën duke kërkuar ngarkimin e kodit/specifikimeve.' };
      }

      const hasMarker = text.includes('[FAZA_' + fazaNum + '_PERFUNDOI]') || text.includes('[FAZA_1_PERFUNDOI]') || text.includes('[PLANI_PERFUNDOI_100%]');
      const hasAllowed = low.includes('allowed_files') || low.includes('skedarët e lejuar') || low.includes('skedaret e lejuar');
      const hasObjectiveOrEntry = low.includes('objektivi') || low.includes('entry point') || low.includes('root cause') || low.includes('specifikimi') || low.includes('hapat');

      if (!hasMarker && !hasAllowed && !hasObjectiveOrEntry) {
        return { ok: false, reason: 'Mungon struktura e kërkuar teknike (ALLOWED_FILES, OBJEKTIVAT, ose etiketimi).' };
      }
      return { ok: true, reason: '' };
    }

    if (isPlannerTask) {
      console.error('[SEARCH_AI_PLANNER] Duke zbatuar Protokollin Universal (Smart Arch Map + Handshake + Slices < 70 KB) për: ' + path.basename(cleanRoot));

      // 1. Gjenero Hartën Smart Arkitekturore (< 25 KB)
      const archMap = generateSmartArchitectureMap(cleanRoot);
      console.error('[SEARCH_AI_PLANNER] Harta Arkitekturore e gatshme (' + archMap.length + ' karaktere / ~' + (archMap.length / 1024).toFixed(1) + ' KB)');

      // 2. Zgjidh specifikimet nga userRequest ose skedarët e referuar
      const embeddedSpecs = resolveAndEmbedExternalFiles(opts.userRequest || promptText);
      let rawSpec = embeddedSpecs;
      if (!rawSpec && opts.userRequest) {
        rawSpec = opts.userRequest;
      }
      if (!rawSpec) {
        rawSpec = promptText;
      }

      // 3. Ndaj specifikimet në faza/slices (< 45 KB secila, brenda limitit strikt 70 KB)
      const specSlices = sliceSpecification(rawSpec, 45000);
      const totalFaza = specSlices.length;
      console.error('[SEARCH_AI_PLANNER] Specifikimet u ndanë në ' + totalFaza + ' faza (< 45 KB secila)');

      const maxChatAttempts = 2;

      for (let chatAttempt = 1; chatAttempt <= maxChatAttempts; chatAttempt++) {
        if (chatAttempt > 1) {
          console.error('[SEARCH_AI_PLANNER] [CHAT_RESET] Modeli nuk u bind. Duke hapur CHAT TË RI të pastër (Tentativa ' + chatAttempt + ')...');
          await page.goto(GOOGLE_SEARCH_AI_URL, { waitUntil: 'domcontentloaded', timeout: 45000 }).catch(function() {});
          await page.waitForTimeout(3000);
          await selectGoogleSearchAiModel(page, 'hydrogen', tabKey);

          if (filesToAttach.length > 0) {
            console.error('[SEARCH_AI] Duke ri-bashkangjitur skedarët në bisedën e re...');
            const plusBtn = page.locator('button[aria-label*="Shto skedarë, vegla dhe zgjidh një model" i], button[aria-label*="Shto skedarë" i], button[aria-label*="Add files" i], button.OEueve').first();
            if (await plusBtn.count() > 0) {
              await plusBtn.click({ force: true }).catch(function() {});
              await page.waitForTimeout(600);
              const fileInput = page.locator('button[aria-label*="Shto skedarë" i] input[type="file"], input[type="file"]').first();
              if (await fileInput.count() > 0) {
                await fileInput.setInputFiles(filesToAttach).catch(function() {});
                await page.waitForTimeout(2500);
              }
            }
          }
        }

        // ==================== HAPI 1: PROTOKOLLI HANDSHAKE NË 4 HYDROGEN ====================
        console.error('[SEARCH_AI_PLANNER] [HAPI_1_HANDSHAKE] Dërgimi i kërkesës së shpaketimit në 4 Hydrogen...');
        const handshakePrompt = 
          '=== PROTOKOLLI I INGESTION-IT (4 HYDROGEN - HAPI 1) ===' + NL +
          '[ROLI: KRYEARKITEKT SISTEMESH & PLANIFIKUES TEKNIK I MULTI-AI RELAY]' + NL +
          'Projekti: ' + path.basename(cleanRoot) + NL + NL +
          archMap + NL + NL +
          (filesToAttach.length > 0 ? ('Ke të bashkëngjitur arkivin e pastruar të kodit të projektit (' + filesToAttach.map(f => path.basename(f)).join(', ') + ').' + NL +
          'Përdor mjedisin tënd të brendshëm Python për ta shpaketuar, lexuar pemën e dosjeve dhe indeksuar modulet.' + NL) : '') +
          'Në këtë hap, MOS shkruaj plan, MOS gjenero kod dhe MOS bëj asnjë propozim ndryshimesh.' + NL +
          'Përgjigju TANI VETËM me fjalët ekzakte:' + NL +
          '"OK e lexova, vazhdojmë me hapin e radhës."' + NL +
          '========================================================';

        let handshakeSuccess = false;
        let lastAnswerText = '';

        for (let hLevel = 1; hLevel <= 3; hLevel++) {
          let hPrompt = handshakePrompt;
          if (hLevel === 2) {
            hPrompt = 
              '=== VËREJTJE OPERATIVE DISIPLINORE PËR HANDSHAKE (NIVELI 2) ===' + NL +
              'Përgjigja jote devijoi nga urdhri!' + NL +
              'Shpaketo skedarin me Python dhe përgjigju TANI VETËM me fjalët ekzakte pa asnjë fjalë tjetër:' + NL +
              '"OK e lexova, vazhdojmë me hapin e radhës."';
          } else if (hLevel === 3) {
            hPrompt = 
              '=== URDHËR ULTIMATIV HANDSHAKE (NIVELI 3) ===' + NL +
              'Konfirmo menjëherë leximin e arkitekturës vetëm me fjalët:' + NL +
              'OK e lexova, vazhdojmë me hapin e radhës.';
          }

          try {
            const hRes = await sendTurnAndExtract(hPrompt, false, '', 10);
            lastAnswerText = hRes;
            const lowH = (hRes || '').toLowerCase();
            if (lowH.includes('ok') || lowH.includes('lexova') || lowH.includes('vazhdo') || lowH.includes('hapin e radhës') || lowH.includes('hapin e radhes')) {
              console.error('[SEARCH_AI_PLANNER] [HANDSHAKE_SUKSES] Modeli 4 Hydrogen konfirmoi shpaketimin (' + hRes.trim().slice(0, 80) + ')');
              handshakeSuccess = true;
              break;
            } else {
              console.error('[SEARCH_AI_PLANNER] [HANDSHAKE_VËREJTJE] Përgjigja nuk ishte konfirmim i pastër: ' + hRes.slice(0, 100));
            }
          } catch (hErr) {
            console.error('[SEARCH_AI_PLANNER] [HANDSHAKE_ERROR] ' + hErr.message);
          }
          await page.waitForTimeout(2000);
        }

        if (!handshakeSuccess) {
          console.error('[SEARCH_AI_PLANNER] Handshake dështoi pas 3 niveleve.');
          if (chatAttempt < maxChatAttempts) continue;
          throw new Error('PLANNER_HANDSHAKE_FAILED: Modeli nuk konfirmoi leximin e arkitekturës.');
        }

        // ==================== TRANZICIONI NË 4 CARBON ====================
        console.error('[SEARCH_AI_PLANNER] [TRANZICIONI] Modeli 4 Hydrogen e indeksoi kodin me sukses. Duke kaluar sesionin ne 4 Carbon - Most complex work...');
        await selectGoogleSearchAiModel(page, 'carbon', tabKey);
        await page.waitForTimeout(1000);

        // ==================== HAPI 2..N: FAZAT E SPECIFIKIMIT DHE PLANIFIKIMIT (4 CARBON) ====================
        const phasePlans = [];
        let allPhasesValid = true;

        for (let fIdx = 0; fIdx < totalFaza; fIdx++) {
          const fazaNum = fIdx + 1;
          const sliceText = specSlices[fIdx];
          console.error('[SEARCH_AI_PLANNER] [4_CARBON] Ekzekutimi i Fazës ' + fazaNum + ' nga ' + totalFaza + ' (' + sliceText.length + ' karaktere)...');

          const slicePromptL1 = 
            '=== PROTOKOLLI I PLANIFIKIMIT (4 CARBON - FAZA ' + fazaNum + ' NGA ' + totalFaza + ') ===' + NL +
            '[URDHER OPERATIV NGA ORCHESTRATORI - ZBATO PA ASNJË DEVIJIM]' + NL +
            'Mbi bazën e arkitekturës dhe kodit të shpaketuar që miratove në Handshake, ja pjesa ' + fazaNum + '/' + totalFaza + ' e specifikimeve funksionale:' + NL + NL +
            sliceText + NL + NL +
            'KUFIZIM I DETYRUESHËM ANTI-TIMEOUT (120–180 RRESHTA / MAKSIMUMI 8–10 KB):' + NL +
            'Përgjigja jote për këtë fazë DUHET të jetë STRIKTISHT midis 120 dhe 180 rreshtave tekst/kod (jo më shumë se 8–10 KB).' + NL +
            'Çdo përgjigje mbi 200 rreshta këput lidhjen nga serveri pas 60 sekondash.' + NL +
            'Shkruaj me densitet maksimal teknik direkt pikat e kërkuara, PA asnjë fjalë hyrëse narrative dhe PA përsëritur tekstin e kërkesës:' + NL + NL +
            'UDHËZIM OPERATIV PËR FAZËN ' + fazaNum + ':' + NL +
            'Harto planin e saktë teknik dhe arkitekturor për këtë pjesë pa asnjë placeholder:' + NL +
            '1. OBJEKTIVAT & NON-GOALS: Çfarë zgjidhet dhe çfarë nuk duhet prekur.' + NL +
            '2. ENTRY POINT & ROOT CAUSE: Rruga reale e ekzekutimit, funksionet konkrete dhe shkaku teknik.' + NL +
            '3. ALLOWED_FILES & FORBIDDEN_FILES: Lista strikte e skedarëve (rrugë relative me /).' + NL +
            '4. SPECIFIKIMI SKEDAR MË SKEDAR: Funksionet e reja, kontratat e të dhënave dhe logjika 100% e plotë.' + NL +
            '5. HARDENING & EDGE CASES: Trajtimi i gabimeve, tipizimi, null/empty, IO/rrjeti.' + NL +
            '6. KRITERET E VERIFIKIMIT (DoD MATRIX): Komandat ekzakte të testit/build-it.' + NL + NL +
            'Në fund të përgjigjes shkruaj ekzaktësisht etiketën:' + NL +
            '[FAZA_' + fazaNum + '_PERFUNDOI]' + NL +
            '================================================================';

          let phaseSuccess = false;
          let phaseResText = '';

          for (let pLevel = 1; pLevel <= 3; pLevel++) {
            let pPrompt = slicePromptL1;
            if (pLevel === 2) {
              pPrompt = 
                '=== VËREJTJE OPERATIVE DISIPLINORE PËR FAZËN ' + fazaNum + ' (NIVELI 2) ===' + NL +
                '[URDHER KORRIGJUES - ZERO TOLERANCE]' + NL +
                'Përgjigja jote shkeli strukturën e kërkuar ose tejkaloi limitin e rreshtave për Fazën ' + fazaNum + '!' + NL +
                'KUFIZIM STRIKT: Kthe maksimumi 120–150 rreshta (jo më shumë se 8 KB) pa asnjë fjalë hyrëse!' + NL +
                'Mos kërko ngarkim skedarësh, kodi dhe arkitektura janë tashmë në kontekst.' + NL +
                'Shkruaj TANI VETËM:' + NL +
                '1. OBJEKTIVAT' + NL +
                '2. ENTRY POINT' + NL +
                '3. ALLOWED_FILES (Lista strikte me /)' + NL +
                '4. SPECIFIKIMI SKEDAR MË SKEDAR' + NL +
                '5. HARDENING & EDGE CASES' + NL +
                '6. KRITERET DoD' + NL + NL +
                'Mbyll detyrimisht me: [FAZA_' + fazaNum + '_PERFUNDOI]';
            } else if (pLevel === 3) {
              pPrompt = 
                '=== URDHËR ULTIMATIV PËR FAZËN ' + fazaNum + ' (NIVELI 3) ===' + NL +
                'KUFIZIM: Maksimumi 120 rreshta (max 8 KB).' + NL +
                'Jep menjëherë planin teknik me ALLOWED_FILES, SPECIFIKIMIN SKEDAR MË SKEDAR dhe DoD për Fazën ' + fazaNum + '.' + NL +
                'Vendos etiketën: [FAZA_' + fazaNum + '_PERFUNDOI]';
            }

            try {
              phaseResText = await sendTurnAndExtract(pPrompt, true, lastAnswerText, 80);
              const comp = validateFazaCompliance(phaseResText, fazaNum);
              if (comp.ok) {
                console.error('[SEARCH_AI_PLANNER] [FAZA_' + fazaNum + '_SUKSES] Faza ' + fazaNum + ' u miratua me sukses (' + phaseResText.length + ' karaktere).');
                phaseSuccess = true;
                lastAnswerText = phaseResText;
                break;
              } else {
                console.error('[SEARCH_AI_PLANNER] [FAZA_' + fazaNum + '_REFUZIM] ' + comp.reason);
              }
            } catch (pErr) {
              console.error('[SEARCH_AI_PLANNER] [FAZA_' + fazaNum + '_ERROR] ' + pErr.message);
            }
            await page.waitForTimeout(2000);
          }

          // Failsafe nëse u ndërpre por ka tekst të vlefshëm (>250 karaktere)
          if (!phaseSuccess && phaseResText && phaseResText.length > 250) {
            console.error('[SEARCH_AI_PLANNER] Faza ' + fazaNum + ' u ndërpre por ka tekst të vlefshëm (' + phaseResText.length + ' karaktere). Po pranohet.');
            phaseSuccess = true;
            lastAnswerText = phaseResText;
          }

          if (phaseSuccess) {
            phasePlans.push(phaseResText);
          } else {
            allPhasesValid = false;
            break;
          }
        }

        if (allPhasesValid && phasePlans.length === totalFaza) {
          tabAuthStatus[tabKey] = 'AUTHENTICATED';
          tabActiveModel[tabKey] = '4 Carbon - Most complex work';
          tabDiscoveredModels[tabKey] = '4 Carbon (Most complex work)';

          // Stitching harmonik i të gjitha fazave
          const stitchedSections = [];
          for (let sIdx = 0; sIdx < phasePlans.length; sIdx++) {
            const cleanPlan = phasePlans[sIdx]
              .replace(new RegExp('\\[FAZA_' + (sIdx + 1) + '_PERFUNDOI\\]', 'gi'), '')
              .replace(/\[PLANI_PERFUNDOI_100%\]/gi, '')
              .trim();
            stitchedSections.push('### FAZA ' + (sIdx + 1) + ' / ' + totalFaza + NL + NL + cleanPlan);
          }

          const finalPlan = [
            '# PLANI ARKITEKTUROR DHE SPECIFIKIMI I EKZEKUTIMIT (MULTI-AI RELAY)',
            'Projekti: ' + path.basename(cleanRoot),
            'Data: ' + new Date().toISOString(),
            '',
            '## 1. STRUKTURA DHE KONFIRMIMI I ARKITEKTURËS',
            'Modeli analizoi dhe konfirmoi me sukses hartën arkitekturore të sistemit me Handshake të suksesshëm.',
            '',
            '## 2. PLANIFIKIMI I DETAJUAR I FAZAVE',
            '',
            stitchedSections.join(NL + NL + '---' + NL + NL)
          ].join(NL);

          return finalPlan;
        } else {
          console.error('[SEARCH_AI_PLANNER] Një ose më shumë faza dështuan në këtë sesion bisede.');
          if (chatAttempt < maxChatAttempts) continue;
        }
      }

      throw new Error('PLANNER_ESCALATION_FAILED: Dështoi gjenerimi i planit pas përshkallëzimit me 3 nivele dhe rinisjes së bisedës.');
    } else {
      const singleRes = await sendTurnAndExtract(cleanPrompt, false, '', 40);
      tabAuthStatus[tabKey] = 'AUTHENTICATED';
      tabActiveModel[tabKey] = '4 Carbon - Most complex work';
      tabDiscoveredModels[tabKey] = '4 Carbon (Most complex work)';
      return singleRes;
    }
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

function packWorkspace(projectRoot, mode) {
  if (!mode) mode = 'FULL';
  const routing = ensureProjectSetup(projectRoot);
  const cleanRoot = path.resolve(projectRoot);
  const exchangeDir = path.join(cleanRoot, '.antigravity', 'bridge', 'exchange');
  const txtPath = path.join(exchangeDir, 'project_bundle.txt');
  const zipPath = path.join(exchangeDir, 'project_bundle.zip');
  const zipMdPath = path.join(exchangeDir, 'project_bundle.zip.md');

  const ignoredDirs = new Set([
    '.git', '.svn', 'node_modules', '.antigravity', '.hermes', 'dist', 'build', '.next',
    'venv', '.venv', '__pycache__', 'coverage', '.profiles', '.cache', '.vscode',
    'default', 'crashpad', 'gpucache', 'blob_storage', 'session storage', 'indexeddb',
    'service worker', 'temp', 'tmp'
  ]);
  const ignoredFiles = new Set(['package-lock.json', 'yarn.lock', 'pnpm-lock.yaml', 'bun.lockb']);
  const allowedExts = new Set(['.js', '.mjs', '.cjs', '.ts', '.jsx', '.tsx', '.py', '.json', '.md', '.html', '.css', '.scss', '.sql', '.yaml', '.yml', '.sh', '.ps1', '.cs']);

  let deltaSet = null;
  if (mode === 'DELTA') {
    try {
      const diffOut = execSync('git diff --name-only HEAD', { cwd: cleanRoot, encoding: 'utf8' });
      const files = diffOut.split(/\r?\n/).map(function(s) { return s.trim(); }).filter(Boolean);
      if (files.length > 0) {
        deltaSet = new Set(files.map(function(f) { return path.resolve(cleanRoot, f); }));
      }
    } catch (_) {}
  }

  let output = '=== PROJECT BUNDLE (' + mode + ') | PROJECT: ' + path.basename(cleanRoot) + ' ===' + NL;
  const collectedFiles = [];

  function walk(dir) {
    try {
      const entries = fs.readdirSync(dir, { withFileTypes: true });
      for (const entry of entries) {
        const full = path.join(dir, entry.name);
        const low = entry.name.toLowerCase();
        if (entry.isDirectory()) {
          if (ignoredDirs.has(entry.name) || ignoredDirs.has(low)) continue;
          if (low === 'dock' || low === '_build_archive') continue;
          try {
            if (fs.existsSync(path.join(full, 'Local State')) || fs.existsSync(path.join(full, 'IndexedDB'))) continue;
          } catch (_) {}
          walk(full);
        } else if (entry.isFile()) {
          try {
            if (ignoredFiles.has(entry.name)) continue;
            if (!allowedExts.has(path.extname(entry.name).toLowerCase())) continue;
            const stat = fs.statSync(full);
            if (stat.size > 500 * 1024) continue;
            if (deltaSet && !deltaSet.has(path.resolve(full))) continue;

            const relNormalized = path.relative(cleanRoot, full).replace(/\\/g, '/');
            const content = fs.readFileSync(full, 'utf8');
            output += NL + NL + '=================================================================' + NL +
                      '--- FILE: ' + relNormalized + ' ---' + NL +
                      '=================================================================' + NL +
                      content + NL;
            collectedFiles.push({ relNormalized: relNormalized, content: content });
          } catch (_) {
            continue;
          }
        }
      }
    } catch (_) {}
  }

  walk(cleanRoot);
  fs.writeFileSync(txtPath, output, 'utf8');

  const zip = new AdmZip();
  for (const f of collectedFiles) {
    zip.addFile(f.relNormalized, Buffer.from(f.content, 'utf8'));
  }
  zip.writeZip(zipPath);
  fs.copyFileSync(zipPath, zipMdPath);
  const sha256 = crypto.createHash('sha256').update(fs.readFileSync(zipMdPath)).digest('hex');

  writeProjectState(cleanRoot, { phase: 'PACKED', retryCount: 0, lastStatus: 'BUNDLE_READY' });
  return {
    bundlePath: routing.bundleFormat === 'zip.md' ? zipMdPath : txtPath,
    format: routing.bundleFormat || 'auto',
    fileCount: collectedFiles.length,
    sha256: sha256
  };
}

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

function parseCodeBlocksFromMarkdown(markdown) {
  const results = [];
  const pattern = '(?:###\\s*)?FILE:\\s*([^\\r\\n' + String.fromCharCode(96) + ']+)\\r?\\n+' + FENCE3 + '[a-zA-Z0-9_+-]*\\r?\\n([\\s\\S]*?)' + FENCE3;
  const regex = new RegExp(pattern, 'g');
  let match;
  while ((match = regex.exec(markdown)) !== null) {
    const rawPath = String(match[1] || '').trim().replace(/^['"]|['"]$/g, '').replace(/\\/g, '/').replace(/^\/+/, '');
    const code = String(match[2] || '');
    if (rawPath) results.push({ relPath: rawPath, code: code });
  }
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

function applyAndTestDeterministically(projectRoot) {
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
    fs.writeFileSync(targetAbs, item.code, 'utf8');
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
// ---------------- 25-SECOND NON-BLOCKING AUTOPILOT ENGINE ----------------
const activeCycleJobs = {};
async function runAutonomousPipeline(cleanRoot, userRequest) {
activeCycleJobs[cleanRoot] = { running: true, phase: 'PACKING', startedAt: Date.now(), result: null, error: null };
try {
await executeCoreAction('pack_workspace', { projectRoot: cleanRoot, mode: 'FULL', _internal: true });
activeCycleJobs[cleanRoot].phase = 'PLANNING';
const planRes = await executeCoreAction('run_planner', { projectRoot: cleanRoot, userRequest: userRequest, _internal: true });
if (planRes.status === 'DELEGATE_TO_ANTIGRAVITY') {
activeCycleJobs[cleanRoot] = { running: false, phase: 'DELEGATED', result: planRes, error: null };
return;
}
activeCycleJobs[cleanRoot].phase = 'CODING';
let codeRes = await executeCoreAction('run_coder', { projectRoot: cleanRoot, mode: 'IMPLEMENT', userRequest: userRequest, _internal: true });
if (codeRes.status === 'DELEGATE_TO_ANTIGRAVITY') {
activeCycleJobs[cleanRoot] = { running: false, phase: 'DELEGATED', result: codeRes, error: null };
return;
}
activeCycleJobs[cleanRoot].phase = 'APPLYING_AND_TESTING';
let applyRes = await executeCoreAction('apply_and_test', { projectRoot: cleanRoot, _internal: true });
while (applyRes.status === 'BUILD_OR_TEST_FAILED' && !applyRes.maxRetriesReached) {
activeCycleJobs[cleanRoot].phase = 'AUTO_HEAL_RETRY_' + applyRes.retryCount;
codeRes = await executeCoreAction('run_coder', { projectRoot: cleanRoot, mode: 'FIX_ERROR', userRequest: userRequest, _internal: true });
applyRes = await executeCoreAction('apply_and_test', { projectRoot: cleanRoot, _internal: true });
}
if (applyRes.status !== 'APPLIED_AND_GREEN') {
activeCycleJobs[cleanRoot] = { running: false, phase: 'STOPPED_ON_APPLY', result: applyRes, error: null };
return;
}
activeCycleJobs[cleanRoot].phase = 'REVIEWING';
let revRes = await executeCoreAction('run_reviewer', { projectRoot: cleanRoot, _internal: true });
if (revRes.verdict === 'CHANGES_REQUIRED') {
const exchangeDir = path.join(cleanRoot, '.antigravity', 'bridge', 'exchange');
const revContent = fs.existsSync(path.join(exchangeDir, 'review.md')) ? fs.readFileSync(path.join(exchangeDir, 'review.md'), 'utf8') : '';
const revCheck = validateGeneratedCodeMarkdown(revContent);
if (revCheck.valid) {
fs.writeFileSync(path.join(exchangeDir, 'code.md'), revContent, 'utf8');
applyRes = await executeCoreAction('apply_and_test', { projectRoot: cleanRoot, _internal: true });
revRes = { verdict: 'PASSED (APPLIED_REVIEWER_FIX)', engine: revRes.engine };
} else {
activeCycleJobs[cleanRoot].phase = 'REVIEW_FIX';
codeRes = await executeCoreAction('run_coder', { projectRoot: cleanRoot, mode: 'REVIEW_FIX', userRequest: userRequest, _internal: true });
applyRes = await executeCoreAction('apply_and_test', { projectRoot: cleanRoot, _internal: true });
revRes = await executeCoreAction('run_reviewer', { projectRoot: cleanRoot, _internal: true });
}
}
activeCycleJobs[cleanRoot] = {
running: false,
phase: 'COMPLETED',
result: {
status: 'CYCLE_COMPLETED',
verdict: revRes.verdict || revRes.status || 'PASSED',
plannerModel: planRes.activeModel || planRes.engine,
coderModel: codeRes.activeModel || codeRes.engine,
reviewerEngine: revRes.engine || 'off',
writtenFiles: applyRes.writtenFiles || [],
commandsExecuted: applyRes.commandsExecuted || []
},
error: null
};
} catch (err) {
activeCycleJobs[cleanRoot] = { running: false, phase: 'FAILED', result: null, error: err.message };
}
}

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
elapsedSeconds: job ? Math.round((Date.now() - job.startedAt) / 1000) : 0,
nextRequiredToolCall: 'check_cycle_progress',
instruction: 'Puna po vazhdon normalisht ne sfond. Thirr MENJEHERE mjetin check_cycle_progress(projectRoot) PA ekzekutuar asnje komande terminali!'
};
}
async function executeCoreAction(action, payload) {
const projectRoot = payload.projectRoot;
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
const info = packWorkspace(cleanRoot, payload.mode || 'FULL');
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
const isPlanRefusal = SERVICE_ERROR_PATTERNS.some(function(p) { return lowPlan.includes(p); });
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
const bundle = getBundleAttachmentAndNote(cleanRoot, engine);
let rule = fs.readFileSync(path.join(PLUGIN_ROOT, 'rules', 'coder_rules.md'), 'utf8');
if (engine.startsWith('google_search_') || engine.startsWith('gemini')) {
  rule = rule.replace(/\([^)]*zip[^)]*\)/gi, '(Kodi i plotë i projektit është në formatin .txt (project_bundle.txt) i përfshirë në mesazh).');
}
const planTxt = fs.existsSync(planPath) ? fs.readFileSync(planPath, 'utf8') : '';
const embeddedSpecs = resolveAndEmbedExternalFiles(payload.userRequest);
let extraPrompt = bundle.note + embeddedSpecs + NL + NL + '=== PLANI ARKITEKTUROR (plan.md) ===' + NL + planTxt;
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
const isCodeRefusal = SERVICE_ERROR_PATTERNS.some(function(p) { return lowCode.includes(p); });
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
const approved = response.includes('STATUS: APPROVED') || response.includes('STATUS: PASSED');
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
startDashboardAndSingletonServer();
if (!process.stdin.isTTY) {
const transport = new StdioServerTransport();
mcpServer.connect(transport);
} else {
console.error('[STANDALONE MODE] Shtyp Ctrl+C per ta ndalur.');
}


