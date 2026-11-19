'use strict';

const fs = require('node:fs');
const path = require('node:path');

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

  const text = await dispatcher({
    tabKey: args.tabKey,
    projectRoot: args.projectRoot,
    promptText: prompt,
    attachmentPaths: [args.attachmentPath],
    forceFreshChat: args.forceFreshChat !== false,
    disableInternalRetry: true,
    reasoningLevel: 'high',
    modelTier: args.modelTier || 'neon',
    hardCapMs: args.modelTier === 'pro_31' ? 240000 : 65000
  });

  const check = classifyAttachmentHandshakeStrict(text);
  if (!check.ok) {
    throw new Error('GEMINI_ATTACHMENT_INGEST_UNVERIFIED: ' + check.code);
  }
  console.error('[GEMINI_ATTACHMENT_INGEST_VERIFIED] batchId=' + (args.batchId || '') + ' chars=' + text.length);
  return { status: 'VERIFIED', text: text };
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

  async function handleDiagnostics(args) {
    args = Object.assign({}, args, { appendDispatchDiag: appendDispatchDiag });
    return collectGeminiTerminalDiagnostics(args);
  }

  async function handleHandshake(args) {
    args = Object.assign({}, args, {
      dispatchToWebTab: args.dispatchToWebTab || dispatchToWebTab
    });
    return runGeminiAttachmentIngestHandshake(args);
  }

  return {
    ensureGeminiNeonModel,
    invalidateGeminiReceipt,
    collectGeminiTerminalDiagnostics: handleDiagnostics,
    runGeminiAttachmentIngestHandshake: handleHandshake,
    classifyAttachmentHandshakeStrict,
    classifyResetCandidate,
    classifyGeminiRecovery,
    geminiModelReceipts,
    GEMINI_REQUIRED_MODEL,
    GEMINI_APP_URL
  };
}

module.exports = {
  createGeminiEngine,
  GEMINI_REQUIRED_MODEL,
  GEMINI_APP_URL,
  geminiModelReceipts,
  invalidateGeminiReceipt,
  classifyAttachmentHandshakeStrict,
  classifyResetCandidate,
  classifyGeminiRecovery,
  collectGeminiTerminalDiagnostics,
  runGeminiAttachmentIngestHandshake
};
