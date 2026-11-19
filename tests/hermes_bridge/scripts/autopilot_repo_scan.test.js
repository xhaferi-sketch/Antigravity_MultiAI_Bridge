'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');

const PROJECT_ROOT = path.resolve(__dirname, '../../..');
const AUTOPILOT_PATH = path.join(PROJECT_ROOT, 'mcp', 'pipeline', 'autopilot_engine.js');

const {
  scanRepositoryUniversal,
  buildDependencyGraph,
  buildCompactRepoMap,
  CHUNK_ENGINE_LIMITS
} = require(AUTOPILOT_PATH);

test('scanRepositoryUniversal scans repository files and produces deterministic repoFingerprint', () => {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'hermes_scan_test_'));
  try {
    fs.mkdirSync(path.join(tmpDir, 'src'), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, 'node_modules'), { recursive: true });
    fs.mkdirSync(path.join(tmpDir, '.git'), { recursive: true });

    fs.writeFileSync(path.join(tmpDir, 'src', 'index.js'), 'const a = require("./util");\nmodule.exports = { a };\n', 'utf8');
    fs.writeFileSync(path.join(tmpDir, 'src', 'util.js'), 'module.exports = 42;\n', 'utf8');
    fs.writeFileSync(path.join(tmpDir, 'package.json'), '{"name":"test"}\n', 'utf8');
    fs.writeFileSync(path.join(tmpDir, 'node_modules', 'foo.js'), 'module.exports = 1;\n', 'utf8');

    const scan = scanRepositoryUniversal(tmpDir);

    assert.equal(typeof scan.repoFingerprint, 'string');
    assert.equal(scan.repoFingerprint.length, 64);
    assert.equal(scan.files.length, 3); // index.js, util.js, package.json

    const filePaths = scan.files.map(f => f.path);
    assert.ok(filePaths.includes('src/index.js'));
    assert.ok(filePaths.includes('src/util.js'));
    assert.ok(filePaths.includes('package.json'));
    assert.ok(!filePaths.some(p => p.includes('node_modules')));

    // Excluded directory checked
    assert.ok(scan.excluded.some(e => e.path === 'node_modules' && e.reason === 'IGNORED_DIRECTORY'));
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('buildDependencyGraph resolves relative dependencies and records unresolved specifiers', () => {
  const mockScan = {
    files: [
      { path: 'src/app.js', imports: ['./service', 'express', './missing'] },
      { path: 'src/service.js', imports: ['./db'] },
      { path: 'src/db.js', imports: [] }
    ]
  };

  const graph = buildDependencyGraph(mockScan);
  assert.equal(graph.nodes.length, 3);
  assert.equal(graph.edges.length, 2);

  // Directed edges: app -> service, service -> db
  assert.deepEqual(graph.edges, [
    { from: 'src/app.js', to: 'src/service.js' },
    { from: 'src/service.js', to: 'src/db.js' }
  ]);

  // Unresolved edges include non-relative 'express' and non-existent './missing'
  assert.equal(graph.unresolved.length, 2);
  assert.ok(graph.unresolved.some(u => u.specifier === 'express'));
  assert.ok(graph.unresolved.some(u => u.specifier === './missing'));
});

test('buildCompactRepoMap respects repoMapHard budget and generates structured map', () => {
  const mockScan = {
    projectRoot: '/test',
    files: [
      {
        path: 'src/main.js',
        language: 'JavaScript',
        bytes: 120,
        symbols: ['startServer', 'PORT'],
        imports: ['./lib'],
        entryPointSignals: true,
        testSignals: false,
        configSignals: false
      },
      {
        path: 'src/lib.js',
        language: 'JavaScript',
        bytes: 80,
        symbols: ['helper'],
        imports: [],
        entryPointSignals: false,
        testSignals: false,
        configSignals: false
      }
    ],
    excluded: [{ path: 'temp', reason: 'IGNORED_DIRECTORY' }],
    totalBytes: 200,
    repoFingerprint: 'mock_fingerprint_0123456789abcdef'
  };

  const limits = { repoMapHard: 1024 };
  const repoMap = buildCompactRepoMap(mockScan, limits);

  assert.ok(repoMap.bytes <= limits.repoMapHard);
  assert.equal(typeof repoMap.sha256, 'string');
  assert.ok(repoMap.text.includes('PROJECT SUMMARY'));
  assert.ok(repoMap.text.includes('ENTRY POINTS'));
  assert.ok(repoMap.text.includes('src/main.js'));
  assert.ok(repoMap.text.includes('DEPENDENCY EDGES'));
  assert.ok(repoMap.text.includes('src/main.js -> src/lib.js'));
});
