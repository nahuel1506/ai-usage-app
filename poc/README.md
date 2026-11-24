# Colectores CLI y pruebas (`poc/`)

Esta carpeta contiene las sondas desacopladas en **Node.js 24+** que alimentan a la aplicación de escritorio (y que también pueden ejecutarse directamente desde la terminal).

## Colector de Codex (`codex-poc.mjs`)

Consulta la cuota oficial mediante `codex app-server` y analiza los rollouts locales en `%USERPROFILE%\.codex`.

```powershell
# Muestra única en JSON legible
node poc/codex-poc.mjs

# Monitoreo continuo cada 30 segundos grabando en %LOCALAPPDATA%\AIUsageIntelligence\poc
node poc/codex-poc.mjs --watch --interval 30 --json --details --session-view
```

Opciones: `--interval <30..3600>`, `--samples <n>`, `--hours <1..168>`, `--codex <ruta-absoluta>`, `--question-previews`, `--stop-on-stdin-close`.

## Colector de Antigravity (`antigravity-poc.mjs`)

Consulta las 4 ventanas oficiales de cuota vía `agy -p "/usage" --output-format json` (0 tokens consumidos) y lee en modo solo lectura las conversaciones SQLite en `%USERPROFILE%\.gemini\antigravity\conversations`.

```powershell
# Muestra única con analítica 24h / 7d / 30d y detalles de sesión
node poc/antigravity-poc.mjs --json --details --session-view

# Monitoreo continuo cada 30 segundos
node poc/antigravity-poc.mjs --watch --interval 30 --json --details --session-view
```

Opciones: `--interval <5..3600>`, `--samples <n>`, `--hours <1..168>`, `--home <ruta-absoluta>`, `--agy <ruta-absoluta>`, `--question-previews`, `--stop-on-stdin-close`.

## Pruebas unitarias

```powershell
node --test poc/poc.test.mjs poc/antigravity.test.mjs poc/pricing.test.mjs
```

Cubre:
- Deduplicación de cuotas, reconciliación, discontinuidades y atribución de intervalos (`poc.test.mjs`).
- Decodificador Protobuf, lector SQLite con caché incremental y parser de `agy /usage` (`antigravity.test.mjs`).
- Tarifario oficial, semántica inclusiva/exclusiva de caché, tramos de contexto largo (`>272k` / `>200k`), sincronización externa, desglose `Modelo × Esfuerzo`, promedios de cuota por sesión/turno y comparativa intrasesión (`pricing.test.mjs`).
