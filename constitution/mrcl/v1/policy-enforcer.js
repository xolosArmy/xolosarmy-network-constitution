#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const CAE = require('./cae/engine');

function detectTypeIII(rawText) {
  return /\b(Tipo\s*III|Type\s*III)\b/i.test(rawText);
}

function detectAgentLevel(rawText) {
  const explicit = rawText.match(/\b(?:agent[_ -]?level|nivel)\s*[:=]\s*(A[0-3])\b/i);
  if (explicit) return explicit[1].toUpperCase();
  if (/\bA3\b/i.test(rawText)) return 'A3';
  if (/\bA2\b/i.test(rawText)) return 'A2';
  if (/\bA1\b/i.test(rawText)) return 'A1';
  return 'A0';
}

function extractNumber(rawText, regex) {
  const match = rawText.match(regex);
  if (!match) return null;
  const value = Number(match[1]);
  return Number.isFinite(value) ? value : null;
}

function extractCurrentScore(rawText) {
  return extractNumber(rawText, /\b(?:alignment_score|current_score)\s*[:=]\s*([0-9]*\.?[0-9]+)\b/i);
}

function detectAgentId(rawText) {
  const match = rawText.match(/\b(?:agent_id|author_id)\s*[:=]\s*([a-zA-Z0-9:_-]+)\b/i);
  return match ? match[1] : 'agent:unknown';
}

function buildCanonicalEvent(rawText, inputPath) {
  const isTypeIII = detectTypeIII(rawText);
  const agentLevel = detectAgentLevel(rawText);
  const currentScore = extractCurrentScore(rawText);
  const rmz = extractNumber(rawText, /\b(?:quorum[_ ]?rmz|rmz_quorum)\s*[:=]\s*([0-9]*\.?[0-9]+)\b/i);
  const tonalli = extractNumber(rawText, /\b(?:quorum[_ ]?tonalli|tonalli_quorum)\s*[:=]\s*([0-9]*\.?[0-9]+)\b/i);
  const timelock = extractNumber(rawText, /\b(?:timelock|timelock_seconds)\s*[:=]\s*([0-9]+)\b/i);
  const spendCurrent = extractNumber(rawText, /\b(?:current_period_total|spent_current)\s*[:=]\s*([0-9]*\.?[0-9]+)\b/i);
  const spendLimit = extractNumber(rawText, /\b(?:period_limit|spend_limit)\s*[:=]\s*([0-9]*\.?[0-9]+)\b/i);
  const txAmount = extractNumber(rawText, /\b(?:tx[_ ]?amount|tx\.amount)\s*[:=]\s*([0-9]*\.?[0-9]+)\b/i);

  return {
    event_id: `evt-${crypto.randomBytes(8).toString('hex')}`,
    event_type: 'rfc.submitted',
    timestamp: new Date().toISOString(),
    actor: {
      agent_id: detectAgentId(rawText),
      agent_level: agentLevel,
      current_score: currentScore == null ? 1 : currentScore
    },
    context: {
      rfc: {
        source_path: inputPath,
        raw_text: rawText,
        change_type: isTypeIII ? 'III' : 'UNKNOWN'
      },
      proposal: {
        summary: rawText.slice(0, 4000)
      },
      agent: {
        level: agentLevel,
        delegates_purpose: /\bdelegaci[oó]n completa\b/i.test(rawText),
        autonomy_score: extractNumber(rawText, /\bautonomy_score\s*[:=]\s*([0-9]*\.?[0-9]+)\b/i) || 0
      },
      governance: {
        timelock_seconds: timelock == null ? 0 : timelock,
        quorum: {
          RMZ: rmz == null ? 0 : rmz,
          Tonalli: tonalli == null ? 0 : tonalli
        },
        stake: {
          Obsidiana: /\bobsidiana\b/i.test(rawText)
        }
      },
      spending: {
        current_period_total: spendCurrent == null ? 0 : spendCurrent,
        period_limit: spendLimit == null ? 0 : spendLimit,
        circuit_breaker_hits: /circuit breaker/i.test(rawText) ? 1 : 0
      },
      transaction: {
        allowlisted: !/allowlist\s*:\s*false/i.test(rawText)
      },
      tx: {
        amount: txAmount == null ? null : txAmount
      }
    },
    proofs: {
      source: inputPath
    }
  };
}

function main() {
  const inputPath = process.argv[2];
  if (!inputPath) {
    console.error('Usage: node policy-enforcer.js <rfc-markdown-path>');
    process.exit(1);
  }

  const rawText = fs.readFileSync(path.resolve(process.cwd(), inputPath), 'utf8');
  const event = buildCanonicalEvent(rawText, inputPath);
  const { decision, audit_file: auditFile } = CAE.evaluate(event);

  const overall = decision.verdict === 'PASS' ? 'PASS' : 'FAIL';
  const evidenceRows = decision.results.filter((r) => r.result !== 'PASS').slice(0, 8);

  console.log('HLP-COMPLIANCE-BOT');
  console.log(`RFC: ${inputPath}`);
  console.log(`DECISION_ID: ${decision.decision_id}`);
  console.log(`EVENT_ID: ${decision.event_id}`);
  console.log(`OVERALL: ${overall}`);
  console.log(`ENFORCEMENT: mode=${decision.enforcement.mode} severity=${decision.enforcement.severity} actions=${decision.enforcement.actions.join(',')}`);
  console.log(`ALIGNMENT: before=${decision.alignment.before.toFixed(4)} delta=${decision.alignment.delta.toFixed(4)} after=${decision.alignment.after.toFixed(4)}`);
  const activeRestrictions = Array.isArray(decision?.state?.restrictions?.active)
    ? decision.state.restrictions.active
    : [];
  console.log(`STATE: restrictions=${activeRestrictions.length ? activeRestrictions.join(',') : 'none'} consecutive_fails=${decision?.state?.consecutive_fails ?? 0}`);
  if (decision?.state?.prev_audit_hash || decision?.state?.last_audit_hash) {
    console.log(`AUDIT_CHAIN: prev=${decision.state.prev_audit_hash || 'null'} current=${decision.state.last_audit_hash || 'null'}`);
  }
  console.log(`AUDIT: hash=${decision.audit_hash} file=${auditFile}`);
  console.log('EVIDENCE:');
  if (evidenceRows.length === 0) {
    console.log('- none');
  } else {
    for (const r of evidenceRows) {
      console.log(`- ${r.article_id} [${r.result}] precedence=${r.precedence} band=${r.severity_band}`);
    }
  }
}

main();
