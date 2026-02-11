'use strict';

const http = require('node:http');
const { URL } = require('node:url');
const fs = require('node:fs');
const crypto = require('node:crypto');

const CAE = require('./engine');
const stateManager = require('./state_manager');

const HOST = '127.0.0.1';
const DEFAULT_PORT = 8787;
const MAX_BODY_BYTES = 1024 * 1024;

function getPort() {
  const raw = Number(process.env.CAE_PORT);
  if (Number.isInteger(raw) && raw >= 1 && raw <= 65535) return raw;
  return DEFAULT_PORT;
}

function sendJson(res, statusCode, payload) {
  const body = JSON.stringify(payload, null, 2);
  res.writeHead(statusCode, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store'
  });
  res.end(body);
}

function readJsonBody(req) {
  return new Promise((resolve, reject) => {
    let raw = '';

    req.on('data', (chunk) => {
      raw += chunk;
      if (Buffer.byteLength(raw, 'utf8') > MAX_BODY_BYTES) {
        reject(Object.assign(new Error('Request body too large'), { statusCode: 413 }));
      }
    });

    req.on('end', () => {
      if (!raw.trim()) {
        resolve({});
        return;
      }

      try {
        resolve(JSON.parse(raw));
      } catch (err) {
        reject(Object.assign(new Error('Invalid JSON body'), { statusCode: 400 }));
      }
    });

    req.on('error', reject);
  });
}

function ensureDefaultAgent(agentId) {
  const existing = stateManager.getAgent(agentId);
  if (existing) return existing;

  return stateManager.upsertAgent(agentId, {
    alignment_score: 1,
    band: 'nominal',
    capabilities: {},
    restrictions: {
      warning: false,
      restricted: false,
      quarantine: false,
      ban: false,
      active: []
    }
  });
}

function toAgentView(agent) {
  const safeAgent = agent && typeof agent === 'object' ? agent : {};
  return {
    band: safeAgent.band || 'nominal',
    alignment: {
      score: Number.isFinite(Number(safeAgent.alignment_score))
        ? Number(safeAgent.alignment_score)
        : 1
    },
    capabilities: safeAgent.capabilities && typeof safeAgent.capabilities === 'object'
      ? safeAgent.capabilities
      : {},
    restrictions: safeAgent.restrictions && typeof safeAgent.restrictions === 'object'
      ? safeAgent.restrictions
      : { active: [] },
    audit_chain: {
      last_audit_hash: safeAgent?.audit?.last_audit_hash || null
    }
  };
}

function buildCanonicalSignEvent(payload, agentState) {
  const eventType = payload?.event_type;
  if (eventType !== 'tx.sign_request') {
    throw Object.assign(new Error('event_type must be "tx.sign_request"'), { statusCode: 400 });
  }

  const agentId = String(payload?.agent_id || '').trim();
  if (!agentId) {
    throw Object.assign(new Error('agent_id is required'), { statusCode: 400 });
  }

  const context = payload?.context && typeof payload.context === 'object' ? payload.context : {};
  const tx = context?.tx && typeof context.tx === 'object' ? context.tx : {};
  const ctxAgent = context?.agent && typeof context.agent === 'object' ? context.agent : {};
  const level = String(ctxAgent.level || agentState?.agent_level || 'A0').toUpperCase();
  const allowlisted = Boolean(
    tx.allowlisted ??
    context?.transaction?.allowlisted ??
    false
  );

  return {
    event_id: `evt-${crypto.randomBytes(8).toString('hex')}`,
    event_type: 'tx.sign_request',
    timestamp: new Date().toISOString(),
    actor: {
      agent_id: agentId,
      agent_level: level,
      current_score: Number.isFinite(Number(agentState?.alignment_score))
        ? Number(agentState.alignment_score)
        : 1
    },
    context: {
      ...context,
      tx,
      agent: {
        ...ctxAgent,
        level
      },
      transaction: {
        ...(context?.transaction && typeof context.transaction === 'object' ? context.transaction : {}),
        allowlisted
      }
    },
    proofs: payload?.proofs && typeof payload.proofs === 'object' ? payload.proofs : {}
  };
}

function canSignByCapabilities(capabilities, event) {
  const caps = capabilities && typeof capabilities === 'object' ? capabilities : {};
  const signMode = String(caps.sign_mode || caps.sign_mode_A2A3 || 'any');

  if (signMode === 'deny') return false;
  if (signMode === 'allowlist_only') {
    return Boolean(event?.context?.transaction?.allowlisted);
  }
  return true;
}

function buildDenyUi(reason, decision) {
  return {
    title: 'Firma bloqueada por CAE',
    message: reason,
    enforcement_mode: decision?.enforcement?.mode || null
  };
}

function routeGetAgent(req, res, pathname) {
  const match = pathname.match(/^\/v1\/agent\/([^/]+)$/);
  if (!match) return false;

  const agentId = decodeURIComponent(match[1] || '').trim();
  if (!agentId) {
    sendJson(res, 400, { error: 'agent_id is required' });
    return true;
  }

  const agent = ensureDefaultAgent(agentId);
  sendJson(res, 200, {
    agent_id: agentId,
    ...toAgentView(agent)
  });
  return true;
}

async function routePreflightSign(req, res, pathname) {
  if (pathname !== '/v1/preflight/sign') return false;

  const payload = await readJsonBody(req);
  const agentId = String(payload?.agent_id || '').trim();
  if (!agentId) {
    sendJson(res, 400, { error: 'agent_id is required' });
    return true;
  }

  const currentAgent = ensureDefaultAgent(agentId);
  const event = buildCanonicalSignEvent(payload, currentAgent);
  const evaluation = CAE.evaluate(event);
  const decision = evaluation.decision || {};

  const finalAgent = stateManager.getAgent(agentId) || currentAgent;
  const finalCapabilities = decision?.agent_state?.capabilities || finalAgent?.capabilities || {};
  const caePassed = decision.verdict === 'PASS';
  const capabilityAllowsSigning = canSignByCapabilities(finalCapabilities, event);
  const allowed = caePassed && capabilityAllowsSigning;

  const denyReason = !caePassed
    ? `Constitutional policy enforcement (${decision.enforcement?.mode || 'log'})`
    : `Agent capabilities block signing (sign_mode=${String(finalCapabilities.sign_mode || 'unknown')})`;

  const relevantArticles = Array.from(new Set((decision.results || [])
    .filter((result) => result.result !== 'PASS')
    .map((result) => result.article_id)));
  if (!caePassed && Array.isArray(decision.applied_articles)) {
    for (const articleId of decision.applied_articles) {
      if (articleId && !relevantArticles.includes(articleId)) relevantArticles.push(articleId);
    }
  }
  if (caePassed && !capabilityAllowsSigning && relevantArticles.length === 0) {
    relevantArticles.push('CAPABILITY_GATING/TX_SIGN');
  }

  const response = {
    verdict: allowed ? 'ALLOW' : 'DENY',
    reason: allowed ? null : denyReason,
    ui: allowed ? null : buildDenyUi(denyReason, decision),
    audit_hash: decision.audit_hash || finalAgent?.audit?.last_audit_hash || null,
    relevant_articles: relevantArticles,
    agent_state: {
      agent_id: agentId,
      alignment_score: Number.isFinite(Number(finalAgent?.alignment_score))
        ? Number(finalAgent.alignment_score)
        : Number(decision?.alignment?.after ?? 1),
      band: decision?.agent_state?.band || finalAgent?.band || 'nominal',
      capabilities: finalCapabilities,
      restrictions: decision?.agent_state?.restrictions || finalAgent?.restrictions || { active: [] },
      consecutive_fails: Number(decision?.agent_state?.consecutive_fails ?? finalAgent?.consecutive_fails ?? 0),
      audit_chain: {
        last_audit_hash: finalAgent?.audit?.last_audit_hash || decision?.state?.last_audit_hash || decision.audit_hash || null
      }
    }
  };

  sendJson(res, 200, response);
  return true;
}

function main() {
  fs.mkdirSync(`${__dirname}/state`, { recursive: true });
  fs.mkdirSync(`${__dirname}/audit`, { recursive: true });

  const server = http.createServer(async (req, res) => {
    try {
      const method = req.method || 'GET';
      const requestUrl = new URL(req.url || '/', `http://${HOST}`);
      const pathname = requestUrl.pathname;

      if (method === 'GET' && routeGetAgent(req, res, pathname)) return;
      if (method === 'POST' && await routePreflightSign(req, res, pathname)) return;

      sendJson(res, 404, { error: 'Not found' });
    } catch (err) {
      const statusCode = Number(err?.statusCode) || 500;
      sendJson(res, statusCode, {
        error: err?.message || 'Internal server error'
      });
    }
  });

  const port = getPort();
  server.listen(port, HOST, () => {
    process.stdout.write(`CAE server listening on http://${HOST}:${port}\n`);
  });
}

main();
