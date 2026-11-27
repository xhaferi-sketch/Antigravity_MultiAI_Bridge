'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const PREV_LOCKS_ENV = process.env.ANTIGRAVITY_MODEL_LOCKS_PATH;
test.before(() => {
  process.env.ANTIGRAVITY_MODEL_LOCKS_PATH = path.join(os.tmpdir(), 'ag-no-locks-truthful-' + process.pid + '.json');
});
test.after(() => {
  if (PREV_LOCKS_ENV === undefined) delete process.env.ANTIGRAVITY_MODEL_LOCKS_PATH;
  else process.env.ANTIGRAVITY_MODEL_LOCKS_PATH = PREV_LOCKS_ENV;
});
const { createCopilotEngine } = require(path.join(__dirname, '..', 'engines', 'copilot_engine.js'));
const { ensureGeminiTemporaryChat, inspectGeminiTemporaryChatDom } = require(path.join(__dirname, '..', 'engines', 'gemini_engine.js'));

test('Copilot ensureCopilotGpt56Model rejects Auto / unverified reasoning (never bypasses to Auto)', async () => {
  const engine = createCopilotEngine({
    tabAuthStatus: {},
    tabActiveModel: {},
    tabDiscoveredModels: {},
    copilotModelReceipts: {},
    captureSupportEvidence: async () => {}
  });

  await assert.rejects(
    () => engine.ensureCopilotGpt56Model({
      evaluate: async () => ({ ok: false, reason: 'COPILOT_REQUIRED_MODEL_UNAVAILABLE', active: 'Auto' })
    }, 'web1'),
    /COPILOT_MODEL_LOCK_FAILED: COPILOT_REQUIRED_MODEL_UNAVAILABLE/
  );

  await assert.rejects(
    () => engine.ensureCopilotGpt56Model({
      evaluate: async () => ({ ok: true, active: 'GPT-5.6 Sol Think', reasoningLocked: false })
    }, 'web1'),
    /COPILOT_MODEL_LOCK_FAILED: COPILOT_REASONING_NOT_DEEP/
  );
});

test('copilot_engine.js source has no Auto bypass and strictly checks reasoningLocked', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'engines', 'copilot_engine.js'), 'utf8');
  assert.doesNotMatch(src, /else if \(text\(button\)\.toLowerCase\(\)\.includes\('auto'\)/);
  assert.match(src, /COPILOT_REASONING_NOT_DEEP/);
  assert.match(src, /isForbiddenWeakModel/);
});

test('Gemini ensureGeminiTemporaryChat retries inside collapsed sidebar drawer when toggle is initially hidden', async () => {
  let drawerOpened = false;
  const mockPage = {
    evaluate: async (fn, arg) => {
      const code = fn.toString();
      if (code.includes('toggleControl')) {
        return { controlFound: false, active: false, indicatorFound: false, ariaPressed: null, ariaChecked: null, controlLabel: '' };
      }
      if (!drawerOpened && arg && arg.requested) {
        drawerOpened = true;
        return { clicked: false, retryAfterDrawer: true, reason: 'OPENED_DRAWER_FOR_TEMPORARY_CHAT' };
      }
      return { clicked: true, reason: 'CLICKED_TEMPORARY_CHAT_TOGGLE' };
    }
  };
  // After drawer opens and click succeeds, inspectGeminiTemporaryChatDom returns controlFound false on mock unless updated;
  // verify drawer fallback path executes and stops fail-closed on DOM_VERIFICATION_TIMEOUT rather than immediately failing before opening drawer.
  const res = await ensureGeminiTemporaryChat(mockPage, 'gemini1', true, { timeoutMs: 40, pollMs: 10 });
  assert.equal(drawerOpened, true);
  assert.equal(res.reason, 'DOM_VERIFICATION_TIMEOUT');
  assert.equal(res.verified, false);
});

test('inspectGeminiTemporaryChatDom detects real Gemini Temporary Chat banner ("Temporary chats don\'t appear")', async () => {
  const prevDocument = global.document;
  const prevWindow = global.window;
  try {
    const fakeNode = {
      isConnected: true,
      innerText: "Just stopping by?\nTemporary chats don't appear in recent chats and aren't used to improve Google AI. Stored for 72 hours for safety.",
      classList: { contains: () => false },
      getAttribute: () => '',
      closest: () => null,
      getBoundingClientRect: () => ({ width: 400, height: 120 })
    };
    global.window = { getComputedStyle: () => ({ display: 'block', visibility: 'visible' }) };
    global.document = {
      querySelectorAll: (sel) => (sel.includes('main') ? [fakeNode] : []),
      querySelector: () => null
    };
    const res = await inspectGeminiTemporaryChatDom({ evaluate: (fn) => fn() });
    assert.equal(res.indicatorFound, true);
    assert.equal(res.active, true);

    // Turn-2 active conversation: top header shows "Temporary Chat", while sidebar button should not false-trigger when inactive
    const headerNode = {
      isConnected: true,
      innerText: 'Temporary Chat',
      classList: { contains: () => false },
      getAttribute: () => '',
      closest: () => null,
      getBoundingClientRect: () => ({ width: 120, height: 24 })
    };
    global.document = {
      querySelectorAll: (sel) => (sel.includes('header') ? [headerNode] : []),
      querySelector: () => null
    };
    const turn2Res = await inspectGeminiTemporaryChatDom({ evaluate: (fn) => fn() });
    assert.equal(turn2Res.indicatorFound, true);
    assert.equal(turn2Res.active, true);

    const sidebarButtonNode = {
      isConnected: true,
      innerText: 'Temporary Chat',
      classList: { contains: () => false },
      getAttribute: () => '',
      closest: (s) => (s.includes('button') ? {} : null),
      getBoundingClientRect: () => ({ width: 120, height: 24 })
    };
    global.document = {
      querySelectorAll: (sel) => (sel.includes('header') ? [sidebarButtonNode] : []),
      querySelector: () => null
    };
    const offRes = await inspectGeminiTemporaryChatDom({ evaluate: (fn) => fn() });
    assert.equal(offRes.indicatorFound, false);
    assert.equal(offRes.active, false);
  } finally {
    global.document = prevDocument;
    global.window = prevWindow;
  }
});

test('Truthful Dashboard runtime reports disconnected/unverified instead of fake static labels when tabs are closed', () => {
  const prevTestExport = process.env.ANTIGRAVITY_TEST_EXPORT;
  const prevTruthful = process.env.ANTIGRAVITY_TRUTHFUL_TEST;
  process.env.ANTIGRAVITY_TEST_EXPORT = '1';
  process.env.ANTIGRAVITY_TRUTHFUL_TEST = '1';
  const serverPath = path.join(__dirname, '..', 'server.js');
  try {
    delete require.cache[require.resolve(serverPath)];
    const srv = require(serverPath);
    const state = srv.buildDashboardState([]);
    for (const k of ['web1', 'web2', 'gemini1', 'gemini2', 'gemini3', 'google_search_1']) {
      assert.equal(state.tabs[k].open, false);
      assert.equal(state.tabs[k].model, '-', `${k} must show '-' when closed, not a fake model`);
      assert.equal(state.tabs[k].connectionLabel, 'E Shkëputur', `${k} must show E Shkëputur when closed`);
    }
    assert.notEqual(state.tabs.web1.temporaryChatStatus, 'OFF_VERIFIED', 'Closed tab must not claim OFF_VERIFIED');
  } finally {
    delete require.cache[require.resolve(serverPath)];
    if (prevTestExport === undefined) delete process.env.ANTIGRAVITY_TEST_EXPORT; else process.env.ANTIGRAVITY_TEST_EXPORT = prevTestExport;
    if (prevTruthful === undefined) delete process.env.ANTIGRAVITY_TRUTHFUL_TEST; else process.env.ANTIGRAVITY_TRUTHFUL_TEST = prevTruthful;
  }
});

test('autopilot_engine notifyWhatsApp uses shell:false so multi-word messages reach hermes.exe without Exit Code 2', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'pipeline', 'autopilot_engine.js'), 'utf8');
  const fnBlock = src.slice(src.indexOf('function notifyWhatsApp'), src.indexOf('let AdmZip'));
  assert.match(fnBlock, /shell:\s*false/);
  assert.match(fnBlock, /detached:\s*false/);
  assert.match(fnBlock, /windowsHide:\s*true/);
  assert.doesNotMatch(fnBlock, /shell:\s*true/);
});

test('local_executor spawns git/node/python/taskkill strictly with windowsHide:true (zero console flash on Windows)', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'pipeline', 'local_executor.js'), 'utf8');
  const spawnLines = src.split(/\r?\n/).filter((l) => /\b(execSync|spawnSync|nodeSpawnSync|nodeSpawn)\s*\(/.test(l) && !/function\s+|require\(|execSyncFn|spawnSyncFn|const\s+spawnSync/.test(l));
  assert.ok(spawnLines.length >= 10);
  for (const line of spawnLines) {
    assert.match(line, /windowsHide:\s*true/, `Missing windowsHide:true on line: ${line.trim()}`);
  }
});

test('parseCodeBlocksFromMarkdown skips fenced diff patches so applyBatch never treats diff as collapsed stub', () => {
  const { parseCodeBlocksFromMarkdown } = require(path.join(__dirname, '..', 'pipeline', 'local_executor.js'));
  const diffMd = [
    '```diff',
    'diff --git a/src/Other.cs b/src/Other.cs',
    '--- a/src/Other.cs',
    '+++ b/src/Other.cs',
    '@@ -1,2 +1,2 @@',
    '-old();',
    '+new();',
    '```'
  ].join('\n');
  const parsed = parseCodeBlocksFromMarkdown(diffMd, ['src/BigExecutor.cs', 'src/Other.cs']);
  assert.equal(parsed.length, 0, 'Fenced unified diff must not be parsed as full-file replacement for BigExecutor.cs');
});

test('buildMinimalBatchContext extracts line/symbol windows from >200KB source files', () => {
  const os = require('os');
  const { buildMinimalBatchContext, CHUNK_ENGINE_LIMITS } = require(path.join(__dirname, '..', 'pipeline', 'autopilot_engine.js'));
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-big-src-'));
  try {
    fs.mkdirSync(path.join(tmpDir, 'src'), { recursive: true });
    const lines = [];
    for (let i = 1; i <= 3000; i++) {
      if (i === 1270) {
        lines.push('internal static void ValidateAcceptedConnectivity() { if (OpenConnectors == 0) {} }');
      } else {
        lines.push('// filler line ' + i + ' ' + 'x'.repeat(80));
      }
    }
    fs.writeFileSync(path.join(tmpDir, 'src', 'Huge.cs'), lines.join('\r\n'), 'utf8');
    const ctx = buildMinimalBatchContext(
      { batchId: 'B1', targets: ['src/Huge.cs'] },
      { scan: { projectRoot: tmpDir, files: [{ path: 'src/Huge.cs', bytes: 260000 }] }, planSlice: 'Rreth rreshtit ~1270 ValidateAcceptedConnectivity OpenConnectors' },
      CHUNK_ENGINE_LIMITS
    );
    assert.ok(ctx.text.includes('ValidateAcceptedConnectivity'), 'Targeted symbol window around line 1270 must be included in batch context');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('applyBatch applies patch inside App subdirectory of parent .git repository', () => {
  const os = require('os');
  const { spawnSync } = require('child_process');
  const { applyBatch } = require(path.join(__dirname, '..', 'pipeline', 'local_executor.js'));
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-subgit-'));
  try {
    const app = path.join(parent, 'App');
    fs.mkdirSync(path.join(app, 'src'), { recursive: true });
    fs.writeFileSync(path.join(app, 'src', 'Demo.cs'), 'line1\r\nline2\r\n', 'utf8');
    spawnSync('git', ['init'], { cwd: parent, windowsHide: true });
    spawnSync('git', ['config', 'user.email', 'test@example.com'], { cwd: parent, windowsHide: true });
    spawnSync('git', ['config', 'user.name', 'Test'], { cwd: parent, windowsHide: true });
    spawnSync('git', ['add', '.'], { cwd: parent, windowsHide: true });
    spawnSync('git', ['commit', '-m', 'init'], { cwd: parent, windowsHide: true });

    const patchOutput = [
      'diff --git a/src/Demo.cs b/src/Demo.cs',
      '--- a/src/Demo.cs',
      '+++ b/src/Demo.cs',
      '@@ -1,2 +1,2 @@',
      ' line1',
      '-line2',
      '+line2_fixed'
    ].join('\n');
    const res = applyBatch({
      projectRoot: app,
      batch: { batchId: 'SUBGIT_1', targets: ['src/Demo.cs'] },
      parsedFiles: [],
      batchOutput: patchOutput
    });
    assert.equal(res.status, 'BATCH_APPLIED');
    assert.match(fs.readFileSync(path.join(app, 'src', 'Demo.cs'), 'utf8'), /line2_fixed/);
  } finally {
    fs.rmSync(parent, { recursive: true, force: true });
  }
});

test('autopilot_engine fails fast without wasting INTEGRATION_REPAIR calls on environment tooling errors', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'pipeline', 'autopilot_engine.js'), 'utf8');
  assert.match(src, /isEnvironmentToolingError/);
  assert.match(src, /ENVIRONMENT_TOOLING_FAILED/);
  assert.match(src, /isArchiveOrIgnoredTarget/);
});

test('persistCheckpointReceiptOnce persists DIFF_PATCH targets and isTargetVerifiedForCheckpoint validates them on resume', () => {
  const os = require('os');
  const crypto = require('crypto');
  const le = require(path.join(__dirname, '..', 'pipeline', 'local_executor.js'));
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-diff-cp-'));
  try {
    fs.mkdirSync(path.join(tmpRoot, 'src'), { recursive: true });
    fs.writeFileSync(path.join(tmpRoot, 'src', 'Target.cs'), 'class A { int x = 2; }\n', 'utf8');
    const codePath = path.join(tmpRoot, 'code.md');
    const planText = 'FILE_TARGET: src/Target.cs';
    const planFp = crypto.createHash('sha256').update(planText).digest('hex');
    const identity = Object.assign({}, le.computeCheckpointIdentity(tmpRoot, planText), { planFingerprint: planFp });
    const exec = le.createLocalExecutor({ fs, path, crypto });
    fs.writeFileSync(codePath, '<!-- CODE_PLAN_META planFingerprint=' + planFp + ' -->\n', 'utf8');
    exec.persistCheckpointReceiptOnce(codePath, { batchId: 'BATCH_1' }, [{ relPath: 'src/Target.cs' }], tmpRoot, identity);
    const audit = le.parseCheckpointAudit(fs.readFileSync(codePath, 'utf8'));
    assert.equal(le.isTargetVerifiedForCheckpoint(audit, 'src/Target.cs', tmpRoot, identity), true);
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});
