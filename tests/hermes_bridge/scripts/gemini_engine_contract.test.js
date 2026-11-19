'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const PROJECT_ROOT = path.resolve(__dirname, '../../..');
const ENGINE_PATH = path.join(PROJECT_ROOT, 'mcp', 'engines', 'gemini_engine.js');

const {
  createGeminiEngine,
  GEMINI_REQUIRED_MODEL,
  GEMINI_APP_URL,
  geminiModelReceipts,
  invalidateGeminiReceipt,
  classifyAttachmentHandshakeStrict,
  classifyResetCandidate,
  classifyGeminiRecovery,
  collectGeminiTerminalDiagnostics,
  runGeminiAttachmentIngestHandshake
} = require(ENGINE_PATH);

test('gemini_engine exports required contract symbols', () => {
  assert.equal(typeof createGeminiEngine, 'function');
  assert.ok(GEMINI_REQUIRED_MODEL && typeof GEMINI_REQUIRED_MODEL === 'object');
  assert.equal(typeof GEMINI_APP_URL, 'string');
  assert.ok(geminiModelReceipts && typeof geminiModelReceipts === 'object');
  assert.equal(typeof invalidateGeminiReceipt, 'function');
  assert.equal(typeof classifyAttachmentHandshakeStrict, 'function');
  assert.equal(typeof classifyResetCandidate, 'function');
  assert.equal(typeof classifyGeminiRecovery, 'function');
  assert.equal(typeof collectGeminiTerminalDiagnostics, 'function');
  assert.equal(typeof runGeminiAttachmentIngestHandshake, 'function');
});

test('createGeminiEngine enforces mandatory runtimeContext dependency', () => {
  assert.throws(() => createGeminiEngine(), /Mandatory runtimeContext dependency is required/);
  assert.throws(() => createGeminiEngine(null), /Mandatory runtimeContext dependency is required/);
  assert.throws(() => createGeminiEngine('not_an_object'), /Mandatory runtimeContext dependency is required/);

  const engine = createGeminiEngine({
    tabActiveModel: {},
    tabDiscoveredModels: {},
    captureSupportEvidence: async () => {},
    appendDispatchDiag: () => {}
  });

  assert.ok(engine && typeof engine === 'object');
  assert.equal(typeof engine.ensureGeminiNeonModel, 'function');
  assert.equal(typeof engine.invalidateGeminiReceipt, 'function');
  assert.equal(typeof engine.collectGeminiTerminalDiagnostics, 'function');
  assert.equal(typeof engine.runGeminiAttachmentIngestHandshake, 'function');
  assert.equal(typeof engine.classifyAttachmentHandshakeStrict, 'function');
  assert.equal(typeof engine.classifyResetCandidate, 'function');
  assert.equal(typeof engine.classifyGeminiRecovery, 'function');
  assert.deepEqual(engine.GEMINI_REQUIRED_MODEL, GEMINI_REQUIRED_MODEL);
  assert.equal(engine.GEMINI_APP_URL, GEMINI_APP_URL);
});

test('GEMINI_REQUIRED_MODEL preserves frozen 4 Neon contract', () => {
  assert.equal(GEMINI_REQUIRED_MODEL.family, 'neon');
  assert.equal(GEMINI_REQUIRED_MODEL.modelLabel, '4 Neon');
  assert.equal(GEMINI_REQUIRED_MODEL.menuLabel, 'Deeper analysis (4 Neon)');
  assert.equal(GEMINI_REQUIRED_MODEL.displayLabel, '4 Neon (High)');
  assert.equal(GEMINI_REQUIRED_MODEL.reasoning, 'high');
  assert.equal(GEMINI_REQUIRED_MODEL.reasoningSource, 'integrated-model-mode');
  assert.ok(Object.isFrozen(GEMINI_REQUIRED_MODEL));
});

test('invalidateGeminiReceipt resets model receipt deterministically', () => {
  geminiModelReceipts.gemini1 = { verified: true, modelLabel: '4 Neon' };
  assert.ok(geminiModelReceipts.gemini1 !== null);

  invalidateGeminiReceipt('gemini1');
  assert.equal(geminiModelReceipts.gemini1, null);

  // Unknown key does not throw or mutate valid keys
  geminiModelReceipts.gemini2 = { verified: true, modelLabel: '4 Neon' };
  invalidateGeminiReceipt('unknown_key');
  assert.ok(geminiModelReceipts.gemini2 !== null);
  invalidateGeminiReceipt('gemini2');
  assert.equal(geminiModelReceipts.gemini2, null);
});

test('classifyAttachmentHandshakeStrict validates handshake response formats', () => {
  // 1. Blank response
  const blankRes = classifyAttachmentHandshakeStrict('');
  assert.equal(blankRes.ok, false);
  assert.equal(blankRes.code, 'BLANK');

  // 2. Prompt echo
  const echoRes = classifyAttachmentHandshakeStrict('Lexo skedarin e bashkëngjitur plotësisht. Mos shkruaj kod ende.');
  assert.equal(echoRes.ok, false);
  assert.equal(echoRes.code, 'PROMPT_ECHO');

  // 3. Accepted handshake
  const validRes = classifyAttachmentHandshakeStrict('Po, e lexova skedarin plotësisht dhe jam gati për hapin pasues.');
  assert.equal(validRes.ok, true);
  assert.equal(validRes.code, 'SEARCH_AI_ATTACHMENT_HANDSHAKE_ACCEPTED');

  // 4. English accepted handshake
  const englishRes = classifyAttachmentHandshakeStrict('File received and understood. Ready.');
  assert.equal(englishRes.ok, true);
  assert.equal(englishRes.code, 'SEARCH_AI_ATTACHMENT_HANDSHAKE_ACCEPTED');

  // 5. Unrecognized / arbitrary text
  const unverifiedRes = classifyAttachmentHandshakeStrict('Une jam nje model gjuhesor inteligjent.');
  assert.equal(unverifiedRes.ok, false);
});

test('ensureGeminiNeonModel verifies and selects 4 Neon via target frame', async () => {
  const tabActiveModel = {};
  const tabDiscoveredModels = {};
  const engine = createGeminiEngine({
    tabActiveModel,
    tabDiscoveredModels
  });

  // 1. Success path
  const successFrame = {
    evaluate: async (fn, req) => ({
      ok: true,
      verified: true,
      family: req.family,
      modelLabel: req.modelLabel,
      displayLabel: req.displayLabel,
      reasoning: req.reasoning,
      reasoningSource: req.reasoningSource,
      stablePolls: 2,
      thinkingSelectorRequired: false
    })
  };

  const model = await engine.ensureGeminiNeonModel(successFrame, 'gemini1');
  assert.equal(model, '4 Neon (High)');
  assert.equal(tabActiveModel.gemini1, '4 Neon (High)');
  assert.equal(tabDiscoveredModels.gemini1, 'Deeper analysis (4 Neon)');
  assert.ok(geminiModelReceipts.gemini1 && geminiModelReceipts.gemini1.verified === true);

  // 2. Model trigger timeout
  const timeoutFrame = {
    evaluate: async () => ({ ok: false, code: 'MODEL_TRIGGER_TIMEOUT' })
  };
  await assert.rejects(
    () => engine.ensureGeminiNeonModel(timeoutFrame, 'gemini2'),
    /MODEL_TRIGGER_TIMEOUT/
  );

  // 3. Model option not found
  const notFoundFrame = {
    evaluate: async () => ({ ok: false, code: 'MODEL_OPTION_NOT_FOUND' })
  };
  await assert.rejects(
    () => engine.ensureGeminiNeonModel(notFoundFrame, 'gemini2'),
    /MODEL_OPTION_NOT_FOUND/
  );
});

test('collectGeminiTerminalDiagnostics probes error alerts and containers deterministically', async () => {
  const diagsLogged = [];
  const appendDiag = (root, id, type, meta) => {
    diagsLogged.push({ type, meta });
  };

  // Mock target frame with quota error alert
  const mockFrame = {
    evaluate: async () => ({
      alerts: [{ tag: 'div', textPreview: 'Rate limit reached, please try again later.' }],
      retryVisible: true,
      errorCode: 'GEMINI_QUOTA_OR_RATE_LIMIT',
      responseContainer: {
        tag: 'response-container',
        hasModelThoughts: true,
        outerHtmlSnippetSanitizedMax1000: '<div>response</div>'
      }
    })
  };

  const receipt = await collectGeminiTerminalDiagnostics({
    targetFrame: mockFrame,
    tabKey: 'gemini1',
    projectRoot: PROJECT_ROOT,
    dispatchId: 'diag-test-1',
    errorCode: 'GEMINI_FIRST_TOKEN_TIMEOUT',
    elapsedMs: 5000,
    progressAgeMs: 5000,
    appendDispatchDiag: appendDiag
  });

  assert.equal(receipt.errorCode, 'GEMINI_QUOTA_OR_RATE_LIMIT');
  assert.equal(receipt.retryVisible, true);
  assert.equal(receipt.alerts.length, 1);
  assert.equal(receipt.responseContainer.hasModelThoughts, true);
  assert.ok(diagsLogged.some(d => d.type === 'TERMINAL_DIAG_START'));
  assert.ok(diagsLogged.some(d => d.type === 'GEMINI_ALERTS_PROBED'));

  // Robust error handling when targetFrame evaluation fails
  const failingFrame = {
    evaluate: async () => { throw new Error('Frame detached'); }
  };
  const fallbackReceipt = await collectGeminiTerminalDiagnostics({
    targetFrame: failingFrame,
    tabKey: 'gemini1',
    projectRoot: PROJECT_ROOT,
    dispatchId: 'diag-test-2',
    appendDispatchDiag: appendDiag
  });
  assert.equal(fallbackReceipt.errorCode, '');
  assert.equal(fallbackReceipt.retryVisible, false);
  assert.deepEqual(fallbackReceipt.alerts, []);
});

test('classifyResetCandidate detects domain drift, landing reset, and turn rollback', () => {
  // 1. Domain drift
  const drift = classifyResetCandidate(
    { domainMismatch: true, userTurnCount: 0, assistantTurnCount: 0, generating: false },
    { committed: true }
  );
  assert.equal(drift.isCandidate, true);
  assert.equal(drift.resetKind, 'DOMAIN_DRIFT');
  assert.equal(drift.resetCode, 'ENGINE_DOMAIN_DRIFT_AFTER_SEND');

  // 2. Landing reset
  const landing = classifyResetCandidate(
    { landingVisible: true, conversationContinuity: false, userTurnCount: 0, assistantTurnCount: 0, generating: false },
    { committed: true }
  );
  assert.equal(landing.isCandidate, true);
  assert.equal(landing.resetKind, 'LANDING_RESET');
  assert.equal(landing.resetCode, 'GEMINI_CONVERSATION_RESET_AFTER_SEND');

  // 3. Turn rollback
  const rollback = classifyResetCandidate(
    { committedUserStillPresent: false, userTurnCount: 0, assistantTurnCount: 0, generating: false },
    { committed: true, userTurnFingerprintMatched: true },
    { preUserCount: 0, preAssistantCount: 0, lastText: '' }
  );
  assert.equal(rollback.isCandidate, true);
  assert.equal(rollback.resetKind, 'TURN_ROLLBACK');
  assert.equal(rollback.resetCode, 'GEMINI_TURN_ROLLED_BACK_AFTER_SEND');

  // 4. Normal active generation (no reset)
  const normal = classifyResetCandidate(
    { userTurnCount: 1, assistantTurnCount: 1, generating: true, conversationContinuity: true },
    { committed: true }
  );
  assert.equal(normal.isCandidate, false);
  assert.equal(normal.resetKind, '');
});

test('classifyGeminiRecovery enforces one-reset recovery budget and terminal stop', () => {
  // Attempt 1: Should recover
  const firstReset = classifyGeminiRecovery('GEMINI_CONVERSATION_RESET_AFTER_SEND route=/app', 0, 1);
  assert.equal(firstReset.shouldRecover, true);
  assert.equal(firstReset.exhausted, false);
  assert.equal(firstReset.nextRecoveryCount, 1);
  assert.equal(firstReset.budgetRemaining, 0);

  // Attempt 2: Exhausted -> stop immediately
  const secondReset = classifyGeminiRecovery('GEMINI_CONVERSATION_RESET_AFTER_SEND route=/app', 1, 1);
  assert.equal(secondReset.shouldRecover, false);
  assert.equal(secondReset.exhausted, true);
  assert.equal(secondReset.stopImmediately, true);
  assert.equal(secondReset.code, 'GEMINI_RESET_RECOVERY_EXHAUSTED');

  // Silent preflight timeout recovery classification
  const firstPreflight = classifyGeminiRecovery('GEMINI_SILENT_PREFLIGHT_TIMEOUT elapsedMs=300000', 0, 1);
  assert.equal(firstPreflight.shouldRecover, true);
  assert.equal(firstPreflight.nextRecoveryCount, 1);

  // Non-reset error should not recover
  const normalError = classifyGeminiRecovery('SYNTAX_ERROR', 0, 1);
  assert.equal(normalError.shouldRecover, false);
  assert.equal(normalError.exhausted, false);
});

test('runGeminiAttachmentIngestHandshake executes verified handshake roundtrip', async () => {
  // Mock dispatcher returning valid handshake response
  const validDispatcher = async (opts) => {
    assert.equal(opts.tabKey, 'gemini1');
    assert.ok(opts.promptText.includes('Lexo skedarin e bashkëngjitur plotësisht'));
    assert.equal(opts.attachmentPaths[0], '/tmp/spec.md');
    return 'Po, e lexova skedarin dhe jam gati.';
  };

  const verified = await runGeminiAttachmentIngestHandshake({
    tabKey: 'gemini1',
    projectRoot: PROJECT_ROOT,
    attachmentPath: '/tmp/spec.md',
    batchId: 'BATCH_1',
    dispatchToWebTab: validDispatcher
  });
  assert.equal(verified.status, 'VERIFIED');
  assert.ok(verified.text.includes('jam gati'));

  // Mock dispatcher returning echo / unverified response
  const echoDispatcher = async () => 'Lexo skedarin e bashkëngjitur plotësisht.';
  await assert.rejects(
    () => runGeminiAttachmentIngestHandshake({
      tabKey: 'gemini1',
      projectRoot: PROJECT_ROOT,
      attachmentPath: '/tmp/spec.md',
      batchId: 'BATCH_2',
      dispatchToWebTab: echoDispatcher
    }),
    /GEMINI_ATTACHMENT_INGEST_UNVERIFIED: PROMPT_ECHO/
  );
});
