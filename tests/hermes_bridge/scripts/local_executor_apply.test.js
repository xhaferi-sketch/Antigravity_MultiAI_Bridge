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

test('applies authorized unified diff with git apply and preserves rollback backups', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'patch-apply-'));
  try {
    fs.writeFileSync(path.join(tmpDir, 'target.js'), 'module.exports = 1;\n', 'utf8');
    require('node:child_process').execFileSync('git', ['init', '-q'], { cwd: tmpDir });
    require('node:child_process').execFileSync('git', ['add', 'target.js'], { cwd: tmpDir });
    require('node:child_process').execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'base'], { cwd: tmpDir });
    const patch = [
      'diff --git a/target.js b/target.js',
      '--- a/target.js',
      '+++ b/target.js',
      '@@ -1 +1 @@',
      '-module.exports = 1;',
      '+module.exports = 2;',
      ''
    ].join('\n');
    const executor = createLocalExecutor({ fs, path, crypto });
    const result = executor.applyBatch({ projectRoot: tmpDir, batch: { targets: ['target.js'] }, parsedFiles: [], batchOutput: patch });
    assert.equal(result.status, 'BATCH_APPLIED');
    assert.deepEqual(result.filesWritten, ['target.js']);
    assert.equal(fs.readFileSync(path.join(tmpDir, 'target.js'), 'utf8').replace(/\r\n/g, '\n'), 'module.exports = 2;\n');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('rejects unauthorized patch targets before git apply', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'patch-auth-'));
  try {
    fs.writeFileSync(path.join(tmpDir, 'other.js'), 'module.exports = 1;\n', 'utf8');
    require('node:child_process').execFileSync('git', ['init', '-q'], { cwd: tmpDir });
    const patch = 'diff --git a/other.js b/other.js\n--- a/other.js\n+++ b/other.js\n@@ -1 +1 @@\n-module.exports = 1;\n+module.exports = 2;\n';
    const executor = createLocalExecutor({ fs, path, crypto });
    assert.throws(() => executor.applyBatch({ projectRoot: tmpDir, batch: { targets: ['target.js'] }, parsedFiles: [], batchOutput: patch }), /PATCH_TARGET_UNAUTHORIZED/);
    assert.equal(fs.readFileSync(path.join(tmpDir, 'other.js'), 'utf8'), 'module.exports = 1;\n');
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
test('rejects path traversal and absolute path targets in unified diff patch', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'patch-sec-'));
  try {
    const traversalPatch = 'diff --git a/../escape.js b/../escape.js\n--- a/../escape.js\n+++ b/../escape.js\n@@ -1 +1 @@\n-a\n+b\n';
    const executor = createLocalExecutor({ fs, path, crypto });
    assert.throws(() => executor.applyBatch({ projectRoot: tmpDir, batch: { targets: ['../escape.js'] }, parsedFiles: [], batchOutput: traversalPatch }), /(SECURITY_BLOCK|PATCH_TARGET_UNAUTHORIZED)/);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('rollback restores original files byte-for-byte on git apply failure', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'patch-rollback-'));
  try {
    const originalContent = 'const x = "original_content";\n';
    fs.writeFileSync(path.join(tmpDir, 'target.js'), originalContent, 'utf8');
    require('node:child_process').execFileSync('git', ['init', '-q'], { cwd: tmpDir });
    require('node:child_process').execFileSync('git', ['add', 'target.js'], { cwd: tmpDir });
    require('node:child_process').execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'base'], { cwd: tmpDir });

    // Intentionally bad hunk that fails to apply against original
    const corruptedPatch = [
      'diff --git a/target.js b/target.js',
      '--- a/target.js',
      '+++ b/target.js',
      '@@ -1,1 +1,1 @@',
      '-const x = "does_not_exist";',
      '+const x = "mutated";',
      ''
    ].join('\n');
    const executor = createLocalExecutor({ fs, path, crypto });
    assert.throws(() => executor.applyBatch({ projectRoot: tmpDir, batch: { targets: ['target.js'] }, parsedFiles: [], batchOutput: corruptedPatch }), /(GIT_APPLY_CHECK_FAILED|GIT_APPLY_FAILED)/);
    // Verified byte-for-byte rollback
    assert.equal(fs.readFileSync(path.join(tmpDir, 'target.js'), 'utf8'), originalContent);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('non-target files remain strictly byte-identical during patch application', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'patch-nontarget-'));
  try {
    const untouchedContent = 'const UNTOUCHED = 42;\n';
    fs.writeFileSync(path.join(tmpDir, 'target.js'), 'const a = 1;\n', 'utf8');
    fs.writeFileSync(path.join(tmpDir, 'untouched.js'), untouchedContent, 'utf8');
    require('node:child_process').execFileSync('git', ['init', '-q'], { cwd: tmpDir });
    require('node:child_process').execFileSync('git', ['add', '.'], { cwd: tmpDir });
    require('node:child_process').execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'base'], { cwd: tmpDir });

    const patch = [
      'diff --git a/target.js b/target.js',
      '--- a/target.js',
      '+++ b/target.js',
      '@@ -1 +1 @@',
      '-const a = 1;',
      '+const a = 2;',
      ''
    ].join('\n');
    const executor = createLocalExecutor({ fs, path, crypto });
    const result = executor.applyBatch({ projectRoot: tmpDir, batch: { targets: ['target.js'] }, parsedFiles: [], batchOutput: patch });
    assert.equal(result.status, 'BATCH_APPLIED');
    assert.equal(fs.readFileSync(path.join(tmpDir, 'untouched.js'), 'utf8'), untouchedContent);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('patch size policy rejects over 800 lines and requires explicit allowance for 501-800', () => {
  const makeProject = function(prefix) {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
    fs.writeFileSync(path.join(dir, 'target.txt'), 'base\n', 'utf8');
    require('node:child_process').execFileSync('git', ['init', '-q'], { cwd: dir });
    require('node:child_process').execFileSync('git', ['add', 'target.txt'], { cwd: dir });
    require('node:child_process').execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'base'], { cwd: dir });
    return dir;
  };
  const makePatch = function(addCount) {
    const added = Array.from({ length: addCount }, (_, index) => '+line-' + index);
    return ['diff --git a/target.txt b/target.txt', '--- a/target.txt', '+++ b/target.txt', '@@ -1 +1,' + (addCount + 1) + ' @@', ' base', ...added, ''].join('\n');
  };
  const executor = createLocalExecutor({ fs, path, crypto });
  const extendedDir = makeProject('patch-extended-');
  const maximumDir = makeProject('patch-maximum-');
  try {
    const extendedPatch = makePatch(496); // 502 lines including the terminal split entry.
    assert.throws(() => executor.applyBatch({ projectRoot: extendedDir, batch: { targets: ['target.txt'] }, parsedFiles: [], batchOutput: extendedPatch }), /PATCH_REQUIRES_EXTENDED_ALLOWANCE: 502 lines/);
    const allowed = executor.applyBatch({ projectRoot: extendedDir, batch: { targets: ['target.txt'] }, parsedFiles: [], batchOutput: extendedPatch, allowExtendedPatch: true });
    assert.equal(allowed.status, 'BATCH_APPLIED');
    assert.ok(fs.readFileSync(path.join(extendedDir, 'target.txt'), 'utf8').includes('line-495'));

    const oversizedPatch = makePatch(796); // 802 lines including the terminal split entry.
    assert.throws(() => executor.applyBatch({ projectRoot: maximumDir, batch: { targets: ['target.txt'] }, parsedFiles: [], batchOutput: oversizedPatch, allowExtendedPatch: true }), /PATCH_EXCEEDS_SIZE_LIMIT: 802 lines exceeds maximum 800/);
    assert.equal(fs.readFileSync(path.join(maximumDir, 'target.txt'), 'utf8'), 'base\n');
  } finally {
    fs.rmSync(extendedDir, { recursive: true, force: true });
    fs.rmSync(maximumDir, { recursive: true, force: true });
  }
});

test('combined patch and full-file batch rolls back every target when a later file operation fails', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'patch-combined-rollback-'));
  try {
    const original = Buffer.from('module.exports = 1;\n');
    fs.writeFileSync(path.join(tmpDir, 'existing.js'), original);
    require('node:child_process').execFileSync('git', ['init', '-q'], { cwd: tmpDir });
    require('node:child_process').execFileSync('git', ['add', 'existing.js'], { cwd: tmpDir });
    require('node:child_process').execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'base'], { cwd: tmpDir });
    const patch = [
      'diff --git a/existing.js b/existing.js',
      '--- a/existing.js',
      '+++ b/existing.js',
      '@@ -1 +1 @@',
      '-module.exports = 1;',
      '+module.exports = 2;',
      ''
    ].join('\n');
    const executor = createLocalExecutor({ fs, path, crypto });
    assert.throws(() => executor.applyBatch({
      projectRoot: tmpDir,
      batch: { targets: ['existing.js', 'new.js'] },
      batchOutput: patch,
      parsedFiles: [{ relPath: 'new.js', code: 'const invalid = "\uD800";' }]
    }), /BUNDLE_INVALID_UNICODE/);
    assert.deepEqual(fs.readFileSync(path.join(tmpDir, 'existing.js')), original);
    assert.equal(fs.existsSync(path.join(tmpDir, 'new.js')), false);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});


test('rejects patch when base SHA256 mismatches target file (PATCH_BASE_MISMATCH)', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'patch-base-mismatch-'));
  try {
    const original = Buffer.from('module.exports = 1;\n');
    fs.writeFileSync(path.join(tmpDir, 'target.js'), original);
    require('node:child_process').execFileSync('git', ['init', '-q'], { cwd: tmpDir });
    require('node:child_process').execFileSync('git', ['add', 'target.js'], { cwd: tmpDir });
    require('node:child_process').execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'base'], { cwd: tmpDir });
    const patch = ['diff --git a/target.js b/target.js', '--- a/target.js', '+++ b/target.js', '@@ -1 +1 @@', '-module.exports = 1;', '+module.exports = 2;', ''].join('\n');
    let gitCalls = 0;
    const executor = createLocalExecutor({ fs, path, crypto, spawnSync: function() { gitCalls++; return { status: 0, stdout: '', stderr: '' }; } });
    assert.throws(() => executor.applyBatch({ projectRoot: tmpDir, batch: { targets: ['target.js'] }, batchOutput: patch, baseSha256: '0'.repeat(64) }), /PATCH_BASE_MISMATCH: target\.js/);
    assert.equal(gitCalls, 0);
    assert.deepEqual(fs.readFileSync(path.join(tmpDir, 'target.js')), original);
  } finally { fs.rmSync(tmpDir, { recursive: true, force: true }); }
});

test('enforces per-batch allowExtendedPatch without global env bypass', () => {
  const makeProject = function() {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'patch-batch-allow-'));
    fs.writeFileSync(path.join(dir, 'target.txt'), 'base\n', 'utf8');
    require('node:child_process').execFileSync('git', ['init', '-q'], { cwd: dir });
    require('node:child_process').execFileSync('git', ['add', 'target.txt'], { cwd: dir });
    require('node:child_process').execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'base'], { cwd: dir });
    return dir;
  };
  const patch = ['diff --git a/target.txt b/target.txt', '--- a/target.txt', '+++ b/target.txt', '@@ -1 +1,497 @@', ' base', ...Array.from({ length: 496 }, (_, i) => '+line-' + i), ''].join('\n');
  const prior = process.env.ALLOW_EXTENDED_PATCH;
  process.env.ALLOW_EXTENDED_PATCH = 'true';
  const deniedDir = makeProject(), allowedDir = makeProject();
  try {
    const executor = createLocalExecutor({ fs, path, crypto });
    assert.throws(() => executor.applyBatch({ projectRoot: deniedDir, batch: { targets: ['target.txt'] }, batchOutput: patch }), /PATCH_REQUIRES_EXTENDED_ALLOWANCE/);
    const result = executor.applyBatch({ projectRoot: allowedDir, batch: { targets: ['target.txt'], allowExtendedPatch: true }, batchOutput: patch });
    assert.equal(result.status, 'BATCH_APPLIED');
  } finally {
    if (prior === undefined) delete process.env.ALLOW_EXTENDED_PATCH; else process.env.ALLOW_EXTENDED_PATCH = prior;
    fs.rmSync(deniedDir, { recursive: true, force: true });
    fs.rmSync(allowedDir, { recursive: true, force: true });
  }
});

test('rejects patch target whose canonical parent escapes through symlink', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'patch-symlink-root-'));
  const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'patch-symlink-outside-'));
  try {
    fs.symlinkSync(outside, path.join(tmpDir, 'linked'), 'dir');
    const patch = ['diff --git a/linked/target.js b/linked/target.js', '--- a/linked/target.js', '+++ b/linked/target.js', '@@ -0,0 +1 @@', '+module.exports = 1;', ''].join('\n');
    const executor = createLocalExecutor({ fs, path, crypto });
    assert.throws(() => executor.applyBatch({ projectRoot: tmpDir, batch: { targets: ['linked/target.js'] }, batchOutput: patch }), /SECURITY_BLOCK: symlink escape linked\/target\.js/);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    fs.rmSync(outside, { recursive: true, force: true });
  }
});

test('three-way fallback requires blob identities and restores index/worktree on conflict', () => {
  const childProcess = require('node:child_process');
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'patch-three-way-conflict-'));
  try {
    const target = path.join(tmpDir, 'target.txt');
    fs.writeFileSync(target, 'line-one\nshared\nline-three\n', 'utf8');
    childProcess.execFileSync('git', ['init', '-q'], { cwd: tmpDir });
    childProcess.execFileSync('git', ['add', 'target.txt'], { cwd: tmpDir });
    childProcess.execFileSync('git', ['-c', 'user.name=Test', '-c', 'user.email=test@example.invalid', 'commit', '-qm', 'base'], { cwd: tmpDir });

    fs.writeFileSync(target, 'line-one\npatch-change\nline-three\n', 'utf8');
    const patch = childProcess.execFileSync('git', ['diff', '--binary', '--full-index', '--', 'target.txt'], { cwd: tmpDir, encoding: 'utf8' });
    childProcess.execFileSync('git', ['checkout', '--', 'target.txt'], { cwd: tmpDir });
    fs.writeFileSync(target, 'line-one\nworktree-change\nline-three\n', 'utf8');

    const beforeWorktree = fs.readFileSync(target);
    const indexPath = path.join(tmpDir, '.git', 'index');
    const beforeIndex = fs.readFileSync(indexPath);
    const realSpawnSync = childProcess.spawnSync;
    let ordinaryCheckForced = false;
    let threeWayCheckForced = false;
    const controlledSpawnSync = function(command, args, options) {
      if (command === 'git' && args[0] === 'apply' && args.includes('--check') && !args.includes('--3way')) {
        ordinaryCheckForced = true;
        return { status: 1, stdout: '', stderr: 'forced ordinary context failure' };
      }
      if (command === 'git' && args[0] === 'apply' && args.includes('--check') && args.includes('--3way')) {
        threeWayCheckForced = true;
        return { status: 0, stdout: '', stderr: '' };
      }
      return realSpawnSync(command, args, options);
    };
    const executor = createLocalExecutor({ fs, path, crypto, spawnSync: controlledSpawnSync });
    assert.throws(
      () => executor.applyBatch({ projectRoot: tmpDir, batch: { targets: ['target.txt'] }, parsedFiles: [], batchOutput: patch }),
      /GIT_APPLY_FAILED|GIT_APPLY_THREE_WAY_CONFLICT/
    );
    assert.equal(ordinaryCheckForced, true);
    assert.equal(threeWayCheckForced, true);
    assert.deepEqual(fs.readFileSync(target), beforeWorktree);
    assert.deepEqual(fs.readFileSync(indexPath), beforeIndex);
    assert.equal(childProcess.execFileSync('git', ['ls-files', '--unmerged'], { cwd: tmpDir, encoding: 'utf8' }), '');
    assert.equal(fs.readFileSync(target, 'utf8').includes('<<<<<<<'), false);
    assert.equal(fs.readFileSync(target, 'utf8').includes('>>>>>>>'), false);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
