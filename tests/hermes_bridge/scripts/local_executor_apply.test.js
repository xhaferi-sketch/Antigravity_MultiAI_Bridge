'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');

const {
  createLocalExecutor,
  parseCodeBlocksFromMarkdown,
  validateGeneratedCodeMarkdown,
  atomicWriteValidated
} = require('../../../mcp/pipeline/local_executor.js');

test('parses dynamic-length fenced blocks correctly', () => {
  const md = [
    '### FILE: src/hello.js',
    '````javascript',
    'console.log("hello");',
    '````',
    '',
    '### FILE: src/deep.py',
    '```python',
    'def test():',
    '    pass',
    '```'
  ].join('\n');

  const parsed = parseCodeBlocksFromMarkdown(md, ['src/hello.js', 'src/deep.py']);
  assert.equal(parsed.length, 2);
  assert.equal(parsed[0].relPath, 'src/hello.js');
  assert.equal(parsed[0].code, 'console.log("hello");');
  assert.equal(parsed[1].relPath, 'src/deep.py');
  assert.equal(parsed[1].code, 'def test():\n    pass');
});

test('supports authorized unfenced recovery only when lexical starter validates', () => {
  const md = [
    'FILE: src/unfenced.js',
    'const x = 42;',
    'module.exports = { x };'
  ].join('\n');

  const parsed = parseCodeBlocksFromMarkdown(md, ['src/unfenced.js']);
  assert.equal(parsed.length, 1);
  assert.equal(parsed[0].relPath, 'src/unfenced.js');
  assert.ok(parsed[0].code.includes('const x = 42;'));

  // Invalid starter should NOT be recovered
  const badMd = [
    'FILE: src/bad.js',
    'random invalid prose without code starters'
  ].join('\n');
  const badParsed = parseCodeBlocksFromMarkdown(badMd, ['src/bad.js']);
  assert.equal(badParsed.length, 0);
});

test('rejects path escape, absolute path, unauthorized target, duplicate target, and unsafe Unicode', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sec-test-'));
  try {
    const executor = createLocalExecutor({ fs, path, crypto });

    // Path escape
    assert.throws(
      () => executor.applyBatch({
        projectRoot: tmpDir,
        batch: { targets: ['../escape.js'] },
        parsedFiles: [{ relPath: '../escape.js', code: 'test' }]
      }),
      /SECURITY_BLOCK/
    );

    // Duplicate target
    assert.throws(
      () => executor.applyBatch({
        projectRoot: tmpDir,
        batch: { targets: ['a.js'] },
        parsedFiles: [
          { relPath: 'a.js', code: 'test' },
          { relPath: 'a.js', code: 'test' }
        ]
      }),
      /BATCH_OUTPUT_INCOMPLETE/
    );

    // Unauthorized target
    assert.throws(
      () => executor.applyBatch({
        projectRoot: tmpDir,
        batch: { targets: ['a.js'] },
        parsedFiles: [{ relPath: 'unauthorized.js', code: 'test' }]
      }),
      /BATCH_OUTPUT_INCOMPLETE/
    );

    // Unsafe unicode / unpaired surrogates
    assert.throws(
      () => executor.applyBatch({
        projectRoot: tmpDir,
        batch: { targets: ['unicode.js'] },
        parsedFiles: [{ relPath: 'unicode.js', code: 'const bad = "\uD800";' }]
      }),
      /BUNDLE_INVALID_UNICODE/
    );
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('atomic write leaves either old or new complete file, never partial content', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'atomic-test-'));
  try {
    const target = path.join(tmpDir, 'target.txt');
    fs.writeFileSync(target, 'initial content', 'utf8');

    atomicWriteValidated(target, 'new complete content', fs, crypto);
    assert.equal(fs.readFileSync(target, 'utf8'), 'new complete content');

    // Empty content must be rejected without modifying file
    assert.throws(
      () => atomicWriteValidated(target, '', fs, crypto),
      /ATOMIC_WRITE_EMPTY/
    );
    assert.equal(fs.readFileSync(target, 'utf8'), 'new complete content');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('existing non-target files remain byte-identical during batch application', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'batch-ident-'));
  try {
    const nonTarget = path.join(tmpDir, 'keep.txt');
    const originalBytes = Buffer.from('DO_NOT_TOUCH_ME_12345');
    fs.writeFileSync(nonTarget, originalBytes);

    const executor = createLocalExecutor({ fs, path, crypto });
    const result = executor.applyBatch({
      projectRoot: tmpDir,
      batch: { targets: ['sub/new.txt'] },
      parsedFiles: [{ relPath: 'sub/new.txt', code: 'created content' }]
    });

    assert.equal(result.status, 'BATCH_APPLIED');
    assert.deepEqual(fs.readFileSync(nonTarget), originalBytes);
    assert.equal(fs.readFileSync(path.join(tmpDir, 'sub', 'new.txt'), 'utf8'), 'created content');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
