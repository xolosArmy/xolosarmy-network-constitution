# xolosArmy Network Constitution
Repositorio canónico de gobernanza para xolosArmy Network State (xNS).
La Constitución define la Capa Humana (HLP) como soberanía de objetivo, restricción y finalidad.

## Estructura del repositorio
- [Constitución](constitution/v1/)
- [Enmiendas](amendments/)
- [RFC (Propuestas)](rfc/)
- [Ratificación (hashes / TXIDs)](ratification/)

## Índice
- [Objetivo](#objetivo)
- [Documentos](#documentos)
- [Cómo proponer cambios](#cómo-proponer-cambios)
- [Proceso de decisión](#proceso-de-decisión)
- [Versionado constitucional](#versionado-constitucional)
- [Ratificación](#ratificación)
- [Licencia](#licencia)

## Objetivo
Establecer reglas verificables para que:
- IA ejecute
- Cripto recuerde
- Humanos elijan el vector

## Documentos
- Constitución v1: [constitution/v1/xolosarmy-network-constitution-v1.md](constitution/v1/xolosarmy-network-constitution-v1.md)

## Cómo proponer cambios
1. Crea una RFC desde: [rfc/TEMPLATE.md](rfc/TEMPLATE.md)
2. Abre PR con tu RFC numerada `RFC-XXXX`
3. Sigue el periodo de revisión pública y quórums definidos en la Constitución
4. Si se aprueba, se implementa y se registra en ratification/

## Proceso de decisión
RFC → Mapeo de riesgo → Revisión pública → Votación → Timelock → Ejecución → Post-mortem

## Versionado constitucional
- Se usa SemVer: vMAJOR.MINOR.PATCH
- MAJOR: cambios de principios/estructura
- MINOR: artículos nuevos o ampliaciones compatibles
- PATCH: correcciones de redacción sin cambio de sentido

## Ratificación
Los hashes/TXIDs canónicos se registran en:
- [ratification/REGISTRY.md](ratification/REGISTRY.md)

## Licencia
Por definir (se puede añadir más adelante).
