'use strict';
 
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
 
const PROJECT_ROOT = path.resolve(__dirname, '..', '..', '..');
const SERVER_PATH = path.join(PROJECT_ROOT, 'mcp', 'server.js');
 
const EXPECTED_TOOLS = Object.freeze({
  run_full_cycle: ['projectRoot', 'userRequest'],
  check_cycle_progress: ['projectRoot'],
  pack_workspace: ['projectRoot'],
  run_planner: ['projectRoot', 'userRequest'],
  run_coder: ['projectRoot'],
  apply_and_test: ['projectRoot'],
  run_reviewer: ['projectRoot']
});
 
function sourceText() {
  assert.ok(fs.existsSync(SERVER_PATH), `Missing ${SERVER_PATH}`);
  return fs.readFileSync(SERVER_PATH, 'utf8');
}
 
function extractBalanced(source, startIndex, openChar, closeChar) {
  let depth = 0;
  let quote = '';
  let escaped = false;
  let lineComment = false;
  let blockComment = false;
 
  for (let index = startIndex; index < source.length; index += 1) {
    const char = source[index];
    const next = source[index + 1];
 
    if (lineComment) {
      if (char === '\n') lineComment = false;
      continue;
    }
 
    if (blockComment) {
      if (char === '*' && next === '/') {
        blockComment = false;
        index += 1;
      }
      continue;
    }
 
    if (quote) {
      if (escaped) {
        escaped = false;
      } else if (char === '\\') {
        escaped = true;
      } else if (char === quote) {
        quote = '';
      }
      continue;
    }
 
    if (char === '/' && next === '/') {
      lineComment = true;
      index += 1;
      continue;
    }
 
    if (char === '/' && next === '*') {
      blockComment = true;
      index += 1;
      continue;
    }
 
    if (char === '"' || char === '\'' || char === '`') {
      quote = char;
      continue;
    }
 
    if (char === openChar) depth += 1;
    if (char === closeChar) {
      depth -= 1;
      if (depth === 0) {
        return source.slice(startIndex, index + 1);
      }
    }
  }
 
  throw new Error(`Unbalanced ${openChar}${closeChar} block`);
}
 
function listToolsHandlerSource(source) {
  const marker = 'mcpServer.setRequestHandler(ListToolsRequestSchema';
  const index = source.indexOf(marker);
  assert.notEqual(index, -1, 'ListTools request handler is missing');
 
  const functionStart = source.indexOf('function', index);
  const bodyStart = source.indexOf('{', functionStart);
  return extractBalanced(source, bodyStart, '{', '}');
}
 
function callToolsHandlerSource(source) {
  const marker = 'mcpServer.setRequestHandler(CallToolRequestSchema';
  const index = source.indexOf(marker);
  assert.notEqual(index, -1, 'CallTool request handler is missing');
 
  const functionStart = source.indexOf('function', index);
  const bodyStart = source.indexOf('{', functionStart);
  return extractBalanced(source, bodyStart, '{', '}');
}
 
function parseToolObjects(handlerSource) {
  const toolsIndex = handlerSource.indexOf('tools:');
  assert.notEqual(toolsIndex, -1, 'ListTools handler has no tools array');

  const arrayStart = handlerSource.indexOf('[', toolsIndex);
  const arrayText = extractBalanced(handlerSource, arrayStart, '[', ']');

  const tools = [];
  const objectPattern =
    /\{\s*name:\s*['"]([^'"]+)['"][\s\S]*?inputSchema:\s*\{[\s\S]*?required:\s*\[([^\]]*)\][\s\S]*?\}\s*\}/g;

  let match;
  while ((match = objectPattern.exec(arrayText)) !== null) {
    const required = [...match[2].matchAll(/['"]([^'"]+)['"]/g)]
      .map((requiredMatch) => requiredMatch[1])
      .sort();

    tools.push({
      name: match[1],
      required
    });
  }

  return tools;
}
 
test('exactly seven baseline MCP tools are registered', () => {
  const tools = parseToolObjects(listToolsHandlerSource(sourceText()));
  assert.equal(tools.length, 7);
 
  const actualNames = tools.map((tool) => tool.name).sort();
  const expectedNames = Object.keys(EXPECTED_TOOLS).sort();
 
  assert.deepEqual(actualNames, expectedNames);
});
 
test('MCP required input fields match the frozen baseline', () => {
  const tools = parseToolObjects(listToolsHandlerSource(sourceText()));
  const actual = Object.fromEntries(
    tools.map((tool) => [tool.name, tool.required])
  );
 
  const expected = Object.fromEntries(
    Object.entries(EXPECTED_TOOLS).map(([name, fields]) => [
      name,
      [...fields].sort()
    ])
  );
 
  assert.deepEqual(actual, expected);
});
 
test('call handler delegates the requested tool name and arguments unchanged', () => {
  const handler = callToolsHandlerSource(sourceText());
 
  assert.match(
    handler,
    /const\s+name\s*=\s*request\.params\.name\s*;/
  );
  assert.match(
    handler,
    /const\s+args\s*=\s*request\.params\.arguments\s*;/
  );
  assert.match(
    handler,
    /dispatchActionSingleton\s*\(\s*name\s*,\s*args\s*\)/
  );
});
 
test('MCP errors preserve the support-required response contract', () => {
  const handler = callToolsHandlerSource(sourceText());
 
  assert.match(handler, /isError:\s*true/);
  assert.match(handler, /SUPPORT_REQUIRED_STOP_IMMEDIATELY/);
  assert.match(handler, /directive:/);
  assert.match(handler, /details:\s*err\.message/);
});
 
test('cycle-exclusive lock blocks side actions while a cycle is active', () => {
  const source = sourceText();
 
  assert.match(
    source,
    /action\s*!==\s*['"]run_full_cycle['"][\s\S]*action\s*!==\s*['"]check_cycle_progress['"]/
  );
  assert.match(
    source,
    /activeCycleJobs\s*\[\s*cleanRoot\s*\][\s\S]*\.running/
  );
  assert.match(source, /ACTION_REJECTED_CYCLE_IN_PROGRESS/);
});
 
test('executeCoreAction contains every baseline action dispatch branch', () => {
  const source = sourceText();
  const executeIndex = source.indexOf('async function executeCoreAction');
  assert.notEqual(executeIndex, -1);
 
  const bodyStart = source.indexOf('{', executeIndex);
  const body = extractBalanced(source, bodyStart, '{', '}');
 
  for (const toolName of Object.keys(EXPECTED_TOOLS)) {
    assert.match(
      body,
      new RegExp(`action\\s*===\\s*['"]${toolName}['"]`),
      `executeCoreAction is missing ${toolName}`
    );
  }
});