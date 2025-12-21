# Model Fetching Investigation Report

## Summary

Investigated the model fetching system to determine what models are actually available for both Claude and Codex agents.

## Code Location

The model fetching logic is located in:
- **File**: `packages/server/src/server/agent/model-catalog.ts` (lines 22-101)
- **Main Function**: `fetchProviderModelCatalog(provider, options)`
- **Claude Function**: `fetchClaudeModelCatalog(options)` (lines 35-66)
- **Codex Function**: `fetchCodexModelCatalog()` (lines 68-101)

## How It Works

### Claude Model Fetching
- Uses the Claude Agent SDK's `query.supportedModels()` method
- Creates a query instance with the given `cwd` (working directory)
- Returns models from the SDK with their display names and descriptions

### Codex Model Fetching
- Spawns the Codex binary (`codex app-server`) as a subprocess
- Communicates via JSON-RPC protocol
- Sends `initialize` followed by `model/list` requests
- Returns models with metadata including reasoning efforts

## Actual Models Returned

### Claude Models (3 total)

1. **Default (recommended)** (`default`)
   - Description: "Sonnet 4.5 · Smartest model for daily use"
   - Is Default: false

2. **Opus** (`opus`)
   - Description: "Legacy: Opus 4.1 · Reaches usage limits faster"
   - Is Default: false

3. **Haiku** (`haiku`)
   - Description: "Haiku 4.5 · Fastest model for simple tasks"
   - Is Default: false

### Codex Models (3 total)

1. **gpt-5.1-codex** (`gpt-5.1-codex`) ⭐ DEFAULT
   - Description: "Optimized for codex."
   - Is Default: true
   - Model: gpt-5.1-codex
   - Default Reasoning Effort: medium

2. **gpt-5.1-codex-mini** (`gpt-5.1-codex-mini`)
   - Description: "Optimized for codex. Cheaper, faster, but less capable."
   - Is Default: false
   - Model: gpt-5.1-codex-mini
   - Default Reasoning Effort: medium

3. **gpt-5.1** (`gpt-5.1`)
   - Description: "Broad world knowledge with strong general reasoning."
   - Is Default: false
   - Model: gpt-5.1
   - Default Reasoning Effort: medium

## Key Observations

1. **Claude models**: The model IDs returned are simplified (`default`, `opus`, `haiku`) rather than full model identifiers like `claude-sonnet-4-5-20250929`.

2. **Codex models**: All three models are available and properly marked with `isDefault` flag on `gpt-5.1-codex`.

3. **No Sonnet variant**: Interestingly, Claude returns a "default" model (which is Sonnet 4.5 based on the description) but doesn't expose a model ID called "sonnet" - only "default", "opus", and "haiku".

4. **Model resolution**: The `model-resolver.ts` file uses these catalogs to find the default model when none is specified, preferring models marked with `isDefault: true`.

## Testing Method

Created and ran a test script (`test-models.ts`) that directly imports and calls:
- `fetchClaudeModelCatalog()`
- `fetchCodexModelCatalog()`

Executed with: `npx tsx test-models.ts`

## Related Files

- `src/server/agent/model-catalog.ts` - Model fetching implementation
- `src/server/agent/model-resolver.ts` - Default model resolution
- `src/server/agent/model-catalog.e2e.test.ts` - End-to-end tests
- `src/server/session.ts:1589` - Usage in session handling (list_provider_models_response)
