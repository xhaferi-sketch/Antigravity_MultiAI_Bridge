'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const crypto = require('node:crypto');

const {
  createLocalExecutor,
  computeCheckpointIdentity,
  parseCheckpointAudit,
  isTargetVerifiedForCheckpoint
} = require('../../../mcp/pipeline/local_executor.js');

test('checkpoint verification requires matching repo and plan fingerprints', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ckpt-test-'));
  try {
    const target = 'src/test.js';
    const absPath = path.join(tmpDir, target);
    fs.mkdirSync(path.dirname(absPath), { recursive: true });
    fs.writeFileSync(absPath, 'const a = 1;', 'utf8');
    const hash = crypto.createHash('sha256').update(fs.readFileSync(absPath)).digest('hex');

    const identity = {
      repositoryFingerprint: 'repofp1234567890abcdef',
      planFingerprint: 'planfp1234567890abcdef'
    };

    const auditText = `<!-- CHECKPOINT_FILE_VERIFIED target=${target} inputSha256=${hash} outputSha256=${hash} repositoryFingerprint=${identity.repositoryFingerprint} planFingerprint=${identity.planFingerprint} parserMode=FENCED syntax=PASS quickCheck=PASS status=VERIFIED -->`;
    const auditIndex = parseCheckpointAudit(auditText);

    // 1. Matches identity exactly
    assert.equal(isTargetVerifiedForCheckpoint(auditIndex, target, tmpDir, identity, fs), true);

    // 2. Changed plan invalidates receipt
    const wrongPlanId = {
      repositoryFingerprint: identity.repositoryFingerprint,
      planFingerprint: 'different_plan'
    };
    assert.equal(isTargetVerifiedForCheckpoint(auditIndex, target, tmpDir, wrongPlanId, fs), false);

    // 3. Changed target file content invalidates receipt
    fs.writeFileSync(absPath, 'const modified = 2;', 'utf8');
    assert.equal(isTargetVerifiedForCheckpoint(auditIndex, target, tmpDir, identity, fs), false);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('legacy migration sets historicalOutputProvenance=UNPROVEN', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'legacy-ckpt-'));
  try {
    const codePath = path.join(tmpDir, 'code.md');
    const target = 'src/legacy.js';
    const absPath = path.join(tmpDir, target);
    fs.mkdirSync(path.dirname(absPath), { recursive: true });
    fs.writeFileSync(absPath, 'function legacy() {}', 'utf8');

    fs.writeFileSync(codePath, `### FILE: ${target}\n\`\`\`js\nfunction legacy() {}\n\`\`\`\n`, 'utf8');

    const executor = createLocalExecutor({ fs, path, crypto });
    const identity = { repositoryFingerprint: 'rfp1', planFingerprint: 'pfp1' };

    executor.migrateLegacyCheckpointReceipts(codePath, tmpDir, identity);

    const migrated = fs.readFileSync(codePath, 'utf8');
    assert.ok(migrated.includes('historicalOutputProvenance=UNPROVEN'));
    assert.ok(migrated.includes('status=VERIFIED'));
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('persistCheckpointReceiptOnce only appends unpersisted receipts', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'persist-test-'));
  try {
    const codePath = path.join(tmpDir, 'code.md');
    fs.writeFileSync(codePath, '', 'utf8');

    const target = 'src/persisted.js';
    const absPath = path.join(tmpDir, target);
    fs.mkdirSync(path.dirname(absPath), { recursive: true });
    fs.writeFileSync(absPath, 'const x = 1;', 'utf8');

    const executor = createLocalExecutor({ fs, path, crypto });
    const identity = { repositoryFingerprint: 'rfp1', planFingerprint: 'pfp1' };
    const receipt = { batchId: 'BATCH-001' };
    const parsedFiles = [{ relPath: target, code: 'const x = 1;' }];

    // First persistence: appends
    executor.persistCheckpointReceiptOnce(codePath, receipt, parsedFiles, tmpDir, identity);
    const content1 = fs.readFileSync(codePath, 'utf8');
    assert.ok(content1.includes('CHECKPOINT_FILE_VERIFIED'));

    // Second persistence: already verified on disk, no duplicate append
    executor.persistCheckpointReceiptOnce(codePath, receipt, parsedFiles, tmpDir, identity);
    const content2 = fs.readFileSync(codePath, 'utf8');
    assert.equal(content1, content2);
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
