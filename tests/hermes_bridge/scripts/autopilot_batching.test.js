'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const PROJECT_ROOT = path.resolve(__dirname, '../../..');
const AUTOPILOT_PATH = path.join(PROJECT_ROOT, 'mcp', 'pipeline', 'autopilot_engine.js');

const {
  parseAndValidatePlanBatches,
  partitionCodingBatches,
  halveBatchAdaptively,
  buildBatchMiniMap,
  extractBatchPlanSlice,
  CHUNK_ENGINE_LIMITS
} = require(AUTOPILOT_PATH);

test('parseAndValidatePlanBatches parses FILE_TARGET lines and validates plan', () => {
  const plan = `
# IMPLEMENTATION PLAN
- FILE_TARGET: src/engine.js
- FILE_TARGET: src/parser.js
- FILE_TARGET: tests/engine.test.js
`;
  const graph = { edges: [{ from: 'src/engine.js', to: 'src/parser.js' }] };
  const batches = parseAndValidatePlanBatches(plan, graph);

  assert.ok(Array.isArray(batches));
  assert.ok(batches.length >= 2);

  // Targets are preserved
  const allTargets = batches.flatMap(b => b.targets);
  assert.ok(allTargets.includes('src/engine.js'));
  assert.ok(allTargets.includes('src/parser.js'));
  assert.ok(allTargets.includes('tests/engine.test.js'));

  // Invalid plan with 0 targets throws
  assert.throws(() => parseAndValidatePlanBatches('No targets here', graph), /PLANNING_FINAL_INVALID/);
});

test('partitionCodingBatches isolates test files and groups source targets by batch size limits', () => {
  const targets = ['src/a.js', 'src/b.js', 'src/c.js', 'tests/a.test.js'];
  const graph = { edges: [] };
  const limits = { maxBatchFiles: 2, testMaxFiles: 1 };

  const batches = partitionCodingBatches(targets, graph, limits);

  // test target tests/a.test.js is isolated into its own batch
  const testBatch = batches.find(b => b.targets.includes('tests/a.test.js'));
  assert.ok(testBatch);
  assert.equal(testBatch.targets.length, 1);

  // Source files grouped in batches of at most maxBatchFiles
  for (const b of batches) {
    assert.ok(b.targets.length <= 2);
  }
});

test('halveBatchAdaptively splits multi-target batch into sub-batches deterministically', () => {
  const batch = {
    batchId: 'BATCH-001',
    targets: ['src/a.js', 'src/b.js', 'src/c.js', 'src/d.js'],
    halvingLevel: 0
  };

  const costs = { 'src/a.js': 100, 'src/b.js': 150, 'src/c.js': 200, 'src/d.js': 50 };
  const subBatches = halveBatchAdaptively(batch, costs, 0);

  assert.equal(subBatches.length, 2);
  assert.equal(subBatches[0].batchId, 'BATCH-001.a');
  assert.equal(subBatches[1].batchId, 'BATCH-001.b');
  assert.equal(subBatches[0].halvingLevel, 1);
  assert.equal(subBatches[1].halvingLevel, 1);

  const totalTargets = [...subBatches[0].targets, ...subBatches[1].targets];
  assert.deepEqual(totalTargets.sort(), batch.targets.sort());

  // Single target batch cannot be halved
  const singleBatch = { batchId: 'BATCH-002', targets: ['src/solo.js'], halvingLevel: 0 };
  const indivisible = halveBatchAdaptively(singleBatch, {}, 0);
  assert.equal(indivisible.length, 1);
  assert.deepEqual(indivisible[0], singleBatch);
});

test('buildBatchMiniMap and extractBatchPlanSlice extract concise batch context', () => {
  const batch = { batchId: 'BATCH-001', targets: ['src/a.js'] };
  const state = {
    scan: {
      projectRoot: PROJECT_ROOT,
      files: [{ path: 'src/a.js', symbols: ['funcA', 'CONST_B'], entryPointSignals: false }]
    },
    graph: { edges: [{ from: 'src/a.js', to: 'src/dep.js' }] },
    routing: { buildCmd: 'npm run build', testCmd: 'npm test' },
    contractMemory: 'PREVIOUS_CONTRACTS_NONE',
    planSlice: 'OBJECTIVE: implement src/a.js with zero bugs\nFILE_TARGET: src/a.js'
  };

  const miniMap = buildBatchMiniMap(batch, state, CHUNK_ENGINE_LIMITS);
  assert.ok(miniMap.text.includes('BATCH MINI MAP'));
  assert.ok(miniMap.text.includes('src/a.js'));
  assert.ok(miniMap.text.includes('DIRECT IMPORTS'));
  assert.ok(miniMap.text.includes('src/dep.js'));

  const planSlice = extractBatchPlanSlice(state.planSlice, batch);
  assert.ok(planSlice.includes('src/a.js'));
  assert.ok(planSlice.includes('OBJECTIVE: implement src/a.js'));
});
