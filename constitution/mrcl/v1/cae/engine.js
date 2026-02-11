'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const { evaluateArticle } = require('./evaluator');
const {
  inferPrecedence,
  inferPrecedenceBand,
  normalizeWeight,
  scoreAlignment
} = require('./scorer');
const { writeAuditBundle } = require('./audit');
const stateManager = require('./state_manager');

const ENFORCEMENT_STRENGTH = [
  'kill_switch',
  'slash',
  'quarantine',
  'revert_tx',
  'rate_limit',
  'require_attestation',
  'log'
];

function flattenArticles(mainDoc) {
  const titles = Array.isArray(mainDoc?.titles) ? mainDoc.titles : [];
  const out = [];
  for (const title of titles) {
    const articles = Array.isArray(title?.articles) ? title.articles : [];
    for (const article of articles) out.push(article);
  }
  return out;
}

function scopeMatches(article, agentLevel) {
  if (!Array.isArray(article?.scope) || article.scope.length === 0) return true;
  return article.scope.includes(agentLevel);
}

function hasTrigger(article) {
  return Array.isArray(article?.trigger?.event_types) && article.trigger.event_types.length > 0;
}

function triggerMatches(article, eventType) {
  return article.trigger.event_types.includes(eventType);
}

function isComputable(article) {
  if (typeof article?.computability?.computable === 'boolean') {
    return article.computability.computable;
  }
  return article?.enforcement?.mode && article.enforcement.mode !== 'log';
}

function selectApplicableArticles(allArticles, event) {
  const agentLevel = event?.actor?.agent_level;
  const eventType = event?.event_type;

  return allArticles.filter((article) => {
    if (!scopeMatches(article, agentLevel)) return false;
    if (hasTrigger(article)) return triggerMatches(article, eventType);
    return isComputable(article);
  });
}

function chooseStrongestMode(modes) {
  if (!Array.isArray(modes) || modes.length === 0) return 'log';
  for (const mode of ENFORCEMENT_STRENGTH) {
    if (modes.includes(mode)) return mode;
  }
  return 'log';
}

function inferSeverityLabel(maxPrecedence) {
  if (maxPrecedence >= 95) return 'critical';
  if (maxPrecedence >= 75) return 'high';
  if (maxPrecedence >= 50) return 'medium';
  return 'low';
}

function buildEnforcement(violations) {
  if (violations.length === 0) {
    return {
      mode: 'log',
      severity: 'info',
      actions: []
    };
  }

  const killSwitchSupersede = violations.some((v) => (
    v.result === 'FAIL' &&
    v.precedence >= 95 &&
    v.enforcement_mode === 'kill_switch'
  ));

  const mode = killSwitchSupersede
    ? 'kill_switch'
    : chooseStrongestMode(violations.map((v) => v.enforcement_mode));

  const relevant = violations.filter((v) => v.enforcement_mode === mode);
  const actions = [...new Set(relevant.flatMap((v) => v.actions))];
  const maxPrecedence = Math.max(...violations.map((v) => v.precedence));

  return {
    mode,
    severity: inferSeverityLabel(maxPrecedence),
    actions
  };
}

class ConstitutionalAlignmentEngine {
  /**
   * @param {{mainPath?: string, paramsPath?: string, auditDir?: string}} [config]
   */
  constructor(config = {}) {
    const base = path.resolve(__dirname, '..');
    this.mainPath = config.mainPath || path.join(base, 'main.json');
    this.paramsPath = config.paramsPath || path.join(base, 'parameters.json');
    this.auditDir = config.auditDir || path.join(__dirname, 'audit');

    this.mainDoc = JSON.parse(fs.readFileSync(this.mainPath, 'utf8'));
    this.params = JSON.parse(fs.readFileSync(this.paramsPath, 'utf8'));
    this.articles = flattenArticles(this.mainDoc);
  }

  /**
   * @param {Record<string, any>} event CanonicalEvent
   */
  evaluate(event) {
    if (!event || typeof event !== 'object') {
      throw new Error('CAE.evaluate(event) requires a CanonicalEvent object');
    }
    if (!event.event_id || !event.event_type || !event.timestamp) {
      throw new Error('CanonicalEvent missing required fields: event_id, event_type, timestamp');
    }

    const applicable = selectApplicableArticles(this.articles, event);

    const results = applicable.map((article) => {
      const evalResult = evaluateArticle(article, event);
      const precedence = inferPrecedence(article, this.params);
      const severityBand = inferPrecedenceBand(precedence, this.params.precedence_bands);
      const weight = normalizeWeight(article);

      return {
        article_id: article.article_id,
        result: evalResult.result,
        precedence,
        weight,
        severity_band: severityBand,
        evidence: evalResult.evidence,
        enforcement_mode: article?.enforcement?.mode || 'log',
        actions: Array.isArray(article?.enforcement?.actions) ? article.enforcement.actions : []
      };
    });

    const violations = results.filter((r) => r.result !== 'PASS');
    const enforcement = buildEnforcement(violations);

    const agentId = event?.actor?.agent_id || 'agent:unknown';
    const agentState = stateManager.getAgent(agentId);
    const alignmentBefore = Number(agentState?.alignment_score);
    const alignment = scoreAlignment(results, alignmentBefore, this.params);

    const decisionId = typeof crypto.randomUUID === 'function'
      ? crypto.randomUUID()
      : `${Date.now()}-${Math.random().toString(16).slice(2, 10)}`;

    /** @type {Record<string, any>} */
    const decision = {
      decision_id: decisionId,
      event_id: event.event_id,
      verdict: violations.length === 0 ? 'PASS' : 'ENFORCE',
      applied_articles: violations.map((v) => v.article_id),
      results: results.map((r) => ({
        article_id: r.article_id,
        result: r.result,
        precedence: r.precedence,
        weight: r.weight,
        severity_band: r.severity_band,
        evidence: r.evidence
      })),
      enforcement,
      alignment,
      audit_hash: null
    };

    const audit = writeAuditBundle({
      auditDir: this.auditDir,
      event,
      decision
    });

    decision.audit_hash = audit.audit_hash;
    const state = stateManager.applyDecision({ event, decision });
    decision.alignment = state.alignment;
    decision.state = {
      restrictions: state.restrictions,
      consecutive_fails: state.consecutive_fails,
      spend_daily: state.spend_daily,
      prev_audit_hash: state.prev_audit_hash,
      last_audit_hash: state.last_audit_hash
    };

    return {
      decision,
      audit_file: audit.audit_file
    };
  }
}

const defaultEngine = new ConstitutionalAlignmentEngine();

module.exports = {
  ConstitutionalAlignmentEngine,
  evaluate: (event) => defaultEngine.evaluate(event)
};
