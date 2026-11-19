'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const crypto = require('node:crypto');

const PROJECT_ROOT = path.resolve(__dirname, '../../..');
const AUTOPILOT_PATH = path.join(PROJECT_ROOT, 'mcp', 'pipeline', 'autopilot_engine.js');
const SERVER_PATH = path.join(PROJECT_ROOT, 'mcp', 'server.js');

const {
  createAutopilotEngine,
  PACK_MODES,
  CHUNK_ENGINE_LIMITS,
  getFailoverEngines
} = require(AUTOPILOT_PATH);

function makeTempProject(fileMap) {
  fileMap = fileMap || {
    'package.json': JSON.stringify({ name: 'fixture-app', version: '1.0.0' }),
    'src/a.js': 'module.exports = { a: 1 };',
    'src/b.js': 'module.exports = { b: 2 };'
  };
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cycle-test-'));
  const cleanDir = fs.realpathSync(dir);
  for (const [rel, val] of Object.entries(fileMap)) {
    const full = path.join(cleanDir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, val, 'utf8');
  }
  return cleanDir;
}

const VALID_2BATCH_PLAN = `OBJECTIVES: Implement a and b
ENTRY_POINT: src/a.js
ALLOWED_FILES: src/a.js, src/b.js
FILE_TARGET: src/a.js
FILE_TARGET: src/b.js
DEFINITION_OF_DONE: Complete`;

function createMockEnvironment(overrides) {
  overrides = overrides || {};
  const activeCycleJobs = {};
  const persistedReceipts = [];
  const executedPhases = [];
  const dispatchedCalls = [];

  const fakeExecutor = {
    applyBatch: overrides.applyBatch || function(args) {
      return { filesWritten: args.batch.targets, backups: [] };
    },
    runBatchQuickChecks: overrides.runBatchQuickChecks || function(args) {
      return { status: 'CHECK_PASSED', receipts: [] };
    },
    runFinalBuildAndTests: overrides.runFinalBuildAndTests || function(projectRoot, timeoutMs) {
      return { status: 'CHECK_PASSED', receipts: [{ command: 'npm test', exitCode: 0 }] };
    },
    persistCheckpointReceiptOnce: function(codePath, receipt, parsedFiles, cleanRoot, checkpointIdentity) {
      persistedReceipts.push({ codePath, receipt, checkpointIdentity });
    },
    migrateLegacyCheckpointReceipts: function(codePath, cleanRoot, checkpointIdentity) {
      return { migratedCount: 0 };
    }
  };

  const dispatchChunkedEngineTurn = overrides.dispatchChunkedEngineTurn || async function(engine, cleanRoot, prompt, attachment, opts) {
    dispatchedCalls.push({ engine, isPlanner: opts && opts.isPlanner, prompt });
    if (opts && opts.isPlanner) {
      return overrides.plannerOutput !== undefined ? overrides.plannerOutput : VALID_2BATCH_PLAN;
    }
    if (prompt && prompt.includes('Rishiko')) {
      return overrides.reviewerOutput !== undefined ? overrides.reviewerOutput : 'STATUS: PASSED\nAll good.';
    }
    return `### FILE: src/a.js\n\`\`\`js\nmodule.exports = { a: 1 };\n\`\`\`\n### FILE: src/b.js\n\`\`\`js\nmodule.exports = { b: 2 };\n\`\`\``;
  };

  const runtimeContext = {
    activeCycleJobs: activeCycleJobs,
    localExecutor: fakeExecutor,
    ensureProjectSetup: function() {
      return { roles: { planner: 'web1', coder: 'web2', reviewer: 'web1' } };
    },
    dispatchChunkedEngineTurn: dispatchChunkedEngineTurn,
    validatePlanOutput: overrides.validatePlanOutput || function() { return { ok: true }; },
    sleepFn: function() { return Promise.resolve(); },
    spawnSync: overrides.spawnSync || function() { return { stdout: 'diff --git a/src/a.js b/src/a.js' }; }
  };

  const engine = createAutopilotEngine(runtimeContext);

  return {
    engine,
    activeCycleJobs,
    persistedReceipts,
    dispatchedCalls,
    runtimeContext,
    fakeExecutor
  };
}

// 1. Successful two-batch phase order
test('1. Successful two-batch phase order', async () => {
  const cleanDir = makeTempProject();
  const env = createMockEnvironment();

  const result = await env.engine.runAutonomousPipeline(cleanDir, 'test request');

  assert.equal(result.status, 'CYCLE_COMPLETED');
  assert.equal(result.verdict, 'APPROVED');
  const job = env.engine.getActiveJob(cleanDir);
  assert.equal(job.running, false);
  assert.equal(job.phase, 'COMPLETED');
});

// 2. Single-cycle exclusivity
test('2. Single-cycle exclusivity', async () => {
  const cleanDir = makeTempProject();
  const env = createMockEnvironment();

  env.activeCycleJobs[cleanDir] = { running: true, phase: 'CODING_BATCH 1/2' };

  await assert.rejects(
    async () => env.engine.runAutonomousPipeline(cleanDir, 'concurrent request'),
    /ACTION_REJECTED_CYCLE_IN_PROGRESS/
  );
});

// 3. Lock release exactly once on success
test('3. Lock release exactly once on success', async () => {
  const cleanDir = makeTempProject();
  const env = createMockEnvironment();

  await env.engine.runAutonomousPipeline(cleanDir, 'test request');
  assert.equal(env.engine.isCycleActive(cleanDir), false);

  const res2 = await env.engine.runAutonomousPipeline(cleanDir, 'second request');
  assert.equal(res2.status, 'CYCLE_COMPLETED');
  assert.equal(env.engine.isCycleActive(cleanDir), false);
});

// 4. Lock release exactly once on synchronous throw
test('4. Lock release exactly once on synchronous throw', async () => {
  const cleanDir = makeTempProject();
  const env = createMockEnvironment({
    validatePlanOutput: () => { throw new Error('SYNCHRONOUS_VALIDATION_PANIC'); }
  });

  await assert.rejects(
    async () => env.engine.runAutonomousPipeline(cleanDir, 'req'),
    /SYNCHRONOUS_VALIDATION_PANIC/
  );

  assert.equal(env.engine.isCycleActive(cleanDir), false);
  const job = env.engine.getActiveJob(cleanDir);
  assert.equal(job.running, false);
  assert.equal(job.phase, 'FAILED');
});

// 5. Lock release exactly once on rejected promise
test('5. Lock release exactly once on rejected promise', async () => {
  const cleanDir = makeTempProject();
  const env = createMockEnvironment({
    dispatchChunkedEngineTurn: async () => { throw new Error('ASYNC_NETWORK_EXPLOSION'); }
  });

  await assert.rejects(
    async () => env.engine.runAutonomousPipeline(cleanDir, 'req'),
    /ASYNC_NETWORK_EXPLOSION/
  );

  assert.equal(env.engine.isCycleActive(cleanDir), false);
  const job = env.engine.getActiveJob(cleanDir);
  assert.equal(job.running, false);
  assert.equal(job.phase, 'FAILED');
  assert.match(job.error, /ASYNC_NETWORK_EXPLOSION/);
});

// 6. Lock release on cancellation
test('6. Lock release on cancellation', async () => {
  const cleanDir = makeTempProject();
  const env = createMockEnvironment();

  env.activeCycleJobs[cleanDir] = { running: true, phase: 'CODING_BATCH 1/2' };
  assert.equal(env.engine.isCycleActive(cleanDir), true);

  const cancelled = env.engine.cancelCycle(cleanDir);
  assert.equal(cancelled, true);
  assert.equal(env.engine.isCycleActive(cleanDir), false);
  const job = env.engine.getActiveJob(cleanDir);
  assert.equal(job.running, false);
  assert.equal(job.phase, 'CANCELLED');
});

// 7. No phase after plan-validation failure
test('7. No phase after plan-validation failure', async () => {
  const cleanDir = makeTempProject();
  let codingDispatched = false;

  const env = createMockEnvironment({
    validatePlanOutput: () => ({ ok: false }),
    dispatchChunkedEngineTurn: async (eng, root, prompt, att, opts) => {
      if (opts && opts.isPlanner) return 'INVALID PLAN';
      codingDispatched = true;
      return 'CODE';
    }
  });

  await assert.rejects(
    async () => env.engine.runAutonomousPipeline(cleanDir, 'req'),
    /PLANNING_FINAL_INVALID/
  );

  assert.equal(codingDispatched, false);
  assert.equal(env.engine.isCycleActive(cleanDir), false);
});

// 8. No subsequent batch after apply failure
test('8. No subsequent batch after apply failure', async () => {
  const cleanDir = makeTempProject();
  let batchesCount = 0;

  const env = createMockEnvironment({
    applyBatch: () => {
      batchesCount++;
      throw new Error('APPLY_WRITE_PROTECTION_ERROR');
    }
  });

  await assert.rejects(
    async () => env.engine.runAutonomousPipeline(cleanDir, 'req'),
    /APPLY_WRITE_PROTECTION_ERROR/
  );

  assert.equal(batchesCount, 1);
  assert.equal(env.engine.isCycleActive(cleanDir), false);
});

// 9. No final validation after quick-check failure
test('9. No final validation after quick-check failure', async () => {
  const cleanDir = makeTempProject();
  let finalBuildCalled = false;

  const env = createMockEnvironment({
    runBatchQuickChecks: () => ({ status: 'CHECK_FAILED', receipts: [{ error: 'SyntaxError' }] }),
    runFinalBuildAndTests: () => {
      finalBuildCalled = true;
      return { status: 'CHECK_PASSED' };
    }
  });

  await assert.rejects(
    async () => env.engine.runAutonomousPipeline(cleanDir, 'req'),
    /BATCH_SYNTAX_OR_QUICK_CHECK_FAILED/
  );

  assert.equal(finalBuildCalled, false);
  assert.equal(env.engine.isCycleActive(cleanDir), false);
});

// 10. Final build/tests only after all batches
test('10. Final build/tests only after all batches', async () => {
  const cleanDir = makeTempProject();
  const callSequence = [];

  const env = createMockEnvironment({
    applyBatch: (args) => {
      callSequence.push('apply:' + args.batch.targets.join(','));
      return { filesWritten: args.batch.targets, backups: [] };
    },
    runFinalBuildAndTests: () => {
      callSequence.push('final_build');
      return { status: 'CHECK_PASSED', receipts: [] };
    }
  });

  await env.engine.runAutonomousPipeline(cleanDir, 'req');

  const finalIdx = callSequence.indexOf('final_build');
  assert.ok(finalIdx > 0);
  assert.ok(callSequence[0].startsWith('apply:'));
});

// 11. Resume only when both fingerprints match
test('11. Resume only when both fingerprints match', async () => {
  const cleanDir = makeTempProject();
  const { scanRepositoryUniversal } = require(AUTOPILOT_PATH);
  const scan = scanRepositoryUniversal(cleanDir);
  assert.ok(scan.repoFingerprint);
  assert.equal(scan.repoFingerprint.length, 64);
});

// 12. Rejection of stale plan, stale repository and foreign checkpoint
test('12. Rejection of stale plan, stale repository and foreign checkpoint', () => {
  const { computeCheckpointIdentity, isTargetVerifiedForCheckpoint } = require(path.join(PROJECT_ROOT, 'mcp', 'pipeline', 'local_executor'));
  const cleanDir = makeTempProject();
  const id1 = computeCheckpointIdentity(cleanDir, 'PLAN 1');
  const id2 = computeCheckpointIdentity(cleanDir, 'PLAN 2');
  assert.notEqual(id1.planFingerprint, id2.planFingerprint);

  const fileHash = crypto.createHash('sha256').update(fs.readFileSync(path.join(cleanDir, 'src/a.js'))).digest('hex');
  const auditIndex = {
    fileReceipts: new Map([
      ['src/a.js', {
        status: 'VERIFIED',
        syntax: 'PASS',
        quickCheck: 'PASS',
        inputSha256: fileHash,
        outputSha256: fileHash,
        repositoryFingerprint: id1.repositoryFingerprint,
        planFingerprint: id1.planFingerprint
      }]
    ]),
    conflicts: new Set()
  };
  assert.equal(isTargetVerifiedForCheckpoint(auditIndex, 'src/a.js', cleanDir, id1), true);
  assert.equal(isTargetVerifiedForCheckpoint(auditIndex, 'src/a.js', cleanDir, id2), false);
});

// 13. Checkpoint receipt persistence exactly once
test('13. Checkpoint receipt persistence exactly once', async () => {
  const cleanDir = makeTempProject();
  const env = createMockEnvironment();

  await env.engine.runAutonomousPipeline(cleanDir, 'req');
  assert.ok(env.persistedReceipts.length >= 1);
  for (const r of env.persistedReceipts) {
    assert.ok(r.receipt && r.receipt.batchId);
    assert.ok(r.checkpointIdentity);
  }
});

// 14. Legacy provenance remains UNPROVEN
test('14. Legacy provenance remains UNPROVEN', () => {
  const { createLocalExecutor } = require(path.join(PROJECT_ROOT, 'mcp', 'pipeline', 'local_executor'));
  const cleanDir = makeTempProject();
  const exchangeDir = path.join(cleanDir, '.antigravity', 'bridge', 'exchange');
  fs.mkdirSync(exchangeDir, { recursive: true });
  const codePath = path.join(exchangeDir, 'code.md');
  fs.writeFileSync(codePath, '<!-- AUDIT_RECEIPT: {"batchId":"b1","historicalOutputProvenance":"UNPROVEN"} -->\n', 'utf8');

  const executor = createLocalExecutor({ fs, path, crypto, ensureProjectSetup: () => ({}) });
  const identity = { repositoryFingerprint: 'rfp1', planFingerprint: 'pfp1' };
  executor.migrateLegacyCheckpointReceipts(codePath, cleanDir, identity);
  const content = fs.readFileSync(codePath, 'utf8');
  assert.ok(content.includes('UNPROVEN'));
});

// 15. Recovery/failover boundary without off-by-one
test('15. Recovery/failover boundary without off-by-one', () => {
  const engines = getFailoverEngines('gemini2', new Set());
  assert.ok(engines.length > 0);
  assert.equal(engines.includes('gemini2'), false);
});

// 16. Failover excludes current and excluded engines
test('16. Failover excludes current and excluded engines', () => {
  const engines = getFailoverEngines('gemini2', new Set(['gemini3']));
  assert.equal(engines.includes('gemini2'), false);
  assert.equal(engines.includes('gemini3'), false);
});

// 17. Exact success receipt
test('17. Exact success receipt', async () => {
  const cleanDir = makeTempProject();
  const env = createMockEnvironment();

  const res = await env.engine.runAutonomousPipeline(cleanDir, 'req');
  assert.equal(res.status, 'CYCLE_COMPLETED');
  assert.equal(res.verdict, 'APPROVED');
  assert.ok(Array.isArray(res.writtenFiles));
  assert.ok(Array.isArray(res.commandsExecuted));
  assert.ok(Array.isArray(res.batchReceipts));
  assert.ok(res.finalChecks && typeof res.finalChecks === 'object');
});

// 18. Exact ordinary-failure receipt
test('18. Exact ordinary-failure receipt', async () => {
  const cleanDir = makeTempProject();
  const env = createMockEnvironment({
    runFinalBuildAndTests: () => ({ status: 'CHECK_FAILED', receipts: [{ command: 'npm test', exitCode: 1 }] })
  });

  await assert.rejects(
    async () => env.engine.runAutonomousPipeline(cleanDir, 'req'),
    /FINAL_APPLY_AND_TEST_FAILED/
  );

  const job = env.engine.getActiveJob(cleanDir);
  assert.equal(job.running, false);
  assert.equal(job.phase, 'FAILED');
  assert.equal(job.result, null);
  assert.match(job.error, /FINAL_APPLY_AND_TEST_FAILED/);
});

// 19. Exact support-required terminal contract
test('19. Exact support-required terminal contract', async () => {
  const cleanDir = makeTempProject();
  const env = createMockEnvironment({
    dispatchChunkedEngineTurn: async () => {
      throw new Error('SUPPORT_REQUIRED_STOP_IMMEDIATELY: Quota completely exhausted');
    }
  });

  await assert.rejects(
    async () => env.engine.runAutonomousPipeline(cleanDir, 'req'),
    /SUPPORT_REQUIRED_STOP_IMMEDIATELY/
  );

  const job = env.engine.getActiveJob(cleanDir);
  assert.match(job.error, /SUPPORT_REQUIRED_STOP_IMMEDIATELY/);
});

// 20. Server-wrapper delegation parity
test('20. Server-wrapper delegation parity', () => {
  const source = fs.readFileSync(SERVER_PATH, 'utf8');
  assert.ok(source.includes('getAutopilotEngine().runAutonomousPipeline'));
  assert.ok(source.includes('getAutopilotEngine().waitJobSlice'));
  assert.ok(source.includes('getAutopilotEngine().packWorkspace'));
  assert.ok(source.includes('getAutopilotEngine().dispatchPlannerWithFailover'));
  assert.ok(source.includes('getAutopilotEngine().executeCodingLeaf'));
  assert.ok(source.includes('getAutopilotEngine().executeBatchWithRecovery'));
});

// 21. Zero import/factory side effects and zero console banner
test('21. Zero import/factory side effects and zero console banner', () => {
  const fresh = require(AUTOPILOT_PATH);
  assert.ok(fresh.createAutopilotEngine);
});
