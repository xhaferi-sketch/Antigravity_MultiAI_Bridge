'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const PROJECT_ROOT = path.resolve(__dirname, '../..');
const {
  packWorkspace,
  scanRepositoryUniversal,
  buildBudgetedWorkspaceBundle,
  resolveAndEmbedExternalFiles
} = require(path.join(PROJECT_ROOT, 'mcp', 'pipeline', 'autopilot_engine.js'));

function loadServerForTest() {
  const prevExport = process.env.ANTIGRAVITY_TEST_EXPORT;
  const prevTruthful = process.env.ANTIGRAVITY_TRUTHFUL_TEST;
  process.env.ANTIGRAVITY_TEST_EXPORT = '1';
  process.env.ANTIGRAVITY_TRUTHFUL_TEST = '1';
  try {
    const serverPath = path.join(PROJECT_ROOT, 'mcp', 'server.js');
    delete require.cache[require.resolve(serverPath)];
    return require(serverPath);
  } finally {
    if (prevExport === undefined) delete process.env.ANTIGRAVITY_TEST_EXPORT;
    else process.env.ANTIGRAVITY_TEST_EXPORT = prevExport;
    if (prevTruthful === undefined) delete process.env.ANTIGRAVITY_TRUTHFUL_TEST;
    else process.env.ANTIGRAVITY_TRUTHFUL_TEST = prevTruthful;
  }
}

test('packWorkspace and scanRepositoryUniversal exclude .hermes, .profiles, .antigravity, scratch, and profiles archives', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'batch0_denied_dirs_'));
  try {
    fs.mkdirSync(path.join(tmpDir, '.hermes', 'runs', 'run_01'), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, '.profiles', 'm365_web1'), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, '.antigravity', 'bridge'), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, 'scratch', 'temp_test_user_url', 'Default'), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, 'profiles', 'google_search_1', 'Default'), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, 'mcp'), { recursive: true });

    fs.writeFileSync(path.join(tmpDir, '.hermes', 'runs', 'run_01', 'server.js'), 'console.log("stale");\n', 'utf8');
    fs.writeFileSync(path.join(tmpDir, '.profiles', 'm365_web1', 'index.txt'), 'cache data\n', 'utf8');
    fs.writeFileSync(path.join(tmpDir, '.antigravity', 'bridge', 'state.json'), '{"phase":"OLD"}\n', 'utf8');
    fs.writeFileSync(path.join(tmpDir, 'scratch', 'inspect_cdp.js'), 'console.log("inspect");\n', 'utf8');
    fs.writeFileSync(path.join(tmpDir, 'scratch', 'temp_test_user_url', 'Default', 'LOCK'), 'lock\n', 'utf8');
    fs.writeFileSync(path.join(tmpDir, 'profiles', 'google_search_1', 'Default', 'LOCK'), 'lock2\n', 'utf8');
    fs.writeFileSync(path.join(tmpDir, 'mcp', 'server.js'), 'module.exports = { ok: true };\n', 'utf8');

    const scan = scanRepositoryUniversal(tmpDir);
    const scannedPaths = scan.files.map((f) => f.path);
    assert.deepEqual(scannedPaths, ['mcp/server.js']);

    const pack = packWorkspace(tmpDir, 'CODING_FOCUSED');
    assert.ok(fs.existsSync(pack.bundlePath));
    const bundleText = fs.readFileSync(path.join(tmpDir, '.antigravity', 'bridge', 'exchange', 'project_bundle.txt'), 'utf8');
    assert.ok(bundleText.includes('mcp/server.js'));
    assert.ok(!bundleText.includes('.hermes/runs/run_01/server.js'));
    assert.ok(!bundleText.includes('.profiles/m365_web1/index.txt'));
    assert.ok(!bundleText.includes('.antigravity/bridge/state.json'));
    assert.ok(!bundleText.includes('scratch/inspect_cdp.js'));
    assert.ok(!bundleText.includes('scratch/temp_test_user_url/Default/LOCK'));
    assert.ok(!bundleText.includes('profiles/google_search_1/Default/LOCK'));
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('buildBudgetedWorkspaceBundle ranks production engines ahead of unrelated tests and keeps >64KB explicitTargets uncompacted', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'batch1_bundle_ranking_'));
  try {
    fs.mkdirSync(path.join(tmpDir, 'mcp', 'engines'), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, 'mcp', 'pipeline'), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, 'mcp', 'tests'), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, 'scratch'), { recursive: true });

    const largeServerBody = '// server header\n' + 'const x = 1;\n'.repeat(6000) + '// SERVER_TAIL_UNCOMPACTED_SENTINEL\n';
    assert.ok(Buffer.byteLength(largeServerBody, 'utf8') > 64 * 1024);

    fs.writeFileSync(path.join(tmpDir, 'mcp', 'server.js'), largeServerBody, 'utf8');
    fs.writeFileSync(path.join(tmpDir, 'mcp', 'engines', 'copilot_engine.js'), 'module.exports = { copilot: true };\n', 'utf8');
    fs.writeFileSync(path.join(tmpDir, 'mcp', 'pipeline', 'dom_liveness_wait.js'), 'module.exports = { wait: true };\n', 'utf8');
    fs.writeFileSync(path.join(tmpDir, 'mcp', 'tests', 'unrelated.test.js'), 'console.log("unrelated test");\n', 'utf8');
    fs.writeFileSync(path.join(tmpDir, 'mcp', 'tests', 'server_contract.test.js'), 'console.log("server contract test");\n', 'utf8');
    fs.writeFileSync(path.join(tmpDir, 'scratch', 'inspect_cdp.js'), 'console.log("scratch inspect");\n', 'utf8');

    const built = buildBudgetedWorkspaceBundle(tmpDir, {
      mode: 'CODING_FOCUSED',
      explicitTargets: ['mcp/server.js']
    });

    assert.ok(built.receipt.targetsIncluded.includes('mcp/server.js'));
    assert.deepEqual(built.receipt.targetsMissing, []);
    assert.ok(built.content.includes('// SERVER_TAIL_UNCOMPACTED_SENTINEL'));
    assert.ok(!/--- FILE: mcp\/server\.js[^\n]*summarized=true/.test(built.content));
    assert.ok(!built.files.includes('scratch/inspect_cdp.js'));

    const copilotIdx = built.files.indexOf('mcp/engines/copilot_engine.js');
    const domWaitIdx = built.files.indexOf('mcp/pipeline/dom_liveness_wait.js');
    const relatedTestIdx = built.files.indexOf('mcp/tests/server_contract.test.js');
    const unrelatedTestIdx = built.files.indexOf('mcp/tests/unrelated.test.js');

    assert.ok(copilotIdx !== -1 && domWaitIdx !== -1 && relatedTestIdx !== -1 && unrelatedTestIdx !== -1);
    assert.ok(copilotIdx < unrelatedTestIdx, 'Production copilot_engine.js must rank before unrelated.test.js');
    assert.ok(domWaitIdx < unrelatedTestIdx, 'Production dom_liveness_wait.js must rank before unrelated.test.js');
    assert.ok(relatedTestIdx < unrelatedTestIdx, 'Target-related test must rank before unrelated.test.js');

    const exchangeDir = path.join(tmpDir, '.antigravity', 'bridge', 'exchange');
    fs.mkdirSync(exchangeDir, { recursive: true });
    fs.writeFileSync(path.join(exchangeDir, 'plan.md'), '### ALLOWED_FILES\nFILE_TARGET: mcp/server.js\n', 'utf8');
    const packed = packWorkspace(tmpDir, 'CODING_FOCUSED');
    assert.ok(packed.receipt.targetsIncluded.includes('mcp/server.js'));
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('offloadExternalSpecsFromPrompt offloads >5k specs for Gemini (.txt) and Copilot (.md) with unique 6-char hash prefixes', () => {
  const srv = loadServerForTest();
  assert.equal(typeof srv.offloadExternalSpecsFromPrompt, 'function');

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'batch0_spec_offload_'));
  try {
    const bodyA = 'A'.repeat(14000);
    const bodyB = 'B'.repeat(15000);
    const prompt = [
      'HEADER',
      '=== DOKUMENTI I PLOTE I SPECIFIKIMEVE NGA PERDORUESI: phase2_antigravity_sources.txt ===',
      bodyA,
      '=== FUNDI I SPECIFIKIMEVE (ZBATIM 100% I DETYRUESHEM, ZERO-FAKE, ZERO-PLACEHOLDERS) ===',
      '=== DOKUMENTI I PLOTE I SPECIFIKIMEVE NGA PERDORUESI: phase2_hermes_sources.txt ===',
      bodyB,
      '=== FUNDI I SPECIFIKIMEVE (ZBATIM 100% I DETYRUESHEM, ZERO-FAKE, ZERO-PLACEHOLDERS) ==='
    ].join('\n');

    const gemOut = srv.offloadExternalSpecsFromPrompt(prompt, tmpDir, true);
    assert.equal(gemOut.filesToUpload.length, 2);
    const gemNames = gemOut.filesToUpload.map((f) => path.basename(f));
    assert.ok(gemNames.every((n) => /^[0-9a-f]{6}_.*\.txt$/.test(n)), 'Gemini offloaded specs must use <6hex>_<name>.txt: ' + gemNames.join(','));
    assert.notEqual(gemNames[0].slice(0, 6), gemNames[1].slice(0, 6));
    assert.ok(gemOut.combinedText.length < 2000);
    assert.ok(gemOut.filesToUpload.every((f) => fs.existsSync(f)));

    const copOut = srv.offloadExternalSpecsFromPrompt(prompt, tmpDir, false);
    assert.equal(copOut.filesToUpload.length, 2);
    const copNames = copOut.filesToUpload.map((f) => path.basename(f));
    assert.ok(copNames.every((n) => /^[0-9a-f]{6}_.*\.md$/.test(n)), 'Copilot offloaded specs must use <6hex>_<name>.md: ' + copNames.join(','));
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('offloadExternalSpecsFromPrompt and resolveAndEmbedExternalFiles never truncate on embedded JS marker literals (boundary and legacy)', () => {
  const srv = loadServerForTest();
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'batch1_spec_regression_'));
  try {
    assert.deepEqual(srv.offloadExternalSpecsFromPrompt(null, tmpDir, true), { combinedText: '', filesToUpload: [] });
    assert.deepEqual(srv.offloadExternalSpecsFromPrompt('', tmpDir, true), { combinedText: '', filesToUpload: [] });
    assert.deepEqual(srv.offloadExternalSpecsFromPrompt(12345, tmpDir, true), { combinedText: '', filesToUpload: [] });
    assert.equal(resolveAndEmbedExternalFiles(null), '');
    assert.equal(resolveAndEmbedExternalFiles(''), '');

    const shortPrompt = 'HEADER\n=== DOKUMENTI I PLOTE I SPECIFIKIMEVE NGA PERDORUESI: short.txt ===\n' + 'x'.repeat(2000) + '\n=== FUNDI I SPECIFIKIMEVE ===';
    const shortOut = srv.offloadExternalSpecsFromPrompt(shortPrompt, tmpDir, true);
    assert.equal(shortOut.filesToUpload.length, 0);
    assert.equal(shortOut.combinedText, shortPrompt);

    const specFilePath = path.join(tmpDir, 'specifikim_shqip_ë_ç.txt');
    const jsBodyWithMarkers = [
      '// autopilot_engine.js excerpt (ë, ç, hapësira)',
      'function resolveAndEmbedExternalFiles() {',
      "  const end = '=== FUNDI I SPECIFIKIMEVE (ZBATIM 100% I DETYRUESHEM, ZERO-FAKE, ZERO-PLACEHOLDERS) ===';",
      '  return end;',
      '}',
      '=== FUNDI I SPECIFIKIMEVE (ZBATIM 100% I DETYRUESHEM, ZERO-FAKE, ZERO-PLACEHOLDERS) ===',
      '// ' + 'P'.repeat(14000),
      '// COPILOT_ENGINE_TAIL_MARKER_100PCT',
      '// ' + 'Q'.repeat(14000),
      '// GEMINI_ENGINE_TAIL_MARKER_100PCT',
      '// DOM_LIVENESS_TAIL_MARKER_100PCT'
    ].join('\r\n');
    fs.writeFileSync(specFilePath, jsBodyWithMarkers, 'utf8');

    const embedded = resolveAndEmbedExternalFiles('Analizo skedarin "' + specFilePath + '"');
    assert.match(embedded, /\[BOUNDARY:[a-f0-9]{8}\] ===/);
    assert.match(embedded, /=== FUNDI I SPECIFIKIMEVE \[BOUNDARY:[a-f0-9]{8}\]/);

    const boundaryPrompt = 'HEADER\n' + embedded + '\nFOOTER';
    const boundaryOut = srv.offloadExternalSpecsFromPrompt(boundaryPrompt, tmpDir, true);
    assert.equal(boundaryOut.filesToUpload.length, 1);
    assert.ok(!boundaryOut.combinedText.includes('COPILOT_ENGINE_TAIL_MARKER_100PCT'));
    assert.ok(!boundaryOut.combinedText.includes('DOM_LIVENESS_TAIL_MARKER_100PCT'));
    const writtenBoundary = fs.readFileSync(boundaryOut.filesToUpload[0], 'utf8');
    assert.equal(writtenBoundary, jsBodyWithMarkers);
    assert.ok(writtenBoundary.includes('ë, ç'));
    assert.ok(writtenBoundary.includes('\r\n'));
    assert.ok(writtenBoundary.includes('COPILOT_ENGINE_TAIL_MARKER_100PCT'));
    assert.ok(writtenBoundary.includes('GEMINI_ENGINE_TAIL_MARKER_100PCT'));
    assert.ok(writtenBoundary.includes('DOM_LIVENESS_TAIL_MARKER_100PCT'));

    const legacyJsBody = [
      '// autopilot_engine.js excerpt',
      'function resolveAndEmbedExternalFiles() {',
      "                    '=== FUNDI I SPECIFIKIMEVE (ZBATIM 100% I DETYRUESHEM, ZERO-FAKE, ZERO-PLACEHOLDERS) ===';",
      '}',
      '// ' + 'R'.repeat(14000),
      '// LEGACY_COPILOT_TAIL_MARKER_100PCT',
      '// ' + 'S'.repeat(14000),
      '// LEGACY_DOM_LIVENESS_TAIL_MARKER_100PCT'
    ].join('\n');
    const legacyPrompt = [
      'HEADER',
      '=== DOKUMENTI I PLOTE I SPECIFIKIMEVE NGA PERDORUESI: phase2_antigravity_sources.txt ===',
      legacyJsBody,
      '=== FUNDI I SPECIFIKIMEVE (ZBATIM 100% I DETYRUESHEM, ZERO-FAKE, ZERO-PLACEHOLDERS) ==='
    ].join('\n');
    const legacyOut = srv.offloadExternalSpecsFromPrompt(legacyPrompt, tmpDir, true);
    assert.equal(legacyOut.filesToUpload.length, 1);
    assert.ok(!legacyOut.combinedText.includes('LEGACY_COPILOT_TAIL_MARKER_100PCT'));
    const writtenLegacy = fs.readFileSync(legacyOut.filesToUpload[0], 'utf8');
    assert.equal(writtenLegacy, legacyJsBody);
    assert.ok(writtenLegacy.includes('LEGACY_COPILOT_TAIL_MARKER_100PCT'));
    assert.ok(writtenLegacy.includes('LEGACY_DOM_LIVENESS_TAIL_MARKER_100PCT'));
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});
