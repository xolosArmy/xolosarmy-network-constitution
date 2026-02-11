# MRCL v1 (Machine-Readable Constitutional Layer)

MRCL convierte la constitucion en prosa (`constitution/v1/xolosarmy-network-constitution-v1.md`) en un grafo JSON ejecutable para:
- evaluacion automatica de reglas
- enforcement unificado
- lookup rapido por scope, dominio y precedencia

## Estructura
- `main.json`: raiz MRCL (metadatos, titulos, articulos computables, enforcement registry)
- `parameters.json`: parametros globales (precedence bands, quorum, timelock, limites, alignment)
- `definitions.json`: definiciones DEF-* reutilizables
- `indexes.json`: indices derivados para busqueda rapida
- `mrcl.schema.json`: JSON Schema de validacion estructural
- `policy-enforcer.js`: verificador CLI de RFC contra reglas MRCL

## Parsing Markdown -> MRCL
Reglas implementadas en `main.json.parser_rules` y aplicadas al generar `main.json`:
- `# TÍTULO VII — X` -> `title_id = T07`
- `## Artículo 76 — Triple Candado` -> `article_id = T07-A076`
- cuerpo libre -> `norm.statement`
- listas numeradas/bullets -> `norm.clauses[]`
- `**token**` -> `tags.keywords[]`
- `Art. 12` / `Artículo 12` -> `links[]` (referencia cruzada)

## Validacion
Ejemplo con Python `jsonschema` (si esta instalado):

```bash
python3 - <<'PY'
import json
from jsonschema import Draft202012Validator
schema = json.load(open('constitution/mrcl/v1/mrcl.schema.json'))
doc = json.load(open('constitution/mrcl/v1/main.json'))
Draft202012Validator(schema).validate(doc)
print('main.json valido contra mrcl.schema.json')
PY
```

## Enforcement de RFC

```bash
node constitution/mrcl/v1/policy-enforcer.js ./rfc/RFC-XXXX.md
```

Salida esperada: `HLP-COMPLIANCE-BOT` con estado `PASS|FAIL|WARN` y evidencia por articulo.

## Articulos computables iniciales
- `T01-A003` Principio de Instrumentalidad de la IA (`kill_switch`)
- `T07-A076` Triple Candado (`revert_tx` + timelock/quorum/stake)
- `T08-A098` Control de Gasto (`rate_limit` + bloqueo + penalizacion)

## Agregar nuevos articulos computables
1. Localizar el articulo en `main.json` por `article_id`.
2. Ajustar `tags`, `hierarchy`, `predicate` y `enforcement`.
3. Regenerar/actualizar `indexes.json` para mantener lookup consistente.
4. Validar contra `mrcl.schema.json`.
