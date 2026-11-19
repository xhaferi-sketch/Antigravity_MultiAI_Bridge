'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');
const { spawnSync } = require('node:child_process');

const {
  createLocalExecutor,
  redactDiagnosticSecrets,
  boundedDiagnosticExcerpt,
  freshProjectErrorLog
} = require('../../../mcp/pipeline/local_executor.js');

test('quick check validates JS and JSON files correctly', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'check-test-'));
  try {
    const validJs = path.join(tmpDir, 'valid.js');
    fs.writeFileSync(validJs, 'const a = 1; module.exports = a;', 'utf8');

    const validJson = path.join(tmpDir, 'valid.json');
    fs.writeFileSync(validJson, JSON.stringify({ key: 'val' }), 'utf8');

    const executor = createLocalExecutor({ fs, path, crypto, spawnSync });
    const res = executor.runBatchQuickChecks({
      projectRoot: tmpDir,
      writtenFiles: ['valid.js', 'valid.json']
    });

    assert.equal(res.status, 'CHECK_PASSED');
    assert.equal(res.receipts.length, 2);

    // Invalid JSON check
    const invalidJson = path.join(tmpDir, 'invalid.json');
    fs.writeFileSync(invalidJson, '{ broken json', 'utf8');
    const badRes = executor.runBatchQuickChecks({
      projectRoot: tmpDir,
      writtenFiles: ['invalid.json']
    });
    assert.equal(badRes.status, 'CHECK_FAILED');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('redactDiagnosticSecrets strips tokens, passwords, authorization headers', () => {
  const raw = 'Authorization: Bearer secret_token_xyz API_KEY=abcdef12345 Password=supersecret';
  const redacted = redactDiagnosticSecrets(raw);
  assert.ok(!redacted.includes('secret_token_xyz'));
  assert.ok(!redacted.includes('abcdef12345'));
  assert.ok(!redacted.includes('supersecret'));
  assert.ok(redacted.includes('[REDACTED]'));
});

test('boundedDiagnosticExcerpt truncates large diagnostic output safely', () => {
  const largeOutput = 'error: something failed\n' + 'a'.repeat(30000);
  const excerpt = boundedDiagnosticExcerpt(largeOutput, 24000);
  assert.equal(excerpt.truncated, true);
  assert.ok(Buffer.byteLength(excerpt.text, 'utf8') <= 30000);
  assert.ok(excerpt.text.includes('[DIAGNOSTIC_TRUNCATED]'));
});

test('freshProjectErrorLog rejects out-of-root and stale files', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'err-log-test-'));
  try {
    const errorFile = path.join(tmpDir, 'errors.log');
    fs.writeFileSync(errorFile, 'Sample error output', 'utf8');

    // Fresh error log
    const content = freshProjectErrorLog(tmpDir, Date.now() - 5000, fs);
    assert.equal(content, 'Sample error output');

    // Stale error log (started after file was written)
    const stale = freshProjectErrorLog(tmpDir, Date.now() + 5000, fs);
    assert.equal(stale, null);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
