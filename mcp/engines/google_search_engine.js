'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const NL = String.fromCharCode(10);
const FENCE3 = String.fromCharCode(96, 96, 96);
const GOOGLE_SEARCH_AI_URL = 'https://www.google.com/ai';
const GOOGLE_SEARCH_AI_DISPLAY_LABEL = 'Search AI (High)';

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

function searchAiTextFingerprint(text) {
  return crypto.createHash('sha256').update(String(text || '').replace(/\s+/g,' ').trim()).digest('hex').slice(0,16);
}

function defaultClassifyWebServiceFailure(input) {
  input = input || {};
  const text = [input.text || '', ...(input.alerts || []).map(function(x) { return typeof x === 'string' ? x : (x.textPreview || x.text || ''); }), ...(input.httpHints || [])].join(' ').toLowerCase();
  const groups = [
    ['QUOTA_OR_LIMIT_ERROR', 'WEB_QUOTA_OR_LIMIT_ERROR', false, /quota exceeded|limit reached|reached your limit|resets in|upgrade to advanced|upgrade your plan|usage limit|too many requests|rate limit/],
    ['POLICY_REFUSAL', 'WEB_POLICY_REFUSAL', false, /i can(?:not|'t) help with that|i cannot assist|violates policy|not able to comply|prefer not to continue/],
    ['AUTH_OR_SESSION_ERROR', 'WEB_AUTH_OR_SESSION_ERROR', false, /sign in|session expired|authentication required|log in to continue/],
    ['PAYLOAD_REJECTED', 'WEB_PAYLOAD_REJECTED_OR_OVERSIZED', true, /file too large|payload too large|context too long|maximum context|attachment.*(?:large|rejected)/],
    ['TRANSIENT_SERVICE_ERROR', 'WEB_TRANSIENT_SERVICE_ERROR', true, /encountered an error doing what you asked|could you try again|something went wrong|try again later|service unavailable|oops.? something happened|response wasn.?t generated/]
  ];
  for (const g of groups) {
    const m = text.match(g[3]);
    if (m) return { class: g[0], retryable: g[2], code: g[1], matchedSignals: [m[0]] };
  }
  return { class: 'UNKNOWN_SERVICE_ERROR', retryable: false, code: 'WEB_UNKNOWN_SERVICE_ERROR', matchedSignals: [] };
}

function classifyAttachmentHandshake(text, telemetry, failureClassifier) {
  telemetry = telemetry || {};
  const classifyFailure = typeof failureClassifier === 'function' ? failureClassifier : defaultClassifyWebServiceFailure;
  const normalized = String(text || '').normalize('NFKC').toLowerCase().replace(/[’‘]/g, "'").replace(/[^\p{L}\p{N}' ]+/gu, ' ').replace(/\s+/g, ' ').trim();
  const service = classifyFailure({ text: normalized, alerts: telemetry.alerts || [], engine: 'google_search' });
  if (['QUOTA_OR_LIMIT_ERROR', 'POLICY_REFUSAL', 'AUTH_OR_SESSION_ERROR', 'TRANSIENT_SERVICE_ERROR'].includes(service.class)) return service;
  const failure = /uploaded file could not be processed|file could not be processed|try to upload a different file|couldn'?t process the file|unable to process the file|attachment could not be read|file is too large|unsupported file|context is too long/.exec(normalized);
  if (failure || service.class === 'PAYLOAD_REJECTED') return { class: 'PAYLOAD_REJECTED', code: 'WEB_PAYLOAD_REJECTED_OR_OVERSIZED', retryable: true, matchedSignals: [failure ? failure[0] : 'payload'] };
  const positive = /(^|\b)(ok|e lexova|lexova|shqyrtova|kuptova|jam gati|gati|ready|received|read it|file received|attachment received|kam lexuar|u lexua|vazhdoj|vazhdojmë|proceed|sure|yes|po)(\b|$)/i.test(normalized) || (!failure && normalized.length > 10);
  if (!positive) return { class: 'INVALID_HANDSHAKE', code: 'SEARCH_AI_ATTACHMENT_HANDSHAKE_UNVERIFIED', retryable: false, matchedSignals: [] };
  if (telemetry.attachmentVerified === false) return { class: 'INVALID_HANDSHAKE', code: 'SEARCH_AI_ATTACHMENT_HANDSHAKE_UNVERIFIED', retryable: false, matchedSignals: ['attachment_not_verified'] };
  return { class: 'HANDSHAKE_ACCEPTED', code: 'SEARCH_AI_ATTACHMENT_HANDSHAKE_ACCEPTED', retryable: false, matchedSignals: [] };
}

function validatePlanOutput(text, opts) {
  opts = opts || {};
  let clean = String(text || '').replace(/\n?PLANI_PERFUNDOI_100\s*$/i, '').trim();
  const missing = [];
  if (clean.length < 250) return { ok: false, reason: 'TOO_SHORT', missing: ['minimum_length'], text: clean, gates: 0 };
  if (/Copied to clipboard|Open sidebar|See your Search history|Good response|Bad response|More options for response/i.test(clean)) return { ok: false, reason: 'UI_CONTAMINATION', missing: [], text: clean, gates: 0 };
  if (/no response available|try asking something else|something went wrong|response wasn.t generated|can.t help/i.test(clean)) return { ok: false, reason: 'SERVICE_REFUSAL', missing: [], text: clean, gates: 0 };
  if (/^Duke përdorur kontekstin e skedarit të bashkëngjitur/i.test(clean)) return { ok: false, reason: 'PROMPT_ECHO_DOMINANT', missing: [], text: clean, gates: 0 };
  const outside = clean.split(FENCE3).filter(function(_, i) { return i % 2 === 0; }).join(NL);
  const targetRegex = /^\s*(?:[-*]\s*)?FILE_TARGET:\s*([^\r\n]+)\s*$/gmi;
  const targets = [];
  let tm;
  while ((tm = targetRegex.exec(outside)) !== null) {
    const v = tm[1].trim().replace(/[\x22\x27\x60*]/g, '');
    if (!targets.includes(v)) targets.push(v);
  }
  if (targets.some(function(x) { return /^(?:[a-z]:[\\/]|\\\\|\/)|(?:^|[\\/])\.\.(?:[\\/]|$)/i.test(x); })) return { ok: false, reason: 'UNSAFE_PATH', missing: [], text: clean, gates: 0 };
  const checks = [
    /OBJEKTIV|NON-GOAL/i.test(clean),
    /ENTRY POINT|ROOT CAUSE/i.test(clean),
    /ALLOWED_FILES|FILE_TARGET:/i.test(clean),
    /SPECIFIKIM|SKEDAR MË SKEDAR|FILE-BY-FILE/i.test(clean),
    /DEFINITION OF DONE|\bDoD\b|HARDENING|VERIFIK|TEST/i.test(clean)
  ];
  if (!checks[0]) missing.push('objectives');
  if (!checks[1]) missing.push('entry_root');
  if (!checks[2]) missing.push('allowed_files');
  if (!checks[3]) missing.push('file_spec');
  if (!checks[4]) missing.push('dod');
  const gates = checks.filter(Boolean).length;
  if ((opts.requiresFiles !== false) && targets.length === 0) missing.push('file_target');
  const ok = gates >= 3 && checks[3] && ((opts.requiresFiles === false) || targets.length > 0);
  return { ok: ok, reason: ok ? '' : 'INVALID_PLAN_STRUCTURE', missing: Array.from(new Set(missing)), text: clean, gates: gates, targets: targets };
}

async function classifySearchAiNoResponse(page, opts) {
  const state = await page.evaluate(function() {
    const t = (document.body.innerText || '').toLowerCase();
    const retry = Array.from(document.querySelectorAll('button')).some(function(b) {
      return /retry|try again|provo përsëri/i.test((b.getAttribute('aria-label') || '') + ' ' + (b.innerText || ''));
    });
    const captcha = Boolean(document.querySelector('iframe[src*="recaptcha" i],iframe[title*="recaptcha" i],#recaptcha,form[action*="sorry"]')) || /unusual traffic from your computer network|i.m not a robot/.test(t);
    return {
      captcha: captcha,
      noResponse: /no response available|try asking something else/.test(t),
      service: /something went wrong|response wasn.t generated|service unavailable|try again later/.test(t),
      retry: retry
    };
  });
  if (state.captcha) return 'SEARCH_AI_CAPTCHA_REQUIRED';
  if (state.noResponse) return 'SEARCH_AI_NO_RESPONSE_AVAILABLE';
  if (state.service) return 'SEARCH_AI_SERVICE_ERROR';
  if (opts && opts.assistantTurnExists) return 'SEARCH_AI_BLANK_ASSISTANT_TURN';
  return 'SEARCH_AI_RESPONSE_TIMEOUT';
}

function createGoogleSearchEngine(runtimeContext) {
  if (!runtimeContext || typeof runtimeContext !== 'object') {
    throw new Error('Mandatory runtimeContext dependency is required');
  }

  const withTabLock = runtimeContext.withTabLock;
  const activeProjectPerTab = runtimeContext.activeProjectPerTab || {};
  const getOrCreateTab = runtimeContext.getOrCreateTab;
  const resetChatVerified = runtimeContext.resetChatVerified;
  const captureSupportEvidence = runtimeContext.captureSupportEvidence;
  const checkAuthExpired = runtimeContext.checkAuthExpired;
  const packWorkspace = runtimeContext.packWorkspace;
  const generateSmartArchitectureMap = runtimeContext.generateSmartArchitectureMap;
  const resolveAndEmbedExternalFiles = runtimeContext.resolveAndEmbedExternalFiles;
  const assembleFinalContextArtifact = runtimeContext.assembleFinalContextArtifact;
  const validateFinalTextArtifact = runtimeContext.validateFinalTextArtifact;
  const PACK_MODES = runtimeContext.PACK_MODES || { PLANNING_FULL: 'PLANNING_FULL', RETRY_COMPACT: 'RETRY_COMPACT' };
  const tabAuthStatus = runtimeContext.tabAuthStatus || {};
  const tabActiveModel = runtimeContext.tabActiveModel || {};
  const tabDiscoveredModels = runtimeContext.tabDiscoveredModels || {};
  const collectGeminiTerminalDiagnostics = runtimeContext.collectGeminiTerminalDiagnostics || (async function() {});
  const classifyFailure = runtimeContext.classifyWebServiceFailure || defaultClassifyWebServiceFailure;

  async function ensureSearchAiMenusClosed(page) {
    await page.keyboard.press('Escape').catch(function() {});
    await page.waitForTimeout(150);
    const hasOverlay = await page.evaluate(function() {
      const blocking = Array.from(document.querySelectorAll('.o8Wipc, [role="menu"], [role="listbox"], .cdk-overlay-pane, .cdk-overlay-backdrop')).filter(function(el) {
        if (!el || !el.isConnected) return false;
        const st = window.getComputedStyle(el);
        const r = el.getBoundingClientRect();
        return st.display !== 'none' && st.visibility !== 'hidden' && parseFloat(st.opacity || '1') > 0.05 && r.width > 8 && r.height > 8;
      });
      return blocking.length > 0;
    }).catch(function() { return false; });
    if (hasOverlay) {
      await page.mouse.click(8, 8).catch(function() {});
      await page.keyboard.press('Escape').catch(function() {});
      await page.waitForTimeout(250);
    }
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
        await ensureSearchAiMenusClosed(page);
        if (tabKey) {
          tabActiveModel[tabKey] = GOOGLE_SEARCH_AI_DISPLAY_LABEL;
          tabDiscoveredModels[tabKey] = '4 Hydrogen · Everyday help, 4 Carbon · Most complex work';
        }
        console.error('[MODEL_STATE_OBSERVED] model=' + targetLabel + ' reasoning=n/a evidence=' + JSON.stringify(result.evidence));
        console.error('[MODEL_STATE_VERIFIED] tabKey=' + tabKey + ' attempts=' + attempt + ' alreadyActive=' + Boolean(result.alreadyActive));
        return GOOGLE_SEARCH_AI_DISPLAY_LABEL;
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

  async function discoverSearchAiAssistantTurns(page, opts) {
    opts = opts || {};
    return page.evaluate(function(arg) {
      const visible = function(el) { if (!el || !el.isConnected) return false; const st = getComputedStyle(el), r = el.getBoundingClientRect(); return st.display !== 'none' && st.visibility !== 'hidden' && parseFloat(st.opacity || '1') > .05 && r.width > 8 && r.height > 8; };
      const compact = function(v) { return String(v || '').replace(/\s+/g, ' ').trim(); };
      const composer = function(el) { if (Boolean(el.closest('form,[class*="composer" i],[class*="input-area" i]'))) return true; return Array.from(el.querySelectorAll('textarea:not(.e3RQ5d):not([maxlength="1500"]),[contenteditable="true"],[role="textbox"]')).some(visible); };
      const user = function(el) { const role = (el.getAttribute('data-message-author-role') || '').toLowerCase(); const cls = String(el.className || '').toLowerCase(), text = compact(el.innerText || el.textContent || ''), prompt = compact(arg.userPromptText || ''); return role === 'user' || el.hasAttribute('data-query') || /user-query|user-message|query-bubble|query-heading/.test(cls) || Boolean(el.closest('user-query,[data-message-author-role="user"],[data-query]')) || Boolean(prompt && text.startsWith(prompt.slice(0, 120)) && !el.querySelector('button[aria-label*="Good response" i],button[aria-label*="Copy" i]')); };
      const chrome = function(el) { return el.matches('body,main,nav,aside,[role="navigation"]') || Boolean(el.querySelector('nav,aside,[aria-label*="Open sidebar" i],[aria-label*="Search history" i]')); };
      const nodes = Array.from(document.querySelectorAll('section,article,[data-attrid*="ai" i],[data-container-id],[data-message-author-role="assistant"],div[role="region"]')).filter(function(el) { if (!visible(el) || composer(el) || user(el) || chrome(el)) return false; const t = compact(el.innerText || el.textContent || ''); const signal = el.querySelector('button[aria-label*="Good response" i],button[aria-label*="Bad response" i],button[aria-label*="Copy" i],button[aria-label*="Share" i],button[aria-label*="Përgjigje e mirë" i],button[aria-label*="Kopjo" i],button[aria-label*="Ndaj" i],[data-message-author-role="assistant"]'); const clone = el.cloneNode(true); clone.querySelectorAll('button,[role="button"]').forEach(function(x) { x.remove(); }); const clean = compact(clone.innerText || clone.textContent || ''); if (!clean || /^Shared0 filesShow allShow less$/i.test(clean)) return false; return Boolean(signal) || (el.matches('article,section') && t.length >= arg.minChars); });
      const specific = nodes.filter(function(el) { return !nodes.some(function(other) { if (other === el || !el.contains(other)) return false; const a = compact(el.innerText || el.textContent || ''), b = compact(other.innerText || other.textContent || ''); return b.length > 0 && (a === b || a.includes(b)); }); });
      return specific.map(function(el, index) { const t = compact(el.innerText || el.textContent || ''); if (!el.dataset.antigravityAssistantId) el.dataset.antigravityAssistantId = 'sai-' + Date.now() + '-' + index + '-' + Math.random().toString(16).slice(2); return { id: el.dataset.antigravityAssistantId, index: index, text: t, fingerprint: t.slice(0, 120) + '|' + t.length }; });
    }, { minChars: opts.minChars || 20, userPromptText: opts.userPromptText || '' });
  }

  async function extractSearchAiTurnContent(page, opts) {
    opts = opts || {};
    const result = await page.evaluate(function(arg) {
      const node = document.querySelector('[data-antigravity-assistant-id="' + arg.id + '"]'); if (!node) return null;
      const hiddenLive = []; Array.from(node.querySelectorAll('*')).forEach(function(el) { const st = getComputedStyle(el); if (st.display === 'none' || st.visibility === 'hidden' || el.hidden || el.getAttribute('aria-hidden') === 'true') { el.setAttribute('data-sai-hidden', '1'); hiddenLive.push(el); } });
      const clone = node.cloneNode(true);
      hiddenLive.forEach(function(el) { el.removeAttribute('data-sai-hidden'); });
      clone.querySelectorAll('[data-sai-hidden="1"],script,style,noscript,svg,textarea,input,button,[role="button"],[role="menu"],[role="toolbar"],nav,aside,[aria-label*="More options" i],[aria-label*="Copy" i],[aria-label*="Share" i],[aria-label*="Good response" i],[aria-label*="Bad response" i],[aria-label*="Search history" i]').forEach(function(el) { el.remove(); });
      const serialize = function(root) { const block = /^(P|DIV|SECTION|ARTICLE|LI|TR|H1|H2|H3|H4|H5|H6|PRE|BLOCKQUOTE)$/; let out = ''; const walk = function(n) { if (n.nodeType === 3) { out += n.nodeValue || ''; return; } if (n.nodeType !== 1) return; const tag = n.tagName; if (tag === 'BR') { out += '\n'; return; } if (tag === 'PRE') { out += '\n\n' + (n.textContent || '') + '\n\n'; return; } const isBlock = block.test(tag); if (isBlock) out += '\n'; if (tag === 'LI') out += '- '; Array.from(n.childNodes).forEach(walk); if (tag === 'TD' || tag === 'TH') out += ' | '; if (isBlock) out += '\n'; }; walk(root); return out; };
      let text = serialize(clone).replace(/[ \t]+\n/g, '\n').replace(/\n[ \t]+/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
      const chunks = text.split(arg.fence); for (let i = 0; i < chunks.length; i += 2) { chunks[i] = chunks[i].replace(/([^\n])\s*(FILE_TARGET:)/g, '$1\n$2').replace(/([A-Za-z0-9_.\/-]+\.[A-Za-z0-9]+)\s*([1-9][0-9]*\.\s+[A-ZÇË])/g, '$1\n$2'); } text = chunks.join(arg.fence);
      text = text.split('\n').filter(function(line) { return !/^\s*(?:AI Mode reply for .*|AI Mode response for .*|AI Mode response is ready|Përgjigjja e Modalitetit të IA-së është gati|Përgjigjja e [\x22\u201c]?Modalitetit të IA-së[\x22\u201d]? për .*|Copied to clipboard|Failed to copy|Good response|Bad response|Share|More options|Skip to previous prompt|Kalo te kërkesa e mëparshme)\s*$/i.test(line); }).join('\n').trim();
      text = text.replace(/(?:A copy of this chat will be included|Thanks for letting us know|Google may use account and system data)[\s\S]*$/i, '').trim();
      return text;
    }, { id: opts.id, fence: FENCE3 });
    if (result === null) throw new Error('SEARCH_AI_ASSISTANT_CONTAINER_MISSING');
    return { status: 'RESPONSE_EXTRACTED', text: result, turnIndex: opts.turnIndex, containerFingerprint: searchAiTextFingerprint(result), evidence: { newAssistantTurn: true, userBubbleExcluded: true, uiChromeRemoved: true } };
  }

  async function attachFilesToSearchAiClean(page, filesList) {
    if (!filesList || !filesList.length) return;
    const plus = page.locator('button[aria-label*="Add files" i],button[aria-label*="Shto skedar" i],button[aria-label*="select a model" i]').filter({ visible: true }).first();
    await plus.waitFor({ state: 'visible', timeout: 15000 });
    const direct = page.locator('button[aria-label*="Add files" i]:not([aria-label*="select a model" i]) input[type="file"],input[type="file"]:not([accept*="image/"])').last();
    if (await direct.count()) {
      await direct.setInputFiles(filesList);
    } else {
      await plus.click();
      const item = page.locator('[role="menuitem"][aria-label*="Add files" i],[role="menuitem"]:has-text("Add files")').filter({ visible: true }).first();
      const chooser = page.waitForEvent('filechooser', { timeout: 10000 });
      await item.click();
      (await chooser).setFiles(filesList);
    }
    const names = filesList.map(function(f) { return path.basename(f); });
    const deadline = Date.now() + 25000;
    let stable = 0;
    while (Date.now() < deadline) {
      const state = await page.evaluate(function(ns) {
        const c = function(v) { return String(v || '').replace(/\s+/g, '').toLowerCase(); };
        const body = c(document.body.innerText || '');
        const els = Array.from(document.querySelectorAll('[aria-label],[title],[class*="chip" i],[class*="attach" i]'));
        const found = ns.every(function(n) {
          const full = c(n), stem = full.replace(/\.[^.]+$/, '');
          return body.includes(full) || body.includes(stem) || els.some(function(e) {
            const t = c((e.getAttribute('aria-label') || '') + ' ' + (e.getAttribute('title') || '') + ' ' + (e.innerText || ''));
            return t.includes(full) || t.includes(stem);
          });
        });
        const busy = Array.from(document.querySelectorAll('[aria-busy="true"],[role="progressbar"],.spinner,.uploading')).some(function(e) {
          const s = getComputedStyle(e), r = e.getBoundingClientRect();
          return s.display !== 'none' && s.visibility !== 'hidden' && r.width > 4;
        });
        return { found: found, busy: busy };
      }, names);
      stable = state.found && !state.busy ? stable + 1 : 0;
      if (stable >= 3) {
        console.error('[SEARCH_AI_ATTACHMENT_VERIFIED] files=' + names.join(','));
        return;
      }
      await page.waitForTimeout(250);
    }
    throw new Error('SEARCH_AI_ATTACHMENT_NOT_VERIFIED');
  }

  async function dispatchToGoogleSearchAiTab(opts) {
    const tabKey = opts.tabKey;
    const cleanRoot = path.resolve(opts.projectRoot);
    const isPlannerTask = opts.isPlanner === false ? false : Boolean(opts.isPlanner || opts.promptText.includes('CHIEF_ARCHITECT') || opts.promptText.includes('PLANIFIKUESIT') || opts.promptText.includes('plan.md'));

    return withTabLock(tabKey, async function() {
      activeProjectPerTab[tabKey] = cleanRoot;
      let page = await getOrCreateTab(tabKey);
      if (opts.forceFreshChat === true) await resetChatVerified({ page: page, targetFrame: page, tabKey: tabKey, projectRoot: cleanRoot, forceReload: true, reason: 'FORCE_FRESH_DISPATCH' });
      await page.goto(GOOGLE_SEARCH_AI_URL, { waitUntil: 'domcontentloaded', timeout: 45000 });
      await page.waitForTimeout(3000);
      await selectGoogleSearchAiModel(page, 'hydrogen', tabKey);
      if (await checkAuthExpired(page, tabKey)) await captureSupportEvidence(page, cleanRoot, tabKey, 'AUTH_EXPIRED', 'Google Search AI requires login.');

      const exchangeDir = path.join(cleanRoot, '.antigravity', 'bridge', 'exchange');
      if (!fs.existsSync(exchangeDir)) fs.mkdirSync(exchangeDir, { recursive: true });
      const txtBundle = path.join(exchangeDir, 'project_bundle.txt');
      if (!fs.existsSync(txtBundle)) packWorkspace(cleanRoot, 'FULL');
      const master = path.join(exchangeDir, 'project_context_bundle.txt');

      if (isPlannerTask && opts.useProvidedBundle !== true) {
        const activeMode = opts.packMode || PACK_MODES.PLANNING_FULL;
        const arch = generateSmartArchitectureMap(cleanRoot);
        const spec = resolveAndEmbedExternalFiles((opts.userRequest || opts.promptText || '').trim());
        const code = fs.existsSync(txtBundle) ? fs.readFileSync(txtBundle, 'utf8') : '';
        const assembled = assembleFinalContextArtifact({
          header: 'PROJECT CONTEXT BUNDLE',
          taskMetadata: opts.userRequest || 'Analizo projektin.',
          architectureMap: 'PJESA A: HARTA ARKITEKTURORE' + NL + arch,
          externalSpecs: 'PJESA B: SPECIFIKIMET' + NL + (spec || opts.userRequest || 'Analizo projektin.'),
          workspace: 'PJESA C: KODI BURIMOR' + NL + code,
          manifest: 'mode=' + activeMode
        }, activeMode);
        validateFinalTextArtifact(assembled.text, activeMode);
        fs.writeFileSync(master, assembled.text, 'utf8');
        console.error('[FINAL_CONTEXT_VALIDATED] mode=' + activeMode + ' bytes=' + assembled.receipt.finalContextBytes + ' sha256=' + assembled.receipt.finalSha256);
      }

      const files = [];
      if (opts.useProvidedBundle === true && opts.bundlePath && fs.existsSync(opts.bundlePath)) {
        const providedText = fs.readFileSync(opts.bundlePath, 'utf8');
        validateFinalTextArtifact(providedText, PACK_MODES.PLANNING_FULL);
        files.push(opts.bundlePath);
      } else if (isPlannerTask) {
        files.push(master);
      } else if (opts.bundlePath && fs.existsSync(opts.bundlePath)) {
        files.push(opts.bundlePath);
      } else if (fs.existsSync(txtBundle)) {
        files.push(txtBundle);
      }
      let promptOffloadedToFile = false;
      if (!isPlannerTask && opts.promptText && opts.promptText.length > 7400) {
        const promptFile = path.join(exchangeDir, 'search_prompt_full.txt');
        fs.writeFileSync(promptFile, opts.promptText, 'utf8');
        if (!files.includes(promptFile)) files.push(promptFile);
        promptOffloadedToFile = true;
      }
      await attachFilesToSearchAiClean(page, files);

      async function sendTurnAndExtract(text, meta) {
        meta = meta || {};
        const before = await discoverSearchAiAssistantTurns(page, { minChars: 5 });
        const snapshot = {
          assistantCount: before.length,
          assistantNodeIds: before.map(function(x) { return x.id; }),
          latestAssistantFingerprint: before.length ? before[before.length - 1].fingerprint : '',
          sendTimestamp: Date.now()
        };
        console.error('[SEARCH_AI_TURN_SNAPSHOT] assistantCount=' + snapshot.assistantCount + ' latestFingerprint=' + snapshot.latestAssistantFingerprint);

        await ensureSearchAiMenusClosed(page);
        const box = page.locator('textarea.ITIRGe:visible,textarea[placeholder*="Ask" i]:visible,textarea[placeholder*="Pyet" i]:visible,textarea:visible').last();
        await box.waitFor({ state: 'visible', timeout: 25000 });
        const rawMaxLen = await box.getAttribute('maxlength').catch(function() { return null; });
        const maxLen = (rawMaxLen && Number(rawMaxLen) > 0) ? Math.min(7800, Number(rawMaxLen) - 100) : 7800;
        const safeText = String(text || '').length > maxLen
          ? (String(text).slice(0, Math.floor(maxLen / 2)) + '\n...[COMPACTED]...\n' + String(text).slice(-Math.floor(maxLen / 2)))
          : String(text || '');
        await box.click();
        await page.keyboard.press('Control+A');
        await page.keyboard.insertText(safeText);

        let send = page.locator('button[aria-label*="Send" i],button[aria-label*="Dërgo" i],button[type="submit"]').filter({ visible: true }).filter({ hasNotText: /add file|shto skedar|select a model|zgjidh një model|mic|voice/i }).last();
        if (await send.count()) await send.click({ timeout: 5000 });
        else await box.press('Enter');

        const deadline = Date.now() + (meta.timeoutMs || 150000);
        const minNeeded = meta.expectedKind === 'handshake' ? 5 : (meta.minNeeded || 20);
        let observed = null, receipt = null, lastText = '', stable = 0;

        while (Date.now() < deadline) {
          await page.waitForTimeout(1750);
          const pollClass = await classifySearchAiNoResponse(page, {});
          if (pollClass === 'SEARCH_AI_CAPTCHA_REQUIRED') {
            console.error('[CAPTCHA_SIGNAL_DETECTED] engine=' + tabKey);
            await captureSupportEvidence(page, cleanRoot, tabKey, 'CAPTCHA_REQUIRED', 'Captcha detected on Google Search AI.');
            throw new Error('WEB_CAPTCHA_OR_BLOCK_CHALLENGE');
          }
          if (pollClass === 'SEARCH_AI_NO_RESPONSE_AVAILABLE' || pollClass === 'SEARCH_AI_SERVICE_ERROR') {
            throw new Error(pollClass);
          }
          const turns = await discoverSearchAiAssistantTurns(page, { minChars: minNeeded, userPromptText: text });
          const newTurns = turns.filter(function(t) { return !snapshot.assistantNodeIds.includes(t.id); });
          const current = newTurns.length ? newTurns[newTurns.length - 1] : (turns.length > snapshot.assistantCount ? turns[turns.length - 1] : null);

          if (current) {
            observed = current;
            if (current.text && current.text.length >= minNeeded) {
              if (current.text === lastText) {
                stable++;
                if (stable >= 2) {
                  receipt = await extractSearchAiTurnContent(page, { id: current.id, turnIndex: current.index });
                  break;
                }
              } else {
                stable = 0;
                lastText = current.text;
              }
            }
          }
        }

        if (!receipt && observed) {
          receipt = await extractSearchAiTurnContent(page, { id: observed.id, turnIndex: observed.index }).catch(function() { return null; });
        }
        if (!receipt || !receipt.text) {
          const timeoutCode = await classifySearchAiNoResponse(page, { assistantTurnExists: Boolean(observed) });
          throw new Error(timeoutCode);
        }
        const failure = classifyFailure({ text: receipt.text, engine: 'google_search' });
        if (failure.class === 'POLICY_REFUSAL' || failure.class === 'QUOTA_OR_LIMIT_ERROR') {
          throw new Error(failure.code + ': ' + failure.matchedSignals.join(','));
        }
        if (failure.class === 'TRANSIENT_SERVICE_ERROR') throw new Error('WEB_SERVICE_REFUSAL: ' + receipt.text.slice(0, 160));
        console.error('[SEARCH_AI_EXTRACTED] kind=' + (meta.expectedKind || 'generic') + ' chars=' + receipt.text.length + ' chromeRemoved=true');
        return receipt.text;
      }

      if (files.length) {
        let handshakeText = await sendTurnAndExtract(buildSearchAiCleanPrompt(isPlannerTask ? 'handshake' : 'handshakeReview'), { expectedKind: 'handshake', timeoutMs: 60000 });
        console.error('[SEARCH_AI_HANDSHAKE_LOG] text=' + JSON.stringify(handshakeText));
        let handshake = classifyAttachmentHandshake(handshakeText, { attachmentVerified: true, alerts: [] }, classifyFailure);
        if (handshake.class !== 'HANDSHAKE_ACCEPTED') {
          if (handshake.code !== 'WEB_PAYLOAD_REJECTED_OR_OVERSIZED') throw Object.assign(new Error(handshake.code), { classification: handshake });
          await collectGeminiTerminalDiagnostics({ page: page, targetFrame: page, tabKey: tabKey, projectRoot: cleanRoot, dispatchId: 'search-handshake-' + Date.now(), errorCode: handshake.code, state: {}, elapsedMs: 0, progressAgeMs: 0 }).catch(function() {});
          const reset = await resetChatVerified({ page: page, targetFrame: page, tabKey: tabKey, projectRoot: cleanRoot, reason: handshake.code });
          if (!reset || reset.status !== 'CHAT_RESET_VERIFIED') throw new Error('CHAT_RESET_VERIFICATION_FAILED');
          const compactInfo = packWorkspace(cleanRoot, PACK_MODES.RETRY_COMPACT);
          const compactSource = fs.readFileSync(path.join(exchangeDir, 'project_bundle.txt'), 'utf8');
          const compact = assembleFinalContextArtifact({ header: 'PROJECT CONTEXT BUNDLE RETRY', taskMetadata: opts.userRequest || '', workspace: compactSource, manifest: 'mode=RETRY_COMPACT' }, PACK_MODES.RETRY_COMPACT);
          validateFinalTextArtifact(compact.text, PACK_MODES.RETRY_COMPACT);
          fs.writeFileSync(master, compact.text, 'utf8');
          files.length = 0;
          files.push(master);
          await attachFilesToSearchAiClean(page, files);
          handshakeText = await sendTurnAndExtract(buildSearchAiCleanPrompt(isPlannerTask ? 'handshake' : 'handshakeReview'), { expectedKind: 'handshake', timeoutMs: 60000 });
          handshake = classifyAttachmentHandshake(handshakeText, { attachmentVerified: true, alerts: [] }, classifyFailure);
          if (handshake.class !== 'HANDSHAKE_ACCEPTED') throw Object.assign(new Error('SEARCH_AI_ATTACHMENT_RETRY_EXHAUSTED'), { firstClassification: handshake, compactReceipt: compact.receipt, resetReceipt: reset, packReceipt: compactInfo.receipt });
        }
      }

      await selectGoogleSearchAiModel(page, 'carbon', tabKey);
      await page.waitForTimeout(1000);

      if (isPlannerTask) {
        let prompt = buildSearchAiCleanPrompt('plan');
        let lastError = '';
        for (let attempt = 1; attempt <= 2; attempt++) {
          try {
            const text = await sendTurnAndExtract(prompt, { expectedKind: 'plan' });
            const check = validatePlanOutput(text, { requiresFiles: true });
            console.error('[SEARCH_AI_PLAN_VALIDATION] valid=' + check.ok + ' gates=' + check.gates + ' missing=' + check.missing.join(','));
            if (check.ok) {
              tabAuthStatus[tabKey] = 'ACTIVE';
              tabActiveModel[tabKey] = GOOGLE_SEARCH_AI_DISPLAY_LABEL;
              return ['# PLANI ARKITEKTUROR DHE SPECIFIKIMI I EKZEKUTIMIT (MULTI-AI RELAY)', 'Projekti: ' + path.basename(cleanRoot), 'Data: ' + new Date().toISOString(), ' ', check.text].join(NL);
            }
            lastError = 'INVALID_PLAN_STRUCTURE';
            prompt = buildSearchAiCleanPrompt('planRetry', { missing: check.missing });
          } catch (err) {
            lastError = err.message;
            if (/WEB_QUOTA_OR_LIMIT_ERROR/.test(lastError)) throw err;
            if (/NO_RESPONSE_AVAILABLE|BLANK_ASSISTANT_TURN/.test(lastError)) {
              await page.goto(GOOGLE_SEARCH_AI_URL, { waitUntil: 'domcontentloaded', timeout: 45000 });
              await page.waitForTimeout(2500);
              await selectGoogleSearchAiModel(page, 'hydrogen', tabKey);
              await attachFilesToSearchAiClean(page, files);
              await sendTurnAndExtract(buildSearchAiCleanPrompt('handshake'), { expectedKind: 'handshake', timeoutMs: 60000, minNeeded: 5 });
              await selectGoogleSearchAiModel(page, 'carbon', tabKey);
              await page.waitForTimeout(1000);
              prompt = buildSearchAiCleanPrompt('plan');
            } else if (/SERVICE_ERROR/.test(lastError)) {
              await page.waitForTimeout(2500);
            } else throw err;
          }
        }
        throw new Error('PLANNER_ESCALATION_FAILED: ' + lastError);
      }

      if (!isPlannerTask && opts.useProvidedBundle === true) {
        const boxText = promptOffloadedToFile
          ? 'Lexo dhe zbato 100% udhëzimet e plota të bashkëngjitura në skedarin search_prompt_full.txt së bashku me skedarin tjetër të bashkëngjitur.'
          : opts.promptText;
        return sendTurnAndExtract(boxText, { expectedKind: 'chunk', timeoutMs: 180000, minNeeded: 20 });
      }
      const reviewer = opts.promptText.includes('STATUS: APPROVED') || (opts.bundlePath && opts.bundlePath.endsWith('code.md'));
      const kind = reviewer ? 'review' : 'code';
      const contextText = promptOffloadedToFile
        ? 'Udhëzimet e plota, plani dhe konteksti janë bashkëngjitur në skedarin fizik search_prompt_full.txt. Lexoje plotësisht para përgjigjes.'
        : opts.promptText.slice(0, 7200);
      const prompt = buildSearchAiCleanPrompt(kind, { context: contextText });
      return sendTurnAndExtract(prompt, { expectedKind: kind, timeoutMs: 180000 });
    });
  }

  return {
    selectGoogleSearchAiModel,
    ensureGoogleSearchAi4CarbonMode,
    discoverSearchAiAssistantTurns,
    extractSearchAiTurnContent,
    classifySearchAiNoResponse,
    attachFilesToSearchAiClean,
    validatePlanOutput,
    classifyAttachmentHandshake: function(text, telemetry) { return classifyAttachmentHandshake(text, telemetry, classifyFailure); },
    buildSearchAiCleanPrompt,
    searchAiTextFingerprint,
    dispatchToGoogleSearchAiTab
  };
}

module.exports = {
  createGoogleSearchEngine,
  GOOGLE_SEARCH_AI_URL,
  validatePlanOutput,
  classifyAttachmentHandshake,
  buildSearchAiCleanPrompt,
  searchAiTextFingerprint,
  classifySearchAiNoResponse
};
