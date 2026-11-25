'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const {
  parseRootDirectiveAndRequest,
  readRegistryState,
  setActiveRegistryProject,
  pickDefaultActiveProjectRoot
} = require('../pipeline/target_path_utils.js');
const { resolveAndEmbedExternalFiles } = require('../pipeline/autopilot_engine.js');

test('parseRootDirectiveAndRequest extracts quoted root path with spaces and keeps work order path', () => {
  const res = parseRootDirectiveAndRequest(
    'root "C:\\Some Path\\My App" "C:\\Docs Folder\\work order.md"'
  );
  assert.equal(res.extractedRoot, path.resolve('C:\\Some Path\\My App'));
  assert.equal(res.cleanedRequest, '"C:\\Docs Folder\\work order.md"');
});

test('parseRootDirectiveAndRequest extracts unquoted existing directory with spaces before spec path', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-root-test-'));
  const projDir = path.join(tmp, 'My Project With Spaces', 'App');
  const specFile = path.join(tmp, 'spec file with spaces.md');
  fs.mkdirSync(projDir, { recursive: true });
  fs.writeFileSync(specFile, '# Universal Work Order\nBuild feature X', 'utf8');

  const rawPrompt = `root ${projDir} "${specFile}"`;
  const parsed = parseRootDirectiveAndRequest(rawPrompt);
  assert.equal(parsed.extractedRoot, path.resolve(projDir));
  assert.equal(parsed.cleanedRequest, `"${specFile}"`);

  const embedded = resolveAndEmbedExternalFiles(parsed.cleanedRequest);
  assert.ok(embedded.includes('Build feature X'));
});

test('setActiveRegistryProject and pickDefaultActiveProjectRoot prioritize explicit Dashboard activeProject over bridge root', () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ag-reg-test-'));
  const bridgeRoot = path.join(tmp, 'Bridge');
  const projA = path.join(tmp, 'ProjA');
  const projB = path.join(tmp, 'ProjB');
  fs.mkdirSync(bridgeRoot);
  fs.mkdirSync(projA);
  fs.mkdirSync(projB);

  const regPath = path.join(tmp, 'projects_registry.json');
  fs.writeFileSync(regPath, JSON.stringify({ projects: [bridgeRoot, projA, projB] }), 'utf8');

  setActiveRegistryProject(regPath, projA);
  const reg = readRegistryState(regPath);
  assert.equal(reg.activeProject, path.resolve(projA));
  assert.equal(pickDefaultActiveProjectRoot(reg, bridgeRoot), path.resolve(projA));
});
