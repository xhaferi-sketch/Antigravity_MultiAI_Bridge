'use strict';

const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const { spawn } = require('node:child_process');
const readline = require('node:readline/promises');
const { stdin: input, stdout: output } = require('node:process');
const { chromium } = require('playwright');

const {
  readModelLocks,
  setTabModelLock,
  clearTabModelLock,
  buildGeminiLockContract,
  buildCopilotLockContract
} = require('./pipeline/model_locks');
const geminiModule = require('./engines/gemini_engine');
const copilotModule = require('./engines/copilot_engine');

const ROOT_DIR = path.resolve(__dirname, '..');
const PROFILES_DIR = path.join(ROOT_DIR, '.profiles');

const SLOT_DEFS = Object.freeze({
  gemini1: { tabKey: 'gemini1', engine: 'gemini', profile: 'gemini1', port: 18001, url: geminiModule.GEMINI_APP_URL },
  gemini2: { tabKey: 'gemini2', engine: 'gemini', profile: 'gemini2', port: 18002, url: geminiModule.GEMINI_APP_URL },
  gemini3: { tabKey: 'gemini3', engine: 'gemini', profile: 'gemini3', port: 18003, url: geminiModule.GEMINI_APP_URL },
  web1: { tabKey: 'web1', engine: 'copilot', profile: 'm365_web1', port: 18011, url: copilotModule.M365_CHAT_URL },
  web2: { tabKey: 'web2', engine: 'copilot', profile: 'm365_web2', port: 18012, url: copilotModule.M365_CHAT_URL }
});

function findRealChromeBinary() {
  const candidates = [
    process.env.CHROME_BIN,
    path.join(process.env['PROGRAMFILES'] || 'C:\\Program Files', 'Google', 'Chrome', 'Application', 'chrome.exe'),
    path.join(process.env['PROGRAMFILES(X86)'] || 'C:\\Program Files (x86)', 'Google', 'Chrome', 'Application', 'chrome.exe'),
    process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Google', 'Chrome', 'Application', 'chrome.exe') : ''
  ].filter(Boolean);
  for (const bin of candidates) {
    if (fs.existsSync(bin)) return bin;
  }
  return 'chrome';
}

function probeCdpVersion(port, timeoutMs) {
  return new Promise(function(resolve) {
    const req = http.get({ hostname: '127.0.0.1', port: port, path: '/json/version', timeout: timeoutMs || 1500 }, function(res) {
      let raw = '';
      res.on('data', function(chunk) { raw += chunk; });
      res.on('end', function() { resolve(Boolean(res.statusCode === 200 && raw.includes('webSocketDebuggerUrl'))); });
    });
    req.on('error', function() { resolve(false); });
    req.on('timeout', function() { req.destroy(); resolve(false); });
  });
}

async function waitForCdpEndpoint(port, timeoutMs) {
  const deadline = Date.now() + (timeoutMs || 20000);
  while (Date.now() < deadline) {
    if (await probeCdpVersion(port, 1200)) return true;
    await new Promise(function(r) { setTimeout(r, 250); });
  }
  return false;
}

async function openSlotPage(slot) {
  const endpoint = 'http://127.0.0.1:' + slot.port;
  const userDataDir = path.join(PROFILES_DIR, slot.profile);
  if (!fs.existsSync(userDataDir)) fs.mkdirSync(userDataDir, { recursive: true });

  let browser = null;
  let launchedFresh = false;
  try {
    browser = await chromium.connectOverCDP(endpoint, { timeout: 2500 });
  } catch (_) {
    const chromeBin = findRealChromeBinary();
    const child = spawn(chromeBin, [
      '--user-data-dir=' + userDataDir,
      '--remote-debugging-port=' + slot.port,
      '--no-first-run',
      '--no-default-browser-check',
      '--start-maximized'
    ], { detached: true, stdio: 'ignore', windowsHide: false });
    child.on('error', function() {});
    child.unref();
    const ready = await waitForCdpEndpoint(slot.port, 20000);
    if (!ready) {
      throw new Error('Nuk u hap Chrome CDP ne porten ' + slot.port + ' per ' + slot.tabKey);
    }
    browser = await chromium.connectOverCDP(endpoint, { timeout: 15000 });
    launchedFresh = true;
  }

  const ctx = browser.contexts()[0];
  if (!ctx) throw new Error('Mungon konteksti i shfletuesit per ' + slot.tabKey);
  const pages = ctx.pages().filter(function(p) { return !p.isClosed(); });
  let page = pages.find(function(p) {
    const u = (p.url() || '').toLowerCase();
    return slot.engine === 'gemini' ? u.includes('gemini.google.com') : (u.includes('copilot.cloud.microsoft') || u.includes('m365.cloud.microsoft'));
  }) || pages[0] || await ctx.newPage();

  const cur = (page.url() || '').toLowerCase();
  const targetMatch = slot.engine === 'gemini' ? cur.includes('gemini.google.com') : (cur.includes('copilot.cloud.microsoft') || cur.includes('m365.cloud.microsoft'));
  if (!targetMatch) {
    await page.goto(slot.url, { waitUntil: 'domcontentloaded', timeout: 45000 });
    await page.waitForTimeout(2000);
  }
  await page.bringToFront().catch(function() {});

  return {
    browser: browser,
    page: page,
    closeConnectionOnly: async function() {
      // Do NOT close Chrome itself if user wants to keep tabs warm; disconnect Playwright cleanly when we connected to an existing Chrome, or close only if launched? Leaving Chrome open preserves user visibility.
      if (launchedFresh) {
        console.log('  [INFO] Dritarja ' + slot.tabKey + ' (' + slot.profile + ') mbetet hapur ne porten ' + slot.port + ' me sesionin e ruajtur.');
      }
      if (typeof browser.close === 'function' && !launchedFresh) {
        // Note: over connectOverCDP in Playwright, browser.close() only closes the CDP client connection, NOT chrome.exe.
        await browser.close().catch(function() {});
      } else if (typeof browser.close === 'function') {
        await browser.close().catch(function() {});
      }
    }
  };
}

async function recoverLiveFrame(conn, slot) {
  let page = conn && conn.page;
  if (!page || (typeof page.isClosed === 'function' && page.isClosed())) {
    const ctx = conn && conn.browser && conn.browser.contexts()[0];
    const pages = ctx ? ctx.pages().filter(function(p) { return !p.isClosed(); }) : [];
    page = pages.find(function(p) {
      const u = (p.url() || '').toLowerCase();
      return slot.engine === 'gemini' ? u.includes('gemini.google.com') : (u.includes('copilot.cloud.microsoft') || u.includes('m365.cloud.microsoft'));
    }) || pages[0] || null;
    if (!page && ctx) {
      page = await ctx.newPage();
      await page.goto(slot.url, { waitUntil: 'domcontentloaded', timeout: 45000 });
      await page.waitForTimeout(2000);
    }
    if (conn) conn.page = page;
  }
  if (!page) return null;
  return slot.engine === 'copilot' ? copilotModule.findChatFrameOrPage(page) : page;
}

function extractCanonicalGeminiModel(chosenModel) {
  if (chosenModel && chosenModel.shortLabel && !/thinking level/i.test(chosenModel.shortLabel)) {
    return chosenModel.shortLabel;
  }
  const lines = String((chosenModel && chosenModel.label) || '').split(/\r?\n/).map(function(s) { return s.trim(); }).filter(Boolean);
  return lines.find(function(line) {
    return /^(?:\d+(?:\.\d+)?\s+)?(?:auto|hydrogen|neon|carbon|flash|pro|ultra|gemini)\b/i.test(line);
  }) || lines[0] || '';
}

function extractCanonicalReason(rawReason) {
  const line = String(rawReason || '').split(/\r?\n/).map(function(s) { return s.trim(); }).filter(Boolean)[0] || '';
  const m = line.match(/^(low|medium|high|fast)\b/i);
  if (m) return m[1].charAt(0).toUpperCase() + m[1].slice(1).toLowerCase();
  return line.replace(/\s*\([^)]*\)\s*$/, '').trim() || line;
}

async function ensureReadyForDiscovery(rl, slot, conn) {
  let page = conn && conn.page ? conn.page : conn;
  const pickActiveSlotPage = function() {
    if (!conn || !conn.browser) return page;
    const ctx = conn.browser.contexts()[0];
    if (!ctx) return page;
    const live = ctx.pages().filter(function(p) { return !p.isClosed(); });
    const matched = live.find(function(p) {
      const u = (p.url() || '').toLowerCase();
      return slot.engine === 'gemini' ? u.includes('gemini.google.com') : (u.includes('copilot.cloud.microsoft') || u.includes('m365.cloud.microsoft'));
    });
    if (matched) page = matched;
    if (conn) conn.page = page;
    return page;
  };

  while (true) {
    // Poll up to ~8s for page hydration / redirect completion with visible feedback
    let lastAuth = { state: 'CHECKING', reason: 'INIT' };
    for (let attempt = 0; attempt < 9; attempt++) {
      page = pickActiveSlotPage();
      const auth = await copilotModule.inspectLiveAuthState(page, slot.tabKey, {});
      lastAuth = auth;
      if (auth.state === 'ACTIVE') {
        return slot.engine === 'copilot' ? copilotModule.findChatFrameOrPage(page) : page;
      }
      if (attempt === 0) {
        console.log('  [...] Duke verifikuar gjendjen e faqes (' + (auth.reason || auth.state) + ')...');
      }
      if (auth.state === 'ACCOUNT_PICKER' && attempt >= 2) break;
      if (auth.reason === 'LOGIN_HOST_REDIRECT' && attempt >= 2) break;
      await page.waitForTimeout(900).catch(function() {});
    }

    console.log('\n  [KUJDES] ' + slot.tabKey + ' (' + slot.profile + ') eshte ne gjendje: ' + lastAuth.state + ' (' + lastAuth.reason + ') [URL: ' + (lastAuth.url || '') + ']');
    await page.bringToFront().catch(function() {});
    const ans = (await rl.question('  Ploteso login-in / zgjidh 1 llogari te dritarja Chrome dhe shtyp ENTER per te vazhduar (ose "s" per ta anashkaluar): ')).trim().toLowerCase();
    if (ans === 's') return null;
    await page.waitForTimeout(1000).catch(function() {});
  }
}

async function configureSlotInteractively(rl, slot) {
  console.log('\n============================================================');
  console.log('  Po lexoj opsionet LIVE nga uebi per: ' + slot.tabKey.toUpperCase() + ' (' + slot.profile + ')');
  console.log('============================================================');

  let conn = await openSlotPage(slot);
  try {
    let frame = await ensureReadyForDiscovery(rl, slot, conn);
    if (!frame) {
      console.log('  [-] U anashkalua ' + slot.tabKey);
      return null;
    }

    if (slot.engine === 'gemini') {
      const gemEngine = geminiModule.createGeminiEngine({});
      const info = await gemEngine.discoverGeminiLiveOptions(frame);
      if (!info || !info.ok) {
        console.log('  [GABIM] Nuk u lexua menua e Gemini-t: ' + JSON.stringify(info || {}));
        return null;
      }
      if (!Array.isArray(info.models) || info.models.length === 0) {
        console.log('  [GABIM] Nuk u gjet asnje model ne menune e Gemini-t (' + slot.tabKey + '). Sigurohu qe faqja e chat-it eshte ngarkuar plotesisht.');
        return null;
      }
      console.log('  Aktiv tani ne ueb: ' + (info.activeText || info.activeAria || '(panjohur)').replace(/\s+/g, ' '));
      console.log('\n  Modelet e gjetura LIVE ne Gemini (' + slot.tabKey + '):');
      info.models.forEach(function(m, idx) {
        const inlineLabel = String(m.label || '').replace(/\s*\r?\n\s*/g, ' — ');
        console.log('    [' + (idx + 1) + '] ' + inlineLabel + (m.selected ? '  <-- (aktualisht aktiv)' : ''));
      });
      const mRaw = (await rl.question('\n  Zgjidh numrin e modelit (Enter per te mbajtur aktualin / anashkaluar): ')).trim();
      if (!mRaw) return null;
      const mIdx = Number(mRaw) - 1;
      if (!Number.isInteger(mIdx) || mIdx < 0 || mIdx >= info.models.length) {
        console.log('  [-] Zgjedhje e pavlefshme.');
        return null;
      }
      const chosenModel = info.models[mIdx];

      // Check Thinking level submenu live if present
      let chosenReasonLabel = '';
      frame = await recoverLiveFrame(conn, slot) || frame;
      let subInfo = await gemEngine.discoverGeminiLiveOptions(frame, { preselectModelLabel: chosenModel.label });
      const levels = (subInfo && Array.isArray(subInfo.thinkingLevels)) ? subInfo.thinkingLevels : [];
      if (levels.length > 0) {
        console.log('\n  Nivelet e mendimit (Thinking level) LIVE per "' + (chosenModel.shortLabel || chosenModel.label) + '":');
        levels.forEach(function(lv, idx) {
          const inlineLv = String(lv.label || '').replace(/\s*\r?\n\s*/g, ' — ');
          console.log('    [' + (idx + 1) + '] ' + inlineLv + (lv.selected ? '  <-- (aktualisht aktiv)' : ''));
        });
        const rRaw = (await rl.question('  Zgjidh numrin e nivelit (Enter = anashkalo / pa nen-nivel): ')).trim();
        if (rRaw) {
          const rIdx = Number(rRaw) - 1;
          if (!Number.isInteger(rIdx) || rIdx < 0 || rIdx >= levels.length) {
            console.log('  [-] Nivel i pavlefshem.');
            return null;
          }
          chosenReasonLabel = levels[rIdx].shortLabel || levels[rIdx].label;
        }
      }

      const shortModel = extractCanonicalGeminiModel(chosenModel);
      const shortReason = chosenReasonLabel ? extractCanonicalReason(chosenReasonLabel) : '';
      const lockEntry = setTabModelLock(slot.tabKey, {
        engine: 'gemini',
        modelLabel: shortModel,
        reasoningLabel: shortReason,
        reasoning: shortReason ? shortReason.toLowerCase() : 'custom',
        displayLabel: shortReason ? (shortModel + ' (' + shortReason + ')') : shortModel
      });

      const contract = buildGeminiLockContract(slot.tabKey, geminiModule.GEMINI_REQUIRED_MODEL);
      let verified = null;
      try {
        frame = await recoverLiveFrame(conn, slot) || frame;
        verified = await gemEngine.ensureGeminiNeonModel(frame, slot.tabKey, { lockContract: contract });
      } catch (err) {
        const msg = String(err && err.message || err);
        if (/closed|detached|Target page/i.test(msg)) {
          await conn.closeConnectionOnly().catch(function() {});
          conn = await openSlotPage(slot);
          frame = await ensureReadyForDiscovery(rl, slot, conn);
          if (frame) {
            verified = await gemEngine.ensureGeminiNeonModel(frame, slot.tabKey, { lockContract: contract });
          }
        } else {
          throw err;
        }
      }
      console.log('  [KYÇUR] ' + slot.tabKey + ' u vendos dhe u verifikua LIVE -> ' + (verified || lockEntry.displayLabel));
      return lockEntry;
    }

    // Copilot
    const copEngine = copilotModule.createCopilotEngine({});
    const info = await copEngine.discoverCopilotLiveOptions(frame);
    if (!info || !info.ok) {
      console.log('  [GABIM] Nuk u lexua menua e Copilot-it: ' + JSON.stringify(info || {}));
      return null;
    }
    console.log('  Aktiv tani ne ueb: ' + (info.active || '(panjohur)'));
    if (!Array.isArray(info.options) || info.options.length === 0) {
      console.log('  [GABIM] Menua e Copilot (' + slot.tabKey + ') u klikua por nuk shfaqi opsione modelesh ' + JSON.stringify(info.debug || {}) + '.');
      console.log('          Hap manualisht dritaren e Copilot ne Chrome, verifiko qe shfaqet kutia e mesazhit, dhe provoje perseri.');
      return null;
    }
    console.log('\n  Opsionet e gjetura LIVE ne Copilot (' + slot.tabKey + '):');
    info.options.forEach(function(opt, idx) {
      console.log('    [' + (idx + 1) + '] ' + opt.label + (opt.selected ? '  <-- (aktualisht aktiv)' : ''));
    });
    const cRaw = (await rl.question('\n  Zgjidh numrin e modelit (Enter per te anashkaluar): ')).trim();
    if (!cRaw) return null;
    const cIdx = Number(cRaw) - 1;
    if (!Number.isInteger(cIdx) || cIdx < 0 || cIdx >= info.options.length) {
      console.log('  [-] Zgjedhje e pavlefshme.');
      return null;
    }
    const chosen = info.options[cIdx];
    const chosenModelLabel = chosen.shortLabel || chosen.label;
    const lockEntry = setTabModelLock(slot.tabKey, {
      engine: 'copilot',
      modelLabel: chosenModelLabel,
      reasoningLabel: '',
      reasoning: 'custom',
      displayLabel: chosenModelLabel
    });
    const contract = buildCopilotLockContract(slot.tabKey, copilotModule.COPILOT_REQUIRED_MODEL);
    frame = await recoverLiveFrame(conn, slot) || frame;
    const verified = await copEngine.ensureCopilotGpt56Model(frame, slot.tabKey, { contract: contract });
    console.log('  [KYÇUR] ' + slot.tabKey + ' u vendos dhe u verifikua LIVE -> ' + verified);
    return lockEntry;
  } finally {
    await conn.closeConnectionOnly();
  }
}

function printCurrentLocks() {
  const store = readModelLocks();
  console.log('\n--- KYÇJET AKTUALE (model_locks.json) ---');
  for (const k of Object.keys(SLOT_DEFS)) {
    const entry = store.locks[k];
    console.log('  ' + k.padEnd(8) + ' -> ' + (entry ? (entry.displayLabel + ' [USER LOCKED]') : 'Default i sistemit (pa lock manual)'));
  }
}

async function main() {
  const rl = readline.createInterface({ input: input, output: output });
  try {
    console.log('============================================================');
    console.log('  ANTIGRAVITY BRIDGE - SELEKTIMI LIVE I MODELEVE AI');
    console.log('  Lexon realisht menute nga uebi dhe kyç zgjedhjen tende.');
    console.log('============================================================');

    while (true) {
      printCurrentLocks();
      console.log('\nZgjidh veprimin:');
      console.log('  [1] Selekto & Kyç GEMINI 1 (18001)');
      console.log('  [2] Selekto & Kyç GEMINI 2 (18002)');
      console.log('  [3] Selekto & Kyç GEMINI 3 (18003)');
      console.log('  [4] Selekto & Kyç COPILOT Web 1 (m365_web1 / 18011)');
      console.log('  [5] Selekto & Kyç COPILOT Web 2 (m365_web2 / 18012)');
      console.log('  [A] Konfiguro GEMINI 1 dhe apliko te gjitha Gemini (1/2/3)');
      console.log('  [C] Konfiguro COPILOT Web 1 dhe apliko te dyja Copilot (1/2)');
      console.log('  [R] Pastro lock-et manuale (kthehu te default-et)');
      console.log('  [0] Dil');

      const choice = (await rl.question('\nZgjedhja jote: ')).trim().toUpperCase();
      if (choice === '0' || choice === 'Q') break;
      try {
        if (choice === '1') await configureSlotInteractively(rl, SLOT_DEFS.gemini1);
        else if (choice === '2') await configureSlotInteractively(rl, SLOT_DEFS.gemini2);
        else if (choice === '3') await configureSlotInteractively(rl, SLOT_DEFS.gemini3);
        else if (choice === '4') await configureSlotInteractively(rl, SLOT_DEFS.web1);
        else if (choice === '5') await configureSlotInteractively(rl, SLOT_DEFS.web2);
        else if (choice === 'A') {
          const res = await configureSlotInteractively(rl, SLOT_DEFS.gemini1);
          if (res) {
            for (const sibling of ['gemini2', 'gemini3']) {
              setTabModelLock(sibling, res);
              console.log('  [KYÇUR EDHE] ' + sibling + ' -> ' + res.displayLabel);
            }
          }
        } else if (choice === 'C') {
          const res = await configureSlotInteractively(rl, SLOT_DEFS.web1);
          if (res) {
            setTabModelLock('web2', res);
            console.log('  [KYÇUR EDHE] web2 -> ' + res.displayLabel);
          }
        } else if (choice === 'R') {
          for (const k of Object.keys(SLOT_DEFS)) clearTabModelLock(k);
          console.log('  [OK] Te gjithe lock-et manuale u pastruan (u rikthye default-i).');
        }
      } catch (slotErr) {
        console.log('\n  [GABIM] Veprimi deshtoi: ' + String(slotErr && slotErr.message ? slotErr.message : slotErr));
        console.log('  [INFO] Mund ta provosh perseri nga menuja.');
      }
    }
  } finally {
    rl.close();
  }
}

if (require.main === module) {
  main().catch(function(err) {
    console.error('[GABIM] ' + (err && err.stack ? err.stack : err));
    process.exitCode = 1;
  });
}

module.exports = {
  SLOT_DEFS,
  extractCanonicalGeminiModel,
  extractCanonicalReason,
  main
};
