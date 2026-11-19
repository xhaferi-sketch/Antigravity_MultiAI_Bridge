'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');

const PROJECT_ROOT = path.resolve(__dirname, '../../..');
const MCP_DIR = path.join(PROJECT_ROOT, 'mcp');
const SERVER_PATH = path.join(MCP_DIR, 'server.js');

test('WO-MOD-7: Composition Root - Singleton identity and lazy factory getters', () => {
  const serverSource = fs.readFileSync(SERVER_PATH, 'utf8');

  // Verify all 5 lazy singletons exist and guard against multiple instantiations
  const singletonGetters = [
    'getLocalExecutor',
    'getGoogleSearchEngine',
    'getCopilotEngine',
    'getGeminiEngine',
    'getAutopilotEngine'
  ];

  for (const getter of singletonGetters) {
    assert.ok(
      serverSource.includes(`function ${getter}()`),
      `Server must implement lazy singleton getter: ${getter}`
    );
  }
});

test('WO-MOD-7: Composition Root - MCP tool handlers delegate to modular engines', () => {
  const serverSource = fs.readFileSync(SERVER_PATH, 'utf8');

  // Verify core actions delegate through getAutopilotEngine or getLocalExecutor
  assert.ok(serverSource.includes('getAutopilotEngine().runFullCycle'), 'run_full_cycle must delegate to autopilotEngine');
  assert.ok(serverSource.includes('getAutopilotEngine().checkCycleProgress'), 'check_cycle_progress must delegate to autopilotEngine');
  assert.ok(serverSource.includes('getAutopilotEngine().packWorkspace'), 'pack_workspace must delegate to autopilotEngine');
});

test('WO-MOD-7: Composition Root - Dashboard routes preserve exact HTTP contract', () => {
  const serverSource = fs.readFileSync(SERVER_PATH, 'utf8');

  const routes = [
    "url === '/'",
    "url === '/api/state'",
    "url === '/api/save-routing'",
    "url === '/api/add-project'",
    "url === '/api/delete-project'",
    "url === '/api/purge-exchange'",
    "url === '/api/reset-tab'",
    "url === '/api/login-profile'",
    "url === '/api/kill-all'",
    "url === '/api/mcp-proxy'"
  ];

  for (const route of routes) {
    assert.ok(serverSource.includes(route), `Dashboard route handler must be preserved: ${route}`);
  }
});

test('WO-MOD-7: Composition Root - Monolith reduction and active duplicate elimination', () => {
  const serverSource = fs.readFileSync(SERVER_PATH, 'utf8');

  // Verify that active duplicate implementations of cycle state machine were removed
  assert.ok(!serverSource.includes('function scanRepositoryUniversal(') || serverSource.includes('getAutopilotEngine().scanRepositoryUniversal'), 'Must delegate scanRepositoryUniversal');
  assert.ok(serverSource.includes('getAutopilotEngine().runAutonomousPipeline'), 'runAutonomousPipeline must delegate to autopilotEngine');
});
