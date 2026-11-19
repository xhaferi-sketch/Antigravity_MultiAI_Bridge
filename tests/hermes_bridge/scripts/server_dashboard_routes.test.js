'use strict';
 
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
 
const PROJECT_ROOT = path.resolve(__dirname, '..', '..', '..');
const SERVER_PATH = path.join(PROJECT_ROOT, 'mcp', 'server.js');
 
const EXPECTED_ROUTES = Object.freeze([
  { method: 'GET', path: '/' },
  { method: 'GET', path: '/api/state' },
  { method: 'POST', path: '/api/save-routing' },
  { method: 'POST', path: '/api/add-project' },
  { method: 'POST', path: '/api/delete-project' },
  { method: 'POST', path: '/api/purge-exchange' },
  { method: 'POST', path: '/api/reset-tab' },
  { method: 'POST', path: '/api/login-profile' },
  { method: 'POST', path: '/api/kill-all' },
  { method: 'POST', path: '/api/mcp-proxy' }
]);
 
function sourceText() {
  assert.ok(fs.existsSync(SERVER_PATH), `Missing ${SERVER_PATH}`);
  return fs.readFileSync(SERVER_PATH, 'utf8');
}
 
function routeInventory(source) {
  const routes = [];

  const getPattern =
    /req\.method\s*===\s*['"]GET['"]\s*&&\s*req\.url\s*===\s*['"]([^'"]+)['"]/g;
  let match;

  while ((match = getPattern.exec(source)) !== null) {
    routes.push({ method: 'GET', path: match[1] });
  }

  const postPattern = /req\.url\s*===\s*['"]([^'"]+)['"]/g;
  while ((match = postPattern.exec(source)) !== null) {
    const routePath = match[1];
    if (!routes.some((route) => route.path === routePath)) {
      routes.push({ method: 'POST', path: routePath });
    }
  }

  return routes.sort((left, right) =>
    `${left.method} ${left.path}`.localeCompare(
      `${right.method} ${right.path}`
    )
  );
}
 
test('production dashboard defaults remain 127.0.0.1:4321', () => {
  const source = sourceText();
 
  assert.match(source, /const\s+PORT\s*=\s*4321\s*;/);
  assert.match(source, /const\s+HOST\s*=\s*['"]127\.0\.0\.1['"]\s*;/);
  assert.match(
    source,
    /httpServer\.listen\s*\(\s*PORT\s*,\s*HOST\s*,/
  );
});
 
test('dashboard baseline route set is unchanged', () => {
  const actual = routeInventory(sourceText());
  const expected = [...EXPECTED_ROUTES].sort((left, right) =>
    `${left.method} ${left.path}`.localeCompare(
      `${right.method} ${right.path}`
    )
  );
 
  assert.deepEqual(actual, expected);
});
 
test('root and state routes retain expected response content types', () => {
  const source = sourceText();
 
  assert.match(
    source,
    /req\.method\s*===\s*['"]GET['"]\s*&&\s*req\.url\s*===\s*['"]\/['"][\s\S]*?Content-Type['"]?\s*:\s*['"]text\/html;\s*charset=utf-8['"]/
  );
 
  assert.match(
    source,
    /req\.method\s*===\s*['"]GET['"]\s*&&\s*req\.url\s*===\s*['"]\/api\/state['"][\s\S]*?Content-Type['"]?\s*:\s*['"]application\/json['"]/
  );
});
 
test('/api/mcp-proxy delegates action and payload through executeCoreAction', () => {
  const source = sourceText();
 
  assert.match(
    source,
    /req\.url\s*===\s*['"]\/api\/mcp-proxy['"][\s\S]*?executeCoreAction\s*\(\s*data\.action\s*,\s*data\.payload\s*\)/
  );
});
 
test('/api/state reflects shared project, tab, model, receipt, and active-project state', () => {
  const source = sourceText();
 
  const requiredStateSignals = [
    'REGISTRY_PATH',
    'ensureProjectSetup(p)',
    'readProjectState(p)',
    'activeCycleJobs[path.resolve(p)]',
    'tabAuthStatus[k]',
    'tabActiveModel[k]',
    'geminiModelReceipts[k]',
    'tabDiscoveredModels[k]',
    'activeProjectPerTab[k]'
  ];
 
  const missing = requiredStateSignals.filter(
    (signal) => !source.includes(signal)
  );
 
  assert.deepEqual(missing, []);
});
 
test('project mutation routes canonicalize project roots and use existing constrained helpers', () => {
  const source = sourceText();
 
  assert.match(
    source,
    /\/api\/save-routing[\s\S]*ensureProjectSetup\s*\(\s*data\.projectRoot\s*\)/
  );
  assert.match(
    source,
    /\/api\/save-routing[\s\S]*path\.resolve\s*\(\s*data\.projectRoot\s*\)/
  );
  assert.match(
    source,
    /\/api\/add-project[\s\S]*ensureProjectSetup\s*\(\s*data\.projectRoot\s*\)/
  );
  assert.match(
    source,
    /\/api\/delete-project[\s\S]*path\.resolve\s*\(\s*data\.projectRoot\s*\|\|\s*data\.project_id/
  );
  assert.match(
    source,
    /\/api\/purge-exchange[\s\S]*path\.resolve\s*\(\s*data\.projectRoot/
  );
  assert.match(
    source,
    /\/api\/purge-exchange[\s\S]*purgeExchangeArtifacts/
  );
});
 
test('login route resolves both the engine profile and its canonical target URL', () => {
  const source = sourceText();
 
  assert.match(
    source,
    /\/api\/login-profile[\s\S]*getProfileNameForTab\s*\(\s*reqName\s*\)/
  );
  assert.match(
    source,
    /\/api\/login-profile[\s\S]*getTargetUrl\s*\(\s*reqName\s*\)/
  );
  assert.match(
    source,
    /\/api\/login-profile[\s\S]*getOrLaunchContext\s*\(\s*profile\s*,\s*false\s*\)/
  );
  assert.match(
    source,
    /\/api\/login-profile[\s\S]*loginPage\.goto\s*\(\s*targetUrl/
  );
});
 
test('server startup is disabled in ANTIGRAVITY_TEST_EXPORT mode', () => {
  const source = sourceText();
 
  assert.match(
    source,
    /if\s*\(\s*process\.env\.ANTIGRAVITY_TEST_EXPORT\s*!==\s*['"]1['"]\s*\)\s*startDashboardAndSingletonServer\s*\(\s*\)\s*;/
  );
});