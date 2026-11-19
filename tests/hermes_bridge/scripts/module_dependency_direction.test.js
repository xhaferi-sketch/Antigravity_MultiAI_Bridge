'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');

const PROJECT_ROOT = path.resolve(__dirname, '../../..');
const MCP_DIR = path.join(PROJECT_ROOT, 'mcp');

const PRODUCTION_MODULES = [
  'server.js',
  'engines/google_search_engine.js',
  'engines/copilot_engine.js',
  'engines/gemini_engine.js',
  'pipeline/autopilot_engine.js',
  'pipeline/local_executor.js'
];

function extractRequires(filePath) {
  const code = fs.readFileSync(filePath, 'utf8');
  const requireRegex = /require\s*\(\s*['"]([^'"]+)['"]\s*\)/g;
  const requires = [];
  let m;
  while ((m = requireRegex.exec(code)) !== null) {
    requires.push(m[1]);
  }
  return requires;
}

test('WO-MOD-7: Architecture - Zero reverse imports to mcp/server.js', () => {
  const extracted = PRODUCTION_MODULES.filter(m => m !== 'server.js');
  for (const rel of extracted) {
    const full = path.join(MCP_DIR, rel);
    const reqs = extractRequires(full);
    const hasServerImport = reqs.some(r => /server(\.js)?$/.test(r) || r.includes('server'));
    assert.equal(hasServerImport, false, `Module ${rel} must NOT import server.js (found: ${reqs.join(', ')})`);
  }
});

test('WO-MOD-7: Architecture - Zero peer imports between engines', () => {
  const engineFiles = [
    'engines/google_search_engine.js',
    'engines/copilot_engine.js',
    'engines/gemini_engine.js'
  ];
  for (const rel of engineFiles) {
    const full = path.join(MCP_DIR, rel);
    const reqs = extractRequires(full);
    const hasPeerImport = reqs.some(r =>
      r.includes('google_search_engine') ||
      r.includes('copilot_engine') ||
      r.includes('gemini_engine')
    );
    assert.equal(hasPeerImport, false, `Engine ${rel} must NOT import any peer engine (found: ${reqs.join(', ')})`);
  }
});

test('WO-MOD-7: Architecture - Autopilot engine has zero direct engine imports', () => {
  const full = path.join(MCP_DIR, 'pipeline/autopilot_engine.js');
  const reqs = extractRequires(full);
  const hasEngineImport = reqs.some(r => r.includes('engines/'));
  assert.equal(hasEngineImport, false, `autopilot_engine.js must receive engines via runtimeContext, not direct imports (found: ${reqs.join(', ')})`);
});

test('WO-MOD-7: Architecture - Local executor is independent leaf module', () => {
  const full = path.join(MCP_DIR, 'pipeline/local_executor.js');
  const reqs = extractRequires(full);
  const nonNodeReqs = reqs.filter(r => !r.startsWith('node:'));
  assert.equal(nonNodeReqs.length, 0, `local_executor.js must only import node builtins (found: ${reqs.join(', ')})`);
});

test('WO-MOD-7: Architecture - Dependency graph is strictly acyclic DAG', () => {
  const adj = {};
  for (const rel of PRODUCTION_MODULES) {
    const full = path.join(MCP_DIR, rel);
    const reqs = extractRequires(full);
    adj[rel] = reqs
      .filter(r => r.startsWith('.'))
      .map(r => {
        const resolved = path.normalize(path.join(path.dirname(full), r));
        return path.relative(MCP_DIR, resolved).replace(/\\/g, '/');
      });
  }

  // Detect cycle via DFS
  const visited = {};
  const recStack = {};

  function isCyclic(v) {
    visited[v] = true;
    recStack[v] = true;
    const neighbors = adj[v] || [];
    for (const n of neighbors) {
      if (!visited[n] && isCyclic(n)) return true;
      if (recStack[n]) return true;
    }
    recStack[v] = false;
    return false;
  }

  for (const mod of PRODUCTION_MODULES) {
    if (!visited[mod]) {
      assert.equal(isCyclic(mod), false, `Circular dependency detected involving ${mod}`);
    }
  }
});
