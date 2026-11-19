'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');

const PROJECT_ROOT = path.resolve(__dirname, '../../..');
const AUTOPILOT_PATH = path.join(PROJECT_ROOT, 'mcp', 'pipeline', 'autopilot_engine.js');

const {
  createAutopilotEngine,
  PACK_MODES,
  CHUNK_ENGINE_LIMITS,
  scanRepositoryUniversal,
  buildDependencyGraph,
  buildCompactRepoMap,
  partitionAnalysisChunks,
  partitionCodingBatches,
  buildMinimalBatchContext,
  selectCodingTransport,
  halveBatchAdaptively,
  normalizeFailureCode,
  isAdaptiveHalvingFailure,
  getFailoverEngines,
  analyzeRepositoryChunks,
  buildFinalPlanningContext,
  parseAndValidatePlanBatches,
  buildBatchContext,
  runCodingBatch,
  buildCrossBatchContractSummary,
  buildDiffFocusedReviewContext,
  writeChunkContextFile,
  extractTargetsFromError,
  scoreAnalysisChunkRelevance,
  buildLocalStructuralChunkSummary,
  buildBatchMiniMap,
  extractBatchPlanSlice,
  selectAdaptiveReasoningLevel,
  classifyAttachmentHandshakeStrict,
  parseCodeBlocksFromMarkdown,
  persistCheckpointReceiptOnce
} = require(AUTOPILOT_PATH);

test('autopilot_engine exports all required ledger and blueprint symbols', () => {
  assert.equal(typeof createAutopilotEngine, 'function');
  assert.ok(PACK_MODES && typeof PACK_MODES === 'object');
  assert.ok(CHUNK_ENGINE_LIMITS && typeof CHUNK_ENGINE_LIMITS === 'object');
  assert.equal(typeof scanRepositoryUniversal, 'function');
  assert.equal(typeof buildDependencyGraph, 'function');
  assert.equal(typeof buildCompactRepoMap, 'function');
  assert.equal(typeof partitionAnalysisChunks, 'function');
  assert.equal(typeof partitionCodingBatches, 'function');
  assert.equal(typeof buildMinimalBatchContext, 'function');
  assert.equal(typeof selectCodingTransport, 'function');
  assert.equal(typeof halveBatchAdaptively, 'function');
  assert.equal(typeof normalizeFailureCode, 'function');
  assert.equal(typeof isAdaptiveHalvingFailure, 'function');
  assert.equal(typeof getFailoverEngines, 'function');
  assert.equal(typeof analyzeRepositoryChunks, 'function');
  assert.equal(typeof buildFinalPlanningContext, 'function');
  assert.equal(typeof parseAndValidatePlanBatches, 'function');
  assert.equal(typeof buildBatchContext, 'function');
  assert.equal(typeof runCodingBatch, 'function');
  assert.equal(typeof buildCrossBatchContractSummary, 'function');
  assert.equal(typeof buildDiffFocusedReviewContext, 'function');
  assert.equal(typeof writeChunkContextFile, 'function');
  assert.equal(typeof extractTargetsFromError, 'function');
  assert.equal(typeof scoreAnalysisChunkRelevance, 'function');
  assert.equal(typeof buildLocalStructuralChunkSummary, 'function');
  assert.equal(typeof buildBatchMiniMap, 'function');
  assert.equal(typeof extractBatchPlanSlice, 'function');
  assert.equal(typeof selectAdaptiveReasoningLevel, 'function');
  assert.equal(typeof classifyAttachmentHandshakeStrict, 'function');
  assert.equal(typeof parseCodeBlocksFromMarkdown, 'function');
  assert.equal(typeof persistCheckpointReceiptOnce, 'function');
});

test('createAutopilotEngine enforces mandatory runtimeContext dependency', () => {
  assert.throws(() => createAutopilotEngine(), /Mandatory runtimeContext dependency is required/);
  assert.throws(() => createAutopilotEngine(null), /Mandatory runtimeContext dependency is required/);
  assert.throws(() => createAutopilotEngine('invalid'), /Mandatory runtimeContext dependency is required/);

  const engine = createAutopilotEngine({
    activeProjectPerTab: {},
    tabActiveModel: {},
    ensureProjectSetup: () => ({ roles: {} }),
    readProjectState: () => ({}),
    writeProjectState: () => {},
    withCycleLock: (fn) => fn()
  });

  assert.ok(engine && typeof engine === 'object');
  assert.equal(typeof engine.getActiveJob, 'function');
  assert.equal(typeof engine.waitJobSlice, 'function');
  assert.equal(typeof engine.scanRepositoryUniversal, 'function');
  assert.equal(typeof engine.partitionCodingBatches, 'function');
  assert.equal(typeof engine.halveBatchAdaptively, 'function');
});

test('PACK_MODES and CHUNK_ENGINE_LIMITS are frozen immutable configurations', () => {
  assert.ok(Object.isFrozen(PACK_MODES));
  assert.ok(Object.isFrozen(CHUNK_ENGINE_LIMITS));
  assert.equal(PACK_MODES.PLANNING_FULL, 'PLANNING_FULL');
  assert.equal(PACK_MODES.CODING_FOCUSED, 'CODING_FOCUSED');
  assert.equal(CHUNK_ENGINE_LIMITS.maxBatchFiles, 2);
  assert.equal(CHUNK_ENGINE_LIMITS.maxHalvingLevel, 4);
});

test('normalizeFailureCode extracts deterministic error tokens', () => {
  assert.equal(normalizeFailureCode(null), '');
  assert.equal(normalizeFailureCode(new Error('BATCH_OUTPUT_INCOMPLETE: missing targets')), 'BATCH_OUTPUT_INCOMPLETE');
  assert.equal(normalizeFailureCode({ code: 'TARGETS_EXCEED_HARD_LIMIT' }), 'TARGETS_EXCEED_HARD_LIMIT');
  assert.equal(normalizeFailureCode({ failureCode: 'BATCH_PARSE_INCOMPLETE' }), 'BATCH_PARSE_INCOMPLETE');
  assert.equal(normalizeFailureCode('GEMINI_HARD_CAP_TIMEOUT elapsedMs=900000'), 'GEMINI_HARD_CAP_TIMEOUT');
});

test('isAdaptiveHalvingFailure identifies eligible adaptive halving failures', () => {
  assert.equal(isAdaptiveHalvingFailure(new Error('BATCH_OUTPUT_INCOMPLETE: [src/a.js]')), true);
  assert.equal(isAdaptiveHalvingFailure(new Error('BATCH_TARGET_MISSING')), true);
  assert.equal(isAdaptiveHalvingFailure(new Error('BATCH_OUTPUT_TRUNCATED')), true);
  assert.equal(isAdaptiveHalvingFailure(new Error('BATCH_RESPONSE_BUDGET_EXCEEDED')), true);
  assert.equal(isAdaptiveHalvingFailure(new Error('BATCH_PARSE_INCOMPLETE')), true);
  assert.equal(isAdaptiveHalvingFailure(new Error('SYNTAX_ERROR: unexpected token')), false);
  assert.equal(isAdaptiveHalvingFailure(new Error('WEB_CAPTCHA_REQUIRED')), false);
});

test('getFailoverEngines resolves fallback progression without self or excluded engines', () => {
  const geminiFallbacks = getFailoverEngines('gemini2', new Set());
  assert.deepEqual(geminiFallbacks, ['gemini3', 'gemini1', 'web2']);

  const excluded = new Set(['gemini3']);
  const filtered = getFailoverEngines('gemini2', excluded);
  assert.deepEqual(filtered, ['gemini1', 'web2']);

  const copilotFallbacks = getFailoverEngines('web1', new Set());
  assert.deepEqual(copilotFallbacks, ['web2']);
});

test('selectCodingTransport chooses between INLINE and ATTACHMENT correctly', () => {
  const smallContext = { text: 'short context text', bytes: 18 };
  const smallDecision = selectCodingTransport(smallContext, CHUNK_ENGINE_LIMITS);
  assert.equal(smallDecision.transport, 'INLINE');
  assert.equal(smallDecision.attachmentCount, 0);
  assert.equal(smallDecision.twoStepIngest, false);

  const largeText = 'X'.repeat(CHUNK_ENGINE_LIMITS.maxInlineChars + 100);
  const largeContext = { text: largeText, bytes: largeText.length };
  const largeDecision = selectCodingTransport(largeContext, CHUNK_ENGINE_LIMITS);
  assert.equal(largeDecision.transport, 'ATTACHMENT');
  assert.equal(largeDecision.attachmentCount, 1);
  assert.equal(largeDecision.twoStepIngest, true);
});
