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
