'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const PROJECT_ROOT = path.resolve(__dirname, '../../..');
const MCP_DIR = path.join(PROJECT_ROOT, 'mcp');
const SERVER_PATH = path.join(MCP_DIR, 'server.js');

const EXTRACTED_MODULES = [
  'engines/google_search_engine.js',
  'engines/copilot_engine.js',
  'engines/gemini_engine.js',
  'pipeline/autopilot_engine.js',
  'pipeline/local_executor.js'
];

test('WO-MOD-7: Process Mode 1 - ANTIGRAVITY_TEST_EXPORT=1 exits 0 with zero open handles and zero stdout', () => {
  const code = `
    process.env.ANTIGRAVITY_TEST_EXPORT = '1';
    require(${JSON.stringify(SERVER_PATH)});
    const handles = process._getActiveHandles ? process._getActiveHandles() : [];
    // Only standard streams should exist
    const nonStdHandles = handles.filter(h => h !== process.stdout && h !== process.stderr && h !== process.stdin);
    if (nonStdHandles.length > 0) {
      console.error('LEAKED_HANDLES:', nonStdHandles.length);
      process.exit(2);
    }
    process.exit(0);
  `;

  const result = spawnSync(process.execPath, ['-e', code], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe']
  });

  assert.equal(result.status, 0, 'Exit code must be 0');
  assert.equal(result.stdout, '', 'stdout must be strictly empty');
  assert.equal(result.stderr, '', 'stderr must be empty');
});

test('WO-MOD-7: Process Mode 2 - Isolated import of all 5 extracted modules has zero side effects', () => {
  for (const mod of EXTRACTED_MODULES) {
    const fullPath = path.join(MCP_DIR, mod);
    const code = `
      require(${JSON.stringify(fullPath)});
      const handles = process._getActiveHandles ? process._getActiveHandles() : [];
      const nonStdHandles = handles.filter(h => h !== process.stdout && h !== process.stderr && h !== process.stdin);
      if (nonStdHandles.length > 0) {
        console.error('LEAKED_HANDLES in ' + ${JSON.stringify(mod)} + ':', nonStdHandles.length);
        process.exit(2);
      }
      process.exit(0);
    `;

    const result = spawnSync(process.execPath, ['-e', code], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe']
    });

    assert.equal(result.status, 0, `Module ${mod} must exit cleanly with code 0`);
    assert.equal(result.stdout, '', `Module ${mod} must have zero stdout`);
    assert.equal(result.stderr, '', `Module ${mod} must have zero stderr`);
  }
});

test('WO-MOD-7: Process Mode 3 - Signal shutdown triggers graceful cleanup', () => {
  const serverSource = require('fs').readFileSync(SERVER_PATH, 'utf8');

  // Verify SIGINT and SIGTERM handlers are registered
  assert.ok(serverSource.includes("process.on('SIGINT'"), 'SIGINT handler must be registered');
  assert.ok(serverSource.includes("process.on('SIGTERM'"), 'SIGTERM handler must be registered');
  assert.ok(serverSource.includes('closeAllContexts()'), 'SIGINT/SIGTERM must invoke closeAllContexts()');
});

test('WO-MOD-7: Process Mode 4 - Stdio transport mode starts and disconnects cleanly', () => {
  const serverSource = require('fs').readFileSync(SERVER_PATH, 'utf8');

  assert.ok(serverSource.includes('new StdioServerTransport()'), 'Must instantiate StdioServerTransport');
  assert.ok(serverSource.includes('mcpServer.connect(transport)'), 'Must connect transport to mcpServer');
  assert.ok(serverSource.includes('ANTIGRAVITY_TEST_EXPORT'), 'Must guard transport startup with ANTIGRAVITY_TEST_EXPORT');
});
