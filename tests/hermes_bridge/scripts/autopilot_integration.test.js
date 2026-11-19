'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const crypto = require('node:crypto');

const PROJECT_ROOT = path.resolve(__dirname, '../../..');
const AUTOPILOT_PATH = path.join(PROJECT_ROOT, 'mcp', 'pipeline', 'autopilot_engine.js');
const EXECUTOR_PATH = path.join(PROJECT_ROOT, 'mcp', 'pipeline', 'local_executor.js');

const { createAutopilotEngine } = require(AUTOPILOT_PATH);
const { createLocalExecutor } = require(EXECUTOR_PATH);

function makeFixtureProject(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'auto-integ-'));
  const cleanDir = fs.realpathSync(dir);
  const defaultFiles = {
    'package.json': JSON.stringify({ name: 'integ-fixture', version: '1.0.0' }),
    'src/alpha.js': 'function alpha() { return 1; }\nmodule.exports = { alpha };\n',
    'src/beta.js': 'function beta() { return 2; }\nmodule.exports = { beta };\n',
    'tests/alpha.test.js': 'const { alpha } = require("../src/alpha");\n'
  };
  const allFiles = Object.assign(defaultFiles, files || {});
  for (const [rel, content] of Object.entries(allFiles)) {
    const full = path.join(cleanDir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content, 'utf8');
  }
  return cleanDir;
}

const VALID_INTEGRATION_PLAN = [
  '# PLANI ARKITEKTUROR TEKNIK DHE EKZEKUTIMI',
  '1. OBJEKTIVAT DHE NON-GOALS: Ekstraktim modular i plote me zero humbje funksionaliteti dhe ruajtje te kontratave.',
  '2. ENTRY POINT DHE ROOT CAUSE: Ndarja e pergjegjesive ne src/alpha.js dhe src/beta.js pa krijuar varesi rrethore.',
  '3. ALLOWED_FILES:',
  'FILE_TARGET: src/alpha.js',
  'FILE_TARGET: src/beta.js',
  'FILE_TARGET: tests/alpha.test.js',
  '4. SPECIFIKIMI SKEDAR MË SKEDAR (FILE-BY-FILE):',
  '- src/alpha.js: implementon funksionin alpha dhe eksporton ate sipas specifikimeve.',
  '- src/beta.js: implementon funksionin beta me verifikim deterministik.',
  '- tests/alpha.test.js: shton testet e njesise per verifikim te plote automatik.',
  '5. DEFINITION OF DONE & HARDENING TESTS:',
  'Te gjitha testet e njesise kalojne me 100% sukses dhe exit code 0.',
  'A'.repeat(260)
].join('\n');

function setupRealComposition(cleanDir, opts) {
  opts = opts || {};
  const activeCycleJobs = {};
  const localExecutor = createLocalExecutor({ fs, path, crypto });
  const eventLedger = [];

  const dispatchChunkedEngineTurn = opts.dispatchChunkedEngineTurn || async function(engine, root, prompt, attachment, callOpts) {
    eventLedger.push({ action: 'dispatch', engine, isPlanner: Boolean(callOpts && callOpts.isPlanner) });
    if (callOpts && callOpts.isPlanner) {
      if (opts.plannerThrows) throw new Error(opts.plannerThrows);
      return opts.plannerOutput || VALID_INTEGRATION_PLAN;
    }
    if (prompt && prompt.includes('Rishiko')) {
      if (opts.reviewerThrows) throw new Error(opts.reviewerThrows);
      return opts.reviewerOutput || 'STATUS: PASSED\nAll integration checks approved.';
    }
    // Coding response
    if (opts.coderThrows) throw new Error(opts.coderThrows);
    if (opts.coderOutput !== undefined) return opts.coderOutput;

    return `### FILE: src/alpha.js
\`\`\`js
function alpha() { return 10; }
module.exports = { alpha };
\`\`\`
### FILE: src/beta.js
\`\`\`js
function beta() { return 20; }
module.exports = { beta };
\`\`\`
### FILE: tests/alpha.test.js
\`\`\`js
const assert = require('assert');
const { alpha } = require('../src/alpha');
assert.strictEqual(alpha(), 10);
\`\`\``;
  };

  const runtimeContext = {
    activeCycleJobs,
    localExecutor,
    ensureProjectSetup: function() {
      return { roles: { planner: 'google_search_1', coder: 'web2', reviewer: 'web1' } };
    },
    dispatchChunkedEngineTurn,
    validatePlanOutput: opts.validatePlanOutput,
    sleepFn: function() { return Promise.resolve(); },
    spawnSync: opts.spawnSync || function() {
      return { stdout: 'diff --git a/src/alpha.js b/src/alpha.js\n+ return 10;' };
    }
  };

  const autopilot = createAutopilotEngine(runtimeContext);

  return {
    autopilot,
    localExecutor,
    activeCycleJobs,
    eventLedger,
    runtimeContext
  };
}

// 1. End-to-end integration test with real composition root
test('WO-MOD-6: E2E multi-batch cycle through real composition root (2 source + 1 test leaf)', async () => {
  const cleanDir = makeFixtureProject();
  try {
    const comp = setupRealComposition(cleanDir);
    const result = await comp.autopilot.runAutonomousPipeline(cleanDir, 'Upgrade alpha and beta with tests');

    assert.equal(result.status, 'CYCLE_COMPLETED');
    assert.equal(result.verdict, 'APPROVED');
    assert.ok(result.writtenFiles.length >= 2, 'Must have written targets');

    // Verify lock released exactly once
    const job = comp.autopilot.getActiveJob(cleanDir);
    assert.equal(job.running, false);
    assert.equal(job.phase, 'COMPLETED');

    // Verify checkpoints persisted to code.md
    const codePath = path.join(cleanDir, '.antigravity', 'bridge', 'exchange', 'code.md');
    assert.ok(fs.existsSync(codePath), 'code.md must exist');
    const codeText = fs.readFileSync(codePath, 'utf8');
    assert.ok(codeText.includes('CHECKPOINT_FILE_VERIFIED'), 'Checkpoints must be persisted');
  } finally {
    fs.rmSync(cleanDir, { recursive: true, force: true });
  }
});

// 2. Failure Path 1: Planner failure with eligible failover
test('WO-MOD-6: Failure Path 1 - Planner failure with eligible failover succeeds on secondary engine', async () => {
  const cleanDir = makeFixtureProject();
  try {
    let plannerAttempts = 0;
    const comp = setupRealComposition(cleanDir, {
      dispatchChunkedEngineTurn: async function(engine, root, prompt, attachment, callOpts) {
        if (callOpts && callOpts.isPlanner) {
          plannerAttempts++;
          if (engine === 'google_search_1') {
            throw new Error('SEARCH_AI_RESPONSE_TIMEOUT: Primary planner timed out');
          }
          return VALID_INTEGRATION_PLAN;
        }
        if (prompt && prompt.includes('Rishiko')) {
          return 'STATUS: PASSED';
        }
        return `### FILE: src/alpha.js\n\`\`\`js\nmodule.exports = { alpha: () => 1 };\n\`\`\`\n### FILE: src/beta.js\n\`\`\`js\nmodule.exports = { beta: () => 2 };\n\`\`\`\n### FILE: tests/alpha.test.js\n\`\`\`js\nmodule.exports = {};\n\`\`\``;
      }
    });

    const result = await comp.autopilot.runAutonomousPipeline(cleanDir, 'Plan failover test');
    assert.equal(result.status, 'CYCLE_COMPLETED');
    assert.ok(plannerAttempts >= 2, 'Must attempt secondary failover engine');
    assert.equal(comp.autopilot.getActiveJob(cleanDir).running, false);
  } finally {
    fs.rmSync(cleanDir, { recursive: true, force: true });
  }
});

// 3. Failure Path 2: Terminal support-required failure stops immediately
test('WO-MOD-6: Failure Path 2 - Terminal support-required stops downstream coding and releases lock', async () => {
  const cleanDir = makeFixtureProject();
  try {
    let codingDispatched = false;
    const comp = setupRealComposition(cleanDir, {
      dispatchChunkedEngineTurn: async function(engine, root, prompt, attachment, callOpts) {
        if (callOpts && callOpts.isPlanner) {
          throw new Error('SUPPORT_REQUIRED_STOP_IMMEDIATELY: Manual captcha required');
        }
        codingDispatched = true;
        return '';
      }
    });

    await assert.rejects(
      () => comp.autopilot.runAutonomousPipeline(cleanDir, 'Terminal test'),
      /SUPPORT_REQUIRED_STOP_IMMEDIATELY/
    );

    assert.equal(codingDispatched, false, 'Downstream coding must be suppressed');
    const job = comp.autopilot.getActiveJob(cleanDir);
    assert.equal(job.running, false);
    assert.equal(job.phase, 'FAILED');
  } finally {
    fs.rmSync(cleanDir, { recursive: true, force: true });
  }
});

// 4. Failure Path 3: Invalid or forbidden target rejected before coding
test('WO-MOD-6: Failure Path 3 - Invalid or forbidden target stops cycle immediately', async () => {
  const cleanDir = makeFixtureProject();
  try {
    let codingDispatched = false;
    const invalidPlan = [
      '# PLANI ARKITEKTUROR TEKNIK',
      '1. OBJEKTIVAT DHE NON-GOALS: Attack test',
      '2. ENTRY POINT DHE ROOT CAUSE: Path traversal',
      '3. ALLOWED_FILES:',
      'FILE_TARGET: ../forbidden.js',
      '4. SPECIFIKIMI SKEDAR MË SKEDAR: Illegal outside target',
      '5. DEFINITION OF DONE: Done',
      'A'.repeat(260)
    ].join('\n');

    const comp = setupRealComposition(cleanDir, {
      plannerOutput: invalidPlan,
      dispatchChunkedEngineTurn: async function(engine, root, prompt, attachment, callOpts) {
        if (callOpts && callOpts.isPlanner) {
          return invalidPlan;
        }
        codingDispatched = true;
        return '';
      }
    });

    await assert.rejects(
      () => comp.autopilot.runAutonomousPipeline(cleanDir, 'Path traversal test')
    );

    assert.equal(codingDispatched, false, 'Coding must never be dispatched for forbidden targets');
    assert.equal(comp.autopilot.getActiveJob(cleanDir).running, false);
  } finally {
    fs.rmSync(cleanDir, { recursive: true, force: true });
  }
});

// 5. Failure Path 4: Coding response parse failure / empty code fails cleanly
test('WO-MOD-6: Failure Path 4 - Unparseable coding output aborts with lock release', async () => {
  const cleanDir = makeFixtureProject();
  try {
    const comp = setupRealComposition(cleanDir, {
      coderOutput: 'I am not writing any code blocks for this task.'
    });

    await assert.rejects(
      () => comp.autopilot.runAutonomousPipeline(cleanDir, 'Bad coder test')
    );

    const job = comp.autopilot.getActiveJob(cleanDir);
    assert.equal(job.running, false);
    assert.equal(job.phase, 'FAILED');
  } finally {
    fs.rmSync(cleanDir, { recursive: true, force: true });
  }
});

// 6. Failure Path 5: Batch apply failure stops downstream batches
test('WO-MOD-6: Failure Path 5 - Batch apply failure aborts downstream batches and releases lock', async () => {
  const cleanDir = makeFixtureProject();
  try {
    const comp = setupRealComposition(cleanDir);
    // Force apply failure on executor
    comp.localExecutor.applyBatch = function() {
      throw new Error('APPLY_FAILURE: Target file is locked or missing');
    };

    await assert.rejects(
      () => comp.autopilot.runAutonomousPipeline(cleanDir, 'Apply failure test'),
      /APPLY_FAILURE/
    );

    const job = comp.autopilot.getActiveJob(cleanDir);
    assert.equal(job.running, false);
    assert.equal(job.phase, 'FAILED');
  } finally {
    fs.rmSync(cleanDir, { recursive: true, force: true });
  }
});

// 7. Failure Path 6: Quick-check failure stops final validation
test('WO-MOD-6: Failure Path 6 - Quick check failure stops subsequent phases and releases lock', async () => {
  const cleanDir = makeFixtureProject();
  try {
    const comp = setupRealComposition(cleanDir);
    comp.localExecutor.runBatchQuickChecks = function() {
      return { status: 'CHECK_FAILED', errors: ['Syntax error in alpha.js'] };
    };

    await assert.rejects(
      () => comp.autopilot.runAutonomousPipeline(cleanDir, 'Quick check failure test'),
      /QUICK_CHECK_FAILED/
    );

    const job = comp.autopilot.getActiveJob(cleanDir);
    assert.equal(job.running, false);
    assert.equal(job.phase, 'FAILED');
  } finally {
    fs.rmSync(cleanDir, { recursive: true, force: true });
  }
});

// 8. Failure Path 7: Final build/test failure aborts cycle
test('WO-MOD-6: Failure Path 7 - Final build/test failure aborts cycle with terminal error', async () => {
  const cleanDir = makeFixtureProject();
  try {
    const comp = setupRealComposition(cleanDir);
    comp.localExecutor.runFinalBuildAndTests = function() {
      return { status: 'CHECK_FAILED', output: 'Integration test suite failed with 2 errors' };
    };

    await assert.rejects(
      () => comp.autopilot.runAutonomousPipeline(cleanDir, 'Final test failure'),
      /FINAL_APPLY_AND_TEST_FAILED/
    );

    const job = comp.autopilot.getActiveJob(cleanDir);
    assert.equal(job.running, false);
    assert.equal(job.phase, 'FAILED');
  } finally {
    fs.rmSync(cleanDir, { recursive: true, force: true });
  }
});

// 9. Failure Path 8: Cancellation during active cycle
test('WO-MOD-6: Failure Path 8 - Cancellation marks CANCELLED and guarantees lock release', async () => {
  const cleanDir = makeFixtureProject();
  try {
    const comp = setupRealComposition(cleanDir, {
      dispatchChunkedEngineTurn: async function(engine, root, prompt, attachment, callOpts) {
        if (callOpts && callOpts.isPlanner) {
          // Cancel while planning is underway
          comp.autopilot.cancelCycle(cleanDir);
          return VALID_INTEGRATION_PLAN;
        }
        return '';
      }
    });

    await assert.rejects(
      () => comp.autopilot.runAutonomousPipeline(cleanDir, 'Cancel test'),
      /CYCLE_CANCELLED/
    );

    const job = comp.autopilot.getActiveJob(cleanDir);
    assert.equal(job.running, false);
    assert.equal(job.phase, 'CANCELLED');
  } finally {
    fs.rmSync(cleanDir, { recursive: true, force: true });
  }
});

// 10. Failure Path 9: Stale or foreign checkpoint forces re-execution
test('WO-MOD-6: Failure Path 9 - Stale or foreign checkpoint is ignored and files re-executed', async () => {
  const cleanDir = makeFixtureProject();
  try {
    const comp = setupRealComposition(cleanDir);
    const exchangeDir = path.join(cleanDir, '.antigravity', 'bridge', 'exchange');
    fs.mkdirSync(exchangeDir, { recursive: true });
    const codePath = path.join(exchangeDir, 'code.md');

    // Insert foreign checkpoint with wrong repo fingerprint
    const staleAudit = `<!-- CHECKPOINT_FILE_VERIFIED target=src/alpha.js repositoryFingerprint=foreign_repo_123 planFingerprint=foreign_plan_123 status=VERIFIED -->\n`;
    fs.writeFileSync(codePath, staleAudit, 'utf8');

    let codingRuns = 0;
    comp.runtimeContext.dispatchChunkedEngineTurn = async function(engine, root, prompt, attachment, callOpts) {
      if (callOpts && callOpts.isPlanner) return VALID_INTEGRATION_PLAN;
      if (prompt && prompt.includes('Rishiko')) return 'STATUS: PASSED';
      codingRuns++;
      return `### FILE: src/alpha.js\n\`\`\`js\nmodule.exports = { alpha: () => 1 };\n\`\`\`\n### FILE: src/beta.js\n\`\`\`js\nmodule.exports = { beta: () => 2 };\n\`\`\`\n### FILE: tests/alpha.test.js\n\`\`\`js\nmodule.exports = {};\n\`\`\``;
    };

    const result = await comp.autopilot.runAutonomousPipeline(cleanDir, 'Stale checkpoint test');
    assert.equal(result.status, 'CYCLE_COMPLETED');
    assert.ok(codingRuns > 0, 'Must re-execute coding because checkpoint was foreign/stale');
  } finally {
    fs.rmSync(cleanDir, { recursive: true, force: true });
  }
});

// 11. Failure Path 10: Side action rejected while cycle is active
test('WO-MOD-6: Failure Path 10 - Side action is rejected while cycle lock is active', async () => {
  const cleanDir = makeFixtureProject();
  try {
    const comp = setupRealComposition(cleanDir);
    // Artificially mark job as running
    comp.activeCycleJobs[cleanDir] = { running: true, phase: 'CODING_BATCH 1/2' };

    await assert.rejects(
      () => comp.autopilot.runAutonomousPipeline(cleanDir, 'Concurrent attempt'),
      /ACTION_REJECTED_CYCLE_IN_PROGRESS/
    );
  } finally {
    fs.rmSync(cleanDir, { recursive: true, force: true });
  }
});
