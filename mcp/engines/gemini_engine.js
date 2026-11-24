'use strict';

const fs = require('node:fs');
const path = require('node:path');

const GEMINI_APP_URL = 'https://' + 'gemini.' + 'google.com' + '/app';

const DEFAULT_STANDARD_HARD_CAP_MS = 65000;
const HIGH_REASONING_HARD_CAP_MS = 240000;
const GEMINI_TEMP_CHAT_ALLOWLIST = Object.freeze(['gemini1', 'gemini2', 'gemini3']);

// ============================================================================
// RREGULL I PANEGOCIUESHËM DHE I KYÇUR (INVIOLABLE LOCK - HIGH PRIORITY)
// NDALOHET KATEGORIKISHT ÇDO MODALITET TJETËR PËRVEÇ "NEON HIGH" (EXTRA THOROUGH).
// NDALOHET KATEGORIKISHT NEON LOW (FAST AND EFFICIENT), FLASH OSE AUTO.
// BUTONI DUHET TË JETË VETËM "Neon\nHigh" ME ARIA "Open mode picker, currently Neon High".
// ASNJË AGJENT NUK KA TË DREJTË TA NDRYSHOJË APO ZBUTË KËTË KUSHT KURRË!
// ============================================================================
const GEMINI_REQUIRED_MODEL = Object.freeze({
  family: 'neon',
  menuPattern: '4\\s*neon',
  activePattern: 'neon[\\s\\n]+high|currently\\s*neon\\s*high',
  menuLabel: 'Deeper analysis (4 Neon)',
  modelLabel: '4 Neon',
  displayLabel: '4 Neon (High)',
  reasoning: 'high',
  reasoningSource: 'integrated-model-mode'
});

function normalizeHardCapToken(value) {
  if (typeof value !== 'string') return '';
  return value.normalize('NFKC').trim().toLowerCase();
}

function resolveGeminiHardCapMs(args) {
  if (!args || typeof args !== 'object') {
    return DEFAULT_STANDARD_HARD_CAP_MS;
  }

  if (typeof args.hardCapMs === 'number' && Number.isFinite(args.hardCapMs) && args.hardCapMs > 0) {
    const explicitCap = Math.floor(args.hardCapMs);
    if (explicitCap > 0) {
      return explicitCap;
    }
  }

  const tier = normalizeHardCapToken(args.modelTier);
  const reasoning = normalizeHardCapToken(args.reasoningLevel) || normalizeHardCapToken(args.thinkingLevel);
  const active = normalizeHardCapToken(args.activeModel) ||
    normalizeHardCapToken(args.modelLabel) ||
    normalizeHardCapToken(args.model);
  const normalizedReasoning = reasoning.replace(/\s+/g, ' ');

  if (tier === 'pro_31') {
    return HIGH_REASONING_HARD_CAP_MS;
  }

  if (
    normalizedReasoning === 'high' ||
    normalizedReasoning === 'extra_thorough' ||
    normalizedReasoning === 'extra thorough'
  ) {
    return HIGH_REASONING_HARD_CAP_MS;
  }

  if (
    /(?:^|[\s_.-])(neon|argon|pro|thinking|reasoning)[\s_.-]*high(?:$|[\s_.-])/.test(tier) ||
    tier === 'high' ||
    tier === 'high_reasoning'
  ) {
    return HIGH_REASONING_HARD_CAP_MS;
  }

  if (
    normalizedReasoning !== 'low' &&
    /\b(neon|argon|pro)\b/.test(active) &&
    /\b(high|extra\s+thorough)\b/.test(active) &&
    !/\b(low|fast|flash|lite)\b/.test(active)
  ) {
    return HIGH_REASONING_HARD_CAP_MS;
  }

  return DEFAULT_STANDARD_HARD_CAP_MS;
}

const geminiModelReceipts = {
  gemini1: null,
  gemini2: null,
  gemini3: null
};

function invalidateGeminiReceipt(tabKey) {
  if (tabKey && Object.prototype.hasOwnProperty.call(geminiModelReceipts, tabKey)) {
    geminiModelReceipts[tabKey] = null;
  }
}

function classifyAttachmentHandshakeStrict(text) {
  const normalized = String(text || '').trim();
  if (!normalized) return { ok: false, code: 'BLANK' };
  if (/Lexo skedarin e bashkëngjitur|Mos shkruaj kod ende/i.test(normalized)) {
    return { ok: false, code: 'PROMPT_ECHO' };
  }
  const clean = normalized.normalize('NFKC').toLowerCase().replace(/[’‘]/g, "'").replace(/[^\p{L}\p{N}' ]+/gu, ' ').replace(/\s+/g, ' ').trim();
  const positive = /(^|\b)(ok|e lexova|lexova|jam gati|gati|ready|received|read it|file received|attachment received)(\b|$)/i.test(clean);
  if (!positive) return { ok: false, code: 'SEARCH_AI_ATTACHMENT_HANDSHAKE_UNVERIFIED' };
  return { ok: true, code: 'SEARCH_AI_ATTACHMENT_HANDSHAKE_ACCEPTED' };
}

function classifyResetCandidate(state, sendMeta, preCounts) {
  state = state || {};
  sendMeta = sendMeta || {};
  preCounts = preCounts || {};
  const preUserCount = Number(preCounts.preUserCount || 0);
  const preAssistantCount = Number(preCounts.preAssistantCount || 0);
  const observedUserHighWatermark = Math.max(Number(preCounts.observedUserHighWatermark || preUserCount), state.userTurnCount || 0);
  const observedAssistantHighWatermark = Math.max(Number(preCounts.observedAssistantHighWatermark || preAssistantCount), state.assistantTurnCount || 0);
  const newTurnWasObserved = Boolean(
    observedUserHighWatermark > preUserCount ||
    observedAssistantHighWatermark > preAssistantCount ||
    sendMeta.newUserTurnFingerprint ||
    sendMeta.userTurnFingerprintMatched ||
    (sendMeta.evidence && sendMeta.evidence.userTurnFingerprintMatched)
  );
  const countsReturnedToBaseline = Boolean((state.userTurnCount || 0) <= preUserCount && (state.assistantTurnCount || 0) <= preAssistantCount);
  const committedTurnMissing = Boolean(!state.committedUserStillPresent);
  const turnRolledBackAfterSend = Boolean(
    sendMeta.committed && newTurnWasObserved && countsReturnedToBaseline && committedTurnMissing && !state.generating && !preCounts.lastText
  );
  const domainDriftCandidate = Boolean(
    sendMeta.committed && state.domainMismatch && (state.userTurnCount || 0) === 0 && (state.assistantTurnCount || 0) === 0 && !state.generating
  );
  const landingResetCandidate = Boolean(
    sendMeta.committed && state.landingVisible && (state.userTurnCount || 0) === 0 && (state.assistantTurnCount || 0) === 0 && !state.generating && !state.conversationContinuity
  );
  const isCandidate = Boolean(domainDriftCandidate || landingResetCandidate || turnRolledBackAfterSend);
  const resetKind = domainDriftCandidate ? 'DOMAIN_DRIFT' : (landingResetCandidate ? 'LANDING_RESET' : (turnRolledBackAfterSend ? 'TURN_ROLLBACK' : ''));
  const resetCode = domainDriftCandidate
    ? 'ENGINE_DOMAIN_DRIFT_AFTER_SEND'
    : (turnRolledBackAfterSend && !landingResetCandidate
      ? 'GEMINI_TURN_ROLLED_BACK_AFTER_SEND'
      : 'GEMINI_CONVERSATION_RESET_AFTER_SEND');

  return {
    isCandidate,
    resetKind,
    resetCode,
    domainDriftCandidate,
    landingResetCandidate,
    turnRolledBackAfterSend,
    newTurnWasObserved,
    countsReturnedToBaseline,
    committedTurnMissing
  };
}

function classifyGeminiRecovery(errorMessage, currentRecoveryCount, maxRecoveries) {
  maxRecoveries = Number.isFinite(maxRecoveries) ? maxRecoveries : 1;
  currentRecoveryCount = Number.isFinite(currentRecoveryCount) ? currentRecoveryCount : 0;
  const msg = String(errorMessage || '');
  const isPreflight = msg.includes('GEMINI_SILENT_PREFLIGHT_TIMEOUT');
  const isReset = msg.includes('GEMINI_CONVERSATION_RESET_AFTER_SEND') ||
                  msg.includes('ENGINE_DOMAIN_DRIFT_AFTER_SEND') ||
                  msg.includes('GEMINI_TURN_ROLLED_BACK_AFTER_SEND');

  if (!isPreflight && !isReset) {
    return { shouldRecover: false, exhausted: false, code: msg.split(' ')[0] };
  }

  if (currentRecoveryCount < maxRecoveries) {
    return {
      shouldRecover: true,
      exhausted: false,
      code: msg.split(' ')[0],
      nextRecoveryCount: currentRecoveryCount + 1,
      budgetRemaining: maxRecoveries - (currentRecoveryCount + 1)
    };
  }

  return {
    shouldRecover: false,
    exhausted: true,
    code: 'GEMINI_RESET_RECOVERY_EXHAUSTED',
    reason: 'SECOND_RESET ' + (isPreflight ? 'GEMINI_SILENT_PREFLIGHT_TIMEOUT' : 'GEMINI_CONVERSATION_RESET_AFTER_SEND'),
    stopImmediately: true
  };
}

async function collectGeminiTerminalDiagnostics(args) {
  args = args || {};
  const safeAppend = typeof args.appendDispatchDiag === 'function'
    ? args.appendDispatchDiag
    : (typeof appendDispatchDiag === 'function' ? appendDispatchDiag : function() {});
  const state = args.state || {};
  const dispatchId = args.dispatchId || 'n/a';
  safeAppend(args.projectRoot, dispatchId, 'TERMINAL_DIAG_START', {
    errorCode: args.errorCode,
    elapsedMs: args.elapsedMs,
    progressAgeMs: args.progressAgeMs,
    routeKey: state.routeKey || '',
    users: state.userTurnCount || 0,
    assistants: state.assistantTurnCount || 0
  });

  const probe = await (args.targetFrame && typeof args.targetFrame.evaluate === 'function'
    ? args.targetFrame.evaluate(function() {
        const visible = function(el) {
          if (!el || !el.isConnected) return false;
          const st = getComputedStyle(el), r = el.getBoundingClientRect();
          return st.display !== 'none' && st.visibility !== 'hidden' && parseFloat(st.opacity || '1') > 0.05 && r.width > 4 && r.height > 4;
        };
        const clean = function(v, max) {
          return String(v || '').replace(/https?:\/\/\S+/gi, '[url]').replace(/[A-Za-z]:[\\/]\S+/g, '[path]').replace(/\s+/g, ' ').trim().slice(0, max);
        };
        const finger = function(v) {
          let h = 2166136261;
          for (let i = 0; i < v.length; i++) {
            h ^= v.charCodeAt(i);
            h = Math.imul(h, 16777619);
          }
          return ('00000000' + (h >>> 0).toString(16)).slice(-8);
        };
        const alertNodes = Array.from(document.querySelectorAll('[role="alert"],[role="status"],[aria-live="assertive"],[aria-live="polite"],mat-snack-bar-container,snack-bar-container,[class*="snack" i],[class*="toast" i],[class*="error" i]')).filter(visible);
        const alerts = alertNodes.map(function(el) {
          const text = clean(el.innerText || el.textContent || '', 240);
          return {
            tag: el.tagName.toLowerCase(),
            role: el.getAttribute('role') || '',
            ariaLive: el.getAttribute('aria-live') || '',
            textFingerprint: finger(text),
            textPreview: text
          };
        }).filter(function(x) { return x.textPreview; });

        const all = alerts.map(function(x) { return x.textPreview.toLowerCase(); }).join(' | ');
        const retryVisible = Array.from(document.querySelectorAll('button,[role="button"]')).some(function(el) {
          return visible(el) && /retry|try again|provo përsëri/i.test((el.getAttribute('aria-label') || '') + ' ' + (el.innerText || ''));
        });

        let errorCode = '';
        if (/quota|rate limit|too many requests|limit reached/.test(all)) {
          errorCode = 'GEMINI_QUOTA_OR_RATE_LIMIT';
        } else if (/upload|attachment/.test(all) && /fail|unsupported|error|problem/.test(all)) {
          errorCode = 'GEMINI_ATTACHMENT_PROCESSING_ERROR';
        } else if (/sign in|session|auth|log in|login/.test(all)) {
          errorCode = 'GEMINI_AUTH_OR_SESSION_ERROR';
        } else if (/something went wrong|try again|server error|service unavailable/.test(all)) {
          errorCode = 'GEMINI_SERVICE_ERROR';
        }

        let containers = Array.from(document.querySelectorAll('response-container'));
        if (!containers.length) containers = Array.from(document.querySelectorAll('model-response,[data-message-author-role="model"]'));
        const node = containers[containers.length - 1] || null;
        let responseContainer = null;
        if (node) {
          const clone = node.cloneNode(true);
          clone.querySelectorAll('input,textarea,script,style').forEach(function(el) { el.remove(); });
          clone.querySelectorAll('[href],[src]').forEach(function(el) { el.removeAttribute('href'); el.removeAttribute('src'); });
          Array.from(clone.attributes || []).forEach(function(a) {
            if (/^data-/i.test(a.name) && !/data-testid/i.test(a.name)) clone.removeAttribute(a.name);
          });
          let html = String(clone.outerHTML || '').replace(/\s(?:value|placeholder)=([\x22\x27]).*?\1/gi, '').replace(/https?:\/\/[^\s\x22\x27>]+/gi, '[url]').replace(/\s+/g, ' ').slice(0, 1000);
          responseContainer = {
            tag: node.tagName.toLowerCase(),
            classNames: Array.from(node.classList).filter(function(x) { return /^[A-Za-z0-9_-]{1,80}$/.test(x); }).slice(0, 12),
            childElementCount: node.childElementCount,
            textLength: String(node.textContent || '').length,
            hasMessageContent: Boolean(node.querySelector('message-content')),
            hasModelThoughts: Boolean(node.querySelector('model-thoughts,.thoughts-container,.thought-container,[data-test-id*="thought" i],[data-testid*="thought" i],ms-thought-chunk')),
            ariaBusy: node.getAttribute('aria-busy') || '',
            dataTestIds: Array.from(node.querySelectorAll('[data-testid]')).map(function(el) { return clean(el.getAttribute('data-testid'), 80); }).slice(0, 12),
            outerHtmlFingerprint: finger(html),
            outerHtmlSnippetSanitizedMax1000: html
          };
        }

        if (responseContainer && node) {
          const presented = node.querySelector('.presented-response-container,[class*="presented-response" i]');
          const safeChildren = Array.from((presented || node).children || []).slice(0, 20).map(function(el) {
            return { tag: el.tagName.toLowerCase(), classNames: Array.from(el.classList || []).slice(0, 8) };
          });
          const selectors = [
            '.response-container-header-processing-state',
            '.response-container-header svg',
            '.presented-response-container svg',
            '.presented-response-container canvas',
            '.presented-response-container bard-avatar',
            '.presented-response-container lottie-animation',
            'pending-response',
            'loading-indicator',
            'bard-avatar',
            'lottie-animation',
            '[role="progressbar"]',
            '[aria-busy="true"]',
            'mat-progress-spinner',
            '[class*="spinner" i]',
            '[class*="loading" i]',
            '[class*="processing" i]'
          ].join(',');
          const pc = Array.from(node.querySelectorAll(selectors)).slice(0, 20).map(function(el) {
            const st = getComputedStyle(el), r = el.getBoundingClientRect();
            return {
              tag: el.tagName.toLowerCase(),
              classNames: Array.from(el.classList || []).slice(0, 8),
              role: el.getAttribute('role') || '',
              ariaBusy: el.getAttribute('aria-busy') || '',
              rect: { width: Math.round(r.width), height: Math.round(r.height) },
              animated: Boolean(st.animationName && st.animationName !== 'none'),
              visibleWrapper: visible(el)
            };
          });
          responseContainer.presentedResponse = {
            exists: Boolean(presented),
            tag: presented ? presented.tagName.toLowerCase() : '',
            classNames: presented ? Array.from(presented.classList || []).slice(0, 8) : [],
            childTagsAndClassesMax20: safeChildren
          };
          responseContainer.processingCandidates = pc;
          responseContainer.processingVisualDetected = pc.some(function(x) { return x.visibleWrapper; });
          responseContainer.processingFallbackDetected = false;
        }

        return {
          alerts: alerts,
          errorCode: errorCode,
          retryVisible: retryVisible,
          responseContainer: responseContainer
        };
      })
    : Promise.resolve({ alerts: [], errorCode: '', retryVisible: false, responseContainer: null })
  ).catch(function() {
    return { alerts: [], errorCode: '', retryVisible: false, responseContainer: null };
  });

  safeAppend(args.projectRoot, dispatchId, 'GEMINI_ALERTS_PROBED', {
    count: probe.alerts.length,
    errorCode: probe.errorCode,
    retryVisible: probe.retryVisible,
    alerts: probe.alerts
  });
  safeAppend(args.projectRoot, dispatchId, 'GEMINI_RESPONSE_CONTAINER_PROBED', {
    container: probe.responseContainer
  });

  let screenshotPath = '';
  if (args.page && typeof args.page.screenshot === 'function' && args.projectRoot) {
    try {
      const dir = path.join(path.resolve(args.projectRoot), '.antigravity', 'bridge', 'exchange');
      if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
      screenshotPath = path.join(dir, 'support_' + (args.tabKey || 'gemini') + '_' + Date.now() + '.png');
      await args.page.screenshot({ path: screenshotPath, fullPage: false });
      safeAppend(args.projectRoot, dispatchId, 'TERMINAL_SCREENSHOT_SAVED', { path: path.basename(screenshotPath) });
    } catch (err) {
      safeAppend(args.projectRoot, dispatchId, 'SCREENSHOT_CAPTURE_FAILED', { error: String(err && err.message || err).slice(0, 160) });
    }
  }

  return {
    errorCode: probe.errorCode,
    retryVisible: probe.retryVisible,
    alerts: probe.alerts,
    responseContainer: probe.responseContainer,
    screenshotPath: screenshotPath
  };
}

async function runGeminiAttachmentIngestHandshake(args) {
  args = args || {};
  const prompt = 'Lexo skedarin e bashkëngjitur plotësisht. Mos shkruaj kod ende. Përgjigju vetëm me konfirmim të shkurtër se skedari u lexua dhe je gati.';
  const dispatcher = args.dispatchToWebTab || (typeof dispatchToWebTab === 'function' ? dispatchToWebTab : null);
  if (typeof dispatcher !== 'function') {
    throw new Error('Mandatory dispatchToWebTab dispatcher is required for handshake');
  }

  const resolvedModelTier = args.modelTier || 'neon';
  const resolvedReasoningLevel = (typeof args.reasoningLevel === 'string' && args.reasoningLevel.trim())
    ? args.reasoningLevel
    : ((typeof args.thinkingLevel === 'string' && args.thinkingLevel.trim()) ? args.thinkingLevel : 'high');
  const receipt = args.tabKey && Object.prototype.hasOwnProperty.call(geminiModelReceipts, args.tabKey)
    ? geminiModelReceipts[args.tabKey]
    : null;
  const resolvedActiveModel = args.activeModel || args.modelLabel || args.model || (receipt && receipt.displayLabel) || undefined;
  const hardCapMs = resolveGeminiHardCapMs({
    hardCapMs: args.hardCapMs,
    modelTier: resolvedModelTier,
    reasoningLevel: resolvedReasoningLevel,
    thinkingLevel: args.thinkingLevel,
    activeModel: resolvedActiveModel
  });

  const text = await dispatcher({
    tabKey: args.tabKey,
    projectRoot: args.projectRoot,
    promptText: prompt,
    attachmentPaths: [args.attachmentPath],
    forceFreshChat: args.forceFreshChat !== false,
    disableInternalRetry: true,
    reasoningLevel: resolvedReasoningLevel,
    modelTier: resolvedModelTier,
    hardCapMs: hardCapMs
  });

  const check = classifyAttachmentHandshakeStrict(text);
  if (!check.ok) {
    throw new Error('GEMINI_ATTACHMENT_INGEST_UNVERIFIED: ' + check.code);
  }
  console.error('[GEMINI_ATTACHMENT_INGEST_VERIFIED] batchId=' + (args.batchId || '') + ' chars=' + text.length);
  return { status: 'VERIFIED', text: text };
}

const GEMINI_SESSION_SELECTORS = Object.freeze({
  newConversation: [
    'a[href="/app"]',
    'button[aria-label*="New chat" i]',
    '[role="button"][aria-label*="New chat" i]'
  ],
  composer: ['rich-textarea', '[contenteditable="true"]', 'textarea'],
  modelControl: [
    'button[aria-label*="model" i]',
    'button[aria-label*="mode" i]',
    'button[aria-haspopup="true"]',
    'button[aria-haspopup="menu"]',
    '[role="button"][aria-haspopup="menu"]',
    '.input-area-switch'
  ],
  blockingOverlay: ['[role="dialog"]', '.cdk-overlay-backdrop-showing']
});

function normalizeResetContract(args) {
  const legacyFresh = Boolean(args && args.forceFreshChat);
  return Object.assign({
    strategy: 'SOFT_FIRST',
    preserveVerifiedModel: true,
    requireFreshConversation: legacyFresh,
    allowRouteReopen: true,
    allowHardReload: true
  }, args && args.resetPolicy || {});
}

function readinessSatisfied(state) {
  return Boolean(state && state.documentReady && state.routeStable && state.composerAvailable &&
    state.modelControlAvailable && !state.blockingOverlay && state.mutationsSettled &&
    state.authenticated && state.domainValid);
}

async function observeSessionReadiness(args) {
  const target = args.targetFrame || args.page;
  if (!target || typeof target.evaluate !== 'function') throw new Error('SESSION_TARGET_REQUIRED');
  const observed = await target.evaluate(function(selectors) {
    const visible = function(selector) {
      return Array.from(document.querySelectorAll(selector)).some(function(node) {
        const style = window.getComputedStyle(node);
        return style.visibility !== 'hidden' && style.display !== 'none' && node.getClientRects().length > 0;
      });
    };
    const route = location.pathname;
    return {
      documentReady: document.readyState === 'complete' || document.readyState === 'interactive',
      route: route,
      routeStable: route === '/app' || route.indexOf('/app/') === 0,
      composerAvailable: selectors.composer.some(visible),
      modelControlAvailable: selectors.modelControl.some(visible),
      blockingOverlay: selectors.blockingOverlay.some(visible),
      authenticated: !document.querySelector('a[href*="accounts.google.com"]'),
      domainValid: location.hostname === 'gemini.google.com',
      conversationId: route,
      composerEmpty: selectors.composer.some(function(selector) {
        const node = document.querySelector(selector);
        return node && !String(node.value || node.textContent || '').trim();
      })
    };
  }, GEMINI_SESSION_SELECTORS);
  observed.mutationsSettled = args.mutationsSettled !== false;
  observed.ready = readinessSatisfied(observed);
  return observed;
}

async function waitForSessionReady(args) {
  const timeoutMs = Number(args.timeoutMs || 30000);
  const pollMs = Number(args.pollMs || 250);
  const deadline = Date.now() + timeoutMs;
  let stable = 0;
  let last = null;
  while (Date.now() <= deadline) {
    last = await observeSessionReadiness(args);
    stable = last.ready ? stable + 1 : 0;
    if (stable >= Number(args.stablePolls || 2)) return Object.assign({}, last, { stablePolls: stable });
    if (args.page && typeof args.page.waitForTimeout === 'function') await args.page.waitForTimeout(pollMs);
    else await new Promise(function(resolve) { setTimeout(resolve, pollMs); });
  }
  const err = new Error('TRANSIENT_UI_HYDRATION');
  err.observation = last;
  throw err;
}

async function resetConversation(args) {
  const page = args.page;
  const target = args.targetFrame || page;
  const policy = normalizeResetContract(args);
  const before = args.before || await observeSessionReadiness(args);
  const preservedReceipt = policy.preserveVerifiedModel ? geminiModelReceipts[args.tabKey] : null;
  let softFailure = null;
  try {
    const clicked = await target.evaluate(function(selectors) {
      for (const selector of selectors) {
        const node = document.querySelector(selector);
        if (node) { node.click(); return true; }
      }
      return false;
    }, GEMINI_SESSION_SELECTORS.newConversation);
    if (!clicked) throw new Error('NATIVE_NEW_CHAT_UNAVAILABLE');
    const ready = await waitForSessionReady(args);
    if (policy.requireFreshConversation && ready.conversationId === before.conversationId && !ready.composerEmpty) throw new Error('CONVERSATION_IDENTITY_UNCHANGED');
    if (preservedReceipt) geminiModelReceipts[args.tabKey] = preservedReceipt;
    return { status: 'SESSION_READY', method: 'NATIVE_NEW_CHAT', documentChanged: false, readiness: ready };
  } catch (error) { softFailure = error; }
  if (policy.allowRouteReopen && page && typeof page.goto === 'function') {
    try {
      await page.goto(GEMINI_APP_URL, { waitUntil: 'domcontentloaded', timeout: Number(args.timeoutMs || 30000) });
      const ready = await waitForSessionReady(Object.assign({}, args, { targetFrame: page }));
      if (preservedReceipt) geminiModelReceipts[args.tabKey] = preservedReceipt;
      return { status: 'SESSION_READY', method: 'ROUTE_REOPEN', documentChanged: false, readiness: ready };
    } catch (error) { softFailure = error; }
  }
  if (!policy.allowHardReload || !page || typeof page.reload !== 'function') throw softFailure || new Error('SESSION_RESET_FAILED');
  await page.reload({ waitUntil: 'domcontentloaded', timeout: Number(args.timeoutMs || 30000) });
  invalidateGeminiReceipt(args.tabKey);
  const readiness = await waitForSessionReady(Object.assign({}, args, { targetFrame: page }));
  return { status: 'SESSION_READY', method: 'HARD_RELOAD', documentChanged: true, readiness: readiness };
}

async function recoverGeminiSession(args) {
  try { return await waitForSessionReady(args); }
  catch (error) {
    if (!/^TRANSIENT_|MODEL_TRIGGER_TIMEOUT/.test(String(error && error.message))) throw error;
    return resetConversation(args);
  }
}

async function inspectGeminiTemporaryChatDom(page) {
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

      const toggleControl = Array.from(document.querySelectorAll('button, [role="button"], [role="switch"], a'))
        .find(function(el) {
          if (!actionable(el)) return false;
          const label = normalize((el.getAttribute('aria-label') || '') + ' ' + (el.innerText || el.textContent || ''));
          return /temporary chat|bisedë e përkohshme/i.test(label);
        }) || null;

      const ariaPressed = toggleControl ? toggleControl.getAttribute('aria-pressed') : null;
      const ariaChecked = toggleControl ? toggleControl.getAttribute('aria-checked') : null;
      const controlLabel = toggleControl
        ? String(toggleControl.getAttribute('aria-label') || toggleControl.innerText || '').trim().slice(0, 120)
        : '';

      const controlActive = Boolean(
        toggleControl && (
          ariaPressed === 'true' ||
          ariaChecked === 'true' ||
          toggleControl.classList.contains('active') ||
          toggleControl.classList.contains('is-active')
        )
      );

      let indicatorFound = false;
      const promptEl = document.querySelector('rich-textarea div.ql-editor, textarea, [contenteditable="true"]');
      if (promptEl) {
        const ph = promptEl.getAttribute('data-placeholder') || promptEl.getAttribute('placeholder') || '';
        if (/temporary|përkohshme/i.test(ph)) indicatorFound = true;
      }
      if (!indicatorFound) {
        const elements = Array.from(document.querySelectorAll('[role="region"], [role="status"], aside, header, div, span, p, mat-chip, .badge'))
          .filter(actionable);
        indicatorFound = elements.some(function(el) {
          const t = normalize(el.innerText || el.textContent || '');
          return (t.includes('temporary chat') || t.includes('bisedë e përkohshme')) &&
            (t.includes("won't appear") || t.includes('won’t appear') || t.includes('nuk do të ruhet') || t.includes('is on') || t.includes('është aktive') || el.classList.contains('active'));
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

async function ensureGeminiTemporaryChat(page, tabId, desiredEnabled, opts) {
  opts = opts || {};
  const requested = Boolean(desiredEnabled);
  const timeoutMs = Number.isFinite(opts.timeoutMs) ? Math.max(100, opts.timeoutMs) : 5000;
  const pollMs = Number.isFinite(opts.pollMs) ? Math.max(20, opts.pollMs) : 150;
  const nowIso = function() { return new Date().toISOString(); };

  if (!GEMINI_TEMP_CHAT_ALLOWLIST.includes(tabId)) {
    return {
      tabId: tabId,
      requested: requested,
      active: false,
      verified: false,
      status: 'MISMATCH_OR_UNVERIFIED',
      reason: 'INVALID_GEMINI_TAB_ID',
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

  const initial = await inspectGeminiTemporaryChatDom(page);
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

  const clickRes = await page.evaluate(function(arg) {
    const normalize = function(s) { return String(s || '').toLowerCase().replace(/\s+/g, ' ').trim(); };
    const actionable = function(el) {
      if (!el || !el.isConnected) return false;
      const st = window.getComputedStyle(el);
      const r = el.getBoundingClientRect();
      return st.display !== 'none' && st.visibility !== 'hidden' && r.width > 3 && r.height > 3;
    };
    const allButtons = Array.from(document.querySelectorAll('button, [role="button"], [role="switch"], a')).filter(actionable);
    const tempBtn = allButtons.find(function(el) {
      const label = normalize((el.getAttribute('aria-label') || '') + ' ' + (el.innerText || el.textContent || ''));
      return /temporary chat|bisedë e përkohshme/i.test(label);
    }) || null;

    if (arg.requested) {
      if (!tempBtn) return { clicked: false, reason: 'TEMPORARY_CHAT_CONTROL_NOT_FOUND' };
      tempBtn.click();
      return { clicked: true, reason: 'CLICKED_TEMPORARY_CHAT_TOGGLE' };
    }

    if (tempBtn && (tempBtn.getAttribute('aria-pressed') === 'true' || tempBtn.getAttribute('aria-checked') === 'true' || tempBtn.classList.contains('active'))) {
      tempBtn.click();
      return { clicked: true, reason: 'CLICKED_TEMPORARY_CHAT_TOGGLE_OFF' };
    }

    const newChatBtn = allButtons.find(function(el) {
      const label = normalize((el.getAttribute('aria-label') || '') + ' ' + (el.innerText || el.textContent || ''));
      return /new chat|bisedë e re/i.test(label) && !/temporary/i.test(label);
    }) || null;
    if (newChatBtn) {
      newChatBtn.click();
      return { clicked: true, reason: 'CLICKED_NEW_CHAT_TO_EXIT_TEMPORARY' };
    }
    return { clicked: false, reason: 'TEMPORARY_CHAT_CONTROL_NOT_FOUND' };
  }, { requested: requested }).catch(function(err) {
    return { clicked: false, reason: String(err && err.message || err).slice(0, 120) };
  });

  if (!clickRes || !clickRes.clicked) {
    return {
      tabId: tabId,
      requested: requested,
      active: Boolean(initial.active),
      verified: false,
      status: 'MISMATCH_OR_UNVERIFIED',
      reason: (clickRes && clickRes.reason) || 'TEMPORARY_CHAT_CONTROL_NOT_FOUND',
      checkedAt: nowIso()
    };
  }

  const deadline = Date.now() + timeoutMs;
  let lastObserved = initial;
  while (Date.now() <= deadline) {
    lastObserved = await inspectGeminiTemporaryChatDom(page);
    if (lastObserved.active === requested) {
      return {
        tabId: tabId,
        requested: requested,
        active: lastObserved.active,
        verified: true,
        status: lastObserved.active ? 'ACTIVE_VERIFIED' : 'OFF_VERIFIED',
        reason: 'DOM_VERIFIED',
        checkedAt: nowIso()
      };
    }
    await new Promise(function(resolve) { setTimeout(resolve, pollMs); });
  }

  return {
    tabId: tabId,
    requested: requested,
    active: Boolean(lastObserved.active),
    verified: false,
    status: 'MISMATCH_OR_UNVERIFIED',
    reason: 'DOM_VERIFICATION_TIMEOUT',
    checkedAt: nowIso()
  };
}

function createGeminiEngine(runtimeContext) {
  if (!runtimeContext || typeof runtimeContext !== 'object') {
    throw new Error('Mandatory runtimeContext dependency is required');
  }

  const tabActiveModel = runtimeContext.tabActiveModel || {};
  const tabDiscoveredModels = runtimeContext.tabDiscoveredModels || {};
  const appendDispatchDiag = runtimeContext.appendDispatchDiag || function() {};
  const captureSupportEvidence = runtimeContext.captureSupportEvidence || (async function() {});
  const dispatchToWebTab = runtimeContext.dispatchToWebTab || null;

  async function ensureGeminiNeonModel(targetFrame, tabKey, opts) {
    opts = opts || {};
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

      // ============================================================================
      // RREGULL I PANEGOCIUESHËM DHE I KYÇUR (INVIOLABLE LOCK - HIGH PRIORITY)
      // NDALOHET KATEGORIKISHT NEON LOW (FAST AND EFFICIENT) APO ÇDO MODEL TJETËR.
      // DETYRIM LIGJOR: VETËM "NEON HIGH" (EXTRA THOROUGH).
      // BUTONI DUHET TË KETË TEKSTIN 'Neon\nHigh' DHE ARIA 'Open mode picker, currently Neon High'.
      // ÇDO AGJENT DUHET TË RESPEKTOJË KËTË BLLOKIM PA ASNJË MODIFIKIM!
      // ============================================================================
      const readTriggerState = function(trigger) {
        const text = String(trigger ? (trigger.innerText || '') : '').trim();
        const aria = String(trigger ? (trigger.getAttribute('aria-label') || '') : '').trim();
        const combined = normalize(text + ' ' + aria);
        const isNeonHighAria = /currently\s*neon\s*high/i.test(aria);
        const isNeonHighText = /neon[\s\n]+high/i.test(text);
        const isNeonLowAria = /currently\s*neon\s*(?:low|fast)/i.test(aria) || /currently\s*(?:flash|auto|quick)/i.test(aria);
        const isNeonLowText = /neon\s*(?:low|fast)/i.test(text) || /^(?:flash|auto|quick)$/i.test(text.replace(/\s+/g, ' ').trim());
        const isNeonIdentified = (isNeonHighAria || isNeonHighText || activeRe.test(combined) || /(?:4\s*neon|neon\s*\(high\)|currently\s*neon\b|deeper\s*analysis|\bneon\b)/i.test(combined));
        const isStrictHigh = isNeonIdentified && !isNeonLowAria && !isNeonLowText;
        return {
          text: text,
          aria: aria,
          active: Boolean(isStrictHigh)
        };
      };

      let trigger = null;
      const pollStart = Date.now();
      const pollTimeoutMs = Number(required && required.timeoutMs) || 15000;
      while (Date.now() - pollStart < pollTimeoutMs) {
        trigger = findTrigger();
        if (trigger) break;
        await sleep(300);
      }
      if (!trigger) return { ok: false, code: 'MODEL_TRIGGER_TIMEOUT' };

      let state = readTriggerState(trigger);
      if (!state.active) {
        trigger.click();
        await sleep(600);

        const menus = Array.from(document.querySelectorAll('[role="menu"], [role="listbox"], mat-menu-content, .cdk-overlay-pane'));
        const options = menus.flatMap(function(m) {
          return Array.from(m.querySelectorAll('[role="menuitemradio"], [role="menuitem"], [role="option"]'));
        }).filter(actionable);

        const neonMatches = options.filter(function(el) {
          const txt = normalize((el.innerText || '') + ' ' + (el.getAttribute('aria-label') || ''));
          return menuRe.test(txt);
        });
        const neonOption = neonMatches.length > 0 ? neonMatches[neonMatches.length - 1] : null;

        if (!neonOption) {
          document.querySelectorAll('.cdk-overlay-backdrop').forEach(function(b) { b.click(); });
          return { ok: false, code: 'MODEL_OPTION_NOT_FOUND' };
        }

        neonOption.click();
        await sleep(1000);

        // Nese ekziston Thinking Level menuitem ne overlay, kliko High
        const highOption = Array.from(document.querySelectorAll('gem-menu-item, [role="menuitemradio"], [role="menuitem"], [role="option"]')).filter(actionable).find(function(el) {
          const txt = normalize((el.innerText || '') + ' ' + (el.getAttribute('aria-label') || ''));
          return /high.*thorough|extra thorough/i.test(txt);
        });
        if (highOption) {
          highOption.click();
          await sleep(500);
        }

        document.querySelectorAll('.cdk-overlay-backdrop').forEach(function(b) { b.click(); });
        try { document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', code: 'Escape', bubbles: true })); } catch (_) {}
        await sleep(600);

        let pollActiveStart = Date.now();
        while (Date.now() - pollActiveStart < 8000) {
          trigger = findTrigger();
          if (trigger) {
            state = readTriggerState(trigger);
            if (state.active) break;
          }
          await sleep(400);
        }
        if (!trigger) return { ok: false, code: 'MODEL_SELECTION_UNVERIFIED', debug: 'NO_TRIGGER' };
        if (!state.active) return { ok: false, code: 'MODEL_SELECTION_UNVERIFIED', debug: { text: state.text, aria: state.aria } };
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
      reasoningSource: GEMINI_REQUIRED_MODEL.reasoningSource,
      timeoutMs: opts.timeoutMs || 15000
    });

    if (!receipt || !receipt.ok) {
      if (receipt && receipt.debug) {
        console.error('[MODEL_SELECTION_DEBUG] tabKey=' + tabKey + ' debug=' + JSON.stringify(receipt.debug));
      }
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

    tabActiveModel[tabKey] = GEMINI_REQUIRED_MODEL.displayLabel;
    tabDiscoveredModels[tabKey] = GEMINI_REQUIRED_MODEL.menuLabel;

    console.error('[MODEL_STATE_OBSERVED] tabKey=' + tabKey + ' model=' + GEMINI_REQUIRED_MODEL.modelLabel + ' reasoning=' + GEMINI_REQUIRED_MODEL.reasoning);
    console.error('[MODEL_STATE_VERIFIED] tabKey=' + tabKey + ' receipt=' + JSON.stringify(geminiModelReceipts[tabKey]));
    return GEMINI_REQUIRED_MODEL.displayLabel;
  }

  async function handleDiagnostics(args) {
    args = Object.assign({}, args, { appendDispatchDiag: appendDispatchDiag });
    return collectGeminiTerminalDiagnostics(args);
  }

  async function handleHandshake(args) {
    args = args || {};
    const tabKey = args.tabKey;
    const activeModelFromTab = tabKey && tabActiveModel && tabActiveModel[tabKey] && tabActiveModel[tabKey] !== '-'
      ? tabActiveModel[tabKey]
      : undefined;
    const enrichedArgs = Object.assign({}, args, {
      dispatchToWebTab: args.dispatchToWebTab || dispatchToWebTab,
      activeModel: args.activeModel || activeModelFromTab
    });
    return runGeminiAttachmentIngestHandshake(enrichedArgs);
  }

  return {
    ensureGeminiNeonModel,
    inspectGeminiTemporaryChatDom,
    ensureGeminiTemporaryChat,
    resetConversation,
    observeSessionReadiness,
    waitForSessionReady,
    recoverGeminiSession,
    invalidateGeminiReceipt,
    collectGeminiTerminalDiagnostics: handleDiagnostics,
    runGeminiAttachmentIngestHandshake: handleHandshake,
    classifyAttachmentHandshakeStrict,
    classifyResetCandidate,
    classifyGeminiRecovery,
    resolveGeminiHardCapMs,
    DEFAULT_STANDARD_HARD_CAP_MS,
    HIGH_REASONING_HARD_CAP_MS,
    geminiModelReceipts,
    GEMINI_REQUIRED_MODEL,
    GEMINI_APP_URL
  };
}

module.exports = {
  createGeminiEngine,
  inspectGeminiTemporaryChatDom,
  ensureGeminiTemporaryChat,
  resetConversation,
  observeSessionReadiness,
  waitForSessionReady,
  recoverGeminiSession,
  normalizeResetContract,
  readinessSatisfied,
  GEMINI_REQUIRED_MODEL,
  GEMINI_APP_URL,
  DEFAULT_STANDARD_HARD_CAP_MS,
  HIGH_REASONING_HARD_CAP_MS,
  resolveGeminiHardCapMs,
  geminiModelReceipts,
  invalidateGeminiReceipt,
  classifyAttachmentHandshakeStrict,
  classifyResetCandidate,
  classifyGeminiRecovery,
  collectGeminiTerminalDiagnostics,
  runGeminiAttachmentIngestHandshake
};