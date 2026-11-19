'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const { spawnSync } = require('node:child_process');

const PROJECT_ROOT = path.resolve(__dirname, '../../..');
const SERVER_PATH = path.join(PROJECT_ROOT, 'mcp', 'server.js');
const EXECUTOR_PATH = path.join(PROJECT_ROOT, 'mcp', 'pipeline', 'local_executor.js');

const {
  redactDiagnosticSecrets,
  boundedDiagnosticExcerpt
} = require(EXECUTOR_PATH);

test('WO-MOD-6: MCP Transport - Zero stdout pollution under ANTIGRAVITY_TEST_EXPORT=1', () => {
  const code = `
    process.env.ANTIGRAVITY_TEST_EXPORT = '1';
    require(${JSON.stringify(SERVER_PATH)});
  `;
  const result = spawnSync(process.execPath, ['-e', code], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe']
  });

  assert.equal(result.status, 0, 'Must exit with code 0');
  assert.equal(result.stdout, '', 'stdout must be strictly empty on import under ANTIGRAVITY_TEST_EXPORT=1');
  assert.ok(!result.stderr.includes('[STANDALONE MODE]'), 'stderr must not contain standalone banner when ANTIGRAVITY_TEST_EXPORT=1');
});

test('WO-MOD-6: MCP Transport - Secret and credential redaction across diagnostics', () => {
  const sensitivePayload = [
    'Authorization: Bearer sk-ant-api03-secret1234567890abcdef',
    'Authorization: Basic dXNlcjpwYXNzd29yZA==',
    'api_key = AIzaSyD-secret-key-google-here',
    'token: ghp_githubPersonalAccessToken12345',
    'password = MySuperSecretPassword123!',
    'secret: confidential-internal-secret-value'
  ].join('\n');

  const redacted = redactDiagnosticSecrets(sensitivePayload);

  assert.ok(!redacted.includes('sk-ant-api03-secret1234567890abcdef'), 'Bearer token must be redacted');
  assert.ok(!redacted.includes('AIzaSyD-secret-key-google-here'), 'API key must be redacted');
  assert.ok(!redacted.includes('ghp_githubPersonalAccessToken12345'), 'Token must be redacted');
  assert.ok(!redacted.includes('MySuperSecretPassword123!'), 'Password must be redacted');
  assert.ok(!redacted.includes('confidential-internal-secret-value'), 'Secret must be redacted');
  assert.ok(redacted.includes('[REDACTED]'), 'Must replace with [REDACTED]');
});

test('WO-MOD-6: MCP Transport - Diagnostic output bounded without altering return contract', () => {
  const hugeDiagnostic = 'Error: Stack trace line\n' + 'at Function.run (/root/app.js:10:5)\n'.repeat(2000);
  assert.ok(hugeDiagnostic.length > 50000, 'Payload is oversized');

  const bounded = boundedDiagnosticExcerpt(hugeDiagnostic, 24000);

  assert.equal(bounded.truncated, true);
  assert.ok(Buffer.byteLength(bounded.text, 'utf8') <= 30000, 'Must be safely bounded');
  assert.ok(bounded.text.includes('[DIAGNOSTIC_TRUNCATED]'), 'Must indicate truncation');
});

test('WO-MOD-6: MCP Transport - Stdio transport separates protocol from logging', () => {
  // Verifies that StdioServerTransport is configured for stdin/stdout and logging uses stderr
  const serverSource = fs.readFileSync(SERVER_PATH, 'utf8');

  // StdioServerTransport must be required from official SDK
  assert.ok(serverSource.includes('@modelcontextprotocol/sdk/server/stdio.js'), 'Must use official stdio transport');
  assert.ok(serverSource.includes('new StdioServerTransport()'), 'Must instantiate StdioServerTransport');

  // Verify that standalone banners or logs write to console.error, never console.log
  assert.ok(!serverSource.includes("console.log('[STANDALONE MODE]"), 'Standalone banner must never write to stdout');
  assert.ok(serverSource.includes("console.error('[STANDALONE MODE]"), 'Standalone banner must write to stderr');
});
