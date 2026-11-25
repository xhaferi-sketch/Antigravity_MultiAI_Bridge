'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');

process.env.ANTIGRAVITY_TEST_EXPORT = '1';
const server = require(path.join(__dirname, '..', 'server.js'));

test('Gemini routeIsClean accepts /app and /u/<n>/app when empty, rejects /app/<id> or non-empty turns', () => {
  const { gemini } = server.WEB_ENGINE_ADAPTERS;
  assert.equal(gemini.routeIsClean({ url: 'https://gemini.google.com/app', users: 0, assistants: 0 }), true);
  assert.equal(gemini.routeIsClean({ url: 'https://gemini.google.com/app/', users: 0, assistants: 0 }), true);
  assert.equal(gemini.routeIsClean({ url: 'https://gemini.google.com/u/1/app', users: 0, assistants: 0 }), true);
  assert.equal(gemini.routeIsClean({ url: 'https://gemini.google.com/u/0/app?hl=sq', users: 0, assistants: 0 }), true);
  assert.equal(gemini.routeIsClean({ url: 'https://gemini.google.com/app/c3d23e12d085a5d2', users: 0, assistants: 0 }), false);
  assert.equal(gemini.routeIsClean({ url: 'https://gemini.google.com/u/1/app/c3d23e12d085a5d2', users: 0, assistants: 0 }), false);
  assert.equal(gemini.routeIsClean({ url: 'https://gemini.google.com/app', users: 1, assistants: 0 }), false);
  assert.equal(gemini.routeIsClean({ url: 'https://accounts.google.com/v3/signin', users: 0, assistants: 0 }), false);
});

test('conversationIdFromUrl extracts conversation ID from both /app/<id> and /u/<n>/app/<id>', () => {
  assert.equal(server.conversationIdFromUrl('https://gemini.google.com/app'), '');
  assert.equal(server.conversationIdFromUrl('https://gemini.google.com/u/1/app'), '');
  assert.equal(server.conversationIdFromUrl('https://gemini.google.com/app/abc123def'), 'abc123def');
  assert.equal(server.conversationIdFromUrl('https://gemini.google.com/u/2/app/abc123def'), 'abc123def');
});

test('server.js resetChatVerified excludes UI button chips, supports Albanian reset, and captures support evidence', () => {
  const fs = require('node:fs');
  const src = fs.readFileSync(path.join(__dirname, '..', 'server.js'), 'utf8');
  assert.match(src, /Bisedë e re/);
  assert.match(src, /!el\.matches\('button,\[role="button"\],input'\)/);
  assert.match(src, /method:'ALREADY_CLEAN'/);
  assert.match(src, /captureSupportEvidence\(page,projectRoot,tabKey,'CHAT_RESET_VERIFICATION_FAILED'/);
});
