'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

test('gemini_engine.js enforces strict Neon High (never accepts Low/bare Neon) and clicks Thinking level submenu', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'engines', 'gemini_engine.js'), 'utf8');
  assert.match(src, /isNeonLowAria\s*=\s*\/currently\\s\*neon\$\//);
  assert.match(src, /isNeonLowText\s*=\s*\/\^neon\$\//);
  assert.doesNotMatch(src, /deeper\\s\*analysis\|\\bneon\\b/);
  assert.match(src, /thinking level\|reasoning level/);
  assert.match(src, /thinkItem\.click\(\)/);
});

test('server.js enables Temporary Chat before ensureMaxReasoningMode so entering temp chat cannot downgrade High model', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  const tempChatIdx = src.indexOf('ensureGeminiTemporaryChat(targetFrame, tabKey, desiredTemp)');
  const ensureModelIdx = src.indexOf('const verifiedModel = await ensureMaxReasoningMode(targetFrame,tabKey');
  assert.ok(tempChatIdx !== -1 && ensureModelIdx !== -1);
  assert.ok(tempChatIdx < ensureModelIdx, 'Temporary chat must run before ensureMaxReasoningMode');
});

test('gemini_engine.js treats gemini1, gemini2, gemini3 symmetrically, supports /u/<n>/app routes, and dismisses overlays with Escape', async () => {
  const engineMod = require('../engines/gemini_engine.js');
  const src = fs.readFileSync(path.join(__dirname, '..', 'engines', 'gemini_engine.js'), 'utf8');

  assert.deepEqual(
    Object.keys(engineMod.geminiModelReceipts).sort(),
    ['gemini1', 'gemini2', 'gemini3']
  );
  assert.doesNotMatch(src, /9514703eb42c922a|159f7542a6843ce4/, 'gemini_engine.js must not contain hardcoded chat IDs');
  assert.match(src, /dismissOverlays/);
  assert.match(src, /Escape/);
  assert.match(src, /u\\\/\\d\+/);

  for (const tabId of ['gemini1', 'gemini2', 'gemini3']) {
    const tcRes = await engineMod.ensureGeminiTemporaryChat(null, tabId, true);
    assert.notEqual(tcRes.reason, 'INVALID_GEMINI_TAB_ID', `${tabId} must be in temporary chat allowlist`);
  }
});

test('classifyResetCandidate suppresses false-positive TURN_ROLLBACK when URL transitioned to /app/<id> or hasThoughtContent is true', () => {
  const { classifyResetCandidate } = require('../engines/gemini_engine.js');

  const baseState = {
    userTurnCount: 0,
    assistantTurnCount: 0,
    committedUserStillPresent: false,
    generating: false
  };
  const sendMeta = { committed: true, userTurnFingerprintMatched: true };
  const preCounts = { preUserCount: 0, preAssistantCount: 0, observedUserHighWatermark: 1, lastText: '' };

  // True rollback on bare /app without conversation ID or thoughts
  const trueRollback = classifyResetCandidate(
    Object.assign({}, baseState, { routeKey: '/app', hasThoughtContent: false }),
    sendMeta,
    preCounts
  );
  assert.equal(trueRollback.isCandidate, true);
  assert.equal(trueRollback.turnRolledBackAfterSend, true);
  assert.equal(trueRollback.resetCode, 'GEMINI_TURN_ROLLED_BACK_AFTER_SEND');

  // False-positive guard 1: URL transitioned to /app/<id> or /u/1/app/<id>
  for (const routeKey of ['/app/c8f91a2b3d4e5f60', '/u/1/app/c8f91a2b3d4e5f60']) {
    const withConvRoute = classifyResetCandidate(
      Object.assign({}, baseState, { routeKey, hasThoughtContent: false }),
      sendMeta,
      preCounts
    );
    assert.equal(withConvRoute.turnRolledBackAfterSend, false, `Must not report rollback for ${routeKey}`);
    assert.equal(withConvRoute.isCandidate, false);
  }

  // False-positive guard 2: Model thoughts present in DOM
  const withThoughts = classifyResetCandidate(
    Object.assign({}, baseState, { routeKey: '/app', hasThoughtContent: true }),
    sendMeta,
    preCounts
  );
  assert.equal(withThoughts.turnRolledBackAfterSend, false);
  assert.equal(withThoughts.isCandidate, false);
});

test('server.js symmetry check for gemini1..3, CDP ports 18001..18003, and absence of hardcoded chat IDs when configured', () => {
  const serverSrc = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  for (const tabKey of ['gemini1', 'gemini2', 'gemini3']) {
    assert.ok(serverSrc.includes(tabKey), `server.js must include ${tabKey}`);
  }
  if (/18001/.test(serverSrc)) {
    assert.match(serverSrc, /18001[\s\S]*18002[\s\S]*18003/);
    assert.doesNotMatch(serverSrc, /9514703eb42c922a|159f7542a6843ce4/);
  }
});

test('server.js classifies Gemini "An error occurred / Try again" as retryable TRANSIENT_SERVICE_ERROR and prevents smallDotWrapper stall on div.response-content', () => {
  const serverSrc = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  assert.match(serverSrc, /el\.matches\('div\.response-content,\.response-content,\.markdown-main-panel,message-content,\[role="alert"\]'\)/);
  assert.match(serverSrc, /hasActiveExplicitSpinner/);
  assert.match(serverSrc, /state\.inlineServiceError/);
  assert.match(serverSrc, /thinking-overlay,thinking-dots-animation/);
  assert.match(serverSrc, /function packWorkspace\(projectRoot, mode, opts\)/);

  const prevExport = process.env.ANTIGRAVITY_TEST_EXPORT;
  process.env.ANTIGRAVITY_TEST_EXPORT = '1';
  try {
    const srvPath = require.resolve('../server.js');
    delete require.cache[srvPath];
    const srv = require('../server.js');
    assert.ok(srv.SERVICE_ERROR_PATTERNS.includes('an error occurred'));
    const cls = srv.classifyWebServiceFailure({ text: 'WEB_SERVICE_REFUSAL: Gemini said\nAn error occurred\nTry again' });
    assert.equal(cls.class, 'TRANSIENT_SERVICE_ERROR');
    assert.equal(cls.retryable, true);
    assert.equal(cls.code, 'WEB_TRANSIENT_SERVICE_ERROR');
  } finally {
    if (prevExport === undefined) delete process.env.ANTIGRAVITY_TEST_EXPORT;
    else process.env.ANTIGRAVITY_TEST_EXPORT = prevExport;
  }
});

test('local_executor.js supports fail-closed SEARCH/REPLACE blocks alongside ### FILE: and diff --git', () => {
  const os = require('node:os');
  const execMod = require('../pipeline/local_executor.js');
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'search_replace_exec_'));
  try {
    const rel = 'src/sample.js';
    const abs = path.join(tmpDir, rel);
    fs.mkdirSync(path.dirname(abs), { recursive: true });
    fs.writeFileSync(abs, 'const a = 1;\r\nconst b = 2;\r\nconst c = 3;\r\n', 'utf8');

    const md = [
      'FILE: ' + rel,
      '',
      'javascript',
      '',
      '// SEARCH_REPLACE_PATCH',
      '<<<<<<< SEARCH',
      'const b = 2;',
      '=======',
      'const b = 200;',
      '>>>>>>> REPLACE',
      '',
      'Use code with caution.'
    ].join('\n');

    const v = execMod.validateGeneratedCodeMarkdown(md, tmpDir);
    assert.equal(v.valid, true, v.reason || '');
    const parsed = execMod.parseCodeBlocksFromMarkdown(md, [rel], tmpDir);
    const applied = execMod.applyBatch({
      projectRoot: tmpDir,
      batch: { batchId: 'B1', targets: [rel] },
      parsedFiles: parsed,
      batchOutput: md
    });
    assert.equal(applied.status, 'BATCH_APPLIED');
    const updated = fs.readFileSync(abs, 'utf8');
    assert.equal(updated, 'const a = 1;\r\nconst b = 200;\r\nconst c = 3;\r\n');

    assert.throws(() => {
      execMod.applySearchReplaceBlocks(updated, '<<<<<<< SEARCH\nmissing_line();\n=======\nx();\n>>>>>>> REPLACE', rel);
    }, /SEARCH_BLOCK_NOT_FOUND/);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
