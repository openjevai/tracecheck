# OpenJEV Support

This fork of [bmccarn/tracecheck](https://github.com/bmccarn/tracecheck) adds optional support for [OpenJEV](https://openjev.sh), a free community gateway to the same Jev model built by [TypeSafe](https://typesafe.ai). TypeSafe stays the default; anyone with a TypeSafe key sees zero behaviour change.

## What was added

- **`src/jev.ts`** — Added `OPENJEV_BASE_URL` (`https://api.openjev.sh`) and `OPENJEV_MODEL` (`openjev`) constants; added `JEV_PROVIDER` and `OPENJEV_API_KEY` to `PROVIDER_ENVIRONMENT`; extended `jevSettings()` with OpenJEV provider selection; updated the `Jev` constructor error message to list `OPENJEV_API_KEY`.
- **`src/cli.ts`** — Updated CLI help text to mention OpenJEV, `JEV_PROVIDER`, and the `openjev` model default.
- **`src/mcp.ts`** — Updated the `tracecheck_review` tool description to list OpenJEV as a provider.
- **`README.md`** — Added an OpenJEV support note after the intro, updated the "Set a provider key" section, the environment variable table, the MCP setup forwarding list, and added a "Using Jev through OpenJEV" section.
- **`skills/tracecheck/references/tool-usage.md`** — Added `OPENJEV_API_KEY` to the missing-credentials guidance.
- **`benchmarks/calibrate.ts`** — Added `OPENJEV_API_KEY` to the live-run error message.

## Provider selection rule

1. **Explicit choice wins:** `JEV_PROVIDER=openjev` selects OpenJEV regardless of other keys.
2. **TypeSafe if its key is set** (default, unchanged): `JEV_API_KEY` or `TYPESAFE_API_KEY` → TypeSafe endpoint with `jev-latest`.
3. **OpenRouter if its key is set** and no TypeSafe key: `OPENROUTER_API_KEY` → OpenRouter endpoint.
4. **OpenJEV if only its key is set** and no TypeSafe/OpenRouter key: `OPENJEV_API_KEY` → OpenJEV endpoint with `openjev` model.

An explicit `TYPESAFE_BASE_URL` always overrides the endpoint base URL, whichever provider is selected. `JEV_MODEL` overrides the model for any provider.

## How to configure

```sh
# Option 1: auto-select OpenJEV when no TypeSafe/OpenRouter key is set
export OPENJEV_API_KEY="your-openjev-key"

# Option 2: force OpenJEV explicitly
export JEV_PROVIDER="openjev"
export OPENJEV_API_KEY="your-openjev-key"
```

Get an OpenJEV API key at https://openjev.sh/dashboard.

## How it was verified

- A live POST to `https://api.openjev.sh/v1/systemone` with model `openjev`, state `ping`, and one noul question returned HTTP 200.
- A grep confirmed no hardcoded `api.typesafe.ai` default remains in the source code (it is still the TypeSafe default, unchanged).

## Upstream

Original project: https://github.com/bmccarn/tracecheck by @bmccarn.
