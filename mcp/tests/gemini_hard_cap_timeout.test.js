'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const geminiEngine = require('../engines/gemini_engine');
const {
  resolveGeminiHardCapMs,
  runGeminiAttachmentIngestHandshake,
  createGeminiEngine,
  DEFAULT_STANDARD_HARD_CAP_MS,
  HIGH_REASONING_HARD_CAP_MS
} = geminiEngine;

test('DoD-1: resolves 240000 ms for pro_31, Neon High, and explicit high reasoning tiers', () => {
  assert.equal(DEFAULT_STANDARD_HARD_CAP_MS, 65000);
  assert.equal(HIGH_REASONING_HARD_CAP_MS, 240000);

  assert.equal(resolveGeminiHardCapMs({ modelTier: 'pro_31' }), 240000);
  assert.equal(resolveGeminiHardCapMs({ modelTier: 'neon', reasoningLevel: 'high' }), 240000);
  assert.equal(resolveGeminiHardCapMs({ modelTier: '4_neon', reasoningLevel: 'high' }), 240000);
  assert.equal(resolveGeminiHardCapMs({ modelTier: 'neon_4', reasoningLevel: 'high' }), 240000);
  assert.equal(resolveGeminiHardCapMs({ modelTier: 'auto', reasoningLevel: 'high' }), 240000);
  assert.equal(resolveGeminiHardCapMs({ modelTier: undefined, reasoningLevel: 'high' }), 240000);
  assert.equal(resolveGeminiHardCapMs({ modelTier: 'neon_high' }), 240000);
  assert.equal(resolveGeminiHardCapMs({ modelTier: 'argon_high' }), 240000);
  assert.equal(resolveGeminiHardCapMs({ modelTier: 'high_reasoning' }), 240000);
  assert.equal(resolveGeminiHardCapMs({ reasoningLevel: 'extra_thorough' }), 240000);
  assert.equal(resolveGeminiHardCapMs({ reasoningLevel: 'extra thorough' }), 240000);

  assert.equal(resolveGeminiHardCapMs({ activeModel: '4 Neon · High' }), 240000);
  assert.equal(resolveGeminiHardCapMs({ activeModel: '4 Neon High (Extra thorough)' }), 240000);
  assert.equal(resolveGeminiHardCapMs({ activeModel: '4 Neon (High)' }), 240000);
  assert.equal(resolveGeminiHardCapMs({ activeModel: '4 Argon · High (Extra thorough)' }), 240000);

  assert.equal(resolveGeminiHardCapMs({ modelTier: 'neon', reasoningLevel: 'low' }), 65000);
  assert.equal(resolveGeminiHardCapMs({ activeModel: '4 Neon · High', reasoningLevel: 'low' }), 65000);
  assert.equal(resolveGeminiHardCapMs({ modelTier: 'flash' }), 65000);
  assert.equal(resolveGeminiHardCapMs({ modelTier: 'standard' }), 65000);
  assert.equal(resolveGeminiHardCapMs({ modelTier: 'default' }), 65000);
  assert.equal(resolveGeminiHardCapMs({}), 65000);
});

test('DoD-2: honors valid explicit numeric hardCapMs overrides and ignores invalid boundary values', () => {
  assert.equal(resolveGeminiHardCapMs({ hardCapMs: 300000 }), 300000);
  assert.equal(resolveGeminiHardCapMs({ hardCapMs: 5000, modelTier: 'neon', reasoningLevel: 'high' }), 5000);
  assert.equal(resolveGeminiHardCapMs({ hardCapMs: 240000.9 }), 240000);
  assert.equal(resolveGeminiHardCapMs({ hardCapMs: 240000.7 }), 240000);

  const invalidHardCaps = [0, -1, -65000, 0.5, NaN, Infinity, -Infinity, '240000', null, undefined];
  for (const invalidValue of invalidHardCaps) {
    assert.equal(
      resolveGeminiHardCapMs({ hardCapMs: invalidValue, modelTier: 'neon', reasoningLevel: 'high' }),
      240000,
      `Expected fallback 240000 for invalid hardCapMs=${String(invalidValue)} with high reasoning`
    );
  }

  assert.equal(resolveGeminiHardCapMs({ hardCapMs: NaN }), 65000);
  assert.equal(resolveGeminiHardCapMs({ hardCapMs: 0 }), 65000);
  assert.equal(resolveGeminiHardCapMs({ hardCapMs: -100 }), 65000);
});

test('DoD-3: handles null/empty/non-object inputs, case normalization, and Unicode NFKC safely', () => {
  assert.equal(resolveGeminiHardCapMs(), 65000);
  assert.equal(resolveGeminiHardCapMs(null), 65000);
  assert.equal(resolveGeminiHardCapMs(undefined), 65000);
  assert.equal(resolveGeminiHardCapMs('neon'), 65000);
  assert.equal(resolveGeminiHardCapMs(12345), 65000);
  assert.equal(resolveGeminiHardCapMs({ modelTier: null, reasoningLevel: '' }), 65000);

  assert.equal(resolveGeminiHardCapMs({ reasoningLevel: 'HIGH' }), 240000);
  assert.equal(resolveGeminiHardCapMs({ reasoningLevel: ' High ' }), 240000);
  assert.equal(resolveGeminiHardCapMs({ reasoningLevel: 'ＨＩＧＨ' }), 240000);

  assert.equal(resolveGeminiHardCapMs({ modelTier: 'PRO_31' }), 240000);
  assert.equal(resolveGeminiHardCapMs({ modelTier: '  Neon_High  ' }), 240000);
  assert.equal(resolveGeminiHardCapMs({ thinkingLevel: 'high' }), 240000);

  assert.equal(resolveGeminiHardCapMs({ activeModel: '4 Neon · Low (Fast)' }), 65000);
  assert.equal(resolveGeminiHardCapMs({ activeModel: '4 Neon Flash High' }), 65000);
});

test('DoD-4: static anti-regression invariant removes pro_31 binary hardcoding and wires resolveGeminiHardCapMs', () => {
  const engineFilePath = path.resolve(__dirname, '..', 'engines', 'gemini_engine.js');
  const source = fs.readFileSync(engineFilePath, 'utf8');

  assert.doesNotMatch(
    source,
    /modelTier\s*===\s*['"]pro_31['"]\s*\?\s*240000\s*:\s*65000/,
    'Legacy binary pro_31 hardCapMs ternary must be removed'
  );

  const invocationMatches = source.match(/(?<!function\s)resolveGeminiHardCapMs\s*\(/g) || [];
  assert.ok(
    invocationMatches.length >= 1,
    'resolveGeminiHardCapMs must be actively invoked in mcp/engines/gemini_engine.js'
  );
});

test('DoD-5: isolated handshake integration preserves 240000 ms deadline past 65s for Neon High and stays isolated across tabs', async () => {
  const observedDispatches = [];
  const simulatedWaitElapsedMs = 70000;

  async function mockDispatcher(payload) {
    observedDispatches.push(payload);
    if (simulatedWaitElapsedMs > payload.hardCapMs) {
      throw new Error(
        `GEMINI_HARD_CAP_TIMEOUT elapsedMs=${simulatedWaitElapsedMs} deadlineMs=${payload.hardCapMs} route=/app users=1 assistants=1`
      );
    }
    return 'Skedari u lexua plotësisht dhe jam gati.';
  }

  const highResult = await runGeminiAttachmentIngestHandshake({
    tabKey: 'gemini2',
    projectRoot: '/tmp/project',
    attachmentPath: '/tmp/project/batch_BATCH_3_ctx.txt',
    batchId: 'BATCH_3',
    modelTier: 'neon',
    reasoningLevel: 'high',
    dispatchToWebTab: mockDispatcher
  });

  assert.equal(highResult.status, 'VERIFIED');
  assert.equal(observedDispatches[0].hardCapMs, 240000);
  assert.equal(observedDispatches[0].reasoningLevel, 'high');
  assert.equal(observedDispatches[0].modelTier, 'neon');

  await assert.rejects(
    () => runGeminiAttachmentIngestHandshake({
      tabKey: 'gemini2',
      projectRoot: '/tmp/project',
      attachmentPath: '/tmp/project/batch_BATCH_3_ctx.txt',
      batchId: 'BATCH_3',
      modelTier: 'neon',
      reasoningLevel: 'low',
      dispatchToWebTab: mockDispatcher
    }),
    /GEMINI_HARD_CAP_TIMEOUT elapsedMs=70000 deadlineMs=65000/
  );

  const engineDispatches = [];
  const engine = createGeminiEngine({
    tabActiveModel: {
      gemini1: '4 Neon (High)',
      gemini2: '4 Neon (High)',
      gemini3: '-'
    },
    dispatchToWebTab: async (payload) => {
      engineDispatches.push(payload);
      return 'OK, e lexova dhe jam gati.';
    }
  });

  const [r1, r2, r3] = await Promise.all([
    engine.runGeminiAttachmentIngestHandshake({
      tabKey: 'gemini1',
      projectRoot: '/tmp/project',
      attachmentPath: '/tmp/project/a.txt',
      modelTier: 'neon'
    }),
    engine.runGeminiAttachmentIngestHandshake({
      tabKey: 'gemini2',
      projectRoot: '/tmp/project',
      attachmentPath: '/tmp/project/b.txt',
      modelTier: 'neon',
      reasoningLevel: 'low'
    }),
    engine.runGeminiAttachmentIngestHandshake({
      tabKey: 'gemini3',
      projectRoot: '/tmp/project',
      attachmentPath: '/tmp/project/c.txt',
      modelTier: 'neon',
      hardCapMs: 5000
    })
  ]);

  assert.equal(r1.status, 'VERIFIED');
  assert.equal(r2.status, 'VERIFIED');
  assert.equal(r3.status, 'VERIFIED');

  const byTab = new Map(engineDispatches.map((d) => [d.tabKey, d]));
  assert.equal(byTab.get('gemini1').hardCapMs, 240000);
  assert.equal(byTab.get('gemini2').hardCapMs, 65000);
  assert.equal(byTab.get('gemini3').hardCapMs, 5000);
});