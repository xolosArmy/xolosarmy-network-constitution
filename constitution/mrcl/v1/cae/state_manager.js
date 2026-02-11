'use strict';

const fs = require('fs');
const path = require('path');

const { clamp } = require('./scorer');

const BASE_DIR = __dirname;
const STATE_DIR = path.join(BASE_DIR, 'state');
const REGISTRY_PATH = path.join(STATE_DIR, 'agent_registry.json');
const LOG_PATH = path.join(STATE_DIR, 'state_log.jsonl');
const LOCK_PATH = path.join(STATE_DIR, '.lock');
const SCHEMA_PATH = path.join(STATE_DIR, 'state_schema.json');
const PARAMS_PATH = path.join(BASE_DIR, '..', 'parameters.json');

const LOCK_RETRIES = 200;
const LOCK_WAIT_MS = 25;
const STATE_VERSION = '1.0.0';

function nowIso() {
  return new Date().toISOString();
}

function sleepSync(ms) {
  const sab = new SharedArrayBuffer(4);
  const i32 = new Int32Array(sab);
  Atomics.wait(i32, 0, 0, ms);
}

function withLock(fn) {
  fs.mkdirSync(STATE_DIR, { recursive: true });

  for (let i = 0; i < LOCK_RETRIES; i += 1) {
    try {
      const fd = fs.openSync(LOCK_PATH, 'wx');
      try {
        return fn();
      } finally {
        fs.closeSync(fd);
        fs.rmSync(LOCK_PATH, { force: true });
      }
    } catch (err) {
      if (err && err.code === 'EEXIST') {
        sleepSync(LOCK_WAIT_MS);
        continue;
      }
      throw err;
    }
  }

  throw new Error('state_manager lock timeout');
}

function readJsonSafe(filePath, fallback) {
  if (!fs.existsSync(filePath)) return fallback;
  const raw = fs.readFileSync(filePath, 'utf8');
  if (!raw.trim()) return fallback;
  return JSON.parse(raw);
}

function writeJsonAtomic(filePath, data) {
  const dir = path.dirname(filePath);
  const tmp = path.join(
    dir,
    `${path.basename(filePath)}.tmp-${process.pid}-${Date.now()}-${Math.random().toString(16).slice(2, 8)}`
  );

  fs.writeFileSync(tmp, data, 'utf8');
  fs.renameSync(tmp, filePath);
}

function defaultState() {
  return {
    version: STATE_VERSION,
    updated_at: nowIso(),
    agents: {}
  };
}

function defaultAgent(agentId, initFields = {}) {
  const ts = nowIso();
  return {
    agent_id: String(agentId),
    alignment_score: 1,
    consecutive_fails: 0,
    restrictions: {
      warning: false,
      restricted: false,
      quarantine: false,
      ban: false,
      active: []
    },
    counters: {
      spend_daily: {
        day_utc: null,
        total: 0,
        count: 0,
        limit: null
      }
    },
    audit: {
      prev_audit_hash: null,
      last_audit_hash: null
    },
    created_at: ts,
    updated_at: ts,
    ...initFields
  };
}

function loadSchema() {
  return readJsonSafe(SCHEMA_PATH, {
    required: ['version', 'updated_at', 'agents'],
    properties: {
      version: { type: 'string' },
      updated_at: { type: 'string' },
      agents: { type: 'object' }
    }
  });
}

function assertPrimaryType(value, expected, label) {
  if (expected === 'array') {
    if (!Array.isArray(value)) throw new Error(`Invalid state: ${label} must be an array`);
    return;
  }

  if (expected === 'object') {
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      throw new Error(`Invalid state: ${label} must be an object`);
    }
    return;
  }

  if (typeof value !== expected) {
    throw new Error(`Invalid state: ${label} must be ${expected}`);
  }
}

function validateAgent(agentId, agent) {
  assertPrimaryType(agent, 'object', `agents.${agentId}`);
  assertPrimaryType(agent.agent_id, 'string', `agents.${agentId}.agent_id`);
  assertPrimaryType(agent.alignment_score, 'number', `agents.${agentId}.alignment_score`);
  assertPrimaryType(agent.consecutive_fails, 'number', `agents.${agentId}.consecutive_fails`);
  assertPrimaryType(agent.restrictions, 'object', `agents.${agentId}.restrictions`);
  assertPrimaryType(agent.counters, 'object', `agents.${agentId}.counters`);
  assertPrimaryType(agent.audit, 'object', `agents.${agentId}.audit`);
  assertPrimaryType(agent.created_at, 'string', `agents.${agentId}.created_at`);
  assertPrimaryType(agent.updated_at, 'string', `agents.${agentId}.updated_at`);

  const r = agent.restrictions;
  assertPrimaryType(r.warning, 'boolean', `agents.${agentId}.restrictions.warning`);
  assertPrimaryType(r.restricted, 'boolean', `agents.${agentId}.restrictions.restricted`);
  assertPrimaryType(r.quarantine, 'boolean', `agents.${agentId}.restrictions.quarantine`);
  assertPrimaryType(r.ban, 'boolean', `agents.${agentId}.restrictions.ban`);
  assertPrimaryType(r.active, 'array', `agents.${agentId}.restrictions.active`);

  const sd = agent.counters.spend_daily;
  assertPrimaryType(sd, 'object', `agents.${agentId}.counters.spend_daily`);
  if (sd.day_utc !== null) assertPrimaryType(sd.day_utc, 'string', `agents.${agentId}.counters.spend_daily.day_utc`);
  assertPrimaryType(sd.total, 'number', `agents.${agentId}.counters.spend_daily.total`);
  assertPrimaryType(sd.count, 'number', `agents.${agentId}.counters.spend_daily.count`);
  if (sd.limit !== null) assertPrimaryType(sd.limit, 'number', `agents.${agentId}.counters.spend_daily.limit`);

  if (agent.audit.prev_audit_hash !== null) {
    assertPrimaryType(agent.audit.prev_audit_hash, 'string', `agents.${agentId}.audit.prev_audit_hash`);
  }
  if (agent.audit.last_audit_hash !== null) {
    assertPrimaryType(agent.audit.last_audit_hash, 'string', `agents.${agentId}.audit.last_audit_hash`);
  }
}

function validateState(state) {
  const schema = loadSchema();
  assertPrimaryType(state, 'object', 'root');

  const required = Array.isArray(schema.required) ? schema.required : [];
  for (const key of required) {
    if (!(key in state)) throw new Error(`Invalid state: missing key ${key}`);
  }

  const props = schema.properties || {};
  for (const [key, cfg] of Object.entries(props)) {
    if (key in state && cfg && cfg.type) {
      assertPrimaryType(state[key], cfg.type, key);
    }
  }

  const agents = state.agents || {};
  for (const [agentId, agent] of Object.entries(agents)) {
    validateAgent(agentId, agent);
  }
}

function loadParams() {
  return readJsonSafe(PARAMS_PATH, {});
}

function getDayUtc(timestampIso) {
  const d = new Date(timestampIso || Date.now());
  return d.toISOString().slice(0, 10);
}

function toNumberOrNull(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function restrictionsFromThresholds(score, thresholds) {
  const warning = Number(thresholds?.warning);
  const restricted = Number(thresholds?.restricted);
  const quarantine = Number(thresholds?.quarantine);
  const ban = Number(thresholds?.ban);

  const flags = {
    warning: Number.isFinite(warning) ? score <= warning : false,
    restricted: Number.isFinite(restricted) ? score <= restricted : false,
    quarantine: Number.isFinite(quarantine) ? score <= quarantine : false,
    ban: Number.isFinite(ban) ? score <= ban : false
  };

  const active = Object.entries(flags)
    .filter(([, isActive]) => isActive)
    .map(([name]) => name);

  return {
    ...flags,
    active
  };
}

function ensureStateFiles() {
  fs.mkdirSync(STATE_DIR, { recursive: true });

  if (!fs.existsSync(REGISTRY_PATH)) {
    writeJsonAtomic(REGISTRY_PATH, JSON.stringify(defaultState(), null, 2) + '\n');
  }

  if (!fs.existsSync(LOG_PATH)) {
    fs.writeFileSync(LOG_PATH, '', 'utf8');
  }
}

function doLoadState() {
  ensureStateFiles();
  const state = readJsonSafe(REGISTRY_PATH, defaultState());
  validateState(state);
  return state;
}

function doSaveState(state) {
  validateState(state);
  state.updated_at = nowIso();
  writeJsonAtomic(REGISTRY_PATH, JSON.stringify(state, null, 2) + '\n');
  return state;
}

function doAppendLog(entry) {
  const line = JSON.stringify(entry) + '\n';
  fs.appendFileSync(LOG_PATH, line, 'utf8');
}

function loadState() {
  return withLock(() => doLoadState());
}

function saveState(state) {
  return withLock(() => doSaveState(state));
}

function getAgent(agentId) {
  if (!agentId) return null;

  return withLock(() => {
    const state = doLoadState();
    const existing = state.agents[agentId];
    if (!existing) return null;
    return JSON.parse(JSON.stringify(existing));
  });
}

function upsertAgent(agentId, initFields = {}) {
  if (!agentId) throw new Error('upsertAgent(agent_id, initFields) requires agent_id');

  return withLock(() => {
    const state = doLoadState();
    const current = state.agents[agentId] || defaultAgent(agentId);

    state.agents[agentId] = {
      ...current,
      ...initFields,
      agent_id: String(agentId),
      updated_at: nowIso()
    };

    doSaveState(state);
    return JSON.parse(JSON.stringify(state.agents[agentId]));
  });
}

function appendLog(entry) {
  return withLock(() => {
    doLoadState();
    doAppendLog(entry);
  });
}

function applyDecision(args) {
  const event = args && args.event;
  const decision = args && args.decision;

  if (!event || !decision) {
    throw new Error('applyDecision({ event, decision }) requires both event and decision');
  }

  const agentId = event?.actor?.agent_id || 'agent:unknown';

  return withLock(() => {
    const state = doLoadState();
    const params = loadParams();
    const thresholds = params.alignment_score_thresholds || {};

    const current = state.agents[agentId] || defaultAgent(agentId);

    const before = clamp(toNumberOrNull(current.alignment_score) ?? 1, 0, 1);
    const delta = Number(decision?.alignment?.delta) || 0;
    const after = clamp(before + delta, 0, 1);

    const dayUtc = getDayUtc(event.timestamp);
    const spendAmount = toNumberOrNull(event?.context?.tx?.amount);
    const spendDaily = current?.counters?.spend_daily && typeof current.counters.spend_daily === 'object'
      ? { ...current.counters.spend_daily }
      : { day_utc: null, total: 0, count: 0, limit: null };

    if (spendDaily.day_utc !== dayUtc) {
      spendDaily.day_utc = dayUtc;
      spendDaily.total = 0;
      spendDaily.count = 0;
    }

    if (Number.isFinite(spendAmount)) {
      spendDaily.total = Number(spendDaily.total || 0) + spendAmount;
      spendDaily.count = Number(spendDaily.count || 0) + 1;
    }

    const level = event?.actor?.agent_level;
    const templateLimit = toNumberOrNull(params?.agent_limit_templates?.[level]?.daily_limit);
    if (templateLimit !== null) {
      spendDaily.limit = templateLimit;
    }

    const prevAuditHash = current?.audit?.last_audit_hash || null;
    const lastAuditHash = decision?.audit_hash || null;

    const restrictions = restrictionsFromThresholds(after, thresholds);

    const next = {
      ...current,
      agent_id: String(agentId),
      alignment_score: after,
      consecutive_fails: decision.verdict === 'ENFORCE'
        ? Number(current.consecutive_fails || 0) + 1
        : 0,
      restrictions,
      counters: {
        ...current.counters,
        spend_daily: spendDaily
      },
      audit: {
        prev_audit_hash: prevAuditHash,
        last_audit_hash: lastAuditHash
      },
      last_event_id: event.event_id || null,
      last_decision_id: decision.decision_id || null,
      last_verdict: decision.verdict || null,
      updated_at: nowIso()
    };

    state.agents[agentId] = next;
    doSaveState(state);

    const logEntry = {
      ts: nowIso(),
      event_id: event.event_id || null,
      decision_id: decision.decision_id || null,
      agent_id: agentId,
      verdict: decision.verdict || null,
      score_before: before,
      score_delta: delta,
      score_after: after,
      restrictions_active: restrictions.active,
      consecutive_fails: next.consecutive_fails,
      spend_daily: {
        day_utc: spendDaily.day_utc,
        total: spendDaily.total,
        count: spendDaily.count,
        limit: spendDaily.limit
      },
      prev_audit_hash: prevAuditHash,
      audit_hash: lastAuditHash
    };

    doAppendLog(logEntry);

    return {
      agent_id: agentId,
      alignment: {
        before,
        delta,
        after
      },
      restrictions,
      consecutive_fails: next.consecutive_fails,
      spend_daily: logEntry.spend_daily,
      prev_audit_hash: prevAuditHash,
      last_audit_hash: lastAuditHash
    };
  });
}

module.exports = {
  loadState,
  saveState,
  getAgent,
  upsertAgent,
  applyDecision,
  appendLog
};
