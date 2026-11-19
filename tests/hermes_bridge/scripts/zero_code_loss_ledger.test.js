'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const PROJECT_ROOT = path.resolve(__dirname, '../../..');
const SERVER_PATH = path.join(PROJECT_ROOT, 'mcp', 'server.js');

const OWNER_MODULES = Object.freeze([
  'mcp/server.js',
  'mcp/engines/copilot_engine.js',
  'mcp/engines/gemini_engine.js',
  'mcp/engines/google_search_engine.js',
  'mcp/pipeline/local_executor.js',
  'mcp/pipeline/autopilot_engine.js'
]);

const MCP_TOOL_NAMES = Object.freeze([
  'run_full_cycle',
  'check_cycle_progress',
  'pack_workspace',
  'run_planner',
  'run_coder',
  'apply_and_test',
  'run_reviewer'
]);

const DASHBOARD_ROUTES = Object.freeze([
  '/',
  '/api/state',
  '/api/save-routing',
  '/api/add-project',
  '/api/delete-project',
  '/api/purge-exchange',
  '/api/reset-tab',
  '/api/login-profile',
  '/api/kill-all',
  '/api/mcp-proxy'
]);

const BASELINE_TEST_MODE_EXPORTS = Object.freeze([
  'CHUNK_ENGINE_LIMITS',
  'scanRepositoryUniversal',
  'buildCompactRepoMap',
  'buildDependencyGraph',
  'partitionAnalysisChunks',
  'analyzeRepositoryChunks',
  'buildFinalPlanningContext',
  'parseAndValidatePlanBatches',
  'partitionCodingBatches',
  'buildBatchContext',
  'runCodingBatch',
  'applyBatch',
  'runBatchQuickChecks',
  'repairBatchOnce',
  'halveBatchAdaptively',
  'buildCrossBatchContractSummary',
  'buildDiffFocusedReviewContext',
  'writeChunkContextFile',
  'extractTargetsFromError',
  'scoreAnalysisChunkRelevance',
  'buildLocalStructuralChunkSummary',
  'buildBatchMiniMap',
  'extractBatchPlanSlice',
  'buildMinimalBatchContext',
  'selectCodingTransport',
  'selectAdaptiveReasoningLevel',
  'classifyAttachmentHandshakeStrict',
  'getFailoverEngines',
  'parseCodeBlocksFromMarkdown',
  'normalizeFailureCode',
  'isAdaptiveHalvingFailure',
  'persistCheckpointReceiptOnce'
]);

const SYMBOL_OWNERSHIP = Object.freeze({
  // Pipeline / Local Executor
  applyBatch: 'mcp/pipeline/local_executor.js',
  runBatchQuickChecks: 'mcp/pipeline/local_executor.js',
  repairBatchOnce: 'mcp/pipeline/local_executor.js',

  // Pipeline / Autopilot Engine
  CHUNK_ENGINE_LIMITS: 'mcp/pipeline/autopilot_engine.js',
  scanRepositoryUniversal: 'mcp/pipeline/autopilot_engine.js',
  buildCompactRepoMap: 'mcp/pipeline/autopilot_engine.js',
  buildDependencyGraph: 'mcp/pipeline/autopilot_engine.js',
  partitionAnalysisChunks: 'mcp/pipeline/autopilot_engine.js',
  analyzeRepositoryChunks: 'mcp/pipeline/autopilot_engine.js',
  buildFinalPlanningContext: 'mcp/pipeline/autopilot_engine.js',
  parseAndValidatePlanBatches: 'mcp/pipeline/autopilot_engine.js',
  partitionCodingBatches: 'mcp/pipeline/autopilot_engine.js',
  buildBatchContext: 'mcp/pipeline/autopilot_engine.js',
  runCodingBatch: 'mcp/pipeline/autopilot_engine.js',
  halveBatchAdaptively: 'mcp/pipeline/autopilot_engine.js',
  buildCrossBatchContractSummary: 'mcp/pipeline/autopilot_engine.js',
  buildDiffFocusedReviewContext: 'mcp/pipeline/autopilot_engine.js',
  writeChunkContextFile: 'mcp/pipeline/autopilot_engine.js',
  extractTargetsFromError: 'mcp/pipeline/autopilot_engine.js',
  scoreAnalysisChunkRelevance: 'mcp/pipeline/autopilot_engine.js',
  buildLocalStructuralChunkSummary: 'mcp/pipeline/autopilot_engine.js',
  buildBatchMiniMap: 'mcp/pipeline/autopilot_engine.js',
  extractBatchPlanSlice: 'mcp/pipeline/autopilot_engine.js',
  buildMinimalBatchContext: 'mcp/pipeline/autopilot_engine.js',
  selectCodingTransport: 'mcp/pipeline/autopilot_engine.js',
  selectAdaptiveReasoningLevel: 'mcp/pipeline/autopilot_engine.js',
  classifyAttachmentHandshakeStrict: 'mcp/pipeline/autopilot_engine.js',
  getFailoverEngines: 'mcp/pipeline/autopilot_engine.js',
  parseCodeBlocksFromMarkdown: 'mcp/pipeline/autopilot_engine.js',
  normalizeFailureCode: 'mcp/pipeline/autopilot_engine.js',
  isAdaptiveHalvingFailure: 'mcp/pipeline/autopilot_engine.js',
  persistCheckpointReceiptOnce: 'mcp/pipeline/autopilot_engine.js',

  // Composition Root / Server
  startDashboardAndSingletonServer: 'mcp/server.js',
  dispatchActionSingleton: 'mcp/server.js',
  executeCoreAction: 'mcp/server.js',
  closeAllContexts: 'mcp/server.js',
  ensureProjectSetup: 'mcp/server.js',
  readProjectState: 'mcp/server.js',
  writeProjectState: 'mcp/server.js',
  purgeExchangeArtifacts: 'mcp/server.js',
  getProfileNameForTab: 'mcp/server.js',
  getTargetUrl: 'mcp/server.js',
  getOrLaunchContext: 'mcp/server.js',
  withTabLock: 'mcp/server.js',

  // Engines
  COPILOT_REQUIRED_MODEL: 'mcp/engines/copilot_engine.js',
  COPILOT_OUTPUT_CONTRACT: 'mcp/engines/copilot_engine.js',
  M365_CHAT_URL: 'mcp/engines/copilot_engine.js',
  findChatFrameOrPage: 'mcp/engines/copilot_engine.js',
  checkAuthExpired: 'mcp/engines/copilot_engine.js',

  GEMINI_REQUIRED_MODEL: 'mcp/engines/gemini_engine.js',
  GEMINI_APP_URL: 'mcp/engines/gemini_engine.js',
  geminiModelReceipts: 'mcp/engines/gemini_engine.js',
  invalidateGeminiReceipt: 'mcp/engines/gemini_engine.js',
  collectGeminiTerminalDiagnostics: 'mcp/engines/gemini_engine.js',

  GOOGLE_SEARCH_TAB: 'mcp/engines/google_search_engine.js'
});

test('owner modules list is exact and frozen to 6 modules', () => {
  assert.equal(OWNER_MODULES.length, 6);
  assert.ok(OWNER_MODULES.includes('mcp/server.js'));
  assert.ok(OWNER_MODULES.includes('mcp/engines/copilot_engine.js'));
  assert.ok(OWNER_MODULES.includes('mcp/engines/gemini_engine.js'));
  assert.ok(OWNER_MODULES.includes('mcp/engines/google_search_engine.js'));
  assert.ok(OWNER_MODULES.includes('mcp/pipeline/local_executor.js'));
  assert.ok(OWNER_MODULES.includes('mcp/pipeline/autopilot_engine.js'));
});

test('baseline test-mode exports are frozen and all mapped to valid owner modules', () => {
  assert.equal(BASELINE_TEST_MODE_EXPORTS.length, 32);
  for (const exportName of BASELINE_TEST_MODE_EXPORTS) {
    const owner = SYMBOL_OWNERSHIP[exportName];
    assert.ok(owner, `Missing owner for export ${exportName}`);
    assert.ok(OWNER_MODULES.includes(owner), `Invalid owner ${owner} for ${exportName}`);
  }
});

test('no symbol has duplicate owners', () => {
  const seen = new Set();
  for (const [symbol, owner] of Object.entries(SYMBOL_OWNERSHIP)) {
    assert.ok(!seen.has(symbol), `Duplicate symbol ${symbol}`);
    seen.add(symbol);
    assert.ok(OWNER_MODULES.includes(owner), `Unknown owner module ${owner}`);
  }
});

test('all seven baseline MCP tools are accounted for', () => {
  assert.equal(MCP_TOOL_NAMES.length, 7);
  const source = fs.readFileSync(SERVER_PATH, 'utf8');
  for (const tool of MCP_TOOL_NAMES) {
    assert.ok(source.includes(`name: '${tool}'`) || source.includes(`name: "${tool}"`), `Missing tool ${tool}`);
  }
});

test('all ten baseline dashboard routes are accounted for', () => {
  assert.equal(DASHBOARD_ROUTES.length, 10);
  const source = fs.readFileSync(SERVER_PATH, 'utf8');
  for (const route of DASHBOARD_ROUTES) {
    assert.ok(source.includes(route), `Missing route ${route}`);
  }
});

test('monolith imports safely under ANTIGRAVITY_TEST_EXPORT without starting server', () => {
  assert.equal(process.env.ANTIGRAVITY_TEST_EXPORT, '1');
  const monolith = require(SERVER_PATH);
  assert.ok(monolith && typeof monolith === 'object');
  for (const exportName of BASELINE_TEST_MODE_EXPORTS) {
    assert.ok(exportName in monolith, `Export ${exportName} missing from monolith export`);
  }
});
