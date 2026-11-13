# DOKUMENTI BAZË I PLUGIN-IT: MULTI-AI ORCHESTRATOR BRIDGE
**VERSIONI:** 3.2 FULL-CODE (100% STANDALONE, ZERO-TOKEN RELAY & EXECUTOR, 5-TAB POOL, DASHBOARD & SCORE ENGINE)

---

## 1. HYRJE, QËLLIMI DHE IZOLIMI FIZIK I SISTEMIT

Ky dokument shërben si specifikim teknik dhe kod i plotë ndërtimi për plugin-in e integruar në **Google Antigravity për PC**. Qëllimi kryesor është menaxhimi i ciklit të plotë të zhvillimit (Planifikim -> Kodim -> Aplikim & Testim -> Kontroll Cilësor `PASSED`) përmes një arkitekture të padukshme në sfond (**Headless Chromium Pool + Mini Web Dashboard në `http://127.0.0.1:4321`**) me **zero djegie kreditesh në IDE**.

### Rregulli i Artë i Mos-Ndërhyrjes (100% Standalone)
Ky plugin funksionon si sistem krejtësisht më vete brenda Antigravity-t:
- **Zero Përplasje Portash:** Përdor vetëm portën lokale `127.0.0.1:4321` për Dashboard-in dhe Singleton Proxy-n e tij. **Nuk prek kurrë** portat e sistemeve të tjera në PC (`15550`, `15555`, `15556`, `18000`, `19000`, `19005`).
- **Zero Përplasje Profilesh:** Të 4 profilet e shfletuesit ruhen ekskluzivisht brenda dosjes lokale të plugin-it (`.antigravity/plugins/multi-ai-orchestrator-bridge/.profiles/`). Nuk lexon dhe nuk modifikon kurrë `%LOCALAPPDATA%\HermesWebBridge` apo Chrome-in personal të përdoruesit.
- **Zero Kill Global:** Komanda `Kill & Restart Engine` mbyll vetëm kontekstet e veta Playwright në memorie, pa ekzekutuar kurrë `taskkill /IM chrome.exe` në Windows.

### Kapaciteti i 5 Fletëve + Opsioni Lokal
Sistemi menaxhon 5 fleta të jashtme AI me serializim kërkesash (**Tab Mutex**):
- **M365 Copilot Web:** `web1` dhe `web2` (në profilin e izoluar `m365` në `https://m365.cloud.microsoft/chat`)
- **Google Gemini Pro:** `gemini1`, `gemini2` dhe `gemini3` (në 3 profile fizike të ndara në `https://gemini.google.com/app`)
- **Opsioni Lokal:** `⚡ antigravity` në çdo Dropdown roli kur përdoruesi zgjedh ekzekutim lokal.

Çdo motor i jashtëm detyrohet automatikisht përmes sistemit të pikëve (`model_scores.json`) të punojë vetëm në modelin më të lartë llogaritës (**Thinking / Think Deeper / 3.1 Pro / GPT-5.6 Sol** — duke skualifikuar opsionet e bllokuara `disabled`, `Deep Research`, `Auto` dhe `Fast/Flash`). Ndërsa aplikimi i skedarëve dhe testimet në terminal kryhen me **0 tokena nga motori deterministik Node.js (`apply_and_test`)**, duke përdorur Agjentin `executor` vetëm si fallback.

---

## 2. ARKITEKTURA DHE STRUKTURA E DOSJEVE TË PLUGIN-IT

### Vendndodhja globale e plugin-it në PC
```text
.antigravity/plugins/multi-ai-orchestrator-bridge/
```

### Struktura e plotë e skedarëve brenda plugin-it
```text
multi-ai-orchestrator-bridge/
├── plugin.json                      # Manifesti kryesor i plugin-it V3.2
├── projects_registry.json           # Regjistri automatik i projekteve për Dashboard-in
├── .profiles/                       # 4 profile fizike 100% të izoluara (m365, gemini1, gemini2, gemini3)
├── agents/
│   ├── orchestrator.md              # Rregullat e Orchestrator-it Zero-Token
│   └── executor.md                  # Rregullat e Fallback Executor-it lokal
├── mcp/
│   ├── package.json                 # Varësitë për Playwright, Adm-Zip dhe MCP SDK
│   ├── model_scores.json            # Tabela e pikëve (Thinking/Think Deeper vs Auto/Flash/Deep Research)
│   ├── server.js                    # Serveri Node.js: MCP + HTTP 4321 + 5-Tab Pool + 0-Token Applier
│   └── dashboard.html               # Ndërfaqja grafike lokale në http://127.0.0.1:4321
├── rules/
│   ├── planner_rules.md             # Rregullat universale për rolin Planifikues/Arkitekt
│   ├── coder_rules.md               # Rregullat universale për rolin Kodues/Worker
│   ├── reviewer_rules.md            # Rregullat për Release Gate (PASSED / FAILED)
│   └── zero_token_protocol.md       # Protokolli i shkëmbimit me skedarë në disk
└── skills/
    └── run-cycle/
        └── SKILL.md                 # Procedura e plotë e ciklit të mbyllur (/run-cycle)
```

### Struktura e izoluar që krijohet automatikisht brenda çdo projekti target
```text
<Project-Root>/.antigravity/bridge/
├── routing.json                     # Rolet, komandat Build/Test dhe preferencat nga Dashboard-i
├── state.json                       # Gjendja deterministe e ciklit dhe numëruesi i Auto-Heal (max 2)
└── exchange/
    ├── project_bundle.txt           # Paketa e filtruar (FULL ose DELTA) me rrugë të pastra "/"
    ├── project_bundle.zip           # Arkivi binar kur aktivizohet paketimi ZIP për M365
    ├── project_bundle.zip.md        # Kopja byte-identike me prapashtesën .md për M365 Copilot
    ├── plan.md                      # Plani arkitekturor i validuar nga Planner
    ├── code.md                      # Kodi i pastër Markdown (pa Thinking dhe pa placeholder-a)
    ├── build_test.log               # Log-u real i ekzekutimit të Build + Test nga Node.js
    ├── review.md                    # Verdikti i Release Gate (STATUS: APPROVED / PASSED ose korrigjimet)
    └── last_error.txt               # Gabimi i kompresuar (10k head + 10k tail) për Auto-Heal
```

---

## 3. SKEDARËT E KONFIGURIMIT (`plugin.json`, `package.json` & `model_scores.json`)

### SKEDARI 1: `plugin.json`
```json
{
  "name": "multi-ai-orchestrator-bridge",
  "version": "3.2.0",
  "description": "Standalone 5-Tab Multi-AI Bridge (2x M365 + 3x Gemini Pro) with 127.0.0.1:4321 dashboard, score-based Thinking mode, and 0-token Node.js deterministic executor.",
  "agents": {
    "orchestrator": "agents/orchestrator.md",
    "executor": "agents/executor.md"
  },
  "mcpServers": {
    "multi-ai-relay": {
      "command": "node",
      "args": ["mcp/server.js"]
    }
  },
  "rules": [
    "rules/planner_rules.md",
    "rules/coder_rules.md",
    "rules/reviewer_rules.md",
    "rules/zero_token_protocol.md"
  ],
  "skills": [
    "skills/run-cycle/SKILL.md"
  ]
}
```

### SKEDARI 2: `mcp/package.json`
```json
{
  "name": "multi-ai-orchestrator-mcp",
  "version": "3.2.0",
  "private": true,
  "dependencies": {
    "@modelcontextprotocol/sdk": "^1.0.1",
    "adm-zip": "^0.5.16",
    "playwright": "^1.49.0"
  }
}
```

### SKEDARI 3: `mcp/model_scores.json`
*(Përditësuar që të zgjedhë `3.1 Pro` / `Thinking` / `GPT-5.6 Sol Think Deeper`, dhe të refuzojë kategorikisht `Deep Research`, `Auto`, `Quick Response`, `Flash` dhe opsionet e bllokuara pa kredite).*

```json
{
  "positiveWeights": {
    "think deeper": 160,
    "6.sol": 150,
    "5.6": 135,
    "3.1 pro": 145,
    "2.5 pro": 130,
    "sol": 115,
    "thinking": 110,
    "high": 90,
    "reasoning": 85,
    "pro": 80
  },
  "negativeWeights": {
    "deep research": -600,
    "research": -300,
    "auto": -250,
    "quick response": -250,
    "quick": -200,
    "flash": -250,
    "fast": -200,
    "lite": -250,
    "mini": -200,
    "everyday": -150,
    "standard": -50,
    "upgrade": -500,
    "locked": -500
  },
  "disqualifySelectors": [
    "[disabled]",
    "[aria-disabled='true']",
    ".is-disabled",
    ".mat-mdc-menu-item-disabled"
  ],
  "minimumAcceptableScore": 75
}
```


## 4. SERVERI I PLOTË MCP + HTTP DASHBOARD + 0-TOKEN ENGINE (`mcp/server.js`)

Ky skript mban Singleton Lock (`127.0.0.1:4321`), menaxhon 4 profile fizike 100% të ndara Chromium pa prekur asnjë portë tjetër në PC, serializon thirrjet me `tabLocks` (Mutex), detyron modelin me pikët më të larta, ngarkon skedarët në 0.1s dhe nxjerr kodin e pastër Markdown pa prishur indentimin.

```javascript
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

if (!fs.existsSync(PROFILES_DIR)) fs.mkdirSync(PROFILES_DIR, { recursive: true });
if (!fs.existsSync(REGISTRY_PATH)) fs.writeFileSync(REGISTRY_PATH, JSON.stringify({ projects: [] }, null, 2));

// Gjendja e konteksteve, 5 fletëve, radhës Mutex dhe modeleve aktive
const contexts = {}; // m365, gemini1, gemini2, gemini3
const contextModes = {}; // 'headless' | 'visible'
const tabs = { web1: null, web2: null, gemini1: null, gemini2: null, gemini3: null };
const tabAuthStatus = { web1: 'UNKNOWN', web2: 'UNKNOWN', gemini1: 'UNKNOWN', gemini2: 'UNKNOWN', gemini3: 'UNKNOWN' };
const tabActiveModel = { web1: '-', web2: '-', gemini1: '-', gemini2: '-', gemini3: '-' };
const activeProjectPerTab = {};

// Mutex Queue për çdo fletë që dy role të mos përplasen kurrë në të njëjtin tab
const tabLocks = {
  web1: Promise.resolve(),
  web2: Promise.resolve(),
  gemini1: Promise.resolve(),
  gemini2: Promise.resolve(),
  gemini3: Promise.resolve()
};

function withTabLock(tabKey, fn) {
  const prev = tabLocks[tabKey] || Promise.resolve();
  let release;
  tabLocks[tabKey] = new Promise(r => { release = r; });
  return prev.then(() => fn()).finally(() => release());
}

function getProfileNameForTab(tabKey) {
  return tabKey.startsWith('web') ? 'm365' : tabKey;
}

function getTargetUrl(tabKey) {
  return tabKey.startsWith('gemini')
    ? 'https://gemini.google.com/app'
    : 'https://m365.cloud.microsoft/chat';
}

// Hap kontekstin e izoluar Chromium (Headless i padukshëm për punë, ose Visible për Login)
async function getOrLaunchContext(profileName, headless = true) {
  const desiredMode = headless ? 'headless' : 'visible';

  if (contexts[profileName] && contextModes[profileName] === desiredMode) {
    return contexts[profileName];
  }

  // Nëse ka mbetur hapur në modalitet tjetër (p.sh. pas Login-it), mbylle pastër para rihapjes
  if (contexts[profileName]) {
    try { await contexts[profileName].close(); } catch (_) {}
    delete contexts[profileName];
    delete contextModes[profileName];
  }

  const userDataDir = path.join(PROFILES_DIR, profileName);
  if (!fs.existsSync(userDataDir)) fs.mkdirSync(userDataDir, { recursive: true });

  const launchArgs = [
    '--disable-blink-features=AutomationControlled',
    '--disable-gpu',
    '--disable-dev-shm-usage',
    '--mute-audio',
    '--no-first-run',
    '--no-default-browser-check'
  ];

  if (headless) {
    launchArgs.push('--headless=new', '--window-position=-32000,-32000');
  }

  const ctx = await chromium.launchPersistentContext(userDataDir, {
    channel: 'chrome',
    headless: false, // Përdorim '--headless=new' te args për përputhshmëri 100% me Chrome real kundër anti-bot
    args: launchArgs,
    ignoreDefaultArgs: ['--enable-automation']
  });

  if (headless) {
    await ctx.route('**/*.{png,jpg,jpeg,gif,webp,svg,woff,woff2,mp4,mp3}', route => route.abort());
  }

  // Pastrim automatik nëse përdoruesi mbyll dritaren e Login-it me dorë
  ctx.on('close', () => {
    delete contexts[profileName];
    delete contextModes[profileName];
    for (const k of Object.keys(tabs)) {
      if (getProfileNameForTab(k) === profileName) tabs[k] = null;
    }
  });

  contexts[profileName] = ctx;
  contextModes[profileName] = desiredMode;
  return ctx;
}

// Lazy-Load i fletës specifike kur kërkohet nga roli (web1 dhe web2 hapin fleta të ndara)
async function getOrCreateTab(tabKey) {
  const profileName = getProfileNameForTab(tabKey);

  // Nëse konteksti ishte hapur për Login (visible), kalojmë automatikisht në Headless për punë
  if (contexts[profileName] && contextModes[profileName] === 'visible') {
    await getOrLaunchContext(profileName, true);
  }

  if (tabs[tabKey] && !tabs[tabKey].isClosed()) return tabs[tabKey];

  const ctx = await getOrLaunchContext(profileName, true);
  const page = await ctx.newPage();
  await page.goto(getTargetUrl(tabKey), { waitUntil: 'domcontentloaded', timeout: 45000 });
  await page.waitForTimeout(1200);
  tabs[tabKey] = page;
  return page;
}

// Kontroll i saktë i skadimit të Login-it dhe gabimeve të shfletuesit
async function checkAuthExpired(page, tabKey) {
  const url = page.url().toLowerCase();

  if (url.includes('chromewebdata') || url === 'about:blank') {
    tabAuthStatus[tabKey] = 'BROWSER_ERROR';
    throw new Error(`BROWSER_UNAVAILABLE në [${tabKey}]. Kontrollo lidhjen e internetit ose kliko Reset Tab.`);
  }

  const isLoginUrl =
    url.includes('accounts.google.com') ||
    url.includes('login.microsoftonline.com') ||
    url.includes('login.live.com') ||
    url.includes('login.windows.net');

  const hasSignInGate = await page.evaluate(() => {
    const bodyTxt = (document.body ? document.body.innerText : '').slice(0, 1500).toLowerCase();
    const hasChatBox = Boolean(document.querySelector('rich-textarea, div[contenteditable="true"], textarea'));
    if (hasChatBox) return false;
    return bodyTxt.includes('sign in to continue') || bodyTxt.includes('identifikohu');
  }).catch(() => false);

  const expired = isLoginUrl || hasSignInGate;
  tabAuthStatus[tabKey] = expired ? 'AUTH_EXPIRED' : 'ACTIVE';
  return expired;
}

// Zgjedh automatikisht modelin me pikët më të larta dhe refuzon opsionet disabled / Deep Research / Auto / Flash
async function ensureMaxReasoningMode(page, tabKey) {
  const scoresConfig = JSON.parse(fs.readFileSync(SCORES_PATH, 'utf8'));

  const selectedLabel = await page.evaluate(async ({ cfg, isGemini }) => {
    const isDisqualified = (el) => {
      if (!el) return true;
      for (const sel of (cfg.disqualifySelectors || [])) {
        if (el.matches && el.matches(sel)) return true;
        if (el.querySelector && el.querySelector(sel)) return true;
      }
      return Boolean(el.disabled || el.getAttribute('aria-disabled') === 'true');
    };

    const scoreText = (txt, el) => {
      if (el && isDisqualified(el)) return -9999;
      const lower = (txt || '').toLowerCase().trim();
      if (!lower) return -9999;
      let score = 0;
      for (const [word, pts] of Object.entries(cfg.positiveWeights)) {
        if (lower.includes(word)) score += pts;
      }
      for (const [word, pts] of Object.entries(cfg.negativeWeights)) {
        if (lower.includes(word)) score += pts;
      }
      return score;
    };

    const switcherSelectors = isGemini
      ? [
          'button[data-test-id*="model"]',
          'bard-mode-switcher button',
          'button[aria-label*="model" i]',
          '.input-area-switch button'
        ]
      : [
          'button[aria-label*="mode" i]',
          'button[aria-label*="model" i]',
          'button[aria-label*="Think" i]',
          '[data-testid*="mode-selector"]',
          '[data-testid*="model-switcher"]'
        ];

    let triggerBtn = null;
    for (const sel of switcherSelectors) {
      const el = document.querySelector(sel);
      if (el) { triggerBtn = el; break; }
    }

    if (!triggerBtn) return 'Default (No Switcher)';

    const currentLabel = (triggerBtn.innerText || triggerBtn.getAttribute('aria-label') || '').trim();
    if (scoreText(currentLabel, null) >= cfg.minimumAcceptableScore) {
      return currentLabel;
    }

    triggerBtn.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
    triggerBtn.click();
    await new Promise(r => setTimeout(r, 450));

    const menuItems = Array.from(document.querySelectorAll('[role="menuitem"], [role="menuitemradio"], [role="option"], .mat-mdc-menu-item'));
    let bestItem = null;
    let bestScore = -9999;
    let bestText = currentLabel;

    for (const item of menuItems) {
      const txt = (item.innerText || '').trim();
      const s = scoreText(txt, item);
      if (s > bestScore) {
        bestScore = s;
        bestItem = item;
        bestText = txt.split('\n')[0].trim();
      }
    }

    if (bestItem && bestScore >= cfg.minimumAcceptableScore) {
      bestItem.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
      bestItem.click();
      await new Promise(r => setTimeout(r, 300));
      return bestText;
    }

    document.body.click();
    return currentLabel || 'Unchanged';
  }, { cfg: scoresConfig, isGemini: tabKey.startsWith('gemini') });

  tabActiveModel[tabKey] = selectedLabel;
  return selectedLabel;
}

// Hap bisedë të re kur fleta ndërron projekt + konfirmon dialogun "Leave temporary chat?" në Copilot
async function resetChatIfNeeded(page, tabKey, projectRoot, force = false) {
  if (!force && activeProjectPerTab[tabKey] === projectRoot) return;

  const isGemini = tabKey.startsWith('gemini');

  await page.evaluate((gemini) => {
    const newChatSelectors = gemini
? ['a[aria-label*="New chat" i]', 'button[aria-label*="New chat" i]', '[data-test-id="new-chat-button"]']
: ['button[aria-label*="New chat" i]', 'button[title*="New chat" i]', '[data-testid*="new-chat" i]', 'a[aria-label*="New chat" i]'];
for (const sel of newChatSelectors) {
const btn = document.querySelector(sel);
if (btn) {
btn.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
btn.click();
return;
}
}
}, isGemini);
await page.waitForTimeout(550);
// Konfirmo vetëm dialogun e daljes nga biseda nëse shfaqet në M365 Copilot
if (!isGemini) {
await page.evaluate(() => {
const dialogs = Array.from(document.querySelectorAll('[role="dialog"], [role="alertdialog"], .fui-DialogSurface'));
for (const dlg of dialogs) {
const txt = (dlg.innerText || '').toLowerCase();
if (txt.includes('leave') || txt.includes('temporary chat') || txt.includes('start a new chat')) {
const confirmBtn = Array.from(dlg.querySelectorAll('button')).find(b => {
const bt = (b.innerText || '').toLowerCase();
return bt.includes('leave') || bt.includes('confirm') || bt.includes('new chat') || bt.includes('yes');
});
if (confirmBtn) confirmBtn.click();
}
}
});
await page.waitForTimeout(450);
}
activeProjectPerTab[tabKey] = projectRoot;
}
// Zbuluesi i Refuzimeve / Gabimeve të Shërbimit (që të mos ruhen si kod në code.md / plan.md)
const SERVICE_ERROR_PATTERNS = [
'oops! something happened',
"looks like i can't chat about this",
"let's try a different topic",
'i prefer not to continue this conversation',
'something went wrong'
];
// Smart Stream Detector & Nxjerrja e Pastër Markdown me textContent (Zero prishje indentimi)
async function waitAndExtractCleanResponse(page, tabKey, previousCount) {
const maxWaitMs = 240000; // Deri në 4 minuta për arsyetim të thellë Thinking / Think Deeper
const start = Date.now();
let lastText = '';
let stableTicks = 0;
while (Date.now() - start < maxWaitMs) {
await page.waitForTimeout(650);
const state = await page.evaluate(({ isGemini, prevCount }) => {
const stopBtn = document.querySelector(
'button[aria-label*="Stop" i], button[title*="Stop" i], [data-testid*="stop" i]'
);
const containers = isGemini
? Array.from(document.querySelectorAll('message-content, model-response'))
: Array.from(document.querySelectorAll('[data-testid="chat-turn-assistant"], .assistant-message, .fai-CopilotMessage, [data-content="ai-message"]'));
if (containers.length <= prevCount) {
return { generating: true, text: '' };
}
const latest = containers[containers.length - 1].cloneNode(true);
// Hiq blloqet e mendimeve të brendshme ("Thinking...") dhe elementet e UI-së
latest.querySelectorAll(
'model-thoughts, .thought-container, [data-test-id*="thought"], [data-testid*="thought"], details, button, .code-header, .footnote'
).forEach(n => n.remove());
// Rindërto blloqet e kodit me textContent që indentimi në Python/YAML/JS të mbetet 100% i paprekur
latest.querySelectorAll('pre').forEach(pre => {
const codeEl = pre.querySelector('code');
const classStr = codeEl ? (codeEl.className || '') : (pre.className || '');
const langMatch = classStr.match(/language-([a-zA-Z0-9_+-]+)/);
const lang = langMatch ? langMatch[1] : '';
const rawCode = (codeEl ? codeEl.textContent : pre.textContent) || '';
const fence = String.fromCharCode(96, 96, 96);
        const replacement = document.createTextNode('\n' + fence + lang + '\n' + rawCode.replace(/\n+$/, '') + '\n' + fence + '\n');
pre.parentNode.replaceChild(replacement, pre);
});
return {
generating: Boolean(stopBtn),
text: (latest.innerText || '').trim()
};
}, { isGemini: tabKey.startsWith('gemini'), prevCount: previousCount });
if (!state.generating && state.text.length > 0) {
if (state.text === lastText) {
stableTicks++;
if (stableTicks >= 4) {
const lower = state.text.toLowerCase();
if (state.text.length < 260 && SERVICE_ERROR_PATTERNS.some(p => lower.includes(p))) {
throw new Error('WEB_SERVICE_REFUSAL në [' + tabKey + ']: "' + state.text.slice(0, 140) + '"');
}
return state.text;
}
} else {
stableTicks = 0;
lastText = state.text;
}
} else {
stableTicks = 0;
lastText = state.text;
}
}
if (lastText && lastText.length > 20) return lastText;
throw new Error('TIMEOUT: Motori [' + tabKey + '] nuk përfundoi brenda 240 sekondave.');
}
// Ngarkim i sigurt i skedarëve në DOM pa ngjitur kurrë skedarë gjigantë si tekst në chat
async function attachFilesSafely(page, tabKey, validFiles) {
if (validFiles.length === 0) return;
let fileInput = await page.$('input[type="file"]');
// Nëse UI e fsheh input[type="file"], hap menunë e bashkëngjitjes që të krijohet në DOM
if (!fileInput) {
await page.evaluate(() => {
const attachSelectors = [
'button[aria-label*="Attach" i]',
'button[aria-label*="Add" i]',
'button[aria-label*="Upload" i]',
'[data-testid*="attach" i]',
'button.upload-card-button'
];
for (const sel of attachSelectors) {
const btn = document.querySelector(sel);
if (btn) { btn.click(); break; }
}
});
await page.waitForTimeout(450);
fileInput = await page.$('input[type="file"]');
}
if (!fileInput) {
throw new Error('FILE_INPUT_NOT_FOUND në [' + tabKey + ']. Ndërfaqja ueb nuk lejoi ngarkimin e skedarit.');
}
await fileInput.setInputFiles(validFiles);
await page.waitForTimeout(900);
}
// Dërgimi i mbrojtur me Tab Mutex, PointerEvents, mbrojtje 30k karaktere dhe 1 Auto-Retry në rast "Oops!"
async function dispatchToWebTab({ tabKey, projectRoot, promptText, attachmentPaths = [] }) {
return withTabLock(tabKey, async () => {
const safePrompt = promptText.length > 29500
? promptText.slice(0, 12000) + '\n\n...[MIDDLE COMPACTED FOR DOM STABILITY]...\n\n' + promptText.slice(-15000)
: promptText;
for (let attempt = 1; attempt <= 2; attempt++) {
const page = await getOrCreateTab(tabKey);
if (await checkAuthExpired(page, tabKey)) {
throw new Error('AUTH_EXPIRED në [' + tabKey + ']. Hap http://' + HOST + ':' + PORT + ' dhe kliko "Login Profile" për këtë llogari.');
}
const routing = ensureProjectSetup(projectRoot);
if (routing.autoNewChatOnProjectSwitch || attempt === 2) {
await resetChatIfNeeded(page, tabKey, projectRoot, attempt === 2);
}
await ensureMaxReasoningMode(page, tabKey);
const prevCount = await page.evaluate((isGemini) => {
const sel = isGemini
? 'message-content, model-response'
: '[data-testid="chat-turn-assistant"], .assistant-message, .fai-CopilotMessage, [data-content="ai-message"]';
return document.querySelectorAll(sel).length;
}, tabKey.startsWith('gemini'));
const validFiles = attachmentPaths.filter(p => p && fs.existsSync(p));
await attachFilesSafely(page, tabKey, validFiles);
// Instant Paste në editor
await page.evaluate((text) => {
const box = document.querySelector(
'rich-textarea div[contenteditable="true"], div.ql-editor[contenteditable="true"], [role="textbox"][contenteditable="true"], div[contenteditable="true"], textarea'
);
if (!box) throw new Error('CHAT_BOX_NOT_FOUND: Fusha e shkrimit nuk u gjet në DOM.');
box.focus();
if (box.tagName.toLowerCase() === 'textarea') {
box.value = text;
box.dispatchEvent(new Event('input', { bubbles: true }));
} else {
document.execCommand('selectAll', false, null);
document.execCommand('insertText', false, text);
}
}, safePrompt);
await page.waitForTimeout(250);
// Dërgo me PointerEvent dhe REFUZO rreptësisht çdo buton "Stop generating"
const sent = await page.evaluate(() => {
const candidates = Array.from(document.querySelectorAll(
'button[aria-label*="Send" i], button[aria-label*="Submit" i], button[data-testid*="send" i], button.send-button'
));
const validSendBtn = candidates.find(b => {
const lbl = ((b.getAttribute('aria-label') || '') + ' ' + (b.title || '')).toLowerCase();
return !b.disabled && !lbl.includes('stop');
});
if (validSendBtn) {
validSendBtn.dispatchEvent(new PointerEvent('pointerdown', { bubbles: true }));
validSendBtn.dispatchEvent(new PointerEvent('pointerup', { bubbles: true }));
validSendBtn.click();
return true;
}
return false;
});
if (!sent) await page.keyboard.press('Enter');
try {
return await waitAndExtractCleanResponse(page, tabKey, prevCount);
} catch (err) {
if (attempt === 1 && String(err.message).includes('WEB_SERVICE_REFUSAL')) {
continue; // Pastro bisedën dhe riprovo 1 herë automatikisht
}
throw err;
}
}
});
}

// ---------------- PJESA 2: WORKSPACE PACKER, 0-TOKEN EXECUTOR & HTTP/MCP SERVER ----------------
// Kompresori inteligjent i gabimeve të terminalit (10k head + 10k tail që të mos pritet kurrë Traceback-u)
function compactErrorLog(rawText, maxChars = 20000) {
  const clean = String(rawText || '').replace(/\\/g, '/').trim();
  if (clean.length <= maxChars) return clean;
  const half = Math.floor(maxChars / 2);
  return (
    clean.slice(0, half) +
    `\n\n... [SNIPPED ${clean.length - maxChars} CHARS OF MIDDLE NOISE] ...\n\n` +
    clean.slice(-half)
  );
}

// Menaxhimi determinist i state.json për çdo projekt (mbron nga loop-et pafund të Auto-Heal)
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
  const next = { ...readProjectState(projectRoot), ...patch, updatedAt: new Date().toISOString() };
  fs.writeFileSync(statePath, JSON.stringify(next, null, 2), 'utf8');
  return next;
}

// Krijon automatikisht strukturën lokale të projektit dhe e regjistron në Dashboard-in 127.0.0.1:4321
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
      bundleFormat: 'txt', // 'txt' ose 'zip.md' (për projekte të mëdha në M365 Copilot)
      buildCmd: '',        // p.sh. 'npm run build'
      testCmd: '',         // p.sh. 'npm test'
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

  return JSON.parse(fs.readFileSync(routingPath, 'utf8'));
}

// Paketimi i Zgjuar i Projektit (FULL ose DELTA) me rrugë "/" + opsioni .zip.md me SHA-256 identik
function packWorkspace(projectRoot, mode = 'FULL') {
  const routing = ensureProjectSetup(projectRoot);
  const cleanRoot = path.resolve(projectRoot);
  const exchangeDir = path.join(cleanRoot, '.antigravity', 'bridge', 'exchange');
  const txtPath = path.join(exchangeDir, 'project_bundle.txt');
  const zipPath = path.join(exchangeDir, 'project_bundle.zip');
  const zipMdPath = path.join(exchangeDir, 'project_bundle.zip.md');

  const ignoredDirs = new Set([
    '.git', 'node_modules', '.antigravity', '.hermes', 'dist', 'build', '.next', 'venv', '.venv', '__pycache__', 'coverage'
  ]);
  const ignoredFiles = new Set(['package-lock.json', 'yarn.lock', 'pnpm-lock.yaml', 'bun.lockb']);
  const allowedExts = new Set([
    '.js', '.mjs', '.cjs', '.ts', '.jsx', '.tsx', '.py', '.json', '.md', '.html', '.css', '.scss', '.sql', '.yaml', '.yml', '.sh', '.ps1', '.cs'
  ]);

  let deltaSet = null;
  if (mode === 'DELTA') {
    try {
      const diffOut = execSync('git diff --name-only HEAD', { cwd: cleanRoot, encoding: 'utf8' });
      const files = diffOut.split(/\r?\n/).map(s => s.trim()).filter(Boolean);
      if (files.length > 0) deltaSet = new Set(files.map(f => path.resolve(cleanRoot, f)));
    } catch (_) { /* Fallback në FULL nëse s'ka Git */ }
  }

  let output = `=== PROJECT BUNDLE (${mode}) | PROJECT: ${path.basename(cleanRoot)} ===\n`;
  const collectedFiles = [];

  function walk(dir) {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (!ignoredDirs.has(entry.name)) walk(full);
      } else if (entry.isFile()) {
        if (ignoredFiles.has(entry.name)) continue;
        if (!allowedExts.has(path.extname(entry.name).toLowerCase())) continue;
        const stat = fs.statSync(full);
        if (stat.size > 500 * 1024) continue;
        if (deltaSet && !deltaSet.has(path.resolve(full))) continue;

        // Përdor gjithmonë "/" për të shmangur filtrat e sigurisë në M365 Copilot
        const relNormalized = path.relative(cleanRoot, full).replace(/\\/g, '/');
        const content = fs.readFileSync(full, 'utf8');
        output += `\n--- FILE: ${relNormalized} ---\n${content}\n`;
        collectedFiles.push({ relNormalized, content });
      }
    }
  }

  walk(cleanRoot);
  fs.writeFileSync(txtPath, output, 'utf8');

  let sha256 = null;
  if (routing.bundleFormat === 'zip.md') {
    const zip = new AdmZip();
    for (const f of collectedFiles) {
      zip.addFile(f.relNormalized, Buffer.from(f.content, 'utf8'));
    }
    zip.writeZip(zipPath);
    fs.copyFileSync(zipPath, zipMdPath); // Kopje byte-identike me prapashtesën .md
    sha256 = crypto.createHash('sha256').update(fs.readFileSync(zipMdPath)).digest('hex');
  }

  writeProjectState(cleanRoot, { phase: 'PACKED', retryCount: 0, lastStatus: 'BUNDLE_READY' });
  return {
    bundlePath: routing.bundleFormat === 'zip.md' ? zipMdPath : txtPath,
    format: routing.bundleFormat || 'txt',
    fileCount: collectedFiles.length,
    sha256
  };
}

function getBundleAttachmentAndNote(projectRoot) {
  const routing = ensureProjectSetup(projectRoot);
  const exchangeDir = path.join(path.resolve(projectRoot), '.antigravity', 'bridge', 'exchange');
  const txtPath = path.join(exchangeDir, 'project_bundle.txt');
  const zipMdPath = path.join(exchangeDir, 'project_bundle.zip.md');

  if (routing.bundleFormat === 'zip.md') {
    if (!fs.existsSync(zipMdPath)) packWorkspace(projectRoot, 'FULL');
    const hash = crypto.createHash('sha256').update(fs.readFileSync(zipMdPath)).digest('hex');
    const note = `\n\nUDHËZIM PËR SKEDARIN E BASHKËNGJITUR (project_bundle.zip.md):\nSkedari \`project_bundle.zip.md\` është arkiv binar real .zip (SHA-256: ${hash}) me prapashtesën .md për transport. Hiq prapashtesën finale .md dhe hape si .zip normal për të lexuar skedarët e projektit.\n`;
    return { path: zipMdPath, note };
  }

  if (!fs.existsSync(txtPath)) packWorkspace(projectRoot, 'FULL');
  return { path: txtPath, note: '' };
}

// Validues 0-Kredi që refuzon kodin bosh ose me placeholder-a ("// TODO", "// ... rest of code")
function validateGeneratedCodeMarkdown(markdown) {
  const fileBlocks = parseCodeBlocksFromMarkdown(markdown);
  if (fileBlocks.length === 0) {
    return { valid: false, reason: 'Mungojnë blloqet e skedarëve me etiketën "### FILE: path/to/file.ext".' };
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
        return { valid: false, reason: `Placeholder i ndaluar u gjet në skedarin "${b.relPath}". Kërkohet kod 100% i plotë.` };
      }
    }
  }
  return { valid: true, fileBlocks };
}

// Parser deterministik që nxjerr çdo "### FILE: path/to/file" dhe bllokun e kodit pasues
function parseCodeBlocksFromMarkdown(markdown) {
  const results = [];
  const f3 = String.fromCharCode(96, 96, 96);
  const regex = new RegExp('###\\s*FILE:\\s*([^\\r\\n`]+)\\r?\\n+' + f3 + '[a-zA-Z0-9_+-]*\\r?\\n([\\s\\S]*?)' + f3, 'g');
  let match;
  while ((match = regex.exec(markdown)) !== null) {
    const rawPath = match[1].trim().replace(/^['"`]|['"`]$/g, '').replace(/\\/g, '/').replace(/^\/+/, '');
    const code = match[2];
    if (rawPath) results.push({ relPath: rawPath, code });
  }
  return results;
}

// 0-TOKEN DETERMINISTIC EXECUTOR: Shkruan skedarët në disk me mbrojtje Path-Traversal & ekzekuton Build/Test
function applyAndTestDeterministically(projectRoot) {
  const routing = ensureProjectSetup(projectRoot);
  const cleanRoot = path.resolve(projectRoot);
  const exchangeDir = path.join(cleanRoot, '.antigravity', 'bridge', 'exchange');
  const codePath = path.join(exchangeDir, 'code.md');
  const logPath = path.join(exchangeDir, 'build_test.log');
  const errorPath = path.join(exchangeDir, 'last_error.txt');

  if (!fs.existsSync(codePath)) {
    throw new Error('Skedari exchange/code.md nuk ekziston ende. Ekzekuto run_coder fillimisht.');
  }

  const rawMarkdown = fs.readFileSync(codePath, 'utf8');
  const check = validateGeneratedCodeMarkdown(rawMarkdown);
  if (!check.valid) {
    return {
      status: 'DELEGATE_FALLBACK_EXECUTOR',
      reason: check.reason,
      codeFile: codePath
    };
  }

  const writtenFiles = [];
  for (const item of check.fileBlocks) {
    const targetAbs = path.resolve(cleanRoot, item.relPath);
    // Mbrojtje strikte kundër Path Traversal jashtë projektit
    if (!targetAbs.startsWith(cleanRoot + path.sep) && targetAbs !== cleanRoot) {
      throw new Error(`SECURITY_BLOCK: Tentativë shkrimi jashtë projectRoot: ${item.relPath}`);
    }
const parentDir = path.dirname(targetAbs);
if (!fs.existsSync(parentDir)) fs.mkdirSync(parentDir, { recursive: true });
fs.writeFileSync(targetAbs, item.code, 'utf8');
writtenFiles.push(item.relPath);
}
const commands = [routing.buildCmd, routing.testCmd].map(c => (c || '').trim()).filter(Boolean);
let combinedLogs = '=== DETERMINISTIC APPLY COMPLETED (' + writtenFiles.length + ' files) ===\nFiles: ' + writtenFiles.join(', ') + '\n';
for (const cmd of commands) {
combinedLogs += '\n$ ' + cmd + '\n';
const run = spawnSync(cmd, {
cwd: cleanRoot,
shell: true,
encoding: 'utf8',
timeout: 180000
});
const out = (run.stdout || '') + '\n' + (run.stderr || '');
combinedLogs += out;
if (run.status !== 0) {
const compacted = compactErrorLog('COMMAND FAILED: ' + cmd + '\nEXIT_CODE: ' + run.status + '\n\n' + out);
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
return {
status: 'APPLIED_AND_GREEN',
writtenFiles,
commandsExecuted: commands,
logFile: logPath
};
}
// Ekzekutuesi qendror i komandave (Thërritet direkt ose përmes Singleton HTTP Proxy)
async function executeCoreAction(action, payload) {
const { projectRoot } = payload;
if (action === 'pack_workspace') {
const info = packWorkspace(projectRoot, payload.mode || 'FULL');
return { status: 'SUCCESS', ...info };
}
const routing = ensureProjectSetup(projectRoot);
const cleanRoot = path.resolve(projectRoot);
const exchangeDir = path.join(cleanRoot, '.antigravity', 'bridge', 'exchange');
const planPath = path.join(exchangeDir, 'plan.md');
const codePath = path.join(exchangeDir, 'code.md');
const reviewPath = path.join(exchangeDir, 'review.md');
const logPath = path.join(exchangeDir, 'build_test.log');
const errorPath = path.join(exchangeDir, 'last_error.txt');
if (action === 'run_planner') {
const engine = routing.roles.planner;
if (engine === 'antigravity') {
return { status: 'DELEGATE_TO_ANTIGRAVITY', role: 'planner', targetFile: planPath };
}
const bundle = getBundleAttachmentAndNote(cleanRoot);
const rule = fs.readFileSync(path.join(PLUGIN_ROOT, 'rules', 'planner_rules.md'), 'utf8');
const prompt = rule + bundle.note + '\n\nKËRKESA E PËRDORUESIT:\n' + (payload.userRequest || 'Analizo dhe planifiko ndryshimet me saktësi arkitekturore.');
const response = await dispatchToWebTab({
tabKey: engine,
projectRoot: cleanRoot,
promptText: prompt,
attachmentPaths: [bundle.path]
});
if (!response || response.trim().length < 40) {
throw new Error('PLANNER_EMPTY_OUTPUT nga [' + engine + '].');
}
fs.writeFileSync(planPath, response, 'utf8');
writeProjectState(cleanRoot, { phase: 'PLANNED', retryCount: 0, lastStatus: 'PLAN_READY' });
return { status: 'EXTERNAL_COMPLETED', engine, activeModel: tabActiveModel[engine], outputFile: planPath };
}
if (action === 'run_coder') {
const engine = routing.roles.coder;
if (engine === 'antigravity') {
return { status: 'DELEGATE_TO_ANTIGRAVITY', role: 'coder', planFile: planPath, targetFile: codePath };
}
const st = readProjectState(cleanRoot);
if (payload.mode === 'FIX_ERROR' && st.retryCount > (st.maxRetries || 2)) {
return {
status: 'MAX_RETRIES_EXCEEDED',
message: 'U arrit kufiri maksimal prej 2 riprovave Auto-Heal. Kërkohet ndërhyrja e përdoruesit.',
errorFile: errorPath
};
}
const bundle = getBundleAttachmentAndNote(cleanRoot);
const rule = fs.readFileSync(path.join(PLUGIN_ROOT, 'rules', 'coder_rules.md'), 'utf8');
const attachments = [bundle.path, planPath];
let extraPrompt = bundle.note;
if (payload.mode === 'FIX_ERROR' && fs.existsSync(errorPath)) {
attachments.push(errorPath);
extraPrompt += '\n\nKUJDES (AUTO-HEAL): Kodi i mëparshëm dështoi në terminal. Lexo last_error.txt dhe kthe skedarët e korrigjuar të plotë me etiketën "### FILE: path/to/file.ext"!';
}
let response = await dispatchToWebTab({
tabKey: engine,
projectRoot: cleanRoot,
promptText: rule + extraPrompt,
attachmentPaths: attachments
});
// Gate 0-Kredi: nëse Coder ka lënë placeholder ose ka harruar etiketën ### FILE:, kërko plotësim menjëherë në të njëjtin tab
const validation = validateGeneratedCodeMarkdown(response);
if (!validation.valid) {
response = await dispatchToWebTab({
tabKey: engine,
projectRoot: cleanRoot,
promptText: 'KORRIGJIM FORMATI I DETYRUESHËM: ' + validation.reason + '\nRishkruaj përgjigjen duke dhënë kodin 100% të plotë për çdo skedar me etiketën e saktë ### FILE: rruga/skedari.ext.',
attachmentPaths: []
});
}
fs.writeFileSync(codePath, response, 'utf8');
writeProjectState(cleanRoot, { phase: 'CODED', lastStatus: 'CODE_READY' });
return { status: 'EXTERNAL_COMPLETED', engine, activeModel: tabActiveModel[engine], outputFile: codePath };
}
if (action === 'apply_and_test') {
return applyAndTestDeterministically(cleanRoot);
}
if (action === 'run_reviewer') {
const engine = routing.roles.reviewer;
if (!engine || engine === 'off') {
writeProjectState(cleanRoot, { phase: 'PASSED_SKIPPED_REVIEW', lastStatus: 'PASSED' });
return { status: 'SKIPPED' };
}
if (engine === 'antigravity') {
return { status: 'DELEGATE_TO_ANTIGRAVITY', role: 'reviewer', codeFile: codePath, targetFile: reviewPath };
}
const rule = fs.readFileSync(path.join(PLUGIN_ROOT, 'rules', 'reviewer_rules.md'), 'utf8');
const attachments = [planPath, codePath];
if (fs.existsSync(logPath)) attachments.push(logPath);
const response = await dispatchToWebTab({
tabKey: engine,
projectRoot: cleanRoot,
promptText: rule,
attachmentPaths: attachments
});
fs.writeFileSync(reviewPath, response, 'utf8');
const approved = response.includes('STATUS: APPROVED') || response.includes('STATUS: PASSED');
writeProjectState(cleanRoot, {
phase: approved ? 'PASSED' : 'REVIEW_CHANGES_REQUESTED',
lastStatus: approved ? 'PASSED' : 'FAILED_REVIEW'
});
return {
status: 'EXTERNAL_COMPLETED',
engine,
verdict: approved ? 'PASSED' : 'CHANGES_REQUIRED',
outputFile: reviewPath
};
}
throw new Error('Veprim i panjohur: ' + action);
}
// ---------------- SINGLETON HTTP SERVER & MINI WEB DASHBOARD (127.0.0.1:4321) ----------------
let isPrimaryInstance = false;
function startDashboardAndSingletonServer() {
const httpServer = http.createServer(async (req, res) => {
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
const projectsData = reg.projects
.filter(p => fs.existsSync(p))
.map(p => ({ ...ensureProjectSetup(p), state: readProjectState(p) }));
const tabStates = {};
for (const k of Object.keys(tabs)) {
tabStates[k] = {
open: Boolean(tabs[k] && !tabs[k].isClosed()),
auth: tabAuthStatus[k],
model: tabActiveModel[k],
activeProject: activeProjectPerTab[k] ? path.basename(activeProjectPerTab[k]) : 'Asnjë'
};
}
res.writeHead(200, { 'Content-Type': 'application/json' });
return res.end(JSON.stringify({ projects: projectsData, tabs: tabStates }));
}
let body = '';
req.on('data', chunk => { body += chunk; });
req.on('end', async () => {
try {
const data = body ? JSON.parse(body) : {};
if (req.url === '/api/save-routing') {
ensureProjectSetup(data.projectRoot);
const rPath = path.join(path.resolve(data.projectRoot), '.antigravity', 'bridge', 'routing.json');
const current = JSON.parse(fs.readFileSync(rPath, 'utf8'));
current.roles = { ...current.roles, ...(data.roles || {}) };
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
if (req.url === '/api/reset-tab') {
if (tabs[data.tabKey] && !tabs[data.tabKey].isClosed()) {
await resetChatIfNeeded(tabs[data.tabKey], data.tabKey, '', true);
}
res.writeHead(200, { 'Content-Type': 'application/json' });
return res.end(JSON.stringify({ ok: true }));
}
if (req.url === '/api/login-profile') {
const profile = data.profileName; // m365 | gemini1 | gemini2 | gemini3
const visibleCtx = await getOrLaunchContext(profile, false);
const loginPage = await visibleCtx.newPage();
const url = profile === 'm365' ? 'https://m365.cloud.microsoft/chat' : 'https://gemini.google.com/app';
await loginPage.goto(url, { waitUntil: 'domcontentloaded' });
res.writeHead(200, { 'Content-Type': 'application/json' });
return res.end(JSON.stringify({
ok: true,
message: 'Dritarja e Login-it për [' + profile + '] u hap. Identifikohu në llogari dhe mbylle dritaren kur të mbarosh — sistemi do të kthehet vetë në Headless.'
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
httpServer.on('error', (err) => {
if (err.code === 'EADDRINUSE') {
isPrimaryInstance = false; // Përdor instancën ekzistuese si Singleton Proxy
}
});
httpServer.listen(PORT, HOST, () => {
isPrimaryInstance = true;
});
}
async function dispatchActionSingleton(action, payload) {
if (isPrimaryInstance) {
return await executeCoreAction(action, payload);
}
const resp = await fetch('http://' + HOST + ':' + PORT + '/api/mcp-proxy', {
method: 'POST',
headers: { 'Content-Type': 'application/json' },
body: JSON.stringify({ action, payload })
});
const data = await resp.json();
if (!resp.ok) throw new Error(data.error || 'Singleton proxy error');
return data;
}
// ---------------- DEFINIMI I 5 MJETEVE MCP PËR ANTIGRAVITY ----------------
const mcpServer = new Server(
{ name: 'multi-ai-relay', version: '3.2.0' },
{ capabilities: { tools: {} } }
);
mcpServer.setRequestHandler(ListToolsRequestSchema, async () => ({
tools: [
{
name: 'pack_workspace',
description: 'Paketon projektin në exchange/ (FULL ose DELTA, txt ose .zip.md) dhe e regjistron në Dashboard-in 127.0.0.1:4321.',
inputSchema: {
type: 'object',
properties: {
projectRoot: { type: 'string' },
mode: { type: 'string', enum: ['FULL', 'DELTA'] }
},
required: ['projectRoot']
}
},
{
name: 'run_planner',
description: 'Ekzekuton Planifikuesin e zgjedhur në Dashboard (Thinking / Think Deeper) me Zero-Token në IDE.',
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
name: 'run_coder',
description: 'Ekzekuton Koduesin e zgjedhur në Dashboard me validim anti-placeholder (IMPLEMENT ose FIX_ERROR).',
inputSchema: {
type: 'object',
properties: {
projectRoot: { type: 'string' },
mode: { type: 'string', enum: ['IMPLEMENT', 'FIX_ERROR'] }
},
required: ['projectRoot']
}
},
{
name: 'apply_and_test',
description: '0-Token Node.js Deterministic Executor: aplikon skedarët nga code.md direkt në disk dhe ekzekuton Build/Test pa shpenzuar asnjë kredi AI në Antigravity.',
inputSchema: {
type: 'object',
properties: {
projectRoot: { type: 'string' }
},
required: ['projectRoot']
}
},
{
name: 'run_reviewer',
description: 'Release Gate: kontrollon plan.md + code.md + build_test.log dhe kthen verdiktin PASSED ose CHANGES_REQUIRED.',
inputSchema: {
type: 'object',
properties: {
projectRoot: { type: 'string' }
},
required: ['projectRoot']
}
}
]
}));
mcpServer.setRequestHandler(CallToolRequestSchema, async (request) => {
const { name, arguments: args } = request.params;
const result = await dispatchActionSingleton(name, args);
return {
content: [{ type: 'text', text: JSON.stringify(result, null, 2) }]
};
});
// Mbyll vetëm kontekstet lokale të këtij plugin-i (kurrë Chrome-at e tjerë në PC)
async function closeAllContexts() {
for (const [k, ctx] of Object.entries(contexts)) {
try { await ctx.close(); } catch (_) {}
delete contexts[k];
delete contextModes[k];
}
for (const k of Object.keys(tabs)) tabs[k] = null;
}
process.on('SIGINT', async () => { await closeAllContexts(); process.exit(0); });
process.on('SIGTERM', async () => { await closeAllContexts(); process.exit(0); });
startDashboardAndSingletonServer();
const transport = new StdioServerTransport();
mcpServer.connect(transport);

```

## 5. NDËRFAQJA GRAFIKE E DASHBOARD-IT LOKAL (`mcp/dashboard.html`)

Ky skedar hapet në `http://127.0.0.1:4321` dhe shfaq live modelin e zgjedhur me pikë në çdo fletë, statusin e ciklit (`state.json`), komandat `Build / Test`, formatin e paketimit (`txt` ose `zip.md`), rolet me Dropdown dhe butonat e Login-it për 4 profilet e izoluara.

```html
<!DOCTYPE html>
<html lang="sq">
<head>
  <meta charset="UTF-8" />
  <title>Multi-AI Orchestrator Dashboard (V3.2 Standalone)</title>
  <style>
    body { font-family: system-ui, -apple-system, sans-serif; background: #0f172a; color: #f8fafc; margin: 0; padding: 24px; }
    h1, h2, h3 { margin-top: 0; }
    .sub { color: #94a3b8; font-size: 13px; margin-bottom: 18px; }
    .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(290px, 1fr)); gap: 14px; margin-bottom: 24px; }
    .card { background: #1e293b; border: 1px solid #334155; border-radius: 10px; padding: 16px; }
    select, input, button { padding: 8px 10px; border-radius: 6px; border: 1px solid #475569; background: #0f172a; color: #fff; font-size: 13px; }
    input.full { width: 100%; box-sizing: border-box; margin-top: 4px; }
    button { background: #2563eb; border: none; cursor: pointer; font-weight: 600; }
    button:hover { background: #1d4ed8; }
    button.warn { background: #dc2626; }
    button.warn:hover { background: #b91c1c; }
    button.sec { background: #475569; }
    .row { display: flex; gap: 10px; align-items: center; margin: 8px 0; justify-content: space-between; }
    .lbl { font-size: 12px; color: #cbd5e1; margin-top: 8px; display: block; }
    .badge { padding: 3px 8px; border-radius: 99px; font-size: 11px; font-weight: bold; }
    .ok { background: #166534; color: #dcfce7; }
    .err { background: #991b1b; color: #fee2e2; }
    .idle { background: #334155; color: #e2e8f0; }
  </style>
</head>
<body>
  <h1>⚡ Multi-AI Orchestrator Bridge V3.2 (Standalone 5-Tab Pool)</h1>
  <div class="sub">100% i izoluar në 127.0.0.1:4321 • Thinking / Think Deeper Enforced • 0-Token Node.js Executor</div>

  <div class="card" style="margin-bottom: 20px;">
    <h2>🔑 Profilet e Izoluara të Plugin-it (Login një herë -> pastaj Headless)</h2>
    <div style="display:flex; gap:10px; flex-wrap:wrap;">
      <button onclick="loginProfile('m365')">Login M365 (Web 1 & Web 2)</button>
      <button onclick="loginProfile('gemini1')">Login Gemini 1 (Pro)</button>
      <button onclick="loginProfile('gemini2')">Login Gemini 2 (Pro)</button>
      <button onclick="loginProfile('gemini3')">Login Gemini 3 (Pro)</button>
      <button class="warn" onclick="killAll()">💀 Mbyll Fletët e Plugin-it (Liro RAM)</button>
    </div>
  </div>

  <h2>📡 Statusi Live i 5 Fletëve (Mutex Serialized Pool)</h2>
  <div id="tabsGrid" class="grid"></div>

  <div class="card" style="margin-bottom: 20px;">
    <h2>➕ Regjistro Projekt të Ri në Antigravity</h2>
    <div style="display:flex; gap:10px;">
      <input id="newProjPath" style="flex:1;" placeholder="p.sh. C:/Projects/aplikacioni-im" />
      <button onclick="addProject()">Shto Projektin</button>
    </div>
  </div>

  <h2>🗂️ Konfigurimi i Roleve & 0-Token Build/Test për çdo Projekt</h2>
  <div id="projectsGrid" class="grid"></div>

  <script>
    const ENGINES = [
      { v: 'gemini1', l: 'Gemini 1 (Pro - Thinking)' },
      { v: 'gemini2', l: 'Gemini 2 (Pro - Thinking)' },
      { v: 'gemini3', l: 'Gemini 3 (Pro - Thinking)' },
      { v: 'web1',    l: 'M365 Web 1 (Think Deeper)' },
      { v: 'web2',    l: 'M365 Web 2 (Think Deeper)' },
      { v: 'antigravity', l: '⚡ Antigravity (Local)' }
    ];

    function buildSelect(id, selected, includeOff = false) {
      let opts = includeOff ? `<option value="off" ${selected === 'off' ? 'selected' : ''}>🚫 Off (Skip)</option>` : '';
      for (const e of ENGINES) {
        opts += `<option value="${e.v}" ${selected === e.v ? 'selected' : ''}>${e.l}</option>`;
      }
      return `<select id="${id}">${opts}</select>`;
    }

    function escapeAttr(str) {
      return String(str || '').replace(/"/g, '&quot;');
    }

    async function loadState() {
      const res = await fetch('/api/state');
      const data = await res.json();

      document.getElementById('tabsGrid').innerHTML = Object.entries(data.tabs).map(([k, t]) => {
        const isErr = t.auth === 'AUTH_EXPIRED' || t.auth === 'BROWSER_ERROR';
        const badgeCls = isErr ? 'err' : (t.open ? 'ok' : 'idle');
        return `
          <div class="card">
            <div class="row">
              <strong>${k.toUpperCase()}</strong>
              <span class="badge ${badgeCls}">${t.open ? 'HAPUR' : 'NË GJUMË'} | ${t.auth}</span>
            </div>
            <div style="font-size:13px; margin:4px 0;">Modeli aktiv: <b>${t.model || '-'}</b></div>
            <div style="font-size:13px;">Projekti aktiv: <b>${t.activeProject}</b></div>
            <div style="margin-top:10px;">
              <button class="sec" onclick="resetTab('${k}')">🧹 Force New Chat</button>
            </div>
          </div>
        `;
      }).join('');

      document.getElementById('projectsGrid').innerHTML = data.projects.map((p, i) => {
        const st = p.state || {};
        const stBadge = st.lastStatus === 'PASSED' || st.lastStatus === 'BUILD_OK'
          ? 'ok'
          : (st.lastStatus === 'ERROR' || st.lastStatus === 'FAILED_REVIEW' ? 'err' : 'idle');

        return `
          <div class="card">
            <div class="row">
              <h3 style="margin:0;">📁 ${p.projectName}</h3>
              <span class="badge ${stBadge}">${st.phase || 'IDLE'} (Retry: ${st.retryCount || 0}/2)</span>
            </div>
            <small style="color:#94a3b8; word-break:break-all;">${p.projectRoot}</small>

            <div class="row" style="margin-top:12px;"><span>Planner:</span> ${buildSelect(`pl_${i}`, p.roles.planner)}</div>
            <div class="row"><span>Coder:</span> ${buildSelect(`cd_${i}`, p.roles.coder)}</div>
            <div class="row"><span>Reviewer (Gate):</span> ${buildSelect(`rv_${i}`, p.roles.reviewer, true)}</div>
            <div class="row"><span>Paketimi:</span>
              <select id="fmt_${i}">
                <option value="txt" ${p.bundleFormat !== 'zip.md' ? 'selected' : ''}>project_bundle.txt</option>
                <option value="zip.md" ${p.bundleFormat === 'zip.md' ? 'selected' : ''}>project_bundle.zip.md (M365)</option>
              </select>
            </div>

            <label class="lbl">Komanda Build (0-Token Node.js):</label>
            <input class="full" id="bld_${i}" value="${escapeAttr(p.buildCmd)}" placeholder="p.sh. npm run build" />

            <label class="lbl">Komanda Test (0-Token Node.js):</label>
            <input class="full" id="tst_${i}" value="${escapeAttr(p.testCmd)}" placeholder="p.sh. npm test" />

            <button style="width:100%; margin-top:12px;" onclick="saveRouting('${p.projectRoot.replace(/\\/g, '/')}', ${i})">💾 Ruaj Konfigurimin</button>
          </div>
        `;
      }).join('');
    }

    async function saveRouting(projectRoot, idx) {
      const payload = {
        projectRoot,
        roles: {
          planner: document.getElementById(`pl_${idx}`).value,
          coder: document.getElementById(`cd_${idx}`).value,
          reviewer: document.getElementById(`rv_${idx}`).value
        },
        bundleFormat: document.getElementById(`fmt_${idx}`).value,
        buildCmd: document.getElementById(`bld_${idx}`).value,
        testCmd: document.getElementById(`tst_${idx}`).value
      };
      await fetch('/api/save-routing', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      alert('Konfigurimi u ruajt në routing.json të projektit!');
      loadState();
    }

    async function addProject() {
      const projectRoot = document.getElementById('newProjPath').value.trim();
      if (!projectRoot) return;
      await fetch('/api/add-project', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ projectRoot })
      });
      document.getElementById('newProjPath').value = '';
      loadState();
    }

    async function loginProfile(profileName) {
      const r = await fetch('/api/login-profile', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ profileName })
      });
      const d = await r.json();
      alert(d.message || d.error);
      loadState();
    }

    async function resetTab(tabKey) {
      await fetch('/api/reset-tab', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ tabKey })
      });
      loadState();
    }

    async function killAll() {
      await fetch('/api/kill-all', { method: 'POST' });
      loadState();
    }

    loadState();
    setInterval(loadState, 5000);
  </script>
</body>
</html>
```

---

## 6. DEFINIMI I PLOTË I AGJENTËVE DHE RREGULLAVE (agents/ & rules/)

--- SKEDARI 4: agents/orchestrator.md ---
# Roli: Multi-AI Zero-Token Orchestrator (Control Plane)

Ti je dirigjuesi i ciklit të mbyllur në Antigravity. Detyra jote parësore është kursimi absolut i krediteve në IDE:
1. NDALIMI I LEXIMIT TË SKEDARËVE TË SHKËMBIMIT: Kurrë mos lexo me read_file përmbajtjen e project_bundle.txt, project_bundle.zip.md, plan.md, code.md, build_test.log, review.md ose last_error.txt kur mjeti MCP kthen status EXTERNAL_COMPLETED ose APPLIED_AND_GREEN.
2. RADHA STRIKTE LINEARE E MJETEVE MCP:
   - Hapi 1: pack_workspace(projectRoot, "FULL") (ose "DELTA" në cikle pasuese).
   - Hapi 2: run_planner(projectRoot, userRequest).
   - Hapi 3: run_coder(projectRoot, "IMPLEMENT").
   - Hapi 4: apply_and_test(projectRoot) — motori deterministik Node.js shkruan skedarët dhe teston me 0 kredi AI.
   - Hapi 5: Nëse apply_and_test kthen BUILD_OR_TEST_FAILED dhe maxRetriesReached: false, thirr menjëherë run_coder(projectRoot, "FIX_ERROR") dhe përsërit apply_and_test(projectRoot) (maksimumi 2 herë).
   - Hapi 6: Sapo apply_and_test kthen APPLIED_AND_GREEN, thirr run_reviewer(projectRoot).
3. FALLBACK VETËM KUR KËRKOHET:
   - Thirr Agjentin lokal executor vetëm nëse apply_and_test kthen status DELEGATE_FALLBACK_EXECUTOR.
   - Kryeje vetë një rol lokalisht vetëm nëse mjeti MCP kthen status DELEGATE_TO_ANTIGRAVITY.
4. MBYLLJA E CIKLIT: Cikli mbyllet me sukses kur run_reviewer kthen verdict PASSED (ose status SKIPPED kur Reviewer është Off në Dashboard). Nëse kthen CHANGES_REQUIRED, bëj edhe 1 kalim te run_coder + apply_and_test.

--- SKEDARI 5: agents/executor.md ---
# Roli: Fallback Lokal Executor (Aktivizohet vetëm kur dështon Parseri Deterministik)

Ti thirresh VETËM kur mjeti apply_and_test kthen DELEGATE_FALLBACK_EXECUTOR:
1. Lexo .antigravity/bridge/exchange/code.md (dhe review.md nëse ekziston).
2. Apliko ndryshimet me saktësi mekanike në skedarët e projektit brenda projectRoot, pa shpikur arkitekturë të re.
3. Ekzekuto komandat buildCmd dhe testCmd që gjenden te .antigravity/bridge/routing.json.
4. Nëse terminali jep error, ruaj output-in e plotë në .antigravity/bridge/exchange/last_error.txt dhe ktheja kontrollin Orchestrator-it për run_coder(mode: "FIX_ERROR") — mos harxho tokena me analiza të gjata lokale.

--- SKEDARI 6: rules/planner_rules.md ---
Ti je Arkitekti Kryesor dhe Planifikuesi i Sistemit duke punuar në modalitetin më të lartë llogaritës (Thinking / Think Deeper).
Analizo skedarin e bashkëngjitur të projektit dhe kërkesën e përdoruesit:
1. Listo çdo skedar që duhet krijuar ose modifikuar me rrugën e saktë relative nga root-i (duke përdorur gjithmonë /, p.sh. src/services/auth.ts).
2. Përshkruaj qartë kontratat e funksioneve, strukturat e të dhënave, varësitë mes skedarëve dhe rastet kufitare (edge cases).
3. Përcakto kriteret e verifikimit që kodi duhet të kalojë në Build dhe Test.
4. Mos shkruaj kod zbatimi gjysmë të lënë; fokusohu 100% te një plan arkitekturor i qartë dhe i pakundërshtueshëm për Koduesin.

--- SKEDARI 7: rules/coder_rules.md ---
Ti je Inxhinieri Specialist i Kodimit në modalitetin Thinking / Think Deeper.
Duke u bazuar strikt te plan.md dhe paketa e projektit (si dhe last_error.txt nëse ndodhemi në modalitetin AUTO-HEAL / FIX_ERROR):
1. Shkruaj kodin 100% të plotë dhe të gatshëm për prodhim për çdo skedar që krijohet ose modifikohet.
2. Mbi çdo bllok kodi vendos DETYRIMISHT etiketën e saktë në formatin: ### FILE: path/to/file.ext dhe menjëherë poshtë saj bllokun e kodit Markdown.
3. NDALOHET KATEGORIKISHT përdorimi i shkurtimeve si // ... rest of the code, // ... existing code ... ose // TODO: implement. Parseri automatik e zëvendëson skedarin direkt në disk dhe do ta refuzojë përgjigjen tënde nëse lë pjesë mangët!

--- SKEDARI 8: rules/reviewer_rules.md ---
Ti je Auditori i Release Gate në modalitetin Thinking / Think Deeper.
Krahaso plan.md me kodin e zbatuar në code.md (dhe rezultatin e terminalit në build_test.log nëse është bashkëngjitur):
1. Kontrollo nëse çdo kërkesë e plan.md është përmbushur plotësisht, pa importe të munguara, pa gabime logjike, pa regresione dhe pa vrima sigurie.
2. Nëse gjithçka është e saktë dhe e gatshme për prodhim, kthe në rreshtin e parë fjalinë ekzakte: STATUS: PASSED
3. Nëse ka defekte reale, kthe STATUS: CHANGES_REQUIRED dhe jep skedarët e korrigjuar 100% të plotë me etiketën ### FILE: path/to/file.ext.

--- SKEDARI 9: rules/zero_token_protocol.md ---
Protokolli Zero-Token ndalon rreptësisht ngarkimin e skedarëve të shkëmbimit (.antigravity/bridge/exchange/*) në kontekstin e chat-it të Antigravity-t kur hapat ekzekutohen nga 5 fletët e jashtme (web1, web2, gemini1, gemini2, gemini3) dhe nga ekzekutuesi deterministik Node.js (apply_and_test). Komunikimi mes aktorëve kryhet ekskluzivisht përmes rrugëve fizike të skedarëve në disk.

---

## 7. PROCEDURA E SKILL-IT TË CIKLIT TË MBYLLUR (skills/run-cycle/SKILL.md)

--- SKEDARI 10: skills/run-cycle/SKILL.md ---
---
name: run-cycle
description: Ekzekuton ciklin e mbyllur Zero-Token mes Orchestrator-it, 5 fletëve Web/Gemini (Thinking/Think Deeper), 0-Token Node.js Executor dhe Release Gate në 127.0.0.1:4321.
---

# Procedura e Ciklit të Mbyllur (/run-cycle)

Kur përdoruesi kërkon një ndryshim ose thërret /run-cycle, ndiq këtë rrjedhë lineare pa lexuar skedarët e ndërmjetëm në chat:
1. Paketimi: Thirr pack_workspace(projectRoot, "FULL") (ose "DELTA" nëse projekti është paketuar më parë dhe ka Git).
2. Planifikimi (Thinking / Think Deeper): Thirr run_planner(projectRoot, userRequest).
3. Kodimi i Plotë: Thirr run_coder(projectRoot, "IMPLEMENT"). Serveri verifikon vetë që nuk ka placeholder-a.
4. Ekzekutimi & Testimi 0-Token: Thirr apply_and_test(projectRoot).
   - Nëse kthen BUILD_OR_TEST_FAILED dhe maxRetriesReached: false, thirr run_coder(projectRoot, "FIX_ERROR") dhe më pas përsëri apply_and_test(projectRoot) (deri në 2 riprova).
   - Vetëm nëse kthen DELEGATE_FALLBACK_EXECUTOR, aktivizo agjentin executor.
5. Release Gate (PASSED): Sapo apply_and_test kthen APPLIED_AND_GREEN, thirr run_reviewer(projectRoot).
   - Nëse kthen verdict PASSED ose status SKIPPED, raporto suksesin përfundimtar te përdoruesi me listën e skedarëve të përditësuar.

---

## 8. UDHËZIMI I SHPEJTË I INSTALIMIT PËR HERË TË PARË (3 HAPA)

1. Vendos të gjithë skedarët e mësipërm në .antigravity/plugins/multi-ai-orchestrator-bridge/.
2. Hap terminalin brenda dosjes mcp/ dhe instalo varësitë lokale:
   ```powershell
   cd .antigravity/plugins/multi-ai-orchestrator-bridge/mcp
   npm install
   ```
3. Rinis Antigravity, hap në shfletues http://127.0.0.1:4321, kliko butonat Login një herë për m365 dhe gemini1..3, mbylle dritaren pas identifikimit, dhe plugin-i është 100% gati në modalitetin e padukshëm Headless!

================================================================================
FUNDI I DOKUMENTIT BAZË V3.2 FULL-CODE (STANDALONE EDITION)
================================================================================
