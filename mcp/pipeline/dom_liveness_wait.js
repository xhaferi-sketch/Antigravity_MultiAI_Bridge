'use strict';

/**
 * Activity-driven DOM liveness state evaluator for web LLM dispatch loops.
 *
 * Replaces short fixed wall-clock timers during deep thinking / streaming turns
 * (e.g. Copilot 5.6 SOL Thinking or Gemini 4 Neon High running 20-40+ minutes)
 * with DOM activity tracking: live generating/Stop/spinner/text changes keep
 * the wait alive, while true inactivity stalls or explicit short caller caps
 * still terminate cleanly.
 */

const DEFAULT_ACTIVITY_RUNAWAY_CAP_MS = 60 * 60 * 1000; // 60 minutes absolute backstop
const DEFAULT_GEMINI_INACTIVITY_MS = 10 * 60 * 1000;    // 10 minutes zero DOM progress
const DEFAULT_COPILOT_INACTIVITY_MS = 10 * 60 * 1000;   // 10 minutes zero DOM progress
const DEFAULT_SILENT_THINKING_IDLE_MS = 8 * 60 * 1000;  // 8 minutes with no Stop/content at all

function resolveActivityDrivenBudgets(sendMeta, isGemini) {
  const meta = sendMeta && typeof sendMeta === 'object' ? sendMeta : {};
  const explicitHardCap = Number(meta.hardCapMs);
  const hasExplicitHardCap = Number.isFinite(explicitHardCap) && explicitHardCap > 0;
  const strictWallClock = meta.strictWallClockCap === true || (hasExplicitHardCap && explicitHardCap < 60000);

  const baseHardCapMs = hasExplicitHardCap
    ? explicitHardCap
    : (isGemini ? 900000 : 600000);

  const runawayCapMs = strictWallClock
    ? baseHardCapMs
    : Math.max(baseHardCapMs, Number(meta.maxRunawayCapMs) || DEFAULT_ACTIVITY_RUNAWAY_CAP_MS);

  const firstTokenOverride = Number(meta.firstTokenDeadlineMs);
  const defaultFirstTokenMs = isGemini ? 600000 : 300000;
  const firstTokenDeadlineMs =
    Number.isFinite(firstTokenOverride) && firstTokenOverride > 0
      ? Math.min(runawayCapMs, Math.max(5000, firstTokenOverride))
      : defaultFirstTokenMs;

  const explicitThinkingStall = Number(meta.maxThinkingWithoutDomProgressMs);
  const maxThinkingWithoutDomProgressMs =
    Number.isFinite(explicitThinkingStall) && explicitThinkingStall > 0
      ? explicitThinkingStall
      : (isGemini ? DEFAULT_GEMINI_INACTIVITY_MS : DEFAULT_COPILOT_INACTIVITY_MS);

  const silentDeadlineMs =
    Number.isFinite(Number(meta.silentDeadlineMs)) && Number(meta.silentDeadlineMs) > 0
      ? Math.max(Number(meta.silentDeadlineMs), maxThinkingWithoutDomProgressMs)
      : (isGemini ? 900000 : DEFAULT_SILENT_THINKING_IDLE_MS);

  return {
    strictWallClock,
    baseHardCapMs,
    runawayCapMs,
    firstTokenDeadlineMs,
    activeThinkingFreshMs: Number(meta.activeThinkingFreshMs) || 45000,
    maxThinkingWithoutDomProgressMs,
    silentDeadlineMs
  };
}

function evaluateDomActivityState(input) {
  const state = (input && input.state) || {};
  const budgets = input.budgets;
  const now = Number.isFinite(input.now) ? input.now : Date.now();
  const start = Number.isFinite(input.start) ? input.start : now;
  const lastProgressAt = Number.isFinite(input.lastProgressAt) ? input.lastProgressAt : start;
  const lastGeneratingPulseAt = Number.isFinite(input.lastGeneratingPulseAt)
    ? input.lastGeneratingPulseAt
    : start;
  const lastText = String(input.lastText || '');

  const elapsedMs = Math.max(0, now - start);
  const progressAgeMs = Math.max(0, now - lastProgressAt);
  const pulseAgeMs = Math.max(0, now - lastGeneratingPulseAt);

  const generatingNow = Boolean(
    state.generating || state.activeProcessingEvidence || state.visibleStopControl || state.visibleProcessingSpinner
  );
  const activeThinking = Boolean(
    !state.landingVisible &&
    !state.domainMismatch &&
    state.conversationContinuity !== false &&
    generatingNow
  );

  // If the page is actively showing Stop/spinner or advancing text/thought progress, extend past baseHardCapMs.
  const domAlive = Boolean(
    activeThinking || progressAgeMs < budgets.activeThinkingFreshMs
  );

  const activeThinkingFresh = Boolean(
    activeThinking && (
      progressAgeMs < budgets.activeThinkingFreshMs ||
      pulseAgeMs < budgets.maxThinkingWithoutDomProgressMs
    )
  );

  const shouldDeferPastBaseCap = Boolean(
    !budgets.strictWallClock &&
    domAlive &&
    elapsedMs < budgets.runawayCapMs
  );

  const deadStallExceeded = Boolean(
    !budgets.strictWallClock &&
    !lastText &&
    !activeThinking &&
    pulseAgeMs >= budgets.silentDeadlineMs &&
    progressAgeMs >= budgets.maxThinkingWithoutDomProgressMs
  );

  return {
    elapsedMs,
    progressAgeMs,
    pulseAgeMs,
    generatingNow,
    activeThinking,
    activeThinkingFresh,
    domAlive,
    shouldDeferPastBaseCap,
    deadStallExceeded,
    effectiveLoopLimitMs: shouldDeferPastBaseCap ? budgets.runawayCapMs : budgets.baseHardCapMs
  };
}

module.exports = {
  DEFAULT_ACTIVITY_RUNAWAY_CAP_MS,
  DEFAULT_GEMINI_INACTIVITY_MS,
  DEFAULT_COPILOT_INACTIVITY_MS,
  DEFAULT_SILENT_THINKING_IDLE_MS,
  resolveActivityDrivenBudgets,
  evaluateDomActivityState
};
