'use strict';

const fs = require('node:fs');
const path = require('node:path');

const DEFAULT_LOCKS_PATH = path.resolve(__dirname, '..', '..', '.antigravity', 'bridge', 'model_locks.json');
const ALL_LOCKABLE_TABS = Object.freeze(['gemini1', 'gemini2', 'gemini3', 'web1', 'web2']);

function resolveLocksPath(locksPath) {
  if (locksPath) return path.resolve(String(locksPath));
  if (process.env.ANTIGRAVITY_MODEL_LOCKS_PATH) {
    return path.resolve(String(process.env.ANTIGRAVITY_MODEL_LOCKS_PATH));
  }
  return DEFAULT_LOCKS_PATH;
}

function escapeRegExp(str) {
  return String(str || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function readModelLocks(locksPath) {
  const filePath = resolveLocksPath(locksPath);
  if (!fs.existsSync(filePath)) {
    return { version: 1, locks: {} };
  }
  try {
    const raw = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    if (raw && typeof raw === 'object' && raw.locks && typeof raw.locks === 'object') {
      return { version: Number(raw.version || 1), locks: Object.assign({}, raw.locks) };
    }
  } catch (_) {}
  return { version: 1, locks: {} };
}

function writeModelLocks(data, locksPath) {
  const filePath = resolveLocksPath(locksPath);
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const normalized = {
    version: 1,
    locks: (data && data.locks && typeof data.locks === 'object') ? data.locks : {},
    updatedAt: new Date().toISOString()
  };
  const tmpPath = filePath + '.' + process.pid + '.' + Date.now() + '.tmp';
  fs.writeFileSync(tmpPath, JSON.stringify(normalized, null, 2), 'utf8');
  fs.renameSync(tmpPath, filePath);
  return normalized;
}

function getTabModelLock(tabKey, locksPath) {
  const key = String(tabKey || '').trim();
  if (!key) return null;
  const store = readModelLocks(locksPath);
  const entry = store.locks[key];
  if (!entry || typeof entry !== 'object' || !entry.modelLabel) return null;
  return entry;
}

function setTabModelLock(tabKey, entry, locksPath) {
  const key = String(tabKey || '').trim();
  if (!key) throw new Error('TAB_KEY_REQUIRED');
  if (!entry || typeof entry !== 'object' || !String(entry.modelLabel || '').trim()) {
    throw new Error('MODEL_LABEL_REQUIRED');
  }
  const store = readModelLocks(locksPath);
  const modelLabel = String(entry.modelLabel).trim();
  const reasoningLabel = String(entry.reasoningLabel || '').trim();
  const reasoning = String(entry.reasoning || (reasoningLabel ? reasoningLabel.toLowerCase() : '')).trim();
  const displayLabel = String(
    entry.displayLabel || (reasoningLabel ? (modelLabel + ' (' + reasoningLabel + ')') : modelLabel)
  ).trim();

  store.locks[key] = {
    tabKey: key,
    engine: String(entry.engine || (key.startsWith('gemini') ? 'gemini' : 'copilot')),
    modelLabel: modelLabel,
    reasoningLabel: reasoningLabel,
    reasoning: reasoning,
    displayLabel: displayLabel,
    lockedByUser: true,
    updatedAt: new Date().toISOString()
  };
  writeModelLocks(store, locksPath);
  return store.locks[key];
}

function clearTabModelLock(tabKey, locksPath) {
  const key = String(tabKey || '').trim();
  const store = readModelLocks(locksPath);
  if (key && Object.prototype.hasOwnProperty.call(store.locks, key)) {
    delete store.locks[key];
    writeModelLocks(store, locksPath);
    return true;
  }
  return false;
}

function buildGeminiLockContract(tabKey, defaultContract, locksPath) {
  const userLock = getTabModelLock(tabKey, locksPath);
  if (!userLock) {
    return Object.assign({}, defaultContract, { customLocked: false });
  }
  const modelLabel = String(userLock.modelLabel || '').trim();
  const reasoningLabel = String(userLock.reasoningLabel || '').trim();
  const reasoning = String(userLock.reasoning || reasoningLabel || '').trim().toLowerCase();
  const modelToken = modelLabel.replace(/^[0-9.]+\s+/, '').trim() || modelLabel;

  const modelEsc = escapeRegExp(modelLabel).replace(/\s+/g, '\\s+');
  const tokenEsc = escapeRegExp(modelToken).replace(/\s+/g, '\\s+');
  const reasonEsc = reasoningLabel ? escapeRegExp(reasoningLabel).replace(/\s+/g, '\\s+') : '';
  const activePattern = reasonEsc
    ? ('(?:' + modelEsc + '|' + tokenEsc + ')[\\s\\S]{0,40}' + reasonEsc)
    : ('(?:' + modelEsc + '|' + tokenEsc + ')');

  return Object.freeze({
    family: 'user-locked',
    menuPattern: modelEsc + '|' + tokenEsc,
    activePattern: activePattern,
    menuLabel: modelLabel,
    modelLabel: modelLabel,
    displayLabel: userLock.displayLabel || modelLabel,
    reasoning: reasoning || 'custom',
    reasoningLabel: reasoningLabel,
    reasoningSource: reasoningLabel ? 'user-locked-submenu' : 'user-locked-model',
    customLocked: true
  });
}

function buildCopilotLockContract(tabKey, defaultContract, locksPath) {
  const userLock = getTabModelLock(tabKey, locksPath);
  if (!userLock) {
    return Object.assign({}, defaultContract, { customLocked: false });
  }
  const modelLabel = String(userLock.modelLabel || '').trim();
  const reasoningLabel = String(userLock.reasoningLabel || '').trim();
  const displayLabel = userLock.displayLabel || modelLabel;
  return Object.freeze({
    family: 'user-locked',
    modelLabel: modelLabel,
    displayLabel: displayLabel,
    reasoningLabel: reasoningLabel,
    reasoning: userLock.reasoning || 'custom',
    allowThinkDeeperFallback: false,
    customLocked: true
  });
}

module.exports = {
  DEFAULT_LOCKS_PATH,
  ALL_LOCKABLE_TABS,
  resolveLocksPath,
  readModelLocks,
  writeModelLocks,
  getTabModelLock,
  setTabModelLock,
  clearTabModelLock,
  buildGeminiLockContract,
  buildCopilotLockContract
};
