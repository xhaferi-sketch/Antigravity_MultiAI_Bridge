'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const PROJECT_ROOT = path.resolve(__dirname, '../../..');
const ENGINE_PATH = path.join(PROJECT_ROOT, 'mcp', 'engines', 'copilot_engine.js');

const {
  createCopilotEngine,
  COPILOT_REQUIRED_MODEL,
  COPILOT_OUTPUT_CONTRACT,
  M365_CHAT_URL,
  findChatFrameOrPage,
  checkAuthExpired,
  buildCopilotPromptWithContract
} = require(ENGINE_PATH);

test('copilot_engine exports required contract symbols', () => {
  assert.equal(typeof createCopilotEngine, 'function');
  assert.ok(COPILOT_REQUIRED_MODEL && typeof COPILOT_REQUIRED_MODEL === 'object');
  assert.equal(typeof COPILOT_OUTPUT_CONTRACT, 'string');
  assert.equal(typeof M365_CHAT_URL, 'string');
  assert.equal(typeof findChatFrameOrPage, 'function');
  assert.equal(typeof checkAuthExpired, 'function');
  assert.equal(typeof buildCopilotPromptWithContract, 'function');
});

test('createCopilotEngine enforces mandatory runtimeContext dependency', () => {
  assert.throws(() => createCopilotEngine(), /Mandatory runtimeContext dependency is required/);
  assert.throws(() => createCopilotEngine(null), /Mandatory runtimeContext dependency is required/);
  assert.throws(() => createCopilotEngine('not_an_object'), /Mandatory runtimeContext dependency is required/);

  const engine = createCopilotEngine({
    tabAuthStatus: {},
    tabActiveModel: {},
    captureSupportEvidence: async () => {}
  });

  assert.ok(engine && typeof engine === 'object');
  assert.equal(typeof engine.findChatFrameOrPage, 'function');
  assert.equal(typeof engine.checkAuthExpired, 'function');
  assert.equal(typeof engine.ensureCopilotGpt56Model, 'function');
  assert.equal(typeof engine.buildCopilotPromptWithContract, 'function');
  assert.equal(engine.M365_CHAT_URL, M365_CHAT_URL);
  assert.deepEqual(engine.COPILOT_REQUIRED_MODEL, COPILOT_REQUIRED_MODEL);
});

test('COPILOT_REQUIRED_MODEL preserves frozen gpt-5.6-sol-think contract', () => {
  assert.equal(COPILOT_REQUIRED_MODEL.family, 'gpt-5.6-sol-think');
  assert.equal(COPILOT_REQUIRED_MODEL.modelLabel, 'GPT-5.6 Sol Think');
  assert.equal(COPILOT_REQUIRED_MODEL.reasoningLabel, 'Think deeper');
  assert.equal(COPILOT_REQUIRED_MODEL.reasoning, 'high');
  assert.ok(Object.isFrozen(COPILOT_REQUIRED_MODEL));
});

test('COPILOT_OUTPUT_CONTRACT enforces strictly fenced zero-prose format', () => {
  assert.ok(COPILOT_OUTPUT_CONTRACT.includes('OUTPUT CONTRACT — MANDATORY'));
  assert.ok(COPILOT_OUTPUT_CONTRACT.includes('Return ONLY the authorized target files.'));
  assert.ok(COPILOT_OUTPUT_CONTRACT.includes('FILE: relative/path.ext'));
  assert.ok(COPILOT_OUTPUT_CONTRACT.includes('Rules: Opening and closing triple backticks are mandatory. No prose. No diffs.'));
});

test('buildCopilotPromptWithContract prepends contract idempotently', () => {
  const barePrompt = 'Write the implementation of src/index.js';
  const prepended = buildCopilotPromptWithContract(barePrompt);
  assert.ok(prepended.startsWith(COPILOT_OUTPUT_CONTRACT));
  assert.ok(prepended.includes(barePrompt));

  // Idempotent: does not prepend twice
  const secondPass = buildCopilotPromptWithContract(prepended);
  assert.equal(secondPass, prepended);
});

test('findChatFrameOrPage identifies active Copilot chat frame', () => {
  const dummyPage = { url: () => 'https://m365.cloud.microsoft/' };
  const matchingFrame = { url: () => 'https://m365.cloud.microsoft/chat?auth=1' };
  const otherFrame = { url: () => 'https://example.com/iframe' };

  dummyPage.frames = () => [otherFrame, matchingFrame];
  assert.equal(findChatFrameOrPage(dummyPage), matchingFrame);

  // Fallback to page when no frame matches
  dummyPage.frames = () => [otherFrame];
  assert.equal(findChatFrameOrPage(dummyPage), dummyPage);

  // Handles null/empty gracefully
  assert.equal(findChatFrameOrPage(null), null);
});

test('checkAuthExpired detects active session and login expiration', async () => {
  const authStatus = {};

  // Active session mock
  const activePage = {
    url: () => 'https://m365.cloud.microsoft/chat',
    frames: () => [],
    evaluate: async () => true,
    waitForTimeout: async () => {}
  };
  const activeExpired = await checkAuthExpired(activePage, 'web1', authStatus);
  assert.equal(activeExpired, false);
  assert.equal(authStatus.web1, 'ACTIVE');

  // Expired / Login redirect mock
  const loginPage = {
    url: () => 'https://login.microsoftonline.com/common/oauth2/authorize',
    frames: () => [],
    evaluate: async () => false,
    waitForTimeout: async () => {}
  };
  const loginExpired = await checkAuthExpired(loginPage, 'web2', authStatus);
  assert.equal(loginExpired, true);
  assert.equal(authStatus.web2, 'AUTH_EXPIRED');
});

test('ensureCopilotGpt56Model validates active model lock in target frame', async () => {
  const engine = createCopilotEngine({
    tabAuthStatus: {},
    tabActiveModel: {},
    captureSupportEvidence: async () => {}
  });

  // Mock frame already locked to GPT-5.6 Sol Think
  const validFrame = {
    evaluate: async () => ({
      ok: true,
      active: 'GPT-5.6 Sol Think · Think deeper',
      reasoningLocked: true
    })
  };
  const model = await engine.ensureCopilotGpt56Model(validFrame, 'web1');
  assert.equal(model, 'GPT-5.6 Sol Think');

  // Mock frame where model is unavailable
  const failedFrame = {
    evaluate: async () => ({
      ok: false,
      reason: 'COPILOT_REQUIRED_MODEL_UNAVAILABLE',
      active: 'Basic Copilot'
    })
  };
  await assert.rejects(
    () => engine.ensureCopilotGpt56Model(failedFrame, 'web2'),
    /COPILOT_MODEL_LOCK_FAILED: COPILOT_REQUIRED_MODEL_UNAVAILABLE/
  );
});
