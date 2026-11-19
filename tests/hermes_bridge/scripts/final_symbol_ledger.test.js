'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');

const PROJECT_ROOT = path.resolve(__dirname, '../../..');
const MCP_DIR = path.join(PROJECT_ROOT, 'mcp');
const SERVER_PATH = path.join(MCP_DIR, 'server.js');

const SYMBOL_OWNERSHIP_MAP = {
  // Local executor owned
  applyBatch: 'pipeline/local_executor.js',
  runBatchQuickChecks: 'pipeline/local_executor.js',
  repairBatchOnce: 'pipeline/local_executor.js',
  persistCheckpointReceiptOnce: 'pipeline/local_executor.js',

  // Autopilot engine owned
  CHUNK_ENGINE_LIMITS: 'pipeline/autopilot_engine.js',
  scanRepositoryUniversal: 'pipeline/autopilot_engine.js',
  buildCompactRepoMap: 'pipeline/autopilot_engine.js',
  buildDependencyGraph: 'pipeline/autopilot_engine.js',
  partitionAnalysisChunks: 'pipeline/autopilot_engine.js',
  analyzeRepositoryChunks: 'pipeline/autopilot_engine.js',
  buildFinalPlanningContext: 'pipeline/autopilot_engine.js',
  parseAndValidatePlanBatches: 'pipeline/autopilot_engine.js',
  partitionCodingBatches: 'pipeline/autopilot_engine.js',
  buildBatchContext: 'pipeline/autopilot_engine.js',
  runCodingBatch: 'pipeline/autopilot_engine.js',
  halveBatchAdaptively: 'pipeline/autopilot_engine.js',
  buildCrossBatchContractSummary: 'pipeline/autopilot_engine.js',
  buildDiffFocusedReviewContext: 'pipeline/autopilot_engine.js',
  writeChunkContextFile: 'pipeline/autopilot_engine.js',
  extractTargetsFromError: 'pipeline/autopilot_engine.js',
  scoreAnalysisChunkRelevance: 'pipeline/autopilot_engine.js',
  buildLocalStructuralChunkSummary: 'pipeline/autopilot_engine.js',
  buildBatchMiniMap: 'pipeline/autopilot_engine.js',
  extractBatchPlanSlice: 'pipeline/autopilot_engine.js',
  buildMinimalBatchContext: 'pipeline/autopilot_engine.js',
  selectCodingTransport: 'pipeline/autopilot_engine.js',
  selectAdaptiveReasoningLevel: 'pipeline/autopilot_engine.js',
  classifyAttachmentHandshakeStrict: 'pipeline/autopilot_engine.js',
  getFailoverEngines: 'pipeline/autopilot_engine.js',
  parseCodeBlocksFromMarkdown: 'pipeline/autopilot_engine.js',
  normalizeFailureCode: 'pipeline/autopilot_engine.js',
  isAdaptiveHalvingFailure: 'pipeline/autopilot_engine.js'
};

test('WO-MOD-7: Symbol Ledger - UnownedSymbols = 0', () => {
  process.env.ANTIGRAVITY_TEST_EXPORT = '1';
  const serverExports = require(SERVER_PATH);
  const exportedKeys = Object.keys(serverExports);

  const unowned = exportedKeys.filter(k => !SYMBOL_OWNERSHIP_MAP[k]);
  assert.equal(unowned.length, 0, `All exported symbols must have a registered owner. Unowned: ${unowned.join(', ')}`);
});

test('WO-MOD-7: Symbol Ledger - DuplicateActiveOwners = 0', () => {
  const seenSymbols = new Map();
  const duplicates = [];

  for (const [sym, owner] of Object.entries(SYMBOL_OWNERSHIP_MAP)) {
    if (seenSymbols.has(sym)) {
      duplicates.push({ symbol: sym, first: seenSymbols.get(sym), second: owner });
    } else {
      seenSymbols.set(sym, owner);
    }
  }

  assert.equal(duplicates.length, 0, `No symbol may have multiple owners: ${JSON.stringify(duplicates)}`);
});

test('WO-MOD-7: Symbol Ledger - MissingBaselineSymbols = 0', () => {
  process.env.ANTIGRAVITY_TEST_EXPORT = '1';
  const serverExports = require(SERVER_PATH);

  const missing = Object.keys(SYMBOL_OWNERSHIP_MAP).filter(k => serverExports[k] === undefined);
  assert.equal(missing.length, 0, `All baseline symbols must be present: ${missing.join(', ')}`);
});

test('WO-MOD-7: Symbol Ledger - UnauthorizedExports = 0', () => {
  process.env.ANTIGRAVITY_TEST_EXPORT = '1';
  const serverExports = require(SERVER_PATH);
  const exportedKeys = Object.keys(serverExports);
  const allowedKeys = new Set(Object.keys(SYMBOL_OWNERSHIP_MAP));

  const unauthorized = exportedKeys.filter(k => !allowedKeys.has(k));
  assert.equal(unauthorized.length, 0, `No unauthorized exports permitted: ${unauthorized.join(', ')}`);
});

test('WO-MOD-7: Symbol Ledger - Every owner module exports its assigned symbols', () => {
  for (const [sym, relOwner] of Object.entries(SYMBOL_OWNERSHIP_MAP)) {
    const fullOwner = path.join(MCP_DIR, relOwner);
    const mod = require(fullOwner);
    assert.ok(
      mod[sym] !== undefined,
      `Owner module ${relOwner} must export symbol ${sym}`
    );
  }
});
