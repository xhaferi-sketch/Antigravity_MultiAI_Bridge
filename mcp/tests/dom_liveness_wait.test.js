'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  DEFAULT_ACTIVITY_RUNAWAY_CAP_MS,
  resolveActivityDrivenBudgets,
  evaluateDomActivityState
} = require('../pipeline/dom_liveness_wait.js');

test('Copilot 5.6 SOL Thinking keeps running cleanly for 28 minutes while DOM/Stop is active', () => {
  const budgets = resolveActivityDrivenBudgets({}, false);
  const start = 1_000_000;
  const elapsed28Min = 28 * 60 * 1000;
  const now = start + elapsed28Min;

  const activity = evaluateDomActivityState({
    state: {
      generating: true,
      visibleStopControl: true,
      visibleProcessingSpinner: true,
      conversationContinuity: true,
      landingVisible: false,
      domainMismatch: false
    },
    budgets,
    now,
    start,
    lastProgressAt: now - 15000,
    lastGeneratingPulseAt: now - 750,
    lastText: ''
  });

  assert.equal(budgets.strictWallClock, false);
  assert.equal(activity.activeThinkingFresh, true);
  assert.equal(activity.shouldDeferPastBaseCap, true);
  assert.equal(activity.deadStallExceeded, false);
  assert.equal(activity.effectiveLoopLimitMs, DEFAULT_ACTIVITY_RUNAWAY_CAP_MS);
  assert.ok(activity.elapsedMs < activity.effectiveLoopLimitMs);
});

test('True dead stall terminates cleanly when Stop/spinner and DOM movement vanish past inactivity threshold', () => {
  const budgets = resolveActivityDrivenBudgets({}, false);
  const start = 1_000_000;
  const deadElapsed = 12 * 60 * 1000;
  const now = start + deadElapsed;

  const activity = evaluateDomActivityState({
    state: {
      generating: false,
      visibleStopControl: false,
      visibleProcessingSpinner: false,
      activeProcessingEvidence: false,
      conversationContinuity: true
    },
    budgets,
    now,
    start,
    lastProgressAt: start,
    lastGeneratingPulseAt: start,
    lastText: ''
  });

  assert.equal(activity.activeThinking, false);
  assert.equal(activity.shouldDeferPastBaseCap, false);
  assert.equal(activity.deadStallExceeded, true);
  assert.equal(activity.effectiveLoopLimitMs, budgets.baseHardCapMs);
});

test('Explicit short hardCapMs (<60s) stays strictly wall-clock bounded', () => {
  const budgets = resolveActivityDrivenBudgets({ hardCapMs: 5000 }, true);
  const start = 5_000_000;
  const activity = evaluateDomActivityState({
    state: { generating: true, visibleStopControl: true },
    budgets,
    now: start + 6000,
    start,
    lastProgressAt: start + 5500,
    lastGeneratingPulseAt: start + 5500,
    lastText: ''
  });

  assert.equal(budgets.strictWallClock, true);
  assert.equal(activity.shouldDeferPastBaseCap, false);
  assert.equal(activity.effectiveLoopLimitMs, 5000);
});
