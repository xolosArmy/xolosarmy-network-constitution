# CAE v1 (Constitutional Alignment Engine)

Motor de evaluacion constitucional para la MRCL v1.

## Archivos
- `engine.js`: orquestacion (seleccion, evaluacion, scoring, enforcement, auditoria)
- `evaluator.js`: evaluador del DSL de predicados
- `scorer.js`: precedencia/bandas y delta de alignment
- `audit.js`: evidence bundles y hash `sha256`
- `audit/`: salida de bundles por evaluacion

## Uso desde policy-enforcer

```bash
node constitution/mrcl/v1/policy-enforcer.js ./rfc/MI-RFC.md
```

`policy-enforcer.js` construye un `CanonicalEvent` con `event_type = rfc.submitted`, llama `CAE.evaluate(event)` e imprime el reporte `HLP-COMPLIANCE-BOT`.

## CanonicalEvent (ejemplo)

```json
{
  "event_id": "evt-001",
  "event_type": "rfc.submitted",
  "timestamp": "2026-02-11T12:00:00.000Z",
  "actor": {
    "agent_id": "agent:unknown",
    "agent_level": "A2",
    "current_score": 0.93
  },
  "context": {
    "rfc": {
      "raw_text": "# RFC ...",
      "change_type": "III"
    },
    "agent": {
      "level": "A2"
    },
    "governance": {
      "timelock_seconds": 172800,
      "quorum": {
        "RMZ": 0.51,
        "Tonalli": 0.66
      },
      "stake": {
        "Obsidiana": true
      }
    }
  },
  "proofs": {
    "source": "rfc/MI-RFC.md"
  }
}
```

## Scoring y precedencia
- `outcome_factor`: `PASS=0`, `WARN=-0.5`, `FAIL=-1`.
- `severity_factor`: se calcula desde `parameters.json.precedence_bands[band].min / 100`.
- `precedence_band`: se infiere usando `hierarchy.precedence` (si existe) contra los thresholds `min`.
- fallback de precedencia:
  - `hierarchy.precedence`
  - `hierarchy.precedence_band` -> `parameters.precedence_bands[band].min`
  - `hierarchy.weight` como fallback tecnico
- `weight`: se trata como valor normalizado `0..1`.
- `alignment.after = clamp(alignment.before + delta, 0, 1)`.

## Enforcement planning
- Si algun articulo con `precedence >= 95` falla y su `enforcement.mode` es `kill_switch`, el modo final es `kill_switch`.
- Si hay multiples violaciones, se elige el modo mas fuerte:
  `kill_switch > slash > quarantine > revert_tx > rate_limit > require_attestation > log`.
- `applied_articles[]` conserva todas las violaciones para auditoria y scoring.

## Audit bundle
Cada evaluacion crea un JSON en `constitution/mrcl/v1/cae/audit/` con:
- snapshot del evento
- resultados por articulo
- enforcement final
- alignment before/delta/after
- `audit_hash` sha256

Nombre de archivo: `<decision_id>--<hash_corto>.json`.

## Servidor HTTP local (Tonalli Wallet)

Correr servidor local (bind solo localhost):

```bash
node constitution/mrcl/v1/cae/server.js
```

Puerto configurable con `CAE_PORT` (default `8787`):

```bash
CAE_PORT=8787 node constitution/mrcl/v1/cae/server.js
```

### `GET /v1/agent/:agent_id`

```bash
curl -s http://127.0.0.1:8787/v1/agent/agent%3Atonalli
```

### `POST /v1/preflight/sign`

```bash
curl -s http://127.0.0.1:8787/v1/preflight/sign \
  -H 'Content-Type: application/json' \
  -d '{
    "agent_id": "agent:tonalli",
    "event_type": "tx.sign_request",
    "context": {
      "tx": {"amount": 10, "allowlisted": true},
      "agent": {"level": "A2"}
    },
    "proofs": {}
  }'
```

Nota de seguridad: este servidor solo escucha en `127.0.0.1` (no expone interfaz de red externa).
