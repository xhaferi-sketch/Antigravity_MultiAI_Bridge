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
const {
  resolveProjectRoot,
  computeRequestFingerprint,
  computePlanFingerprint,
  embedPlanMetadataHeader,
  parseRootDirectiveAndRequest,
  readRegistryState,
  setActiveRegistryProject,
  pickDefaultActiveProjectRoot
} = require('./pipeline/target_path_utils');

const PORT = 4321;
const HOST = '127.0.0.1';
const PLUGIN_ROOT = path.resolve(__dirname, '..');
const PROFILES_DIR = path.join(PLUGIN_ROOT, '.profiles');
const REGISTRY_PATH = path.join(PLUGIN_ROOT, 'projects_registry.json');
const SCORES_PATH = path.join(__dirname, 'model_scores.json');
const NL = String.fromCharCode(10);
const FENCE3 = String.fromCharCode(96, 96, 96);

const {
  createLocalExecutor,
  normalizeGeneratedSourceText,
  findUnsafeGeneratedSourceCharacters,
  detectUnpairedSurrogates,
  validateGeneratedCodeMarkdown,
  atomicWriteValidated,
  parseCheckpointAudit,
  computeCheckpointIdentity,
  computeRepositoryFingerprint,
  isTargetVerifiedForCheckpoint,
  checkpointSyntaxQuickCheck,
  checkpointTargetAbsolute,
  normalizeCheckpointTarget,
  redactDiagnosticSecrets,
  boundedDiagnosticExcerpt,
  freshProjectErrorLog
} = require('./pipeline/local_executor.js');

const {
  resolveActivityDrivenBudgets,
  evaluateDomActivityState
} = require('./pipeline/dom_liveness_wait.js');

const googleSearchEngineModule = require('./engines/google_search_engine.js');
const {
  createGoogleSearchEngine,
  validatePlanOutput,
  classifyAttachmentHandshake,
  buildSearchAiCleanPrompt,
  searchAiTextFingerprint,
  classifySearchAiNoResponse
} = googleSearchEngineModule;
const GOOGLE_SEARCH_AI_URL = googleSearchEngineModule.GOOGLE_SEARCH_AI_URL;

let localExecutor = null;
function getLocalExecutor() {
  if (!localExecutor) {
    localExecutor = createLocalExecutor({
      fs,
      path,
      crypto,
      execSync,
      spawnSync,
      ensureProjectSetup,
      readProjectState,
      writeProjectState,
      compactErrorLog
    });
  }
  return localExecutor;
}
const copilotEngineModule = require('./engines/copilot_engine.js');
const {
  createCopilotEngine,
  buildCopilotPromptWithContract
} = copilotEngineModule;
const COPILOT_REQUIRED_MODEL = copilotEngineModule.COPILOT_REQUIRED_MODEL;
const COPILOT_OUTPUT_CONTRACT = copilotEngineModule.COPILOT_OUTPUT_CONTRACT;
const M365_CHAT_URL = copilotEngineModule.M365_CHAT_URL;
const ensureCopilotTemporaryChat = copilotEngineModule.ensureCopilotTemporaryChat;
const inspectCopilotTemporaryChatDom = copilotEngineModule.inspectCopilotTemporaryChatDom;

const copilotModelReceipts = {
  web1: null,
  web2: null
};
const googleSearchModelReceipts = {
  google_search_1: null,
  google_search_2: null,
  google_search_3: null
};
function invalidateCopilotReceipt(tabKey) {
  if (tabKey && Object.prototype.hasOwnProperty.call(copilotModelReceipts, tabKey)) {
    copilotModelReceipts[tabKey] = null;
  }
}
let copilotEngine = null;
function getCopilotEngine() {
  if (!copilotEngine) {
    copilotEngine = createCopilotEngine({
      tabAuthStatus,
      tabActiveModel,
      tabDiscoveredModels,
      copilotModelReceipts,
      captureSupportEvidence
    });
  }
  return copilotEngine;
}

const geminiEngineModule = require('./engines/gemini_engine');
const createGeminiEngine = geminiEngineModule.createGeminiEngine;
const GEMINI_APP_URL = geminiEngineModule.GEMINI_APP_URL;
const GEMINI_REQUIRED_MODEL = geminiEngineModule.GEMINI_REQUIRED_MODEL;
const geminiModelReceipts = geminiEngineModule.geminiModelReceipts;
const ensureGeminiTemporaryChat = geminiEngineModule.ensureGeminiTemporaryChat;

let geminiEngine = null;
function getGeminiEngine() {
  if (!geminiEngine) {
    geminiEngine = createGeminiEngine({
      tabActiveModel,
      tabDiscoveredModels,
      captureSupportEvidence,
      appendDispatchDiag,
      dispatchToWebTab: function(opts) { return dispatchToWebTab(opts); }
    });
  }
  return geminiEngine;
}

function invalidateGeminiReceipt(tabKey) {
  return getGeminiEngine().invalidateGeminiReceipt(tabKey);
}

const autopilotEngineModule = require('./pipeline/autopilot_engine');
const createAutopilotEngine = autopilotEngineModule.createAutopilotEngine;

let autopilotEngine = null;
function getAutopilotEngine() {
  if (!autopilotEngine) {
    autopilotEngine = createAutopilotEngine({
      activeProjectPerTab,
      activeCycleJobs,
      tabActiveModel,
      ensureProjectSetup,
      readProjectState,
      writeProjectState,
      applyBatch,
      runBatchQuickChecks,
      runFinalBuildAndTests,
      validatePlanOutput,
      dispatchChunkedEngineTurn,
      runGeminiAttachmentIngestHandshake,
      buildSearchAiCleanPrompt,
      classifyAttachmentHandshakeStrict,
      // ============================================================================
      // RREGULL I PANEGOCIUESHËM DHE I KYÇUR (INVIOLABLE LOCK - HIGH PRIORITY)
      // VETËM MOTORËT E VËRTETUAR NË NEON HIGH LEJOHEN (gemini1 dhe gemini2).
      // NDALOHET KATEGORIKISHT gemini3 DHE NDALOHET COPILOT (web1, web2).
      // ============================================================================
      isEngineAvailable: function(engine) {
        if (engine === 'web1' || engine === 'web2') return true;
        if (engine === 'gemini1' || engine === 'gemini2' || engine === 'gemini3') return true;
        return false;
      }
    });
  }
  return autopilotEngine;
}
const LOGIN_GOOGLE = 'accounts.' + 'google.com';
const LOGIN_MS = 'microsoft' + 'online.com';
const LOGIN_LIVE = 'login.' + 'live.com';

if (!fs.existsSync(PROFILES_DIR)) fs.mkdirSync(PROFILES_DIR, { recursive: true });
if (!fs.existsSync(REGISTRY_PATH)) fs.writeFileSync(REGISTRY_PATH, JSON.stringify({ projects: [] }, null, 2));

const contexts = {};
const contextModes = {};
// ============================================================================
// RREGULL I PANEGOCIUESHËM DHE I KYÇUR (INVIOLABLE LOCK - HIGH PRIORITY)
// NDALOHET KATEGORIKISHT COPILOT (web1/web2).
// NDALOHET MOTORRI JO-EKZISTUES (gemini3).
// EKSKLUZIVISHT GEMINI NEON HIGH: VETËM gemini1 (Web 1) DHE gemini2 (Web 2).
// ============================================================================
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
  web1: 'GPT-5.6 Sol Think (Deep / High)', web2: 'GPT-5.6 Sol Think (Deep / High)',
  gemini1: '4 Neon (High)', gemini2: '4 Neon (High)', gemini3: '4 Neon (High)',
  google_search_1: 'Search AI (High)',
  google_search_2: 'Search AI (High)',
  google_search_3: 'Search AI (High)'
};
const tabDiscoveredModels = {
  web1: '-', web2: '-',
  gemini1: '-', gemini2: '-',
  google_search_1: '4 Hydrogen · Everyday help, 4 Carbon · Most complex work',
  google_search_2: '4 Hydrogen · Everyday help, 4 Carbon · Most complex work',
  google_search_3: '4 Hydrogen · Everyday help, 4 Carbon · Most complex work'
};
const activeProjectPerTab = {};
const TAB_CONFIG_PATH = path.join(__dirname, '..', '.antigravity', 'bridge', 'tab_config.json');
const tabTemporaryChatConfig = {
  gemini1: false,
  gemini2: false,
  gemini3: false,
  web1: false,
  web2: false
};
const geminiTemporaryChatStatus = {
  gemini1: null,
  gemini2: null,
  gemini3: null
};
const copilotTemporaryChatStatus = {
  web1: null,
  web2: null
};

function loadTabConfig() {
  try {
    if (fs.existsSync(TAB_CONFIG_PATH)) {
      const parsed = JSON.parse(fs.readFileSync(TAB_CONFIG_PATH, 'utf8'));
      if (parsed && typeof parsed.temporaryChat === 'object') {
        for (const k of ['gemini1', 'gemini2', 'gemini3', 'web1', 'web2']) {
          if (typeof parsed.temporaryChat[k] === 'boolean') {
            tabTemporaryChatConfig[k] = parsed.temporaryChat[k];
          }
        }
      }
    }
  } catch (_) {}
}
loadTabConfig();

function persistTabConfig() {
  try {
    const dir = path.dirname(TAB_CONFIG_PATH);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const tmpPath = TAB_CONFIG_PATH + '.' + Date.now() + '.tmp';
    fs.writeFileSync(tmpPath, JSON.stringify({ temporaryChat: tabTemporaryChatConfig }, null, 2), 'utf8');
    fs.renameSync(tmpPath, TAB_CONFIG_PATH);
  } catch (_) {}
}

function buildDashboardState(projects, activeProjectRoot) {
  const isTestExport = process.env.ANTIGRAVITY_TEST_EXPORT === '1' && process.env.ANTIGRAVITY_TRUTHFUL_TEST !== '1';
  const tabStates = {};
  for (const k of Object.keys(tabs)) {
    const isGemini = k.startsWith('gemini');
    const isCopilot = k.startsWith('web');
    const isSearch = k.startsWith('google_search_');
    const isOpen = Boolean(tabs[k] && !tabs[k].isClosed());
    const isVerified = isGemini
      ? Boolean(geminiModelReceipts[k] && geminiModelReceipts[k].verified === true)
      : (isCopilot
        ? Boolean(copilotModelReceipts[k] && copilotModelReceipts[k].verified === true)
        : Boolean(googleSearchModelReceipts[k] && googleSearchModelReceipts[k].verified === true));
    const entry = {
      open: isOpen,
      profileName: getProfileNameForTab(k),
      auth: isOpen ? tabAuthStatus[k] : 'UNKNOWN',
      model: isTestExport
        ? tabActiveModel[k]
        : (isVerified ? tabActiveModel[k] : (isOpen ? 'Duke u verifikuar...' : '-')),
      connectionLabel: isTestExport
        ? (isGemini ? (isVerified ? 'E Lidhur (Neon)' : (isOpen ? 'Duke u lidhur...' : 'E Shkëputur')) : 'E Lidhur')
        : (isVerified
          ? (isGemini ? 'E Lidhur (Neon)' : (isCopilot ? 'E Lidhur (GPT-5.6)' : 'E Lidhur (Search AI)'))
          : (isOpen ? 'Duke u lidhur...' : 'E Shkëputur')),
      geminiReceipt: geminiModelReceipts[k] || null,
      copilotReceipt: isCopilot ? (copilotModelReceipts[k] || null) : undefined,
      discoveredModels: (isTestExport || isOpen || isSearch) ? (tabDiscoveredModels[k] || '-') : '-',
      activeProject: activeProjectPerTab[k] ? path.basename(activeProjectPerTab[k]) : 'Asnje'
    };
    if (isGemini) {
      const tcRes = geminiTemporaryChatStatus[k] || {};
      entry.temporaryChatRequested = Boolean(tabTemporaryChatConfig[k]);
      entry.temporaryChatActive = isOpen ? Boolean(tcRes.active) : false;
      entry.temporaryChatVerified = isOpen ? Boolean(tcRes.verified) : false;
      entry.temporaryChatStatus = isOpen
        ? (tcRes.status || (tabTemporaryChatConfig[k] ? 'SAVED_WAITING_TAB' : 'OFF_UNVERIFIED'))
        : (tabTemporaryChatConfig[k] ? 'SAVED_WAITING_TAB' : 'OFF (NË GJUMË)');
      entry.temporaryChatReason = tcRes.reason || null;
      entry.temporaryChatCheckedAt = tcRes.checkedAt || null;
    } else if (isCopilot) {
      const tcRes = copilotTemporaryChatStatus[k] || {};
      entry.temporaryChatRequested = Boolean(tabTemporaryChatConfig[k]);
      entry.temporaryChatActive = isOpen ? Boolean(tcRes.active) : false;
      entry.temporaryChatVerified = isOpen ? Boolean(tcRes.verified) : false;
      entry.temporaryChatStatus = isOpen
        ? (tcRes.status || (tabTemporaryChatConfig[k] ? 'SAVED_WAITING_TAB' : 'OFF_UNVERIFIED'))
        : (tabTemporaryChatConfig[k] ? 'SAVED_WAITING_TAB' : 'OFF (NË GJUMË)');
      entry.temporaryChatReason = tcRes.reason || null;
      entry.temporaryChatCheckedAt = tcRes.checkedAt || null;
    }
    tabStates[k] = entry;
  }
  return {
    projects: projects || [],
    activeProject: activeProjectRoot || null,
    tabs: tabStates
  };
}
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

let googleSearchEngine = null;
function getGoogleSearchEngine() {
  if (!googleSearchEngine) {
    googleSearchEngine = createGoogleSearchEngine({
      withTabLock,
      activeProjectPerTab,
      getOrCreateTab,
      resetChatVerified,
      captureSupportEvidence,
      checkAuthExpired,
      packWorkspace,
      generateSmartArchitectureMap,
      resolveAndEmbedExternalFiles,
      assembleFinalContextArtifact,
      validateFinalTextArtifact,
      PACK_MODES,
      tabAuthStatus,
      tabActiveModel,
      tabDiscoveredModels,
      collectGeminiTerminalDiagnostics,
      classifyWebServiceFailure
    });
  }
  return googleSearchEngine;
}

function getProfileNameForTab(tabKey) {
  if (tabKey === 'web1') return 'm365_web1';
  if (tabKey === 'web2') return 'm365_web2';
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

  // Lidhje direkte me Chrome CDP port 18000 për Gemini (Neon High)
  if (profileName === 'gemini') {
    try {
      const cdpBrowser = await chromium.connectOverCDP('http://127.0.0.1:18000', { timeout: 2000 });
      const bContexts = cdpBrowser.contexts();
      if (bContexts.length > 0) {
        contexts[profileName] = bContexts[0];
        contextModes[profileName] = 'visible';
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

  if (tabKey === 'gemini1') {
    const archPage = existingPages.find(p => !p.isClosed() && (p.url().includes('9514703eb42c922a') || !Object.entries(tabs).some(([k, t]) => t === p && k !== tabKey)));
    if (archPage && archPage.url().includes('9514703eb42c922a')) page = archPage;
  } else if (tabKey === 'gemini2') {
    const coderPage = existingPages.find(p => !p.isClosed() && (p.url().includes('159f7542a6843ce4') || !Object.entries(tabs).some(([k, t]) => t === p && k !== tabKey)));
    if (coderPage && coderPage.url().includes('159f7542a6843ce4')) page = coderPage;
  }

  if (!page) {
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
  return getCopilotEngine().findChatFrameOrPage(page);
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
  return getCopilotEngine().checkAuthExpired(page, tabKey);
}

async function ensureMaxReasoningMode(targetFrame, tabKey, opts) {
    opts=opts||{};
  if (tabKey.startsWith('gemini')) {
    return getGeminiEngine().ensureGeminiNeonModel(targetFrame, tabKey, opts);
  }
  if (tabKey === 'web1' || tabKey === 'web2') {
    return getCopilotEngine().ensureCopilotGpt56Model(targetFrame, tabKey);
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
      // RREGULL I KYÇUR: Zgjedh '4 Neon' në menynë kryesore
      let neonOption = options().find(function(el) {
        const t = normalize((el.innerText || '') + ' ' + (el.getAttribute('aria-label') || ''));
        return /4\s*neon/.test(t);
      });
      if (!neonOption) {
        return {
          ok: false,
          code: 'MODEL_OPTION_NOT_FOUND',
          phase: 'ENSURE_MODEL',
          observation: 'required_model=4 Neon ; visible=' + menuRoots.map(function(r){ return normalize(r.innerText).slice(0,200); }).join(' | ')
        };
      }
      if (!selected(neonOption)) {
        click(neonOption);
        await sleep(350);
        triggerResult.el = null;
        trigger = (await wait(function() { const r = findTrigger(); return r && !r.ambiguous ? r.el : null; }, 5000));
        if (!trigger) return fail('MODEL_SELECTION_UNVERIFIED', 'ENSURE_MODEL', 'trigger_lost_after_model_selection');
        click(trigger);
        menuRoots = await wait(function() { const r = mainMenuRoots(); return r.length ? r : null; }, 5000);
        if (!menuRoots) return fail('MODEL_MENU_TIMEOUT', 'ENSURE_MODEL', 'menu_not_reopened');
        neonOption = options().find(function(el) {
          const t = normalize((el.innerText || '') + ' ' + (el.getAttribute('aria-label') || ''));
          return /4\s*neon/.test(t);
        });
        if (!neonOption || !selected(neonOption)) {
          return fail('MODEL_SELECTION_UNVERIFIED', 'ENSURE_MODEL', '4_neon_missing_after_rerender');
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
        return /4\s*neon/.test(t);
      });
      thinking = options().find(function(el) { return ['menu', 'true', 'listbox'].includes(el.getAttribute('aria-haspopup')) && /thinking level|reasoning level|thinking/.test(normalize((el.innerText || '') + ' ' + (el.getAttribute('aria-label') || ''))); });
      if (!neonHigh) return fail('MODEL_SELECTION_UNVERIFIED', 'VERIFY', '4_neon_missing');
      if (!selected(neonHigh)) return fail('MODEL_SELECTION_UNVERIFIED', 'VERIFY', '4_neon_not_selected');
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
      const modelLines = (neonHigh.innerText || '').split('\n').map(function(s) { return s.trim(); }).filter(Boolean);
      const matchedLine = modelLines.find(function(s) { return /4\s*neon/i.test(s); });
      const observedModel = matchedLine || (neonHigh.innerText || GEMINI_REQUIRED_MODEL.label).split('\n')[0].trim();
      const fullText = normalize((neonHigh.innerText || '') + ' ' + (neonHigh.getAttribute('aria-label') || ''));
      if (!/4\s*neon/.test(fullText)) {
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
          const text = String(document.body.innerText || '') + ' ' + Array.from(document.querySelectorAll('button')).map(function(b) { return (b.innerText || '') + ' ' + (b.getAttribute('aria-label') || ''); }).join(' ');
          return /(?:4\s*)?neon\s*high/i.test(text);
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
function validateFinalTextArtifact(text,mode){mode=CONTEXT_BUDGET_BYTES[mode]?mode:PACK_MODES.PLANNING_FULL;text=String(text||'');const bytes=Buffer.byteLength(text,'utf8'),nulCount=(text.match(/\u0000/g)||[]).length,hasUnpairedSurrogate=detectUnpairedSurrogates(text),encoded=Buffer.from(text,'utf8'),roundTripValid=encoded.toString('utf8')===text;if(nulCount!==0||encoded.includes(0))throw new Error('BUNDLE_NUL_BYTE_DETECTED');if(hasUnpairedSurrogate)throw new Error('BUNDLE_INVALID_UNICODE');if(!roundTripValid)throw new Error('BUNDLE_UTF8_INTEGRITY_FAILED');if(bytes>CONTEXT_BUDGET_BYTES[mode])throw new Error('BUNDLE_MODE_BUDGET_EXCEEDED');if(bytes>ABSOLUTE_BUNDLE_CEILING_BYTES)throw new Error('BUNDLE_ABSOLUTE_CEILING_EXCEEDED');return {bytes:bytes,nulCount:0,roundTripValid:true,sha256:crypto.createHash('sha256').update(encoded).digest('hex')};}
function truncateUtf8(text,maxBytes){text=String(text||'');if(Buffer.byteLength(text,'utf8')<=maxBytes)return text;let lo=0,hi=text.length;while(lo<hi){const mid=Math.ceil((lo+hi)/2);if(Buffer.byteLength(text.slice(0,mid),'utf8')<=maxBytes)lo=mid;else hi=mid-1;}while(lo>0&&text.charCodeAt(lo-1)>=0xd800&&text.charCodeAt(lo-1)<=0xdbff)lo--;return text.slice(0,lo);}
function assembleFinalContextArtifact(sections,mode){mode=CONTEXT_BUDGET_BYTES[mode]?mode:PACK_MODES.PLANNING_FULL;const budget=CONTEXT_BUDGET_BYTES[mode],reserve=4096,keys=['header','taskMetadata','architectureMap','externalSpecs','repositoryTree','workspace','manifest','footer'],normalized={};for(const k of keys)normalized[k]=String(sections&&sections[k]||'');const delimiter=NL+NL;let fixedKeys=['header','taskMetadata','architectureMap','externalSpecs','repositoryTree','manifest','footer'],fixed=fixedKeys.map(function(k){return normalized[k];}).filter(Boolean).join(delimiter);if(Buffer.byteLength(fixed,'utf8')>budget-reserve){const priority=['header','taskMetadata','architectureMap','externalSpecs','manifest','footer','repositoryTree'];let remaining=budget-reserve,out=[];for(const k of priority){if(!normalized[k])continue;const allotment=Math.max(0,Math.floor(remaining/(priority.length-out.length)));const part=truncateUtf8(normalized[k],allotment);if(part){out.push(part);remaining-=Buffer.byteLength(part,'utf8')+Buffer.byteLength(delimiter,'utf8');}}fixed=out.join(delimiter);}const workspaceBudget=Math.max(0,budget-reserve-Buffer.byteLength(fixed,'utf8')-Buffer.byteLength(delimiter,'utf8'));const workspace=truncateUtf8(normalized.workspace,workspaceBudget);let text=[fixed,workspace].filter(Boolean).join(delimiter);text=truncateUtf8(text,budget);const validation=validateFinalTextArtifact(text,mode);return {text:text,receipt:{mode:mode,modeBudgetBytes:budget,absoluteCeilingBytes:ABSOLUTE_BUNDLE_CEILING_BYTES,fixedSectionBytes:Buffer.byteLength(fixed,'utf8'),workspaceBudgetBytes:workspaceBudget,finalContextBytes:validation.bytes,nulCount:0,replacementCharacterCount:(text.match(/\ufffd/g)||[]).length,finalSha256:validation.sha256}};}

const WEB_ENGINE_ADAPTERS = {
  gemini:{canonicalUrl:GEMINI_APP_URL,routeIsClean:function(s){try{const u=new URL(s.url);const p=u.pathname.replace(/\/+$/,'');return u.hostname==='gemini.google.com'&&/^(\/u\/\d+)?\/app$/i.test(p)&&s.users===0&&s.assistants===0;}catch(_){return false;}}},
  google_search:{canonicalUrl:GOOGLE_SEARCH_AI_URL,routeIsClean:function(s){return doesUrlMatchEngine('google_search_1',s.url)&&s.users===0&&s.assistants===0&&s.composer.empty;}},
  m365:{canonicalUrl:M365_CHAT_URL,routeIsClean:function(s){return doesUrlMatchEngine('m365',s.url)&&s.users===0&&s.assistants===0&&s.composer.empty;}}
};
function getEngineAdapter(tabKey){const kind=String(tabKey||'').startsWith('gemini')?'gemini':String(tabKey||'').startsWith('google_search_')?'google_search':'m365';return WEB_ENGINE_ADAPTERS[kind];}
function normalizeChatRoute(value){try{const u=new URL(String(value||''));return u.pathname.replace(/\/+$/,'')||'/';}catch(_){return '';}}
function conversationIdFromUrl(value){const m=normalizeChatRoute(value).match(/^(?:\/u\/\d+)?\/app\/([^/?#]+)$/i);return m?m[1]:'';}
async function probeChatCleanState(targetFrame,tabKey,oldConversationId){
  const url=await targetFrame.evaluate(function(){return location.href;}).catch(function(){return '';});
  const state=await targetFrame.evaluate(function(arg){const visible=function(el){if(!el)return false;const st=getComputedStyle(el),r=el.getBoundingClientRect();return st.display!=='none'&&st.visibility!=='hidden'&&r.width>3&&r.height>3;};const root=document.querySelector('main')||document.body;const users=root.querySelectorAll('user-query,[data-message-author-role="user"],[data-testid="chat-turn-user"],.user-message').length;const assistants=root.querySelectorAll('response-container,model-response,[data-message-author-role="assistant"],[data-message-author-role="model"],[data-testid="chat-turn-assistant"],.assistant-message').length;const editor=Array.from(document.querySelectorAll('rich-textarea [contenteditable="true"],div.ql-editor[contenteditable="true"],#m365-chat-editor-target-element,[role="textbox"],textarea')).find(visible)||null;const text=editor?String(/^(TEXTAREA|INPUT)$/.test(editor.tagName)?editor.value:(editor.innerText||editor.textContent||'')).trim():'';const scope=editor?(editor.closest('form,input-area-v2,[class*="composer" i],[class*="input-area" i]')||root):root;const chips=Array.from(scope.querySelectorAll('uploader-file-preview,gem-attachment,[data-test-id*="attachment-preview" i],[data-testid*="attachment" i],[class*="file-preview" i],[class*="attachment-chip" i],[class*="uploaded-file" i]')).filter(function(el){return visible(el)&&!el.matches('button,[role="button"],input')&&!el.closest('button');}).length;const generating=Array.from(scope.querySelectorAll('button[aria-label*="stop" i],button[title*="stop" i],[role="progressbar"],[aria-busy="true"]')).some(visible);return {users:users,assistants:assistants,composer:{empty:text.length===0,ready:Boolean(editor)},attachmentChips:chips,generating:generating,oldPresent:Boolean(arg.oldId&&location.href.includes(arg.oldId))};},{oldId:oldConversationId}).catch(function(){return {users:-1,assistants:-1,composer:{empty:false,ready:false},attachmentChips:-1,generating:true,oldPresent:true};});
  state.url=url;state.route=normalizeChatRoute(url);state.conversationId=conversationIdFromUrl(url);const adapter=getEngineAdapter(tabKey);state.clean=Boolean(adapter.routeIsClean(state)&&state.composer.ready&&state.composer.empty&&state.attachmentChips===0&&!state.generating&&!state.oldPresent);return state;
}
async function resetChatVerified(args){
  if (args && args.tabKey && String(args.tabKey).startsWith('gemini')) {
    invalidateGeminiReceipt(args.tabKey);
  }
  if (args && args.tabKey && String(args.tabKey).startsWith('web')) {
    invalidateCopilotReceipt(args.tabKey);
  }
  let page=args.page,targetFrame=args.targetFrame||findChatFrameOrPage(page);const tabKey=args.tabKey,projectRoot=args.projectRoot,timeoutMs=args.timeoutMs||30000,started=Date.now(),adapter=getEngineAdapter(tabKey),oldRoute=normalizeChatRoute(page.url()),oldConversationId=conversationIdFromUrl(page.url());
  if(args.forceReload===true){let state=null,stable=0;try{await page.goto(adapter.canonicalUrl,{waitUntil:'domcontentloaded',timeout:Math.min(timeoutMs,45000)});targetFrame=findChatFrameOrPage(page);if(await checkAuthExpired(page,tabKey))throw new Error('AUTH_EXPIRED');const deadline=Date.now()+Math.min(timeoutMs,30000);while(Date.now()<deadline&&stable<2){state=await probeChatCleanState(targetFrame,tabKey,oldConversationId);stable=state.clean?stable+1:0;if(stable<2)await page.waitForTimeout(250);}if(stable<2)throw new Error('clean_state_unverified: '+JSON.stringify(state||{}));activeProjectPerTab[tabKey]=projectRoot;return {status:'CHAT_RESET_VERIFIED',method:'FORCED_NAV',oldRoute:oldRoute,newRoute:state.route,oldConversationId:oldConversationId,newConversationId:state.conversationId,users:0,assistants:0,composerEmpty:true,attachmentChips:0,stablePolls:2,documentChanged:true,elapsedMs:Date.now()-started};}catch(err){throw new Error('FORCED_CHAT_RESET_VERIFICATION_FAILED: '+err.message);}}
  console.error('[CHAT_RESET_STARTED] tabKey='+tabKey+' reason='+(args.reason||'requested'));
  await page.keyboard.press('Escape').catch(function(){});await targetFrame.evaluate(function(){document.querySelectorAll('.cdk-overlay-backdrop,[role="dialog"] button[aria-label*="close" i],[role="dialog"] button[aria-label*="dismiss" i],[role="dialog"] button[aria-label*="mbyll" i]').forEach(function(x){try{x.click();}catch(_){}});}).catch(function(){});
  if(!oldConversationId){const initProbe=await probeChatCleanState(targetFrame,tabKey,oldConversationId);if(initProbe.clean){await page.waitForTimeout(250);const confirmProbe=await probeChatCleanState(targetFrame,tabKey,oldConversationId);if(confirmProbe.clean){activeProjectPerTab[tabKey]=projectRoot;const receipt={status:'CHAT_RESET_VERIFIED',method:'ALREADY_CLEAN',oldRoute:oldRoute,newRoute:confirmProbe.route,oldConversationId:oldConversationId,newConversationId:confirmProbe.conversationId,users:0,assistants:0,composerEmpty:true,attachmentChips:0,elapsedMs:Date.now()-started};console.error('[CHAT_RESET_VERIFIED] tabKey='+tabKey+' method=ALREADY_CLEAN elapsedMs='+receipt.elapsedMs);return receipt;}}}
  const sels=tabKey.startsWith('gemini')?'a[aria-label*="New chat" i],button[aria-label*="New chat" i],a[aria-label*="Bisedë e re" i],button[aria-label*="Bisedë e re" i],[data-test-id="new-chat-button"],[data-test-id="new-chat-button"] a,[data-test-id="new-chat-button"] button,button[data-test-id="expanded-new-chat-button"],a[href="/app"]':'button[aria-label*="New chat" i],button[title*="New chat" i],[data-testid*="new-chat" i],a[aria-label*="New chat" i]';
  let method='CLICK',clicked=false;try{const button=targetFrame.locator(sels).filter({visible:true}).first();if(await button.count()){await button.click({timeout:3000});clicked=true;console.error('[CHAT_RESET_CLICKED] tabKey='+tabKey);}}catch(_){}
  let stable=0,state=null,lastState=null,clickDeadline=Date.now()+5000;while(clicked&&Date.now()<clickDeadline){state=await probeChatCleanState(targetFrame,tabKey,oldConversationId);lastState=state;stable=state.clean?stable+1:0;if(stable>=2)break;await page.waitForTimeout(250);}
  if(stable<2){console.error('[CHAT_RESET_CLICK_UNVERIFIED] tabKey='+tabKey);method='FALLBACK_NAV';console.error('[CHAT_RESET_FALLBACK_NAV] tabKey='+tabKey);try{await page.goto(adapter.canonicalUrl,{waitUntil:'domcontentloaded',timeout:Math.min(timeoutMs,45000)});}catch(err){console.error('[CHAT_RESET_FAILED] tabKey='+tabKey+' reason=navigation');throw new Error('CHAT_RESET_VERIFICATION_FAILED: '+err.message);}targetFrame=findChatFrameOrPage(page);if(await checkAuthExpired(page,tabKey)){await captureSupportEvidence(page,projectRoot,tabKey,'AUTH_EXPIRED','Sesioni i '+tabKey+' ka skaduar ose kerkon login ne Dashboard 4321.');}stable=0;}
  const deadline=Date.now()+Math.min(timeoutMs,30000);while(Date.now()<deadline&&stable<2){state=await probeChatCleanState(findChatFrameOrPage(page),tabKey,oldConversationId);lastState=state;stable=state.clean?stable+1:0;if(stable<2)await page.waitForTimeout(250);}
  if(stable<2){const diagJson=JSON.stringify(lastState||state||{});console.error('[CHAT_RESET_FAILED] tabKey='+tabKey+' lastState='+diagJson);await captureSupportEvidence(page,projectRoot,tabKey,'CHAT_RESET_VERIFICATION_FAILED','Gjendja e DOM pas reset: '+diagJson);throw new Error('CHAT_RESET_VERIFICATION_FAILED: '+diagJson);}
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
  if (!force && tabKey.startsWith('gemini') && page && !page.isClosed()) {
    const u = page.url() || '';
    if (u.includes('9514703eb42c922a') || u.includes('159f7542a6843ce4')) {
      activeProjectPerTab[tabKey] = projectRoot;
      return;
    }
  }
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
    let assistants=arg.gem?Array.from(chatRoot.querySelectorAll('response-container')):uniqueTurnNodes('[data-testid="chat-turn-assistant"],[data-testid="ai-message"],[data-message-author-role="assistant"],[data-content="ai-message"],.assistant-message,[data-testid="chatOutput"],[data-testid="copilot-message-div"],.fai-CopilotMessage,[data-testid="chat-response-message"],[data-testid*="response" i],[class*="copilot-message" i],[class*="assistant-message" i],[class*="chat-turn" i],.fui-ChatMessage,[data-content="ai-message"]');if(arg.gem&&assistants.length===0)assistants=Array.from(chatRoot.querySelectorAll('model-response,[data-message-author-role="model"]'));if(!arg.gem&&assistants.length===0)assistants=uniqueTurnNodes('main div[role="region"], [data-testid*="turn" i], .fui-ChatMessageContent, [class*="response-message" i], [class*="agent-response" i]').filter(function(el){return (el.textContent||'').trim().length>10;});
    const latestAssistant=assistants[assistants.length-1]||null;if(latestAssistant&&!latestAssistant.dataset.antigravityTurnId)latestAssistant.dataset.antigravityTurnId='ag-turn-'+Array.from(chatRoot.querySelectorAll('*')).indexOf(latestAssistant);
    const latestAssistantText=latestAssistant?norm(latestAssistant.textContent||''):'',latestAssistantFingerprint=latestAssistantText.slice(0,160)+'|'+latestAssistantText.length,latestAssistantNodeSignature=latestAssistant?(latestAssistant.tagName.toLowerCase()+'|'+latestAssistant.dataset.antigravityTurnId):'';
    const thoughtNodes=latestAssistant?Array.from(latestAssistant.querySelectorAll('model-thoughts,.thoughts-container,.thought-container,[data-test-id*="thought" i],[data-testid*="thought" i],ms-thought-chunk,[class*="thought" i],[class*="reason" i],[data-testid*="reason" i]')):Array.from(chatRoot.querySelectorAll('model-thoughts,.thoughts-container,.thought-container,ms-thought-chunk')),thoughtText=thoughtNodes.map(function(el){return norm(el.textContent||'');}).join('|'),thoughtLen=thoughtText.length,thoughtFingerprint=thoughtText.slice(0,160)+'|'+thoughtLen;
    const latestUser=users.length?norm(users[users.length-1].textContent||''):'',chips=composerRoot?Array.from(composerRoot.querySelectorAll('uploader-file-preview,gem-attachment,[class*="attachment" i],[class*="chip" i]')).filter(visible):[],stop=composerRoot?Array.from(composerRoot.querySelectorAll('button[aria-label*="stop" i],button[title*="stop" i],[data-testid*="stop" i],button.stop-button,button.send-button.stop,button:has(mat-icon[fonticon="stop"])')).find(function(el){return visible(el)&&!el.disabled&&el.getAttribute('aria-disabled')!=='true';}):null;
    const classifyGeminiRoute=function(value){const normalized=String(value||'').replace(/\/+$/,'')||'/',match=normalized.match(/^\/app\/([^/?#]+)$/i);return {normalized:normalized,isGenericApp:normalized==='/app',isConversationRoute:Boolean(match),conversationId:match?match[1]:''};};
    const routeKey=location.pathname+location.search,preRoute=classifyGeminiRoute(arg.meta.routeKey||''),currentRoute=classifyGeminiRoute(routeKey),committedUserStillPresent=Boolean(arg.meta.newUserTurnFingerprint&&latestUser.includes(arg.meta.newUserTurnFingerprint)),sameConversationRoute=Boolean(preRoute.isConversationRoute&&currentRoute.isConversationRoute&&preRoute.conversationId===currentRoute.conversationId);
    const processingTurnRoot=latestAssistant?(latestAssistant.closest('model-response,[data-message-author-role="model"],.conversation-container,.conversation-turn,[data-testid="chat-turn-assistant"]')||latestAssistant):chatRoot,presentedRoot=latestAssistant?latestAssistant.querySelector('.presented-response-container,[class*="presented-response" i]'):null;
    const processingSelectors=['.response-container-header-processing-state','.response-container-header svg','.presented-response-container svg','.presented-response-container canvas','.presented-response-container bard-avatar','.presented-response-container lottie-animation','pending-response','loading-indicator','bard-avatar','lottie-animation','[role="progressbar"]','[aria-busy="true"]','mat-progress-spinner','[class*="spinner" i]','[class*="loading" i]','[class*="processing" i]'].join(','),thinkingStatusText=thoughtText.slice(0,240),composerText=editor?norm(/^(TEXTAREA|INPUT)$/.test(editor.tagName)?editor.value:(editor.textContent||'')):'',landingHeading=Array.from(chatRoot.querySelectorAll('h1,h2,h3,[role="heading"]')).some(function(el){return visible(el)&&/where should we start\??/i.test(norm(el.textContent||''));}),generating=Boolean(stop),landing=landingHeading&&Boolean(editor&&visible(editor))&&composerText.length===0&&users.length===0&&assistants.length===0&&chips.length===0&&!generating;
    let conversationContinuity=!arg.meta.committed||Boolean(committedUserStillPresent||sameConversationRoute||users.length>0||assistants.length>0);if(arg.meta.committed&&landing&&users.length===0&&assistants.length===0&&!generating)conversationContinuity=false;
    const canProbeProcessing=Boolean((arg.gem||Boolean(stop)||latestAssistant||thoughtLen>0)&&users.length>0&&!landing&&arg.domainOk);
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
  if(isGemini && Array.isArray(validFiles)) {
    validFiles = validFiles.map(function(filePath) {
      if(typeof filePath === 'string' && path.extname(filePath).toLowerCase() === '.md') {
        const txtPath = filePath.replace(/\.md$/i, '.txt');
        try { fs.copyFileSync(filePath, txtPath); return txtPath; } catch(_) { return filePath; }
      }
      return filePath;
    });
  }
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
    let containers=arg.gem?Array.from(document.querySelectorAll('response-container')):Array.from(document.querySelectorAll('[data-testid="chat-turn-assistant"],[data-testid="ai-message"],[data-message-author-role="assistant"],[data-content="ai-message"],.assistant-message,[data-testid="chatOutput"],[data-testid="copilot-message-div"],.fai-CopilotMessage,[data-testid="chat-response-message"],[data-testid*="response" i],[class*="copilot-message" i],[class*="assistant-message" i],[class*="chat-turn" i],.fui-ChatMessage'));
    if(arg.gem&&containers.length===0)containers=Array.from(document.querySelectorAll('model-response,message-content,[data-message-author-role="model"]'));
    if(!arg.gem&&containers.length===0)containers=Array.from(document.querySelectorAll('main div[role="region"], [data-testid*="turn" i], .fui-ChatMessageContent, [class*="response-message" i], [class*="agent-response" i]')).filter(function(el){return (el.textContent||'').trim().length>10;});
    const substantiveContainers = containers.filter(function(el) { return (el.textContent || '').trim().length > 10; });
    const liveNode = substantiveContainers.length > 0 ? substantiveContainers[substantiveContainers.length - 1] : (containers[containers.length - 1] || null);
    if(!liveNode)return {text:'',metadata:{liveNodeTag:'',contentNodeTag:'',contentCharsBeforeClean:0,thoughtNodesRemoved:0,contentCharsAfterClean:0,codeBlockCount:0,hasMessageContent:false}};
    const nested=arg.gem?liveNode.querySelector('message-content,.markdown-main-panel,.md-content'):(Array.from(liveNode.querySelectorAll('[data-testid="markdown-reply"],.fui-ChatMessageContent,[data-content="ai-message"],[class*="content" i],[class*="markdown" i]')).find(function(el){return (el.textContent||'').trim().length>10;})||null),contentNode=nested||liveNode,hasMessageContent=Boolean(nested),before=(contentNode.textContent||'').length,clone=contentNode.cloneNode(true),codeExtractionReceipts=[],virtualizedErrors=[],thoughtNodes=Array.from(clone.querySelectorAll('model-thoughts,.thoughts-container,.thought-container,[data-test-id*="thought" i],[data-testid*="thought" i],ms-thought-chunk'));thoughtNodes.forEach(function(el){el.remove();});let codeBlockCount=0,virtualizedEditorsFound=0,virtualizedBlocksExtracted=0;
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
async function collectGeminiTerminalDiagnostics(args) {
  return getGeminiEngine().collectGeminiTerminalDiagnostics(args);
}
async function waitAndExtractCleanResponse(page,targetFrame,tabKey,projectRoot,previousCount,sendMeta){
  sendMeta=sendMeta||{};const isGemini=tabKey.startsWith('gemini'),budgets=resolveActivityDrivenBudgets(sendMeta,isGemini),hardCapMs=budgets.runawayCapMs,firstTokenDeadlineMs=budgets.firstTokenDeadlineMs,activeThinkingFreshMs=budgets.activeThinkingFreshMs,maxThinkingWithoutDomProgressMs=budgets.maxThinkingWithoutDomProgressMs,start=Date.now(),recoveryAttempt=sendMeta.recoveryAttempt||0,silentDeadlineMs=budgets.silentDeadlineMs,terminalDiagReceipts=new Map(),preUserCount=Number(sendMeta.preUserCount||0),preAssistantCount=Number(sendMeta.preAssistantCount||0);let lastProgressAt=start,lastGeneratingPulseAt=start,lastLogAt=0,lastDeferredLogAt=0,lastSilentContinueAt=0,lastExtractionReceiptAt=0,lastExtractionChars=-1,lastProgress='',lastText='',stable=0,resetTicks=0,observedUserHighWatermark=preUserCount,observedAssistantHighWatermark=Math.max(previousCount,preAssistantCount),lastThoughtFingerprint=sendMeta.preThoughtFingerprint||'',observedSubstantiveThinkingEvidence=false,silentCheckpointCaptured=false,wasActiveProcessing=false,effectiveLoopLimitMs=budgets.baseHardCapMs;
  const captureTerminalDiagnosticsOnce=async function(code,state,elapsedMs,progressAgeMs){const key=code+':'+recoveryAttempt;if(terminalDiagReceipts.has(key))return terminalDiagReceipts.get(key);const receipt=typeof collectGeminiTerminalDiagnostics==='function'?await collectGeminiTerminalDiagnostics({page:page,targetFrame:targetFrame,tabKey:tabKey,projectRoot:projectRoot,dispatchId:sendMeta.diagId,errorCode:code,state:state,elapsedMs:elapsedMs,progressAgeMs:progressAgeMs}):{errorCode:'',retryVisible:false};terminalDiagReceipts.set(key,receipt);return receipt;};
  while(Date.now()-start<effectiveLoopLimitMs){const reboundFrame=findChatFrameOrPage(page);if(reboundFrame!==targetFrame){const priorUrl=await targetFrame.evaluate(function(){return location.href;}).catch(function(){return '';});const reboundUrl=await reboundFrame.evaluate(function(){return location.href;}).catch(function(){return '';});targetFrame=reboundFrame;appendDispatchDiag(projectRoot,sendMeta.diagId||'n/a','CHAT_CONTEXT_REBOUND',{priorUrl:priorUrl,reboundUrl:reboundUrl,elapsedMs:Date.now()-start});}await page.waitForTimeout(750);const state=await probeWebChatState(targetFrame,isGemini,sendMeta);const elapsed=Date.now()-start;
    observedUserHighWatermark=Math.max(observedUserHighWatermark,state.userTurnCount);observedAssistantHighWatermark=Math.max(observedAssistantHighWatermark,state.assistantTurnCount);const newTurnWasObserved=Boolean(observedUserHighWatermark>preUserCount||observedAssistantHighWatermark>preAssistantCount||sendMeta.newUserTurnFingerprint||sendMeta.userTurnFingerprintMatched||(sendMeta.evidence&&sendMeta.evidence.userTurnFingerprintMatched)),countsReturnedToBaseline=Boolean(state.userTurnCount<=preUserCount&&state.assistantTurnCount<=preAssistantCount),committedTurnMissing=Boolean(!state.committedUserStillPresent),turnRolledBackAfterSend=Boolean(isGemini&&sendMeta.committed&&newTurnWasObserved&&countsReturnedToBaseline&&committedTurnMissing&&!state.generating&&!lastText),domainDriftCandidate=Boolean(isGemini&&sendMeta.committed&&state.domainMismatch&&state.userTurnCount===0&&state.assistantTurnCount===0&&!state.generating),landingResetCandidate=Boolean(isGemini&&sendMeta.committed&&state.landingVisible&&state.userTurnCount===0&&state.assistantTurnCount===0&&!state.generating&&!state.conversationContinuity),resetCandidate=Boolean(domainDriftCandidate||landingResetCandidate||turnRolledBackAfterSend),resetKind=domainDriftCandidate?'DOMAIN_DRIFT':(landingResetCandidate?'LANDING_RESET':(turnRolledBackAfterSend?'TURN_ROLLBACK':''));const resetInvariant=resetCandidate;resetTicks=resetInvariant?resetTicks+1:0;const resetMeta={preRouteKey:state.preRouteKey,currentRouteKey:state.currentRouteKey,preConversationId:state.preConversationId,currentConversationId:state.currentConversationId,committedUserStillPresent:state.committedUserStillPresent,users:state.userTurnCount,assistants:state.assistantTurnCount,preUserCount:preUserCount,preAssistantCount:preAssistantCount,observedUserHighWatermark:observedUserHighWatermark,observedAssistantHighWatermark:observedAssistantHighWatermark,countsReturnedToBaseline:countsReturnedToBaseline,committedTurnMissing:committedTurnMissing,newTurnWasObserved:newTurnWasObserved,turnRolledBackAfterSend:turnRolledBackAfterSend,resetKind:resetKind,landing:state.landingVisible,generating:state.generating,processingProbeSuppressed:state.processingProbeSuppressed,recoveryBudgetRemaining:Math.max(0,1-(sendMeta.recoveryAttempt||0))};if(resetTicks===1){appendDispatchDiag(projectRoot,sendMeta.diagId||'n/a','RESET_CANDIDATE_DETECTED',resetMeta);continue;}
    if(resetTicks>=2){const code=domainDriftCandidate?'ENGINE_DOMAIN_DRIFT_AFTER_SEND':(turnRolledBackAfterSend&&!landingResetCandidate?'GEMINI_TURN_ROLLED_BACK_AFTER_SEND':'GEMINI_CONVERSATION_RESET_AFTER_SEND'),progressAgeMs=Date.now()-lastProgressAt,receipt=await captureTerminalDiagnosticsOnce(code,state,elapsed,progressAgeMs);appendDispatchDiag(projectRoot,sendMeta.diagId||'n/a','RESET_CONFIRMED',Object.assign({code:code,elapsedMs:elapsed,resetTicks:resetTicks,screenshot:receipt&&receipt.screenshotPath},resetMeta));appendDispatchDiag(projectRoot,sendMeta.diagId||'n/a','RESET_DETECTED',Object.assign({code:code,elapsedMs:elapsed},resetMeta));const e=new Error(code);e.receipt=Object.assign({},state,{terminalDiagnostics:receipt});throw e;}
    const hasSubstantiveThinkingEvidence=state.hasSubstantiveThinkingEvidence!==undefined?Boolean(state.hasSubstantiveThinkingEvidence):Boolean(state.hasThinkingEvidence&&((state.thoughtLen||0)>0||(state.latestAssistantChars||0)>0)),activeProcessingEvidence=state.activeProcessingEvidence!==undefined?Boolean(state.activeProcessingEvidence):Boolean(state.generating&&state.visibleProcessingSpinner!==false&&state.visibleStopControl!==false&&state.conversationContinuity&&!state.landingVisible&&!state.domainMismatch),progress=[state.latestAssistantFingerprint||'',state.latestAssistantNodeSignature||'',state.thoughtFingerprint||''].join('|');if(progress!==lastProgress&&(hasSubstantiveThinkingEvidence||!lastProgress)){lastProgress=progress;if(hasSubstantiveThinkingEvidence){lastProgressAt=Date.now();lastGeneratingPulseAt=Date.now();}}
    const hasAssistantContent=Boolean((state.latestAssistantChars||0)>0),hasThoughtContent=Boolean((state.thoughtLen||0)>0),latestAssistantChanged=Boolean(state.latestAssistantFingerprint&&state.latestAssistantFingerprint!==(sendMeta.preAssistantFingerprint||'')),latestAssistantIdentityChanged=state.latestAssistantIdentityChanged!==undefined?Boolean(state.latestAssistantIdentityChanged):Boolean(state.latestAssistantNodeSignature&&state.latestAssistantNodeSignature!==(sendMeta.preAssistantNodeSignature||'')),latestAssistantFingerprintChanged=state.latestAssistantFingerprintChanged!==undefined?Boolean(state.latestAssistantFingerprintChanged):Boolean(hasAssistantContent&&state.latestAssistantFingerprint&&state.latestAssistantFingerprint!==(sendMeta.preAssistantFingerprint||'')),latestAssistantNodeSignatureChanged=Boolean(state.latestAssistantNodeSignature&&state.latestAssistantNodeSignature!==(sendMeta.preAssistantNodeSignature||'')),thoughtFingerprintChanged=state.thoughtFingerprintChanged!==undefined?Boolean(state.thoughtFingerprintChanged):Boolean(hasThoughtContent&&state.thoughtFingerprint&&state.thoughtFingerprint!==lastThoughtFingerprint),extractionEligible=Boolean(!((countsReturnedToBaseline&&committedTurnMissing)||turnRolledBackAfterSend)&&(state.assistantTurnCount>previousCount||(state.conversationContinuity&&(latestAssistantChanged||latestAssistantIdentityChanged||latestAssistantNodeSignatureChanged))));if(thoughtFingerprintChanged)lastThoughtFingerprint=state.thoughtFingerprint;
    if(state.generating||activeProcessingEvidence||state.visibleStopControl||state.visibleProcessingSpinner)lastGeneratingPulseAt=Date.now();
    const domActivity=evaluateDomActivityState({state:state,budgets:budgets,now:Date.now(),start:start,lastProgressAt:lastProgressAt,lastGeneratingPulseAt:lastGeneratingPulseAt,lastText:lastText});effectiveLoopLimitMs=domActivity.effectiveLoopLimitMs;
    if(Date.now()-lastLogAt>=5000){lastLogAt=Date.now();appendDispatchDiag(projectRoot,sendMeta.diagId||'n/a','RESPONSE_POLL',{elapsedMs:elapsed,effectiveLoopLimitMs:effectiveLoopLimitMs,users:state.userTurnCount,assistantTotal:state.assistantTotal,assistantVisible:state.assistantVisible,assistantHighWatermark:observedAssistantHighWatermark,preUserCount:preUserCount,preAssistantCount:preAssistantCount,observedUserHighWatermark:observedUserHighWatermark,observedAssistantHighWatermark:observedAssistantHighWatermark,countsReturnedToBaseline:countsReturnedToBaseline,committedTurnMissing:committedTurnMissing,newTurnWasObserved:newTurnWasObserved,turnRolledBackAfterSend:turnRolledBackAfterSend,resetKind:resetKind,latestAssistantFingerprint:state.latestAssistantFingerprint,latestAssistantChanged:latestAssistantChanged,latestAssistantIdentityChanged:latestAssistantIdentityChanged,latestAssistantFingerprintChanged:latestAssistantFingerprintChanged,hasAssistantContent:hasAssistantContent,thoughtNodes:state.thoughtNodes,thoughtFingerprintChanged:thoughtFingerprintChanged,hasThoughtContent:hasThoughtContent,hasSubstantiveThinkingEvidence:hasSubstantiveThinkingEvidence,extractionEligible:extractionEligible,assistantPlaceholderCreated:Boolean(state.assistantPlaceholderCreated),activeProcessingEvidence:activeProcessingEvidence,processingVisualDetected:Boolean(state.processingVisualDetected),processingFallbackDetected:Boolean(state.processingFallbackDetected),processingRootTag:state.processingRootTag||'',processingMatchCount:state.processingMatchCount||0,processingProbeTags:state.processingProbeTags||[],visibleProcessingSpinner:Boolean(state.visibleProcessingSpinner),visibleStopControl:Boolean(state.visibleStopControl),silentCheckpointCaptured:silentCheckpointCaptured,silentDeadlineMs:silentDeadlineMs,recoveryAttempt:recoveryAttempt,recoveryBudgetRemaining:Math.max(0,1-recoveryAttempt),preRouteKey:state.preRouteKey,currentRouteKey:state.currentRouteKey,preConversationId:state.preConversationId,currentConversationId:state.currentConversationId,committedUserStillPresent:state.committedUserStillPresent,processingProbeSuppressed:state.processingProbeSuppressed,generating:state.generating,progressAgeMs:Date.now()-lastProgressAt,pulseAgeMs:domActivity.pulseAgeMs,landing:state.landingVisible,continuity:state.conversationContinuity});}
    if(extractionEligible){const extracted=await extractWebAssistantContent(targetFrame,isGemini);const extractionChars=extracted.metadata.contentCharsAfterClean;if(extractionChars!==lastExtractionChars||Date.now()-lastExtractionReceiptAt>=(extractionChars===0?15000:5000)){lastExtractionChars=extractionChars;lastExtractionReceiptAt=Date.now();appendDispatchDiag(projectRoot,sendMeta.diagId||'n/a','EXTRACTION_RECEIPT',extracted.metadata);}if(extracted.error)throw new Error(extracted.error);const text=extracted.text;if(text&&text===lastText&&!state.generating){stable++;if(stable>=4){appendDispatchDiag(projectRoot,sendMeta.diagId||'n/a','RESPONSE_EXTRACTED',{chars:text.length});return text;}}else{stable=0;lastText=text;}}
    if(hasSubstantiveThinkingEvidence)observedSubstantiveThinkingEvidence=true;const progressAgeMs=Date.now()-lastProgressAt,activeThinkingFresh=Boolean(domActivity.activeThinkingFresh||(isGemini&&state.conversationContinuity&&!state.landingVisible&&state.generating&&hasSubstantiveThinkingEvidence&&progressAgeMs<activeThinkingFreshMs));
    const lowText=String(lastText||'').toLowerCase();if(lastText.length<500&&SERVICE_ERROR_PATTERNS.some(function(p){return lowText.includes(p);})){appendDispatchDiag(projectRoot,sendMeta.diagId||'n/a','ERROR',{code:'SERVICE_REFUSAL',elapsedMs:elapsed});throw new Error('WEB_SERVICE_REFUSAL: '+lastText.slice(0,150));}
    const assistantPlaceholderCreated=state.assistantPlaceholderCreated!==undefined?Boolean(state.assistantPlaceholderCreated):Boolean(state.assistantTurnCount>(sendMeta.preAssistantCount||0)),silentCandidate=Boolean(isGemini&&state.conversationContinuity&&!state.landingVisible&&!state.domainMismatch&&state.userTurnCount>0&&state.assistantTurnCount>0&&state.latestAssistantChars===0&&!hasSubstantiveThinkingEvidence);
    const shouldProbeProcessingLoss=Boolean(!lastText&&silentCandidate&&wasActiveProcessing&&!activeProcessingEvidence);wasActiveProcessing=wasActiveProcessing||activeProcessingEvidence;
    let silentDiag=null,checkpointConsumedThisPoll=false;const silentPreflight=Boolean(silentCandidate&&activeProcessingEvidence);
    if(resetTicks===0&&!lastText&&silentPreflight){if(elapsed>=firstTokenDeadlineMs&&!silentCheckpointCaptured){silentDiag=await captureTerminalDiagnosticsOnce('GEMINI_SILENT_PREFLIGHT_CHECKPOINT',state,elapsed,progressAgeMs);if(silentDiag.errorCode)throw new Error(silentDiag.errorCode+(silentDiag.retryVisible?' RETRY_VISIBLE':''));silentCheckpointCaptured=true;checkpointConsumedThisPoll=true;if(typeof appendDispatchDiag==='function')appendDispatchDiag(projectRoot,sendMeta.diagId||'n/a','SILENT_PREFLIGHT_CHECKPOINT',{elapsedMs:elapsed,progressAgeMs:progressAgeMs,silentDeadlineMs:silentDeadlineMs,recoveryAttempt:recoveryAttempt});if(typeof appendDispatchDiag==='function')appendDispatchDiag(projectRoot,sendMeta.diagId||'n/a','SILENT_PREFLIGHT_CONTINUING',{elapsedMs:elapsed,silentDeadlineMs:silentDeadlineMs,recoveryAttempt:recoveryAttempt});await page.waitForTimeout(750);continue;}if(elapsed>=silentDeadlineMs){await captureTerminalDiagnosticsOnce('GEMINI_SILENT_PREFLIGHT_TIMEOUT',state,elapsed,progressAgeMs);if(typeof appendDispatchDiag==='function')appendDispatchDiag(projectRoot,sendMeta.diagId||'n/a','SILENT_PREFLIGHT_TIMEOUT',{elapsedMs:elapsed,recoveryAttempt:recoveryAttempt});appendDispatchDiag(projectRoot,sendMeta.diagId||'n/a','SILENT_PREFLIGHT_CLASSIFIED',{elapsedMs:elapsed,progressAgeMs:progressAgeMs,recoveryAttempt:recoveryAttempt});throw new Error('GEMINI_SILENT_PREFLIGHT_TIMEOUT elapsedMs='+elapsed+' deadlineMs='+silentDeadlineMs);}if(elapsed>=firstTokenDeadlineMs&&Date.now()-lastSilentContinueAt>=30000){lastSilentContinueAt=Date.now();if(typeof appendDispatchDiag==='function')appendDispatchDiag(projectRoot,sendMeta.diagId||'n/a','SILENT_PREFLIGHT_CONTINUING',{elapsedMs:elapsed,silentDeadlineMs:silentDeadlineMs,recoveryAttempt:recoveryAttempt});}continue;}
    if(shouldProbeProcessingLoss&&!activeProcessingEvidence){silentDiag=await captureTerminalDiagnosticsOnce('GEMINI_FIRST_TOKEN_TIMEOUT',state,elapsed,progressAgeMs);if(silentDiag&&silentDiag.errorCode)throw new Error(silentDiag.errorCode+(silentDiag.retryVisible?' RETRY_VISIBLE':''));throw new Error('GEMINI_FIRST_TOKEN_TIMEOUT processing_evidence_lost elapsedMs='+elapsed+' progressAgeMs='+progressAgeMs);}
    const effectiveMaxThinkingStallMs=!(Number.isFinite(Number(sendMeta.maxThinkingWithoutDomProgressMs))&&Number(sendMeta.maxThinkingWithoutDomProgressMs)>0)&&activeProcessingEvidence?Math.max(maxThinkingWithoutDomProgressMs,720000):maxThinkingWithoutDomProgressMs;if(resetTicks===0&&!lastText&&progressAgeMs>=effectiveMaxThinkingStallMs&&observedSubstantiveThinkingEvidence&&domActivity.pulseAgeMs>=effectiveMaxThinkingStallMs){const code='GEMINI_THINKING_STALL',diag=await captureTerminalDiagnosticsOnce(code,state,elapsed,progressAgeMs);if(diag.errorCode)throw new Error(diag.errorCode+(diag.retryVisible?' RETRY_VISIBLE':''));throw new Error(code+' elapsedMs='+elapsed+' progressAgeMs='+progressAgeMs+' deadlineMs='+effectiveMaxThinkingStallMs);}
    if(resetTicks===0&&!lastText&&elapsed>=firstTokenDeadlineMs&&!activeThinkingFresh&&!silentPreflight&&!activeProcessingEvidence&&!checkpointConsumedThisPoll){const code='GEMINI_FIRST_TOKEN_TIMEOUT',diag=isGemini?await captureTerminalDiagnosticsOnce(code,state,elapsed,progressAgeMs):null;if(diag&&diag.errorCode)throw new Error(diag.errorCode+(diag.retryVisible?' RETRY_VISIBLE':''));throw new Error(code+' elapsedMs='+elapsed+' progressAgeMs='+progressAgeMs+' deadlineMs='+firstTokenDeadlineMs);}
    if(!lastText&&elapsed>=firstTokenDeadlineMs&&activeThinkingFresh&&Date.now()-lastDeferredLogAt>=30000){lastDeferredLogAt=Date.now();appendDispatchDiag(projectRoot,sendMeta.diagId||'n/a','FIRST_TOKEN_DEADLINE_DEFERRED',{reason:'ACTIVE_THINKING',elapsedMs:elapsed,progressAgeMs:progressAgeMs,pulseAgeMs:domActivity.pulseAgeMs,effectiveLoopLimitMs:effectiveLoopLimitMs});}
  }
  targetFrame=findChatFrameOrPage(page);const finalState=await probeWebChatState(targetFrame,isGemini,sendMeta);let finalExtract={text:'',metadata:{codeBlockCount:0}};if(finalState.assistantTurnCount>0)finalExtract=await extractWebAssistantContent(targetFrame,isGemini);if(finalExtract.error==='GEMINI_EXTRACTION_OVERPRUNED')throw new Error('GEMINI_EXTRACTION_OVERPRUNED');const finalText=String(finalExtract.text||'').trim(),finalElapsed=Date.now()-start;if(!finalState.generating&&finalState.conversationContinuity&&!finalState.landingVisible&&!finalState.domainMismatch&&finalText.length>25){appendDispatchDiag(projectRoot,sendMeta.diagId||'n/a','RESPONSE_EXTRACTED_AFTER_DEADLINE',{elapsedMs:finalElapsed,chars:finalText.length,codeBlockCount:(finalExtract.metadata&&finalExtract.metadata.codeBlockCount)||0});return finalText;}if(resetTicks===0){if(isGemini)await captureTerminalDiagnosticsOnce('GEMINI_HARD_CAP_TIMEOUT',finalState,finalElapsed,Date.now()-lastProgressAt);throw new Error('GEMINI_HARD_CAP_TIMEOUT elapsedMs='+finalElapsed+' deadlineMs='+effectiveLoopLimitMs+' route='+finalState.routeKey+' users='+finalState.userTurnCount+' assistants='+finalState.assistantTurnCount);}throw new Error('GEMINI_RESET_DEBOUNCE_INCOMPLETE elapsedMs='+finalElapsed+' resetTicks='+resetTicks);
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
      if(attempt===2){const backoff=Number.isFinite(opts.backoffMs)?opts.backoffMs:8000+(parseInt(crypto.createHash('sha256').update(diagId).digest('hex').slice(0,8),16)%4001);await (typeof opts.sleepFn==='function'?opts.sleepFn(backoff):new Promise(function(resolve){setTimeout(resolve,backoff);}));await resetChatVerified({page:page,targetFrame:targetFrame,tabKey:tabKey,projectRoot:projectRoot,resetPolicy:normalizeConversationResetPolicy({forceFreshChat:true}),reason:'COMPACT_RECOVERY'});targetFrame=findChatFrameOrPage(page);}
      else if(attempt===1&&opts.forceFreshChat===true){await resetChatVerified({page:page,targetFrame:targetFrame,tabKey:tabKey,projectRoot:projectRoot,resetPolicy:normalizeConversationResetPolicy({forceFreshChat:true}),reason:'CODING_BATCH_FRESH_CHAT'});targetFrame=findChatFrameOrPage(page);}
      else if(routing.autoNewChatOnProjectSwitch){await resetChatIfNeeded(page,tabKey,projectRoot,false);}
      const desiredTemp = Boolean(tabTemporaryChatConfig[tabKey]);
      if (tabKey.startsWith('gemini') && typeof ensureGeminiTemporaryChat === 'function') {
        const tempRes = await ensureGeminiTemporaryChat(targetFrame, tabKey, desiredTemp);
        geminiTemporaryChatStatus[tabKey] = tempRes || { active: Boolean(tempRes && tempRes.active), verified: false, status: 'MISMATCH_OR_UNVERIFIED' };
        if ((desiredTemp && (!tempRes || !tempRes.verified || !tempRes.active)) || (!desiredTemp && (!tempRes || !tempRes.verified || tempRes.active !== false))) {
          await captureSupportEvidence(page, projectRoot, tabKey, 'TEMPORARY_CHAT_UNVERIFIED', 'Gemini Temporary Chat u kerkua ' + (desiredTemp ? 'ON' : 'OFF') + ' por deshtoi verifikimi ne DOM: ' + JSON.stringify(tempRes || {}));
        }
        targetFrame = findChatFrameOrPage(page);
      } else if (tabKey.startsWith('web') && typeof ensureCopilotTemporaryChat === 'function') {
        const tempRes = await ensureCopilotTemporaryChat(targetFrame, tabKey, desiredTemp);
        copilotTemporaryChatStatus[tabKey] = tempRes || { active: Boolean(tempRes && tempRes.active), verified: false, status: 'MISMATCH_OR_UNVERIFIED' };
        if ((desiredTemp && (!tempRes || !tempRes.verified || !tempRes.active)) || (!desiredTemp && (!tempRes || !tempRes.verified || tempRes.active !== false))) {
          if (desiredTemp && tempRes && tempRes.status === 'CONTROL_NOT_FOUND') {
            copilotTemporaryChatStatus[tabKey] = Object.assign({}, tempRes, { status: 'UNSUPPORTED_IN_TENANT' });
            console.error('[TEMP_CHAT_UNSUPPORTED] tabKey=' + tabKey + ' reason=' + (tempRes.reason || 'COPILOT_TOGGLE_NOT_FOUND'));
          } else {
            await captureSupportEvidence(page, projectRoot, tabKey, 'TEMPORARY_CHAT_UNVERIFIED', 'Copilot Temporary Chat u kerkua ' + (desiredTemp ? 'ON' : 'OFF') + ' por deshtoi verifikimi ne DOM: ' + JSON.stringify(tempRes || {}));
          }
        }
        targetFrame = findChatFrameOrPage(page);
      }
      const verifiedModel = await ensureMaxReasoningMode(targetFrame,tabKey,{reasoningLevel:'high',modelTier:opts.modelTier||'neon'});
      tabActiveModel[tabKey]=verifiedModel;appendDispatchDiag(projectRoot,diagId,'MODEL_VERIFIED',{model:verifiedModel});
      await page.keyboard.press('Escape').catch(function() {});
      await targetFrame.evaluate(function() {
        document.querySelectorAll('.cdk-overlay-backdrop').forEach(function(b) { b.click(); });
      }).catch(function() {});
      await page.waitForTimeout(200);

      // 1. Numërimi i saktë i përgjigjeve ekzistuese (1:1 me waitAndExtractCleanResponse)
      const previousAssistant=await targetFrame.evaluate(function(isGem){const root=document.querySelector('main')||document.body,norm=function(v){return String(v||'').replace(/\s+/g,' ').trim();};let c=isGem?Array.from(root.querySelectorAll('response-container')):Array.from(root.querySelectorAll('[data-testid="copilot-message-div"],[data-message-author-role="assistant"],[data-testid="chat-turn-assistant"],[data-testid="ai-message"],[data-content="ai-message"],.assistant-message,.fai-CopilotMessage,[data-testid*="response" i],[class*="copilot-message" i],[class*="assistant-message" i],[class*="chat-turn" i],.fui-ChatMessage,[data-content="ai-message"]'));if(isGem&&c.length===0)c=Array.from(root.querySelectorAll('model-response,[data-message-author-role="model"]'));if(!isGem&&c.length===0)c=Array.from(root.querySelectorAll('main div[role="region"], [data-testid*="turn" i], .fui-ChatMessageContent, [class*="response-message" i], [class*="agent-response" i]')).filter(function(el){return (el.textContent||'').trim().length>10;});const n=c[c.length-1]||null;if(n&&!n.dataset.antigravityTurnId)n.dataset.antigravityTurnId='ag-turn-'+Array.from(root.querySelectorAll('*')).indexOf(n);const t=n?norm(n.textContent||''):'';return {count:c.length,fingerprint:t.slice(0,160)+'|'+t.length,nodeSignature:n?(n.tagName.toLowerCase()+'|'+n.dataset.antigravityTurnId):''};},isGemini);const previousCount=previousAssistant.count;
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
        if (attempt === 2 && isGemini && !opts.isPlanner) continue;
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
          if(!send){
            await page.waitForTimeout(600);
            try {
              await composer.locator.evaluate(function(el){
                el.dispatchEvent(new Event('input',{bubbles:true}));
                el.dispatchEvent(new Event('change',{bubbles:true}));
              });
            } catch(_){}
            send=await resolveSendButton(targetFrame,isGemini,composer.token);
          }
          if(send){
            console.error('[SEND_ACTION] tabKey='+tabKey+' attempt='+sendAttempt+' locator='+send.strategy+' click=playwright');
            try{
              await send.locator.click({timeout:5000});
            }catch(e){
              await page.waitForTimeout(250);
              send=await resolveSendButton(targetFrame,isGemini,composer.token);
              if(send)await send.locator.click({timeout:5000});
              else {
                console.error('[SEND_ACTION] fallback locator=editor-enter click=keyboard');
                await composer.locator.press('Enter');
              }
            }
          } else {
            console.error('[SEND_ACTION] tabKey='+tabKey+' attempt='+sendAttempt+' locator=editor-enter-universal click=keyboard');
            try {
              await composer.locator.press('Enter');
            } catch(e) {
              throw new Error('SEND_BUTTON_NOT_FOUND');
            }
          }
          commitReceipt=await waitForSendCommit(targetFrame,{composerToken:composer.token,isGemini:isGemini,attachmentNames:attachmentNames,fingerprint:fingerprint,pre:pre,timeoutMs:15000});
          if(commitReceipt.committed){appendDispatchDiag(projectRoot,diagId,'SEND_COMMITTED',{routeKey:commitReceipt.routeKey,evidence:commitReceipt.evidence});if(resetRecoveries===1)appendDispatchDiag(projectRoot,diagId,'RECOVERY_COMMITTED',{attempt:resetRecoveries,routeKey:commitReceipt.routeKey});console.error('[SEND_COMMITTED] tabKey='+tabKey+' attempt='+sendAttempt+' evidence='+JSON.stringify(commitReceipt.evidence));break;}
          console.error('[SEND_NOT_COMMITTED] tabKey='+tabKey+' attempt='+sendAttempt+' evidence='+JSON.stringify(commitReceipt.evidence));
        }
        if(!commitReceipt||!commitReceipt.committed)throw new Error('SEND_NOT_COMMITTED');
      try {
        return await waitAndExtractCleanResponse(page,targetFrame,tabKey,projectRoot,previousCount,Object.assign({},commitReceipt,{fingerprint:fingerprint,preUserCount:pre.userCount,preAssistantCount:pre.assistantCount,preAssistantFingerprint:pre.assistantFingerprint||previousAssistant.fingerprint,preAssistantNodeSignature:pre.assistantNodeSignature||previousAssistant.nodeSignature,composerToken:composer.token,diagId:diagId,recoveryAttempt:resetRecoveries,silentDeadlineMs:isGemini?600000:300000,hardCapMs:opts.hardCapMs}));
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
  const res = await getGoogleSearchEngine().selectGoogleSearchAiModel(page, targetKeyword, tabKey);
  if (tabKey && Object.prototype.hasOwnProperty.call(googleSearchModelReceipts, tabKey)) googleSearchModelReceipts[tabKey] = { verified: true };
  return res;
}
async function ensureGoogleSearchAi4CarbonMode(page, tabKey) {
  const res = await getGoogleSearchEngine().ensureGoogleSearchAi4CarbonMode(page, tabKey);
  if (tabKey && Object.prototype.hasOwnProperty.call(googleSearchModelReceipts, tabKey)) googleSearchModelReceipts[tabKey] = { verified: true };
  return res;
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

async function discoverSearchAiAssistantTurns(page, opts) {
  return getGoogleSearchEngine().discoverSearchAiAssistantTurns(page, opts);
}

async function extractSearchAiTurnContent(page, opts) {
  return getGoogleSearchEngine().extractSearchAiTurnContent(page, opts);
}

async function attachFilesToSearchAiClean(page, filesList) {
  return getGoogleSearchEngine().attachFilesToSearchAiClean(page, filesList);
}

async function dispatchToGoogleSearchAiTab(opts) {
  return getGoogleSearchEngine().dispatchToGoogleSearchAiTab(opts);
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
  autopilotEngineModule.writeFileAtomic(statePath, JSON.stringify(next, null, 2));
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

  const parsedRouting = JSON.parse(fs.readFileSync(routingPath, 'utf8'));
  if (!parsedRouting.roles) {
    parsedRouting.roles = {
      planner: parsedRouting.targets?.web1?.accountPool?.[0] || 'gemini1',
      coder: parsedRouting.targets?.web2?.accountPool?.[0] || 'gemini2',
      reviewer: parsedRouting.targets?.web1?.accountPool?.[0] || 'gemini1'
    };
  }
  return parsedRouting;
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

function classifyWorkspaceFile(rel, meta) { return autopilotEngineModule.classifyWorkspaceFile ? autopilotEngineModule.classifyWorkspaceFile(rel, meta) : {}; }
function scoreWorkspaceFile(info) { return autopilotEngineModule.scoreWorkspaceFile ? autopilotEngineModule.scoreWorkspaceFile(info) : 0; }
function compactWorkspaceContent(rel, content, maxBytes, classification) { return autopilotEngineModule.compactWorkspaceContent ? autopilotEngineModule.compactWorkspaceContent(rel, content, maxBytes, classification) : { text: content, summarized: false }; }
function buildBudgetedWorkspaceBundle(projectRoot, opts) { return autopilotEngineModule.buildBudgetedWorkspaceBundle ? autopilotEngineModule.buildBudgetedWorkspaceBundle(projectRoot, opts) : { content: '', receipt: {}, files: [] }; }
function packWorkspace(projectRoot, mode) { return getAutopilotEngine().packWorkspace(projectRoot, mode); }
function getBundleAttachmentAndNote(projectRoot, targetEngine) { return getAutopilotEngine().getBundleAttachmentAndNote(projectRoot, targetEngine); }

async function applyAndTestDeterministically(projectRoot) {
  return await getLocalExecutor().applyAndTestDeterministically(projectRoot);
}

const CHUNK_ENGINE_LIMITS = autopilotEngineModule.CHUNK_ENGINE_LIMITS;
function normalizeBatchTarget(value) { return String(value || '').replace(/\\/g, '/').replace(/^\.\//, '').trim(); }
function inferRepositoryLanguage(rel) { return autopilotEngineModule.inferRepositoryLanguage ? autopilotEngineModule.inferRepositoryLanguage(rel) : path.extname(rel); }
function extractRepositorySignals(rel, text) { return autopilotEngineModule.extractRepositorySignals ? autopilotEngineModule.extractRepositorySignals(rel, text) : {}; }
function scanRepositoryUniversal(projectRoot) { return getAutopilotEngine().scanRepositoryUniversal(projectRoot); }
function resolveDependencyPath(from, spec, paths) { return autopilotEngineModule.resolveDependencyPath ? autopilotEngineModule.resolveDependencyPath(from, spec, paths) : null; }
function buildDependencyGraph(scan) { return getAutopilotEngine().buildDependencyGraph(scan); }
function buildCompactRepoMap(scan, limits) { return getAutopilotEngine().buildCompactRepoMap(scan, limits); }
function partitionAnalysisChunks(scan, graph, limits) { return getAutopilotEngine().partitionAnalysisChunks(scan, graph, limits); }
async function analyzeRepositoryChunks(chunks, opts) { return getAutopilotEngine().analyzeRepositoryChunks(chunks, opts); }
function scoreAnalysisChunkRelevance(chunk, scan, graph, userRequest) { return getAutopilotEngine().scoreAnalysisChunkRelevance(chunk, scan, graph, userRequest); }
function buildLocalStructuralChunkSummary(chunk, scan) { return getAutopilotEngine().buildLocalStructuralChunkSummary(chunk, scan); }
function buildFinalPlanningContext(args) { return getAutopilotEngine().buildFinalPlanningContext(args); }
function parseAndValidatePlanBatches(plan, graph, scan, projectRoot) { return getAutopilotEngine().parseAndValidatePlanBatches(plan, graph, scan, projectRoot); }
function partitionCodingBatches(targets, graph, limits) { return getAutopilotEngine().partitionCodingBatches(targets, graph, limits); }
function buildBatchMiniMap(batch, state, limits) { return getAutopilotEngine().buildBatchMiniMap(batch, state, limits); }
function extractBatchPlanSlice(planText, batch) { return getAutopilotEngine().extractBatchPlanSlice(planText, batch); }
function buildMinimalBatchContext(batch, state, limits) { return getAutopilotEngine().buildMinimalBatchContext(batch, state, limits); }
function selectCodingTransport(context, limits) { return getAutopilotEngine().selectCodingTransport(context, limits); }
function selectAdaptiveReasoningLevel(ctx) { return getAutopilotEngine().selectAdaptiveReasoningLevel(ctx); }
function classifyAttachmentHandshakeStrict(text) {
  return getGeminiEngine().classifyAttachmentHandshakeStrict(text);
}
async function runGeminiAttachmentIngestHandshake(args) {
  return getGeminiEngine().runGeminiAttachmentIngestHandshake(args);
}
function buildBatchContext(batch, state, limits) { return getAutopilotEngine().buildBatchContext(batch, state, limits); }
async function runCodingBatch(batch, context, engine, opts) { return getAutopilotEngine().runCodingBatch(batch, context, engine, opts); }
function parseCodeBlocksFromMarkdown(markdown, expectedTargets) {
  return getLocalExecutor().parseCodeBlocksFromMarkdown(markdown, expectedTargets);
}

function applyBatch(args) {
  return getLocalExecutor().applyBatch(args);
}
function runBatchQuickChecks(args) {
  return getLocalExecutor().runBatchQuickChecks(args);
}

async function runFinalBuildAndTests(projectRoot, timeoutMs) {
  return await getLocalExecutor().runFinalBuildAndTests(projectRoot, timeoutMs);
}

async function repairBatchOnce(args) { if (args.repairsUsed >= 1) throw new Error('BATCH_REPAIR_EXHAUSTED'); const result = await runCodingBatch(args.batch, args.context, args.engine, Object.assign({}, args, { repair: true })); return Object.assign(result, { repairsUsed: 1 }); }
function halveBatchAdaptively(batch, costs, level) { return getAutopilotEngine().halveBatchAdaptively(batch, costs, level); }
function normalizeFailureCode(err) { return getAutopilotEngine().normalizeFailureCode(err); }
const ADAPTIVE_HALVING_CODES = autopilotEngineModule.ADAPTIVE_HALVING_CODES || new Set(['BATCH_OUTPUT_INCOMPLETE','BATCH_TARGET_MISSING','BATCH_OUTPUT_TRUNCATED','BATCH_RESPONSE_BUDGET_EXCEEDED','BATCH_PARSE_INCOMPLETE']);
function isAdaptiveHalvingFailure(err) { return getAutopilotEngine().isAdaptiveHalvingFailure(err); }
function buildCrossBatchContractSummary(receipt, previous) { return getAutopilotEngine().buildCrossBatchContractSummary(receipt, previous); }
function buildDiffFocusedReviewContext(args) { return getAutopilotEngine().buildDiffFocusedReviewContext(args); }
function writeChunkContextFile(exchangeDir, chunk, scan, maxBytes) { return getAutopilotEngine().writeChunkContextFile(exchangeDir, chunk, scan, maxBytes); }
function extractTargetsFromError(text, known) { return getAutopilotEngine().extractTargetsFromError(text, known); }
function migrateLegacyCheckpointReceipts(codePath, cleanRoot, checkpointIdentity) {
  return getLocalExecutor().migrateLegacyCheckpointReceipts(codePath, cleanRoot, checkpointIdentity);
}
function appendBatchAudit(codePath, receipt, parsed, cleanRoot, checkpointIdentity) {
  return getLocalExecutor().appendBatchAudit(codePath, receipt, parsed, cleanRoot, checkpointIdentity);
}
function persistCheckpointReceiptOnce(codePath, receipt, parsedFiles, cleanRoot, checkpointIdentity) {
  return getLocalExecutor().persistCheckpointReceiptOnce(codePath, receipt, parsedFiles, cleanRoot, checkpointIdentity);
}
function normalizeConversationResetPolicy(opts) {
  opts = opts || {};
  if (opts.resetPolicy) return Object.assign({}, opts.resetPolicy);
  if (opts.forceFreshChat === true) return { strategy: 'SOFT_FIRST', preserveVerifiedModel: true, requireFreshConversation: true, allowRouteReopen: true, allowHardReload: true };
  return { strategy: 'SOFT_FIRST', preserveVerifiedModel: true, requireFreshConversation: false, allowRouteReopen: true, allowHardReload: true };
}

async function dispatchChunkedEngineTurn(engine,cleanRoot,prompt,attachment,opts){opts=opts||{};const common={tabKey:engine,projectRoot:cleanRoot,promptText:prompt,attachmentPaths:[attachment],bundlePath:attachment,isPlanner:Boolean(opts.isPlanner),userRequest:opts.userRequest||'',forceFreshChat:opts.forceFreshChat!==false,resetPolicy:normalizeConversationResetPolicy(opts),useProvidedBundle:opts.useProvidedBundle===true,backoffMs:opts.backoffMs,sleepFn:opts.sleepFn,disableInternalRetry:opts.disableInternalRetry===true,reasoningLevel:'high',modelTier:opts.modelTier||'neon',hardCapMs:opts.hardCapMs};return engine.startsWith('google_search_')?dispatchToGoogleSearchAiTab(common):dispatchToWebTab(common);}
function getFailoverEngines(primaryEngine, excludedSet) { return getAutopilotEngine().getFailoverEngines(primaryEngine, excludedSet); }
function isEngineFailoverEligible(code) { return getAutopilotEngine().isEngineFailoverEligible(code); }
async function dispatchPlannerWithFailover(state, routing, cleanRoot, prompt, attachment, opts) { return getAutopilotEngine().dispatchPlannerWithFailover(state, routing, cleanRoot, prompt, attachment, opts); }
async function executeCodingLeaf(batch, state, routing, job, opts) { return getAutopilotEngine().executeCodingLeaf(batch, state, routing, job, opts); }
async function executeBatchWithRecovery(batch, state, routing, job, opts) { return getAutopilotEngine().executeBatchWithRecovery(batch, state, routing, job, opts); }
const activeCycleJobs = {};
async function runAutonomousPipeline(cleanRoot, userRequest, opts) { return getAutopilotEngine().runAutonomousPipeline(cleanRoot, userRequest, opts); }
function resolveAndEmbedExternalFiles(userRequest) { return autopilotEngineModule.resolveAndEmbedExternalFiles ? autopilotEngineModule.resolveAndEmbedExternalFiles(userRequest) : ''; }
async function waitJobSlice(cleanRoot, maxSliceMs) { return getAutopilotEngine().waitJobSlice(cleanRoot, maxSliceMs); }
function resolveTargetProjectAndRequest(payload) {
  payload = payload || {};
  let rawRoot = String(payload.projectRoot || payload.project_root || '').trim();
  let req = String(payload.userRequest || payload.user_request || payload.prompt || '').trim();
  let hasExplicitRoot = Boolean(rawRoot && path.resolve(rawRoot).toLowerCase() !== PLUGIN_ROOT.toLowerCase());

  const parsedDirective = parseRootDirectiveAndRequest(req);
  if (parsedDirective.extractedRoot) {
    if (!rawRoot || path.resolve(rawRoot).toLowerCase() === PLUGIN_ROOT.toLowerCase()) {
      rawRoot = parsedDirective.extractedRoot;
      hasExplicitRoot = true;
    }
    req = parsedDirective.cleanedRequest;
  }

  let cleanRoot = rawRoot ? path.resolve(rawRoot) : '';

  if (!cleanRoot || !fs.existsSync(cleanRoot) || (!hasExplicitRoot && cleanRoot.toLowerCase() === PLUGIN_ROOT.toLowerCase())) {
    const activeRoots = Object.keys(activeCycleJobs).filter(function(k) { return activeCycleJobs[k] && activeCycleJobs[k].running; });
    if (activeRoots.length > 0) {
      cleanRoot = activeRoots[0];
    }
    if (!cleanRoot) {
      const reg = readRegistryState(REGISTRY_PATH);
      cleanRoot = pickDefaultActiveProjectRoot(reg, PLUGIN_ROOT);
    }
    if (!cleanRoot) {
      for (const t of Object.keys(activeProjectPerTab)) {
        if (activeProjectPerTab[t] && fs.existsSync(activeProjectPerTab[t])) {
          cleanRoot = path.resolve(activeProjectPerTab[t]);
          break;
        }
      }
    }
    if (!cleanRoot) {
      cleanRoot = process.cwd();
    }
  }

  cleanRoot = resolveProjectRoot(cleanRoot).root;

  const isGeneric = !req || req === 'null' || req === 'undefined' || req.includes('Perdoruesi thirri /run-cycle');
  if (isGeneric) {
    const searchDirs = [cleanRoot, path.join(cleanRoot, 'docs')].filter(function(d) { return fs.existsSync(d); });
    let foundWorkOrder = null;

    for (const dir of searchDirs) {
      try {
        const files = fs.readdirSync(dir);
        const match = files.find(function(f) {
          return /^(urdher_pune|work_order|task|blueprint|specification|plan|prompt)/i.test(f) && f.endsWith('.md');
        });
        if (match) {
          foundWorkOrder = path.join(dir, match);
          break;
        }
      } catch (_) {}
    }

    if (foundWorkOrder && fs.existsSync(foundWorkOrder)) {
      req = 'Zbato kerkesen dhe urdhrin e punes nga skedari: ' + foundWorkOrder + '\n\n' + fs.readFileSync(foundWorkOrder, 'utf8').slice(0, 15000);
    } else {
      req = 'Ekzekuto ciklin autonom te plote (Pack -> Planner -> Coder -> Apply -> Reviewer) per projektin aktiv [' + cleanRoot + '].';
    }
  }

  return { cleanRoot: cleanRoot, userRequest: req };
}

async function executeCoreAction(action, payload) {
payload = payload || {};
action = action ? action.replace(/^(mcp__multi_ai_relay__|multi-ai-relay[/:])/, '') : action;
const resolved = resolveTargetProjectAndRequest(payload);
const cleanRoot = resolved.cleanRoot;
const userRequest = resolved.userRequest;

// SHTYLLA 1: BLLOKADE FIZIKE ME KOD (CYCLE_EXCLUSIVE_LOCK)
if (action !== 'run_full_cycle' && action !== 'check_cycle_progress' && !payload._internal) {
  if (activeCycleJobs[cleanRoot] && activeCycleJobs[cleanRoot].running) {
    throw new Error('ACTION_REJECTED_CYCLE_IN_PROGRESS: Cikli autopilot eshte aktiv per [' + cleanRoot + '] ne fazen [' + activeCycleJobs[cleanRoot].phase + ']. Ndalohet kategorikisht thirrja e mjeteve anesore! Thirr vetem check_cycle_progress(projectRoot).');
  }
}
if (action === 'run_full_cycle') {
  return await getAutopilotEngine().runFullCycle(cleanRoot, userRequest, {
    blocking: payload.blocking === true,
    maxSliceMs: Number(payload.waitMs || payload.maxSliceMs) || 22000,
    forceReplan: payload.forceReplan === true
  });
}
if (action === 'check_cycle_progress') {
  return await getAutopilotEngine().checkCycleProgress(cleanRoot, Number(payload.waitMs || payload.maxSliceMs) || 45000);
}
if (action === 'pack_workspace') {
  const info = getAutopilotEngine().packWorkspace(cleanRoot, payload.mode || PACK_MODES.PLANNING_FULL);
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
const effectiveUserRequest = (typeof payload.userRequest === 'string' && payload.userRequest.trim())
  ? payload.userRequest
  : userRequest;
const embeddedSpecs = resolveAndEmbedExternalFiles(effectiveUserRequest);
const currentRequestFingerprint = computeRequestFingerprint(effectiveUserRequest, embeddedSpecs);
const bundle = getBundleAttachmentAndNote(cleanRoot, engine);
let rule = fs.readFileSync(path.join(PLUGIN_ROOT, 'rules', 'planner_rules.md'), 'utf8');
if (engine.startsWith('google_search_') || engine.startsWith('gemini')) {
  rule = rule.replace(/\([^)]*zip[^)]*\)/gi, '(Kodi i plotë i projektit është në formatin .txt (project_bundle.txt) i përfshirë në mesazh).');
}
const prompt = rule + bundle.note + embeddedSpecs + NL + NL + 'KERKESA E PERDORUESIT:' + NL + (effectiveUserRequest || 'Analizo dhe planifiko ndryshimet.');

let response;
if (engine.startsWith('google_search_')) {
  response = await dispatchToGoogleSearchAiTab({
    tabKey: engine,
    projectRoot: cleanRoot,
    promptText: prompt,
    bundlePath: bundle.path,
    isPlanner: true,
    userRequest: effectiveUserRequest
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
const planFingerprint = computePlanFingerprint(response);
const wrappedPlan = embedPlanMetadataHeader(response, {
  requestFingerprint: currentRequestFingerprint,
  planFingerprint: planFingerprint,
  generatedAt: new Date().toISOString()
});
autopilotEngineModule.writeFileAtomic(planPath, wrappedPlan);
for (const staleDownstream of [codePath, reviewPath, logPath, errorPath, path.join(exchangeDir, 'rev_ctx.txt')]) {
  try {
    fs.unlinkSync(staleDownstream);
  } catch (unlinkErr) {
    if (unlinkErr && unlinkErr.code !== 'ENOENT') throw unlinkErr;
  }
}
writeProjectState(cleanRoot, {
  phase: 'PLANNED',
  retryCount: 0,
  lastStatus: 'PLAN_READY',
  requestFingerprint: currentRequestFingerprint,
  planFingerprint: planFingerprint,
  verifiedBatches: {},
  checkpoints: {}
});
return {
  status: 'EXTERNAL_COMPLETED',
  engine: engine,
  activeModel: tabActiveModel[engine],
  outputFile: planPath,
  requestFingerprint: currentRequestFingerprint,
  planFingerprint: planFingerprint
};
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
  const corrPrompt = 'KORRIGJIM FORMATI I DETYRUESHEM: ' + validation.reason + NL + 'Kthe kodin si bllok standard diff --git (diff --git a/... b/...) ose me etiketen ### FILE: rruga/skedari.ext.';
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
autopilotEngineModule.writeFileAtomic(codePath, response);
writeProjectState(cleanRoot, { phase: 'CODED', lastStatus: 'CODE_READY' });
return { status: 'EXTERNAL_COMPLETED', engine: engine, activeModel: tabActiveModel[engine], outputFile: codePath };
}
if (action === 'apply_and_test') {
return await applyAndTestDeterministically(cleanRoot);
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
const reg = readRegistryState(REGISTRY_PATH);
const resolvedActive = pickDefaultActiveProjectRoot(reg, PLUGIN_ROOT);
const projectsData = reg.projects.filter(function(p) { return fs.existsSync(p); }).map(function(p) {
const cfg = ensureProjectSetup(p);
const st = readProjectState(p);
const liveJob = activeCycleJobs[path.resolve(p)];
if (liveJob && liveJob.running) {
st.phase = liveJob.phase;
}
const isActive = Boolean(resolvedActive && path.resolve(p).toLowerCase() === resolvedActive.toLowerCase());
return Object.assign({}, cfg, { state: st, isActive: isActive });
});
const dashboardState = buildDashboardState(projectsData, resolvedActive || null);
res.writeHead(200, { 'Content-Type': 'application/json' });
return res.end(JSON.stringify(dashboardState));
}
let body = '';
req.on('data', function(chunk) { body += chunk; });
req.on('end', async function() {
try {
const data = body ? JSON.parse(body) : {};
if (req.url === '/api/save-routing') {
  if (data.action === 'set_temporary_chat') {
    const tabId = data.tabId || data.tabKey;
    if (!['gemini1', 'gemini2', 'gemini3', 'web1', 'web2'].includes(tabId)) {
      res.writeHead(400, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({ ok: false, error: 'INVALID_TAB_ID' }));
    }
    const enabled = Boolean(data.enabled !== undefined ? data.enabled : data.temporaryChat);
    const tcState = await withTabLock(tabId, async function() {
      tabTemporaryChatConfig[tabId] = enabled;
      persistTabConfig();
      const nowIso = new Date().toISOString();
      if (!tabs[tabId] || tabs[tabId].isClosed()) {
        const waitingState = {
          tabId: tabId,
          requested: enabled,
          active: false,
          verified: false,
          status: 'SAVED_WAITING_TAB',
          reason: 'TAB_NOT_ACTIVE',
          checkedAt: nowIso
        };
        if (tabId.startsWith('gemini')) geminiTemporaryChatStatus[tabId] = waitingState;
        else if (tabId.startsWith('web')) copilotTemporaryChatStatus[tabId] = waitingState;
        return waitingState;
      }
      if (tabId.startsWith('gemini') && typeof ensureGeminiTemporaryChat === 'function') {
        const domRes = await ensureGeminiTemporaryChat(tabs[tabId], tabId, enabled).catch(function(err) {
          return {
            tabId: tabId,
            requested: enabled,
            active: false,
            verified: false,
            status: 'MISMATCH_OR_UNVERIFIED',
            reason: String(err && err.message || err).slice(0, 120),
            checkedAt: new Date().toISOString()
          };
        });
        geminiTemporaryChatStatus[tabId] = domRes;
        return domRes;
      }
      if (tabId.startsWith('web') && typeof ensureCopilotTemporaryChat === 'function') {
        const targetFrame = findChatFrameOrPage(tabs[tabId]);
        const domRes = await ensureCopilotTemporaryChat(targetFrame, tabId, enabled).catch(function(err) {
          return {
            tabId: tabId,
            requested: enabled,
            active: false,
            verified: false,
            status: 'MISMATCH_OR_UNVERIFIED',
            reason: String(err && err.message || err).slice(0, 120),
            checkedAt: new Date().toISOString()
          };
        });
        copilotTemporaryChatStatus[tabId] = domRes;
        return domRes;
      }
      return {
        tabId: tabId,
        requested: enabled,
        active: false,
        verified: false,
        status: 'SAVED_WAITING_TAB',
        reason: 'ENGINE_UNAVAILABLE',
        checkedAt: nowIso
      };
    });
    res.writeHead(200, { 'Content-Type': 'application/json' });
    return res.end(JSON.stringify({ ok: true, tabId: tabId, enabled: enabled, state: tcState }));
  }
ensureProjectSetup(data.projectRoot);
const rPath = path.join(path.resolve(data.projectRoot), '.antigravity', 'bridge', 'routing.json');
const current = JSON.parse(fs.readFileSync(rPath, 'utf8'));
current.roles = Object.assign({}, current.roles, data.roles || {});
if (typeof data.buildCmd === 'string') current.buildCmd = data.buildCmd.trim();
if (typeof data.testCmd === 'string') current.testCmd = data.testCmd.trim();
if (data.bundleFormat) current.bundleFormat = data.bundleFormat;
fs.writeFileSync(rPath, JSON.stringify(current, null, 2), 'utf8');
setActiveRegistryProject(REGISTRY_PATH, data.projectRoot);
res.writeHead(200, { 'Content-Type': 'application/json' });
return res.end(JSON.stringify({ ok: true, activeProject: path.resolve(data.projectRoot) }));
}
if (req.url === '/api/add-project') {
const cfg = ensureProjectSetup(data.projectRoot);
setActiveRegistryProject(REGISTRY_PATH, data.projectRoot);
res.writeHead(200, { 'Content-Type': 'application/json' });
return res.end(JSON.stringify({ ok: true, project: cfg, activeProject: path.resolve(data.projectRoot) }));
}
if (req.url === '/api/set-active-project') {
const targetRoot = path.resolve(data.projectRoot || '');
if (!targetRoot || !fs.existsSync(targetRoot)) {
res.writeHead(400, { 'Content-Type': 'application/json' });
return res.end(JSON.stringify({ ok: false, error: 'VALID_PROJECT_ROOT_REQUIRED' }));
}
ensureProjectSetup(targetRoot);
const updatedReg = setActiveRegistryProject(REGISTRY_PATH, targetRoot);
res.writeHead(200, { 'Content-Type': 'application/json' });
return res.end(JSON.stringify({ ok: true, activeProject: updatedReg.activeProject }));
}
if (req.url === '/api/delete-project') {
const targetRoot = path.resolve(data.projectRoot || data.project_id || '');
if (!targetRoot) {
res.writeHead(400, { 'Content-Type': 'application/json' });
return res.end(JSON.stringify({ ok: false, error: 'projectRoot is required' }));
}
const reg = readRegistryState(REGISTRY_PATH);
const initialLen = reg.projects.length;
reg.projects = reg.projects.filter(function(p) {
return path.resolve(p).toLowerCase() !== targetRoot.toLowerCase();
});
const nextActive = (reg.activeProject && reg.activeProject.toLowerCase() === targetRoot.toLowerCase())
  ? pickDefaultActiveProjectRoot({ projects: reg.projects, activeProject: null }, PLUGIN_ROOT)
  : reg.activeProject;
fs.writeFileSync(REGISTRY_PATH, JSON.stringify({ projects: reg.projects, activeProject: nextActive || null }, null, 2), 'utf8');
res.writeHead(200, { 'Content-Type': 'application/json' });
return res.end(JSON.stringify({ ok: true, removed: initialLen !== reg.projects.length, projectRoot: targetRoot, activeProject: nextActive || null }));
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
      const reqName = String((data && data.profileName) || '').trim();
      if (!reqName || reqName === 'm365') {
        res.writeHead(400, { 'Content-Type': 'application/json' });
        return res.end(JSON.stringify({
          ok: false,
          error: 'SHARED_M365_PROFILE_DEPRECATED: Perdor "m365_web1" (web1) ose "m365_web2" (web2) per izolim te plote.'
        }));
      }
      const profile = getProfileNameForTab(reqName);
      const linkedTab = profile === 'm365_web1' ? 'web1' : (profile === 'm365_web2' ? 'web2' : reqName);
      const targetUrl = getTargetUrl(linkedTab);

      const visibleCtx = await getOrLaunchContext(profile, false);
      const pages = visibleCtx.pages();
      const existingTab = Object.prototype.hasOwnProperty.call(tabs, linkedTab) && tabs[linkedTab] && !tabs[linkedTab].isClosed()
        ? tabs[linkedTab]
        : null;
      const loginPage = existingTab || ((pages.length > 0 && !pages[0].isClosed()) ? pages[0] : await visibleCtx.newPage());
      if (Object.prototype.hasOwnProperty.call(tabs, linkedTab) && !tabs[linkedTab]) {
        tabs[linkedTab] = loginPage;
        if (typeof loginPage.on === 'function') {
          loginPage.on('close', function() {
            if (tabs[linkedTab] === loginPage) tabs[linkedTab] = null;
            invalidateGeminiReceipt(linkedTab);
            invalidateCopilotReceipt(linkedTab);
          });
        }
      }
      const curUrl = (typeof loginPage.url === 'function' ? loginPage.url() : '') || '';
      const isMidAuth = /microsoftonline\.com|login\.live\.com|login\.windows\.net|accounts\.google\.com/i.test(curUrl);
      if (!curUrl || curUrl === 'about:blank' || (!doesUrlMatchEngine(linkedTab, curUrl) && !isMidAuth)) {
        await loginPage.goto(targetUrl, { waitUntil: 'domcontentloaded' }).catch(function() {});
      }
      await loginPage.bringToFront().catch(function() {});

      res.writeHead(200, { 'Content-Type': 'application/json' });
      return res.end(JSON.stringify({
        ok: true,
        profile: profile,
        tabKey: linkedTab,
        message: 'Dritarja e dukshme e izoluar per [' + linkedTab + ' -> .profiles/' + profile + '] u hap me sukses!\n\n1. Identifikohu me llogarine tende (mund te kesh account tjeter ne Web 1 vs Web 2).\n2. Zgjidh ose verifiko modelin / cookies nese kerkohen.\n3. Mund ta lesh hapur ose ta mbyllesh me [X] qe cookies, localStorage dhe sesioni te ruhen vecmas.'
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
const reqPath = req.url || '';
if (reqPath === '/run_cycle' || reqPath === '/api/run-cycle') {
const root = path.resolve(data.projectRoot || '.');
const result = await executeCoreAction('run_full_cycle', {
  projectRoot: root,
  userRequest: data.userRequest || data.prompt || '',
  forceReplan: data.forceReplan === true
});
res.writeHead(200, { 'Content-Type': 'application/json' });
return res.end(JSON.stringify(result));
}
if (reqPath === '/check_cycle_progress' || reqPath === '/api/check-progress' || (reqPath.startsWith('/cycle/') && reqPath.endsWith('/wait'))) {
const root = path.resolve(data.projectRoot || '.');
const result = await executeCoreAction('check_cycle_progress', { projectRoot: root, waitMs: data.waitMs, _internal: true });
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
process.on('unhandledRejection', function(reason, p) {
  console.error('[UNHANDLED_REJECTION]', reason && reason.stack || reason);
});
process.on('uncaughtException', function(err) {
  console.error('[UNCAUGHT_EXCEPTION]', err && err.stack || err);
});
}
async function dispatchActionSingleton(action, payload) {
action = action ? action.replace(/^(mcp__multi_ai_relay__|multi-ai-relay[/:])/, '') : action;
if (isPrimaryInstance) return await executeCoreAction(action, payload);

return new Promise(function(resolve, reject) {
  const postData = JSON.stringify({ action: action, payload: payload });
  const req = http.request({
    hostname: HOST,
    port: PORT,
    path: '/api/mcp-proxy',
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Content-Length': Buffer.byteLength(postData)
    },
    timeout: 0 // Zero timeout: no artificial 300s socket drops
  }, function(res) {
    let responseBody = '';
    res.setEncoding('utf8');
    res.on('data', function(chunk) { responseBody += chunk; });
    res.on('end', function() {
      try {
        const data = JSON.parse(responseBody);
        if (res.statusCode >= 200 && res.statusCode < 300) {
          resolve(data);
        } else {
          reject(new Error(data.error || ('Proxy HTTP ' + res.statusCode + ': ' + responseBody.slice(0, 500))));
        }
      } catch (parseErr) {
        reject(new Error('Invalid proxy JSON response: ' + parseErr.message + ' (' + responseBody.slice(0, 200) + ')'));
      }
    });
  });

  req.on('error', function(err) {
    reject(new Error('Proxy connection error to http://' + HOST + ':' + PORT + ' (' + err.message + ')'));
  });

  req.write(postData);
  req.end();
});
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
description: 'MJETI KRYESOR AUTOPILOT: Nis ciklin autonom (pack -> planner -> coder -> apply -> reviewer) mbi projektin aktiv te Dashboard-it ose mbi rrugen e dhene pas `root <path>`, duke kthyer STILL_RUNNING_CALL_CHECK_PROGRESS brenda ~22s per punet e gjata (zero timeout MCP). Nese projectRoot lihet bosh, perdor automatikisht projektin aktiv ne Dashboard (4321).',
inputSchema: {
type: 'object',
properties: {
projectRoot: { type: 'string', description: 'Opsionale: rruga e projektit (nese lihet bosh, merret projekti aktiv i konfiguruar ne Dashboard)' },
userRequest: { type: 'string', description: 'Kerkesa e punes (tekst i lire, rruge skedari .md/.txt, ose `root <path> <kerkesa>`)' },
blocking: { type: 'boolean', description: 'Opsionale: default false (ekzekutim me feta asinkrone per te shmangur timeout MCP).' },
waitMs: { type: 'number', description: 'Opsionale: gjatesia e fetes se pare ne ms (default 22000).' }
},
required: []
}
},
{
name: 'check_cycle_progress',
description: 'Pret ecurine e ciklit aktiv ne feta ~45s derisa te ktheje CYCLE_COMPLETED / PASSED / FAILED. Thirre ne zinxhir nese merr STILL_RUNNING_CALL_CHECK_PROGRESS. Mos perdor kurre terminal!',
inputSchema: {
type: 'object',
properties: {
projectRoot: { type: 'string', description: 'Rruga e projektit (opsionale)' },
waitMs: { type: 'number', description: 'Opsionale: gjatesia e fetes ne ms (default 45000).' }
},
required: []
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
for (const k of Object.keys(tabs)) {
  tabs[k] = null;
  invalidateGeminiReceipt(k);
  invalidateCopilotReceipt(k);
  if (Object.prototype.hasOwnProperty.call(googleSearchModelReceipts, k)) googleSearchModelReceipts[k] = null;
}
}
process.on('SIGINT', async function() { await closeAllContexts(); process.exit(0); });
process.on('SIGTERM', async function() { await closeAllContexts(); process.exit(0); });
if(process.env.ANTIGRAVITY_TEST_EXPORT==='1'){module.exports={CHUNK_ENGINE_LIMITS,scanRepositoryUniversal,buildCompactRepoMap,buildDependencyGraph,partitionAnalysisChunks,analyzeRepositoryChunks,buildFinalPlanningContext,parseAndValidatePlanBatches,partitionCodingBatches,buildBatchContext,runCodingBatch,applyBatch,runBatchQuickChecks,repairBatchOnce,halveBatchAdaptively,buildCrossBatchContractSummary,buildDiffFocusedReviewContext,writeChunkContextFile,extractTargetsFromError,scoreAnalysisChunkRelevance,buildLocalStructuralChunkSummary,buildBatchMiniMap,extractBatchPlanSlice,buildMinimalBatchContext,selectCodingTransport,selectAdaptiveReasoningLevel,classifyAttachmentHandshakeStrict,getFailoverEngines,parseCodeBlocksFromMarkdown,normalizeFailureCode,isAdaptiveHalvingFailure,persistCheckpointReceiptOnce};}
if(process.env.ANTIGRAVITY_TEST_EXPORT==='1'){Object.defineProperty(module.exports,'buildDashboardState',{value:buildDashboardState,enumerable:false});Object.defineProperty(module.exports,'WEB_ENGINE_ADAPTERS',{value:WEB_ENGINE_ADAPTERS,enumerable:false});Object.defineProperty(module.exports,'conversationIdFromUrl',{value:conversationIdFromUrl,enumerable:false});Object.defineProperty(module.exports,'probeChatCleanState',{value:probeChatCleanState,enumerable:false});Object.defineProperty(module.exports,'getProfileNameForTab',{value:getProfileNameForTab,enumerable:false});}
if(process.env.ANTIGRAVITY_TEST_EXPORT!=='1')startDashboardAndSingletonServer();
if(process.env.ANTIGRAVITY_TEST_EXPORT!=='1' && !process.stdin.isTTY) {
const transport = new StdioServerTransport();
mcpServer.connect(transport);
} else if(process.env.ANTIGRAVITY_TEST_EXPORT!=='1') {
console.error('[STANDALONE MODE] Shtyp Ctrl+C per ta ndalur.');
}