'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const {
  sanitizeTargetPath,
  normalizeTargetKey,
  normalizeFingerprintText,
  computeRequestFingerprint,
  stripPlanMetadataHeader,
  computePlanFingerprint,
  embedPlanMetadataHeader,
  extractPlanMetadataHeader,
  extractPlanTargets
} = require('../pipeline/target_path_utils');

const {
  createAutopilotEngine,
  parseAndValidatePlanBatches,
  isResumablePlannedPhase,
  evaluatePlanCache,
  invalidateStaleCycleArtifacts,
  buildCodePlanMetaHeader,
  buildBatchCheckpointHeader,
  extractCheckpointPlanFingerprint,
  verifyBatchCheckpoint,
  getFailoverEngines
} = require('../pipeline/autopilot_engine');

function createTempRepo(prefix) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix || 'ag-guardrails-'));
  fs.mkdirSync(path.join(dir, '.antigravity', 'bridge', 'exchange'), { recursive: true });
  return dir;
}

function buildValidPlanBody(targetPath) {
  return [
    '# PLANI ARKITEKTUROR',
    '',
    '## 1. OBJEKTIVI',
    'Implementim determinist i validuar me gjatesi mbi 250 karaktere qe kalon te gjitha kontrollet e struktures dhe kontrates se planit.',
    '',
    '## 2. ENTRY POINT & ROOT CAUSE',
    'Moduli kryesor kerkon perditesim te paster dhe te verifikuar ne skedarin e autorizuar.',
    '',
    '## 3. ALLOWED_FILES',
    'FILE_TARGET: ' + targetPath,
    '',
    '## 4. SPECIFIKIMI',
    'Ruaj eksportet dhe shto logjiken e kerkuar pa prishur backward compatibility.'
  ].join('\n');
}

test('DoD-1 & DoD-2: Cryptographic Request/Plan Fingerprinting & Cache Invalidation (Defekti I)', async (t) => {
  await t.test('normalizeFingerprintText normalizes CRLF vs LF, Unicode NFKC (ë/ç), and redundant spaces', () => {
    const a = 'Kërkesë   për\tçështjen\r\n\r\n\r\n  Rreshti 2  ';
    const b = 'Ke\u0308rkese\u0308 për çështjen\n\nRreshti 2';
    assert.equal(normalizeFingerprintText(a), normalizeFingerprintText(b));
    assert.equal(normalizeFingerprintText(null), '');
    assert.equal(normalizeFingerprintText(undefined), '');
  });

  await t.test('computeRequestFingerprint is deterministic and invalidates on 1-char external spec change', () => {
    const fp1 = computeRequestFingerprint('Zbato spec.md', 'Specifikimi v1: ëç');
    const fp2 = computeRequestFingerprint('Zbato spec.md\r\n', 'Specifikimi v1: e\u0308c\u0327');
    const fp3 = computeRequestFingerprint('Zbato spec.md', 'Specifikimi v2: ëç');

    assert.match(fp1, /^[a-f0-9]{64}$/);
    assert.equal(fp1, fp2);
    assert.notEqual(fp1, fp3);

    const fpEmpty = computeRequestFingerprint(null, undefined);
    assert.match(fpEmpty, /^[a-f0-9]{64}$/);
    assert.equal(fpEmpty, computeRequestFingerprint('', ''));
  });

  await t.test('embedPlanMetadataHeader is idempotent and preserves planFingerprint', () => {
    const body = buildValidPlanBody('src/app.js');
    const reqFp = computeRequestFingerprint('Implement feature X', '');
    const planFp = computePlanFingerprint(body);

    const embeddedOnce = embedPlanMetadataHeader(body, {
      requestFingerprint: reqFp,
      planFingerprint: planFp,
      generatedAt: '2026-01-01T00:00:00.000Z'
    });
    const embeddedTwice = embedPlanMetadataHeader(embeddedOnce, {
      requestFingerprint: reqFp,
      planFingerprint: planFp,
      generatedAt: '2026-01-01T00:00:00.000Z'
    });

    assert.equal(embeddedOnce, embeddedTwice);
    assert.equal(computePlanFingerprint(embeddedOnce), planFp);
    assert.equal(stripPlanMetadataHeader(embeddedOnce), body);

    const parsed = extractPlanMetadataHeader(embeddedOnce);
    assert.equal(parsed.requestFingerprint, reqFp);
    assert.equal(parsed.planFingerprint, planFp);
    assert.equal(parsed.generatedAt, '2026-01-01T00:00:00.000Z');
  });

  await t.test('evaluatePlanCache rejects legacy plan (>200B without meta), mismatched requestFp, REVIEW_FAILED, tampered plan, and corrupted state.json', () => {
    const repo = createTempRepo('ag-cache-');
    t.after(() => { try { fs.rmSync(repo, { recursive: true, force: true }); } catch (_) {} });

    const exchangeDir = path.join(repo, '.antigravity', 'bridge', 'exchange');
    const bridgeDir = path.join(repo, '.antigravity', 'bridge');
    const planPath = path.join(exchangeDir, 'plan.md');
    const statePath = path.join(bridgeDir, 'state.json');

    const body = buildValidPlanBody('src/app.js');
    const reqFpA = computeRequestFingerprint('Kerkesa A', '');
    const reqFpB = computeRequestFingerprint('Kerkesa B', '');
    const planFp = computePlanFingerprint(body);

    // 1. Legacy plan (>200B) without ANTIGRAVITY_PLAN_META -> PLAN_META_MISSING
    fs.writeFileSync(planPath, body, 'utf8');
    let res = evaluatePlanCache(repo, reqFpA);
    assert.equal(res.reusable, false);
    assert.equal(res.reason, 'PLAN_META_MISSING');

    // 2. Valid metadata + resumable phase (PLANNED / CODED) -> reusable === true
    const wrapped = embedPlanMetadataHeader(body, { requestFingerprint: reqFpA, planFingerprint: planFp });
    fs.writeFileSync(planPath, wrapped, 'utf8');
    fs.writeFileSync(statePath, JSON.stringify({ phase: 'PLANNED', requestFingerprint: reqFpA, planFingerprint: planFp }), 'utf8');
    res = evaluatePlanCache(repo, reqFpA);
    assert.equal(res.reusable, true);
    assert.equal(res.reason, 'PLAN_CACHE_VALID');
    assert.equal(isResumablePlannedPhase('PLANNED'), true);
    assert.equal(isResumablePlannedPhase('CODED'), true);
    assert.equal(isResumablePlannedPhase('REVIEW_FAILED'), false);

    // 3. Different requestFingerprint -> REQUEST_FINGERPRINT_MISMATCH
    res = evaluatePlanCache(repo, reqFpB);
    assert.equal(res.reusable, false);
    assert.equal(res.reason, 'REQUEST_FINGERPRINT_MISMATCH');

    // 4. Terminal/failed phase REVIEW_FAILED -> PHASE_NOT_RESUMABLE
    fs.writeFileSync(statePath, JSON.stringify({ phase: 'REVIEW_FAILED', requestFingerprint: reqFpA, planFingerprint: planFp }), 'utf8');
    res = evaluatePlanCache(repo, reqFpA);
    assert.equal(res.reusable, false);
    assert.match(res.reason, /^PHASE_NOT_RESUMABLE/);

    // 5. Manually modified plan body -> PLAN_FINGERPRINT_MISMATCH
    fs.writeFileSync(statePath, JSON.stringify({ phase: 'PLANNED', requestFingerprint: reqFpA, planFingerprint: planFp }), 'utf8');
    fs.writeFileSync(planPath, wrapped + '\nFILE_TARGET: src/tampered.js\n', 'utf8');
    res = evaluatePlanCache(repo, reqFpA);
    assert.equal(res.reusable, false);
    assert.equal(res.reason, 'PLAN_FINGERPRINT_MISMATCH');

    // 6. Corrupted JSON in state.json -> STATE_CORRUPTED_STALE without throwing SyntaxError
    fs.writeFileSync(planPath, wrapped, 'utf8');
    fs.writeFileSync(statePath, '{ broken json !!!', 'utf8');
    res = evaluatePlanCache(repo, reqFpA);
    assert.equal(res.reusable, false);
    assert.equal(res.reason, 'STATE_CORRUPTED_STALE');

    // 7. invalidateStaleCycleArtifacts purges stale exchange artifacts and writes clean state.json
    for (const f of ['code.md', 'review.md', 'build_test.log', 'last_error.txt']) {
      fs.writeFileSync(path.join(exchangeDir, f), 'stale artifact', 'utf8');
    }
    const inv = invalidateStaleCycleArtifacts(repo, 'REQUEST_FINGERPRINT_MISMATCH', reqFpB);
    assert.equal(inv.invalidated, true);
    for (const f of ['plan.md', 'code.md', 'review.md', 'build_test.log', 'last_error.txt']) {
      assert.equal(fs.existsSync(path.join(exchangeDir, f)), false);
    }
    const cleanState = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    assert.equal(cleanState.phase, 'IDLE');
    assert.equal(cleanState.requestFingerprint, reqFpB);
    assert.equal(cleanState.planFingerprint, null);
  });

  await t.test('Pipeline invalidates stale plan on external spec edit and preserves legitimate resume', async () => {
    const repo = createTempRepo('ag-pipe-cache-');
    t.after(() => { try { fs.rmSync(repo, { recursive: true, force: true }); } catch (_) {} });

    fs.mkdirSync(path.join(repo, 'src'), { recursive: true });
    fs.writeFileSync(path.join(repo, 'src', 'app.js'), 'module.exports = { v: 1 };\n', 'utf8');
    const specFile = path.join(repo, 'spec.md');
    fs.writeFileSync(specFile, 'Specifikimi fillestar v1\n', 'utf8');

    const exchangeDir = path.join(repo, '.antigravity', 'bridge', 'exchange');
    // Seed a legacy stale plan (>200B without metadata) and stale downstream artifacts
    fs.writeFileSync(path.join(exchangeDir, 'plan.md'), buildValidPlanBody('src/stale.js'), 'utf8');
    fs.writeFileSync(path.join(exchangeDir, 'code.md'), '### FILE: src/stale.js\n```js\nmodule.exports = 0;\n```\n', 'utf8');
    fs.writeFileSync(path.join(exchangeDir, 'review.md'), 'STATUS: CHANGES_REQUIRED\n', 'utf8');

    let plannerCalls = 0;
    let coderCalls = 0;

    const engine = createAutopilotEngine({
      ensureProjectSetup: () => ({ projectRoot: repo, roles: { planner: 'gemini1', coder: 'gemini2', reviewer: 'off' } }),
      dispatchChunkedEngineTurn: async (tabKey, root, prompt, attachment, opts) => {
        if (opts && opts.isPlanner) {
          plannerCalls++;
          return buildValidPlanBody('src/app.js');
        }
        coderCalls++;
        return '### FILE: src/app.js\n```js\nmodule.exports = { v: 2 };\n```\n';
      },
      runBatchQuickChecks: () => ({ status: 'CHECK_PASSED', receipts: [] }),
      runFinalBuildAndTests: async () => ({ status: 'CHECK_PASSED', receipts: [] })
    });

    const reqText = 'Zbato specifikimin nga "' + specFile + '"';
    const r1 = await engine.runAutonomousPipeline(repo, reqText);
    assert.equal(r1.status, 'CYCLE_COMPLETED');
    assert.equal(plannerCalls, 1);
    assert.equal(coderCalls, 1);

    const savedPlan = fs.readFileSync(path.join(exchangeDir, 'plan.md'), 'utf8');
    const savedMeta = extractPlanMetadataHeader(savedPlan);
    assert.ok(savedMeta.requestFingerprint);
    assert.equal(savedMeta.planFingerprint, computePlanFingerprint(savedPlan));

    // Simulate interrupted resumable phase (PLANNED) with identical request + spec -> MUST reuse plan (0 new planner calls)
    const statePath = path.join(repo, '.antigravity', 'bridge', 'state.json');
    const st = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    st.phase = 'PLANNED';
    fs.writeFileSync(statePath, JSON.stringify(st, null, 2), 'utf8');

    const r2 = await engine.runAutonomousPipeline(repo, reqText);
    assert.equal(r2.status, 'CYCLE_COMPLETED');
    assert.equal(plannerCalls, 1, 'Legitimate resume must reuse valid cached plan');

    // Modify 1 char in external spec file -> MUST invalidate plan and re-invoke planner
    fs.writeFileSync(specFile, 'Specifikimi fillestar v2\n', 'utf8');
    const st2 = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    st2.phase = 'PLANNED';
    fs.writeFileSync(statePath, JSON.stringify(st2, null, 2), 'utf8');

    const r3 = await engine.runAutonomousPipeline(repo, reqText);
    assert.equal(r3.status, 'CYCLE_COMPLETED');
    assert.equal(plannerCalls, 2, '1-char external spec edit must invalidate plan cache and call planner');
  });
});

test('DoD-3 & DoD-4: Elastic Deterministic Parser & Fail-Closed Zero-Fallback (Defekti II)', async (t) => {
  const tmpDir = createTempRepo('ag-parser-');
  fs.mkdirSync(path.join(tmpDir, 'src', 'core'), { recursive: true });
  fs.mkdirSync(path.join(tmpDir, 'docs'), { recursive: true });
  fs.writeFileSync(path.join(tmpDir, 'src', 'core', 'service.js'), 'module.exports = {};\n', 'utf8');
  fs.writeFileSync(path.join(tmpDir, 'docs', 'my spec file.md'), '# Spec\n', 'utf8');
  fs.writeFileSync(path.join(tmpDir, '.editorconfig'), 'root = true\n', 'utf8');

  t.after(() => {
    try { fs.rmSync(tmpDir, { recursive: true, force: true }); } catch (_) {}
  });

  await t.test('sanitizeTargetPath handles + bullet prefix, bold/underscore FILE_TARGET wrappers, rejects globs, cross-drive escapes, and NTFS ADS', () => {
    assert.equal(sanitizeTargetPath('+ src/utils/math.js').path, 'src/utils/math.js');
    assert.equal(sanitizeTargetPath('+ **FILE_TARGET:** `src/core/service.js` — (I RI)').path, 'src/core/service.js');
    assert.equal(sanitizeTargetPath('__FILE_TARGET:__ src/core/service.js').path, 'src/core/service.js');
    assert.equal(sanitizeTargetPath('**TARGET**: src\\core\\service.js').path, 'src/core/service.js');
    assert.equal(sanitizeTargetPath('FILE_TARGET: *.cs').path, null);
    assert.equal(sanitizeTargetPath('FILE_TARGET: *.cs').rejectedReason, 'ILLEGAL_PATH_CHARACTERS');
    assert.equal(sanitizeTargetPath('FILE_TARGET: src/**').path, null);
    assert.equal(sanitizeTargetPath('FILE_TARGET: src/**').rejectedReason, 'ILLEGAL_PATH_CHARACTERS');

    // Cross-drive escape on Windows and absolute escape outside projectRoot
    const crossDrive = sanitizeTargetPath('D:/outside/secret.js', 'C:\\repo');
    assert.equal(crossDrive.path, null);
    assert.equal(crossDrive.rejectedReason, 'OUTSIDE_PROJECT_ROOT');

    // NTFS ADS / illegal colon in relative path
    const adsPath = sanitizeTargetPath('src/file:ads.js', tmpDir);
    assert.equal(adsPath.path, null);
    assert.equal(adsPath.rejectedReason, 'ILLEGAL_PATH_CHARACTERS');

    // Explicit traversal segment even if resolving back inside projectRoot
    const selfBounce = sanitizeTargetPath('../' + path.basename(tmpDir) + '/src/core/service.js', tmpDir);
    assert.equal(selfBounce.path, null);
    assert.equal(selfBounce.rejectedReason, 'PATH_TRAVERSAL_REJECTED');
  });

  await t.test('extractPlanTargets extracts FILE_TARGET and ALLOWED_FILES, ignores FORBIDDEN_FILES (glob & trailing-slash dirs) & code fences', () => {
    const plan = [
      '<!-- ANTIGRAVITY_PLAN_META',
      'requestFingerprint: ' + 'a'.repeat(64),
      'planFingerprint: ' + 'b'.repeat(64),
      'generatedAt: 2026-01-01T00:00:00.000Z',
      'FILE_TARGET: should/not/be/parsed_from_comment.js',
      '-->',
      '# PLAN',
      '',
      '## 3. ALLOWED_FILES & FORBIDDEN_FILES',
      '',
      '### ALLOWED_FILES',
      'FILE_TARGET: a/b.js',
      '- `c/d.ts` — shpjegim teknik',
      '* e/f.cs (I RI)',
      '+ `src/core/service.js` — (I RI) shtim validimi',
      '- `docs/my spec file.md`',
      '- `package.json`',
      '- `.hermes/runs/run_01/server.js`',
      '- `scratch/temp.js`',
      '(Shënim: ky rresht prozë nuk duhet nxjerrë si target)',
      '',
      '```markdown',
      'FILE_TARGET: inside/code_fence.js',
      '- `also/inside_fence.ts`',
      '```',
      '',
      '~~~text',
      'FILE_TARGET: inside/tilde_fence.js',
      '~~~',
      '',
      '### FORBIDDEN_FILES',
      '- .hermes/** (të gjitha snapshot-et)',
      '- scratch/',
      '- package.json, package-lock.json',
      'FILE_TARGET: forbidden/direct.js',
      '',
      '## 4. SPECIFIKIMI',
      'FILE_TARGET: Makefile',
      '- `not/in/allowed_section.js`'
    ].join('\n');

    const res = extractPlanTargets(plan, tmpDir);

    assert.deepEqual(res.targets, [
      'a/b.js',
      'Makefile',
      'c/d.ts',
      'e/f.cs',
      'src/core/service.js',
      'docs/my spec file.md'
    ]);

    assert.ok(res.forbiddenPatterns.includes('.hermes/**'));
    assert.ok(res.forbiddenPatterns.includes('scratch/**'));
    assert.ok(res.forbiddenPatterns.includes('package.json'));
    assert.ok(res.forbiddenPatterns.includes('package-lock.json'));

    const forbiddenRejects = res.rejected.filter(r => r.reason === 'FORBIDDEN_TARGET');
    assert.equal(forbiddenRejects.length, 3);
  });

  await t.test('extractPlanTargets rejects traversal, globs, .git metadata, directories, and empty/comment-only plans', () => {
    const maliciousPlan = [
      '### ALLOWED_FILES',
      'FILE_TARGET: ../../etc/passwd',
      'FILE_TARGET: ..\\outside.txt',
      'FILE_TARGET: src/**',
      'FILE_TARGET: *.cs',
      'FILE_TARGET: .git/config',
      'FILE_TARGET: src/core',
      '- Ky eshte thjesht nje rresht proze pa asnje skedar'
    ].join('\n');

    const res = extractPlanTargets(maliciousPlan, tmpDir);
    assert.deepEqual(res.targets, []);

    const reasons = res.rejected.map(r => r.reason);
    assert.ok(reasons.includes('PATH_TRAVERSAL_REJECTED'));
    assert.ok(reasons.includes('ILLEGAL_PATH_CHARACTERS'));
    assert.ok(reasons.includes('GIT_METADATA_FORBIDDEN'));
    assert.ok(reasons.includes('TARGET_IS_DIRECTORY'));
    assert.ok(reasons.includes('PROSE_OR_NON_FILE_REJECTED'));

    assert.deepEqual(extractPlanTargets('', tmpDir).targets, []);
    assert.deepEqual(extractPlanTargets(null, tmpDir).targets, []);
    assert.deepEqual(extractPlanTargets('<!-- comment only -->', tmpDir).targets, []);
  });

  await t.test('extractPlanTargets deduplicates deterministically with FILE_TARGET priority', () => {
    const plan = [
      '### ALLOWED_FILES',
      '- `src/core/service.js`',
      '- `src/other.js`',
      '## 4. DETAILS',
      'FILE_TARGET: src\\core\\service.js'
    ].join('\n');

    const res = extractPlanTargets(plan, tmpDir);
    assert.deepEqual(res.targets, ['src/core/service.js', 'src/other.js']);
    assert.equal(
      normalizeTargetKey(res.targets[0], tmpDir),
      normalizeTargetKey('src\\core\\service.js', tmpDir)
    );
  });

  await t.test('Fail-Closed Zero-Fallback: throws PLAN_NO_VALID_TARGETS, never picks .editorconfig, never calls Coder', async () => {
    assert.throws(
      () => parseAndValidatePlanBatches('# Plan pa asnje target\nVetem tekst shpjegues.', { nodes: [], edges: [] }, { projectRoot: tmpDir, files: [{ path: '.editorconfig', sourceScore: 2, generatedScore: 0 }] }, tmpDir),
      (err) => err && err.code === 'PLAN_NO_VALID_TARGETS' && /PLAN_NO_VALID_TARGETS/.test(err.message)
    );

    const editorConfigBefore = fs.readFileSync(path.join(tmpDir, '.editorconfig'), 'utf8');
    let plannerCalls = 0;
    let coderCalls = 0;

    const engine = createAutopilotEngine({
      ensureProjectSetup: () => ({ projectRoot: tmpDir, roles: { planner: 'gemini1', coder: 'gemini2', reviewer: 'off' } }),
      dispatchChunkedEngineTurn: async (tabKey, root, prompt, attachment, opts) => {
        if (opts && opts.isPlanner) {
          plannerCalls++;
          return '# Plan i gjate por pa asnje skedar te vlefshem\n\nKy plan ka vetem pershkrim arkitekturor dhe asnje direktive te vlefshme skedari qe te provoje sjelljen strikte fail-closed pa fallback mbi scan.files dhe pa prekur asnje skedar konfigurimi ne disk.';
        }
        coderCalls++;
        return '### FILE: .editorconfig\n```ini\ncorrupted = true\n```\n';
      }
    });

    await assert.rejects(
      () => engine.runAutonomousPipeline(tmpDir, 'Ndrysho nje modul pa target'),
      (err) => err && err.code === 'PLAN_NO_VALID_TARGETS'
    );

    assert.equal(plannerCalls, 2, 'Allows at most 1 bounded regeneration attempt before terminal fail-closed');
    assert.equal(coderCalls, 0, 'Coder must NEVER be invoked when plan has no valid targets');
    assert.equal(fs.readFileSync(path.join(tmpDir, '.editorconfig'), 'utf8'), editorConfigBefore);

    const state = JSON.parse(fs.readFileSync(path.join(tmpDir, '.antigravity', 'bridge', 'state.json'), 'utf8'));
    assert.equal(state.phase, 'PLAN_FAILED');
    assert.equal(state.lastStatus, 'PLAN_NO_VALID_TARGETS');
  });
});

test('DoD-5: Checkpoint planFingerprint Binding & Failover Guardrails (Defekti III)', async (t) => {
  await t.test('verifyBatchCheckpoint rejects legacy checkpoints without planFingerprint and mismatched planFingerprint, accepts matching blocks or audit receipts', () => {
    const planFpA = 'a'.repeat(64);
    const planFpB = 'b'.repeat(64);
    const dummySha = 'c'.repeat(64);

    const legacyCodeMd = '### FILE: src/app.js\n```js\nmodule.exports = 1;\n```\n';
    const legacyRes = verifyBatchCheckpoint({
      codeMarkdown: legacyCodeMd,
      state: { planFingerprint: planFpA },
      currentPlanFingerprint: planFpA,
      batchIndex: 0,
      batchTargets: ['src/app.js']
    });
    assert.equal(legacyRes.verified, false);
    assert.equal(legacyRes.reason, 'STALE_CHECKPOINT');

    const oldPlanCodeMd = [
      buildCodePlanMetaHeader(planFpA),
      '### FILE: src/app.js',
      '```js',
      'module.exports = 1;',
      '```',
      buildBatchCheckpointHeader({ planFingerprint: planFpA, batchIndex: 0, targetKeys: ['src/app.js'] })
    ].join('\n');

    const mismatchRes = verifyBatchCheckpoint({
      codeMarkdown: oldPlanCodeMd,
      state: { planFingerprint: planFpB },
      currentPlanFingerprint: planFpB,
      batchIndex: 0,
      batchTargets: ['src/app.js']
    });
    assert.equal(mismatchRes.verified, false);
    assert.equal(mismatchRes.reason, 'STALE_CHECKPOINT');
    assert.equal(extractCheckpointPlanFingerprint(oldPlanCodeMd, ['src/app.js'], 0), planFpA);

    const matchRes = verifyBatchCheckpoint({
      codeMarkdown: oldPlanCodeMd,
      state: { planFingerprint: planFpA },
      currentPlanFingerprint: planFpA,
      batchIndex: 0,
      batchTargets: ['src/app.js']
    });
    assert.equal(matchRes.verified, true);
    assert.equal(matchRes.reason, 'CHECKPOINT_MATCHED');
    assert.equal(matchRes.planFingerprint, planFpA);

    // Audit-only receipt verification (CHECKPOINT_FILE_VERIFIED without inline code block)
    const auditOnlyCodeMd = [
      buildCodePlanMetaHeader(planFpA),
      '<!-- CHECKPOINT_FILE_VERIFIED target=src/app.js inputSha256=' + dummySha + ' outputSha256=' + dummySha + ' repositoryFingerprint=' + dummySha + ' planFingerprint=' + planFpA + ' syntax=PASS quickCheck=PASS status=VERIFIED -->'
    ].join('\n');
    const auditOnlyRes = verifyBatchCheckpoint({
      codeMarkdown: auditOnlyCodeMd,
      state: { planFingerprint: planFpA },
      currentPlanFingerprint: planFpA,
      batchIndex: 0,
      batchTargets: ['src/app.js']
    });
    assert.equal(auditOnlyRes.verified, true);
    assert.equal(auditOnlyRes.reason, 'CHECKPOINT_MATCHED');
  });

  await t.test('Pipeline forces Coder re-execution when code.md has stale planFingerprint and skips on CRLF plan legitimate resume', async () => {
    const repo = createTempRepo('ag-cp-');
    t.after(() => { try { fs.rmSync(repo, { recursive: true, force: true }); } catch (_) {} });

    fs.mkdirSync(path.join(repo, 'src'), { recursive: true });
    fs.writeFileSync(path.join(repo, 'src', 'app.js'), 'module.exports = { v: 1 };\n', 'utf8');

    const reqText = 'Perditeso src/app.js';
    const reqFp = computeRequestFingerprint(reqText, '');
    // Deliberately include CRLF and extra spaces to verify checkpointIdentity uses normalized currentPlanFingerprint
    const planBody = buildValidPlanBody('src/app.js').replace(/\n/g, '\r\n') + '\r\n  -   Shenim shtese  \r\n';
    const planFp = computePlanFingerprint(planBody);
    const wrappedPlan = embedPlanMetadataHeader(planBody, { requestFingerprint: reqFp, planFingerprint: planFp });

    const exchangeDir = path.join(repo, '.antigravity', 'bridge', 'exchange');
    const statePath = path.join(repo, '.antigravity', 'bridge', 'state.json');

    // Seed valid plan.md + state.json, but STALE code.md belonging to a different planFingerprint
    fs.writeFileSync(path.join(exchangeDir, 'plan.md'), wrappedPlan, 'utf8');
    fs.writeFileSync(statePath, JSON.stringify({ phase: 'PLANNED', requestFingerprint: reqFp, planFingerprint: planFp }), 'utf8');
    fs.writeFileSync(
      path.join(exchangeDir, 'code.md'),
      buildCodePlanMetaHeader('f'.repeat(64)) + '\n### FILE: src/app.js\n```js\nmodule.exports = { v: 0 };\n```\n' +
      buildBatchCheckpointHeader({ planFingerprint: 'f'.repeat(64), batchIndex: 0, targetKeys: ['src/app.js'] }) + '\n',
      'utf8'
    );

    let coderCalls = 0;
    const engine = createAutopilotEngine({
      ensureProjectSetup: () => ({ projectRoot: repo, roles: { planner: 'gemini1', coder: 'gemini2', reviewer: 'off' } }),
      dispatchChunkedEngineTurn: async () => {
        coderCalls++;
        return '### FILE: src/app.js\n```js\nmodule.exports = { v: 2 };\n```\n';
      },
      runBatchQuickChecks: () => ({ status: 'CHECK_PASSED', receipts: [] }),
      runFinalBuildAndTests: async () => ({ status: 'CHECK_PASSED', receipts: [] })
    });

    const r1 = await engine.runAutonomousPipeline(repo, reqText);
    assert.equal(r1.status, 'CYCLE_COMPLETED');
    assert.equal(coderCalls, 1, 'Stale checkpoint planFingerprint must force Coder execution');

    const updatedCodeMd = fs.readFileSync(path.join(exchangeDir, 'code.md'), 'utf8');
    assert.equal(extractCheckpointPlanFingerprint(updatedCodeMd, ['src/app.js'], 0), planFp);
    assert.ok(updatedCodeMd.includes('CHECKPOINT_FILE_VERIFIED') && updatedCodeMd.includes('planFingerprint=' + planFp));

    // Set phase back to CODED and re-run with matching CRLF planFingerprint -> verified batch must be skipped (0 new Coder calls)
    const st = JSON.parse(fs.readFileSync(statePath, 'utf8'));
    st.phase = 'CODED';
    fs.writeFileSync(statePath, JSON.stringify(st, null, 2), 'utf8');

    const r2 = await engine.runAutonomousPipeline(repo, reqText);
    assert.equal(r2.status, 'CYCLE_COMPLETED');
    assert.equal(coderCalls, 1, 'Matching checkpoint planFingerprint must skip already-verified batch');
  });

  await t.test('getFailoverEngines honors runtimeContext.isEngineAvailable lock', () => {
    const lockedCtx = {
      isEngineAvailable: (eng) => eng === 'gemini1' || eng === 'gemini2'
    };
    assert.deepEqual(getFailoverEngines('gemini2', new Set(), lockedCtx), ['gemini1']);
    assert.deepEqual(getFailoverEngines('gemini1', new Set(), lockedCtx), ['gemini2']);
    assert.deepEqual(getFailoverEngines('gemini2', new Set(['gemini1']), lockedCtx), []);
  });
});
