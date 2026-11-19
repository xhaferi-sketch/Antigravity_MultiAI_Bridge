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
const { createLocalExecutor, computeCheckpointIdentity } = require(EXECUTOR_PATH);

function makeResumeFixture() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'auto-resume-'));
  const cleanDir = fs.realpathSync(dir);
  const files = {
    'package.json': JSON.stringify({ name: 'resume-fixture', version: '1.0.0' }),
    'src/alpha.js': 'function alpha() { return 1; }\nmodule.exports = { alpha };\n',
    'tests/alpha.test.js': 'const { alpha } = require("../src/alpha");\n'
  };
  for (const [rel, content] of Object.entries(files)) {
    const full = path.join(cleanDir, rel);
    fs.mkdirSync(path.dirname(full), { recursive: true });
    fs.writeFileSync(full, content, 'utf8');
  }
  return cleanDir;
}

const RESUME_PLAN = [
  '# PLANI ARKITEKTUROR TEKNIK DHE EKZEKUTIMI',
  '1. OBJEKTIVAT DHE NON-GOALS: Ekstraktim modular dhe testim i plote.',
  '2. ENTRY POINT DHE ROOT CAUSE: Ndarja ne src/alpha.js dhe tests/alpha.test.js.',
  '3. ALLOWED_FILES:',
  'FILE_TARGET: src/alpha.js',
  'FILE_TARGET: tests/alpha.test.js',
  '4. SPECIFIKIMI SKEDAR MË SKEDAR (FILE-BY-FILE):',
  '- src/alpha.js: implementon alpha.',
  '- tests/alpha.test.js: shton testet e njesise.',
  '5. DEFINITION OF DONE & HARDENING TESTS:',
  'Te gjitha testet kalojne me 100% sukses.',
  'A'.repeat(260)
].join('\n');

test('WO-MOD-6: Resume - Interrupted cycle resumes without re-applying verified batch or duplicating receipts', async () => {
  const cleanDir = makeResumeFixture();
  try {
    const localExecutor = createLocalExecutor({ fs, path, crypto });
    const exchangeDir = path.join(cleanDir, '.antigravity', 'bridge', 'exchange');
    fs.mkdirSync(exchangeDir, { recursive: true });
    const codePath = path.join(exchangeDir, 'code.md');

    // 1. First run: Batch 1 (src/alpha.js) completes and writes verified checkpoint
    const identity = computeCheckpointIdentity(cleanDir, RESUME_PLAN);
    const alphaAbs = path.join(cleanDir, 'src', 'alpha.js');
    const alphaHash = crypto.createHash('sha256').update(fs.readFileSync(alphaAbs)).digest('hex');

    const checkpointAudit = `<!-- CHECKPOINT_FILE_VERIFIED target=src/alpha.js inputSha256=${alphaHash} outputSha256=${alphaHash} repositoryFingerprint=${identity.repositoryFingerprint} planFingerprint=${identity.planFingerprint} parserMode=FENCED syntax=PASS quickCheck=PASS status=VERIFIED -->\n`;
    fs.writeFileSync(codePath, checkpointAudit, 'utf8');

    // 2. Simulate restart: Create a fresh composition root
    let alphaCodingDispatched = false;
    let testCodingDispatched = false;

    const runtimeContext = {
      activeCycleJobs: {},
      localExecutor,
      ensureProjectSetup: () => ({ roles: { planner: 'google_search_1', coder: 'web2', reviewer: 'web1' } }),
      dispatchChunkedEngineTurn: async (engine, root, prompt, attachment, callOpts) => {
        if (callOpts && callOpts.isPlanner) return RESUME_PLAN;
        if (prompt && prompt.includes('Rishiko')) return 'STATUS: PASSED';
        if (prompt && prompt.includes('Implemento VETEM target-et (src/alpha.js)')) alphaCodingDispatched = true;
        if (prompt && prompt.includes('Implemento VETEM target-et (tests/alpha.test.js)')) testCodingDispatched = true;
        return `### FILE: tests/alpha.test.js\n\`\`\`js\nconst assert = require('assert');\n\`\`\``;
      },
      sleepFn: () => Promise.resolve(),
      spawnSync: () => ({ stdout: 'diff --git a/tests/alpha.test.js b/tests/alpha.test.js' })
    };

    const freshAutopilot = createAutopilotEngine(runtimeContext);
    const result = await freshAutopilot.runAutonomousPipeline(cleanDir, 'Resume test');

    assert.equal(result.status, 'CYCLE_COMPLETED');
    assert.equal(alphaCodingDispatched, false, 'Verified Batch 1 must NOT be coded or applied again');

    // 3. Verify receipts not duplicated in code.md
    const codeContent = fs.readFileSync(codePath, 'utf8');
    const alphaMatches = (codeContent.match(/target=src\/alpha\.js/g) || []).length;
    assert.equal(alphaMatches, 1, 'Receipt for src/alpha.js must not be duplicated');
  } finally {
    fs.rmSync(cleanDir, { recursive: true, force: true });
  }
});

test('WO-MOD-6: Resume - Changed repository fingerprint forces re-execution of batch', async () => {
  const cleanDir = makeResumeFixture();
  try {
    const localExecutor = createLocalExecutor({ fs, path, crypto });
    const exchangeDir = path.join(cleanDir, '.antigravity', 'bridge', 'exchange');
    fs.mkdirSync(exchangeDir, { recursive: true });
    const codePath = path.join(exchangeDir, 'code.md');

    // Checkpoint with old/foreign repo fingerprint
    const auditText = `<!-- CHECKPOINT_FILE_VERIFIED target=src/alpha.js inputSha256=111 outputSha256=111 repositoryFingerprint=old_repofp_123 planFingerprint=plan_123 status=VERIFIED -->\n`;
    fs.writeFileSync(codePath, auditText, 'utf8');

    let codingRuns = 0;
    const runtimeContext = {
      activeCycleJobs: {},
      localExecutor,
      ensureProjectSetup: () => ({ roles: { planner: 'google_search_1', coder: 'web2', reviewer: 'web1' } }),
      dispatchChunkedEngineTurn: async (engine, root, prompt, attachment, callOpts) => {
        if (callOpts && callOpts.isPlanner) return RESUME_PLAN;
        if (prompt && prompt.includes('Rishiko')) return 'STATUS: PASSED';
        codingRuns++;
        return `### FILE: src/alpha.js\n\`\`\`js\nmodule.exports = { alpha: () => 1 };\n\`\`\`\n### FILE: tests/alpha.test.js\n\`\`\`js\nmodule.exports = {};\n\`\`\``;
      },
      sleepFn: () => Promise.resolve(),
      spawnSync: () => ({ stdout: 'diff' })
    };

    const freshAutopilot = createAutopilotEngine(runtimeContext);
    await freshAutopilot.runAutonomousPipeline(cleanDir, 'Repo change test');

    assert.ok(codingRuns > 0, 'Must re-execute coding when repository fingerprint differs');
  } finally {
    fs.rmSync(cleanDir, { recursive: true, force: true });
  }
});

test('WO-MOD-6: Resume - Legacy checkpoint sets provenance=UNPROVEN and is not blindly skipped', () => {
  const cleanDir = makeResumeFixture();
  try {
    const localExecutor = createLocalExecutor({ fs, path, crypto });
    const codePath = path.join(cleanDir, 'code.md');

    // Legacy unproven audit file format
    const legacyText = `### FILE: src/alpha.js\nfunction alpha() {}\n`;
    fs.writeFileSync(codePath, legacyText, 'utf8');

    const identity = computeCheckpointIdentity(cleanDir, RESUME_PLAN);
    localExecutor.migrateLegacyCheckpointReceipts(codePath, cleanDir, identity);

    const migratedText = fs.readFileSync(codePath, 'utf8');
    assert.ok(migratedText.includes('historicalOutputProvenance=UNPROVEN'), 'Must be marked UNPROVEN');
    assert.ok(migratedText.includes('LEGACY_VERIFIED_MIGRATION'), 'Must record legacy migration');
  } finally {
    fs.rmSync(cleanDir, { recursive: true, force: true });
  }
});
