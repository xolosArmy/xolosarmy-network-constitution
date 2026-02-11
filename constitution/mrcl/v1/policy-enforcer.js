#!/usr/bin/env node
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = __dirname;
const MAIN_PATH = path.join(ROOT, 'main.json');
const PARAMS_PATH = path.join(ROOT, 'parameters.json');

function getValue(obj, pathStr) {
  if (!pathStr) return undefined;
  return pathStr.split('.').reduce((acc, key) => (acc == null ? undefined : acc[key]), obj);
}

function evaluatePredicate(node, context) {
  if (!node || typeof node !== 'object') return false;
  const op = node.op;

  if (op === 'exists') {
    return getValue(context, node.path) !== undefined;
  }

  if (op === 'not') {
    return !evaluatePredicate(node.predicate, context);
  }

  if (op === 'all') {
    return Array.isArray(node.predicates) && node.predicates.every((p) => evaluatePredicate(p, context));
  }

  if (op === 'any') {
    return Array.isArray(node.predicates) && node.predicates.some((p) => evaluatePredicate(p, context));
  }

  const left = getValue(context, node.path);
  const right = node.value_path ? getValue(context, node.value_path) : node.value;

  switch (op) {
    case 'eq':
      return left === right;
    case 'neq':
      return left !== right;
    case 'gt':
      return Number(left) > Number(right);
    case 'gte':
      return Number(left) >= Number(right);
    case 'lt':
      return Number(left) < Number(right);
    case 'lte':
      return Number(left) <= Number(right);
    case 'in':
      return Array.isArray(right) && right.includes(left);
    case 'contains':
      if (typeof left === 'string') return String(left).toLowerCase().includes(String(right).toLowerCase());
      if (Array.isArray(left)) return left.includes(right);
      return false;
    default:
      return false;
  }
}

function flattenArticles(main) {
  const out = [];
  for (const title of main.titles || []) {
    for (const article of title.articles || []) {
      out.push(article);
    }
  }
  return out;
}

function detectTypeIII(rawText) {
  return /\b(Tipo\s*III|Type\s*III)\b/i.test(rawText);
}

function buildContext(rawText, params) {
  const isTypeIII = detectTypeIII(rawText);
  return {
    context: {
      rfc: {
        raw_text: rawText,
        change_type: isTypeIII ? 'III' : 'UNKNOWN'
      },
      governance: {
        timelock_seconds: isTypeIII ? 0 : 0,
        quorum: {
          RMZ: params?.quorum_defaults?.RMZ || 0,
          Tonalli: params?.quorum_defaults?.Tonalli || 0
        },
        stake: {
          Obsidiana: isTypeIII
        }
      },
      agent: {
        level: /\bA3\b/.test(rawText) ? 'A3' : /\bA2\b/.test(rawText) ? 'A2' : 'A1'
      },
      spending: {
        current_period_total: 0,
        period_limit: 0,
        circuit_breaker_hits: /circuit breaker/i.test(rawText) ? 1 : 0
      },
      transaction: {
        allowlisted: !/allowlist\s*:\s*false/i.test(rawText)
      }
    }
  };
}

function main() {
  const inputPath = process.argv[2];
  if (!inputPath) {
    console.error('Usage: node policy-enforcer.js <rfc-markdown-path>');
    process.exit(1);
  }

  const mainDoc = JSON.parse(fs.readFileSync(MAIN_PATH, 'utf8'));
  const params = JSON.parse(fs.readFileSync(PARAMS_PATH, 'utf8'));
  const rawText = fs.readFileSync(path.resolve(process.cwd(), inputPath), 'utf8');
  const evalContext = buildContext(rawText, params);

  const selectedIds = new Set(['T07-A076', 'T08-A098', 'T01-A003']);
  const rules = flattenArticles(mainDoc).filter((a) => selectedIds.has(a.article_id));

  const results = rules.map((rule) => {
    const triggered = evaluatePredicate(rule.predicate, evalContext);
    let status = 'PASS';
    if (rule.article_id === 'T07-A076' && detectTypeIII(rawText)) {
      status = triggered ? 'WARN' : 'FAIL';
    } else if (triggered && rule.enforcement.mode !== 'log') {
      status = 'WARN';
    }

    return {
      article_id: rule.article_id,
      title: rule.title,
      triggered,
      status,
      mode: rule.enforcement.mode,
      actions: rule.enforcement.actions
    };
  });

  const overall = results.some((r) => r.status === 'FAIL')
    ? 'FAIL'
    : results.some((r) => r.status === 'WARN')
      ? 'WARN'
      : 'PASS';

  console.log('HLP-COMPLIANCE-BOT');
  console.log(`RFC: ${inputPath}`);
  console.log(`OVERALL: ${overall}`);
  console.log('EVIDENCE:');
  for (const r of results) {
    console.log(`- ${r.article_id} [${r.status}] triggered=${r.triggered} mode=${r.mode} actions=${r.actions.join(',')}`);
  }
}

main();
