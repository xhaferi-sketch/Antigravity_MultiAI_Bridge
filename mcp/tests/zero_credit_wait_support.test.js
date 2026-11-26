'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const PROJECT_ROOT = path.resolve(__dirname, '..', '..');

test('rules and run-cycle skill enforce zero-timer / zero-polling 1-wakeup wait for Web 1, Web 2, Web 3, and check_cycle_progress', () => {
  const files = [
    path.join(PROJECT_ROOT, 'rules', 'AGENTS.md'),
    path.join(PROJECT_ROOT, 'agents', 'orchestrator.md'),
    path.join(PROJECT_ROOT, 'skills', 'run-cycle', 'SKILL.md')
  ];
  for (const filePath of files) {
    const text = fs.readFileSync(filePath, 'utf8');
    assert.match(text, /schedule/i, `${path.basename(filePath)} must explicitly forbid schedule timers`);
    assert.match(text, /run_planner.*Web 1|Web 1.*run_planner/i, `${path.basename(filePath)} must cover Web 1`);
    assert.match(text, /run_coder.*Web 2|Web 2.*run_coder/i, `${path.basename(filePath)} must cover Web 2`);
    assert.match(text, /run_reviewer.*Web 3|Web 3.*run_reviewer/i, `${path.basename(filePath)} must cover Web 3`);
    assert.match(text, /\/api\/mcp-proxy/, `${path.basename(filePath)} must document single-wakeup /api/mcp-proxy background wait`);
    assert.match(text, /blocking:\s*true/, `${path.basename(filePath)} must document blocking: true wait`);
  }
});

test('server.js and checkCycleProgress support full-completion blocking wait without waking every 45s', async () => {
  const serverSource = fs.readFileSync(path.join(PROJECT_ROOT, 'mcp', 'server.js'), 'utf8');
  assert.match(serverSource, /payload\.blocking\s*===\s*true[\s\S]{0,120}3600000/);
  assert.match(serverSource, /reqPath\s*===\s*'\/check_cycle_progress'[\s\S]{0,300}blocking:\s*data\.blocking\s*===\s*true/);
  assert.match(serverSource, /httpServer\.requestTimeout\s*=\s*0;/);
  assert.match(serverSource, /httpServer\.setTimeout\(0\);/);

  const { createAutopilotEngine } = require(path.join(PROJECT_ROOT, 'mcp', 'pipeline', 'autopilot_engine.js'));
  const tmp = fs.mkdtempSync(path.join(require('node:os').tmpdir(), 'ag-blocking-wait-'));
  try {
    const engine = createAutopilotEngine({
      sleepFn: (ms) => new Promise((r) => setTimeout(r, Math.min(ms, 20)))
    });
    const resolved = path.resolve(tmp);
    engine.activeCycleJobs[resolved] = {
      running: true,
      phase: 'CODING_BATCH',
      startedAt: Date.now(),
      promise: Promise.resolve()
    };
    setTimeout(() => {
      engine.activeCycleJobs[resolved].running = false;
      engine.activeCycleJobs[resolved].result = { status: 'CYCLE_COMPLETED', verdict: 'PASSED' };
    }, 35);

    const out = await engine.checkCycleProgress(tmp, 3600000);
    assert.equal(out.status, 'CYCLE_COMPLETED');
    assert.equal(out.verdict, 'PASSED');
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
});
