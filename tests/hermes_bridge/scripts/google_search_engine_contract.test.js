'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

const PROJECT_ROOT = path.resolve(__dirname, '../../..');
const ENGINE_PATH = path.join(PROJECT_ROOT, 'mcp', 'engines', 'google_search_engine.js');

const {
  createGoogleSearchEngine,
  GOOGLE_SEARCH_AI_URL,
  validatePlanOutput,
  classifyAttachmentHandshake,
  buildSearchAiCleanPrompt,
  searchAiTextFingerprint,
  classifySearchAiNoResponse
} = require(ENGINE_PATH);

test('google_search_engine exports required contract symbols', () => {
  assert.equal(typeof createGoogleSearchEngine, 'function');
  assert.equal(GOOGLE_SEARCH_AI_URL, 'https://www.google.com/ai');
  assert.equal(typeof validatePlanOutput, 'function');
  assert.equal(typeof classifyAttachmentHandshake, 'function');
  assert.equal(typeof buildSearchAiCleanPrompt, 'function');
  assert.equal(typeof searchAiTextFingerprint, 'function');
  assert.equal(typeof classifySearchAiNoResponse, 'function');
});

test('createGoogleSearchEngine enforces mandatory runtimeContext dependency', () => {
  assert.throws(() => createGoogleSearchEngine(), /Mandatory runtimeContext dependency is required/);
  assert.throws(() => createGoogleSearchEngine(null), /Mandatory runtimeContext dependency is required/);
  assert.throws(() => createGoogleSearchEngine('invalid'), /Mandatory runtimeContext dependency is required/);

  const engine = createGoogleSearchEngine({
    withTabLock: async (tab, fn) => fn(),
    activeProjectPerTab: {},
    getOrCreateTab: async () => ({})
  });
  assert.ok(engine && typeof engine === 'object');
  assert.equal(typeof engine.selectGoogleSearchAiModel, 'function');
  assert.equal(typeof engine.ensureGoogleSearchAi4CarbonMode, 'function');
  assert.equal(typeof engine.discoverSearchAiAssistantTurns, 'function');
  assert.equal(typeof engine.extractSearchAiTurnContent, 'function');
  assert.equal(typeof engine.classifySearchAiNoResponse, 'function');
  assert.equal(typeof engine.attachFilesToSearchAiClean, 'function');
  assert.equal(typeof engine.validatePlanOutput, 'function');
  assert.equal(typeof engine.classifyAttachmentHandshake, 'function');
  assert.equal(typeof engine.buildSearchAiCleanPrompt, 'function');
  assert.equal(typeof engine.searchAiTextFingerprint, 'function');
  assert.equal(typeof engine.dispatchToGoogleSearchAiTab, 'function');
});

test('buildSearchAiCleanPrompt generates frozen prompt variants', () => {
  const hs = buildSearchAiCleanPrompt('handshake');
  assert.ok(hs.includes('Lexo skedarin e bashkëngjitur'));
  assert.ok(hs.includes('jam gati'));

  const plan = buildSearchAiCleanPrompt('plan');
  assert.ok(plan.includes('OBJEKTIVAT DHE NON-GOALS'));
  assert.ok(plan.includes('FILE_TARGET: path'));
  assert.ok(plan.includes('HARDENING DHE DEFINITION OF DONE'));

  const retry = buildSearchAiCleanPrompt('planRetry', { missing: ['file_target', 'dod'] });
  assert.ok(retry.includes('file_target, dod'));

  const rev = buildSearchAiCleanPrompt('review', { context: 'MY_CONTEXT' });
  assert.ok(rev.includes('STATUS: APPROVED ose STATUS: CHANGES_REQUIRED'));
  assert.ok(rev.includes('MY_CONTEXT'));

  const code = buildSearchAiCleanPrompt('code', { context: 'MY_CODE_CTX' });
  assert.ok(code.includes('### FILE: path/relative.ext'));
  assert.ok(code.includes('MY_CODE_CTX'));

  const hsRev = buildSearchAiCleanPrompt('handshakeReview');
  assert.ok(hsRev.includes('ruaje si kontekst për auditimin pasues'));

  const fallback = buildSearchAiCleanPrompt('unknown', { text: 'custom' });
  assert.equal(fallback, 'custom');
});

test('searchAiTextFingerprint produces deterministic 16-character hex string', () => {
  const fp1 = searchAiTextFingerprint('Hello World');
  const fp2 = searchAiTextFingerprint('  Hello   World  ');
  const fp3 = searchAiTextFingerprint('Different text');

  assert.equal(fp1.length, 16);
  assert.equal(fp1, fp2);
  assert.notEqual(fp1, fp3);
});

test('validatePlanOutput verifies plan length, safety, and section requirements', () => {
  // Too short
  const shortRes = validatePlanOutput('Too short plan text');
  assert.equal(shortRes.ok, false);
  assert.equal(shortRes.reason, 'TOO_SHORT');

  // UI Contamination
  const uiText = 'A'.repeat(300) + '\nCopied to clipboard\nOBJEKTIV\nENTRY POINT\nFILE_TARGET: src/app.js\nSPECIFIKIM\nDEFINITION OF DONE';
  assert.equal(validatePlanOutput(uiText).reason, 'UI_CONTAMINATION');

  // Service refusal
  const refusalText = 'A'.repeat(300) + '\nno response available\nOBJEKTIV\nENTRY POINT\nFILE_TARGET: src/app.js\nSPECIFIKIM\nDEFINITION OF DONE';
  assert.equal(validatePlanOutput(refusalText).reason, 'SERVICE_REFUSAL');

  // Prompt echo
  const echoText = 'Duke përdorur kontekstin e skedarit të bashkëngjitur ' + 'A'.repeat(300);
  assert.equal(validatePlanOutput(echoText).reason, 'PROMPT_ECHO_DOMINANT');

  // Unsafe path
  const unsafePlan = [
    'A'.repeat(250),
    '1. OBJEKTIVAT DHE NON-GOALS',
    '2. ENTRY POINT DHE ROOT CAUSE',
    '3. ALLOWED_FILES',
    'FILE_TARGET: ../evil.js',
    '4. SPECIFIKIMI SKEDAR MË SKEDAR',
    '5. DEFINITION OF DONE'
  ].join('\n');
  assert.equal(validatePlanOutput(unsafePlan).reason, 'UNSAFE_PATH');

  // Missing file target when required
  const noFilesPlan = [
    'A'.repeat(250),
    '1. OBJEKTIVAT DHE NON-GOALS',
    '2. ENTRY POINT DHE ROOT CAUSE',
    '3. ALLOWED_FILES',
    '4. SPECIFIKIMI SKEDAR MË SKEDAR',
    '5. DEFINITION OF DONE'
  ].join('\n');
  const noFilesRes = validatePlanOutput(noFilesPlan, { requiresFiles: true });
  assert.equal(noFilesRes.ok, false);
  assert.ok(noFilesRes.missing.includes('file_target'));

  // Valid plan
  const validPlan = [
    '# PLANI ARKITEKTUROR TEKNIK',
    '1. OBJEKTIVAT DHE NON-GOALS: Ekstraktim modular pa humbje kodi.',
    '2. ENTRY POINT DHE ROOT CAUSE: Ndarja e mcp/server.js ne module te pavarura.',
    '3. ALLOWED_FILES:',
    'FILE_TARGET: mcp/engines/google_search_engine.js',
    'FILE_TARGET: tests/contract.test.js',
    '4. SPECIFIKIMI SKEDAR MË SKEDAR:',
    'Detajet e implementimit skedar me skedar per cdo target.',
    '5. DEFINITION OF DONE & HARDENING:',
    'Verifikim me 100% teste te kaluara dhe auditim te plote.'
  ].join('\n');
  const validRes = validatePlanOutput(validPlan, { requiresFiles: true });
  assert.equal(validRes.ok, true);
  assert.deepEqual(validRes.targets, ['mcp/engines/google_search_engine.js', 'tests/contract.test.js']);
  assert.equal(validRes.reason, '');
});

test('classifyAttachmentHandshake classifies responses and errors correctly', () => {
  // Positive confirmation
  const ok1 = classifyAttachmentHandshake('OK, e lexova dhe jam gati.');
  assert.equal(ok1.class, 'HANDSHAKE_ACCEPTED');
  assert.equal(ok1.code, 'SEARCH_AI_ATTACHMENT_HANDSHAKE_ACCEPTED');

  const ok2 = classifyAttachmentHandshake('File received and ready to proceed.');
  assert.equal(ok2.class, 'HANDSHAKE_ACCEPTED');

  // Unverified
  const unverified = classifyAttachmentHandshake('Something else completely unrelated');
  assert.equal(ok1.class, 'HANDSHAKE_ACCEPTED');
  assert.equal(unverified.class, 'INVALID_HANDSHAKE');
  assert.equal(unverified.code, 'SEARCH_AI_ATTACHMENT_HANDSHAKE_UNVERIFIED');

  // Payload rejected / oversized
  const payloadErr = classifyAttachmentHandshake('The uploaded file could not be processed because it is too large');
  assert.equal(payloadErr.class, 'PAYLOAD_REJECTED');
  assert.equal(payloadErr.code, 'WEB_PAYLOAD_REJECTED_OR_OVERSIZED');
  assert.equal(payloadErr.retryable, true);

  // Quota error
  const quotaErr = classifyAttachmentHandshake('Usage limit reached for today. Upgrade your plan.');
  assert.equal(quotaErr.class, 'QUOTA_OR_LIMIT_ERROR');
  assert.equal(quotaErr.code, 'WEB_QUOTA_OR_LIMIT_ERROR');

  // Policy refusal
  const policyErr = classifyAttachmentHandshake('I cannot help with that request.');
  assert.equal(policyErr.class, 'POLICY_REFUSAL');
  assert.equal(policyErr.code, 'WEB_POLICY_REFUSAL');
});

test('classifySearchAiNoResponse evaluates mock page states', async () => {
  // Mock page with captcha
  const mockCaptchaPage = {
    evaluate: async () => ({
      captcha: true,
      noResponse: false,
      service: false,
      retry: false
    })
  };
  assert.equal(await classifySearchAiNoResponse(mockCaptchaPage), 'SEARCH_AI_CAPTCHA_REQUIRED');

  // Mock page with service error
  const mockServicePage = {
    evaluate: async () => ({
      captcha: false,
      noResponse: false,
      service: true,
      retry: false
    })
  };
  assert.equal(await classifySearchAiNoResponse(mockServicePage), 'SEARCH_AI_SERVICE_ERROR');

  // Mock page with no response
  const mockNoRespPage = {
    evaluate: async () => ({
      captcha: false,
      noResponse: true,
      service: false,
      retry: false
    })
  };
  assert.equal(await classifySearchAiNoResponse(mockNoRespPage), 'SEARCH_AI_NO_RESPONSE_AVAILABLE');

  // Mock page with blank turn
  const mockTimeoutPage = {
    evaluate: async () => ({
      captcha: false,
      noResponse: false,
      service: false,
      retry: false
    })
  };
  assert.equal(await classifySearchAiNoResponse(mockTimeoutPage, { assistantTurnExists: true }), 'SEARCH_AI_BLANK_ASSISTANT_TURN');
  assert.equal(await classifySearchAiNoResponse(mockTimeoutPage, { assistantTurnExists: false }), 'SEARCH_AI_RESPONSE_TIMEOUT');
});
