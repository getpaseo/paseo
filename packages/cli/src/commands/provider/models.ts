import type { Command } from 'commander'
import type { CommandOptions, ListResult, OutputSchema, CommandError } from '../../output/index.js'

/** Model list item for display */
export interface ModelListItem {
  model: string
  id: string
}

/** Static model data by provider */
const MODELS_BY_PROVIDER: Record<string, ModelListItem[]> = {
  claude: [
    { model: 'Claude Sonnet 4', id: 'claude-sonnet-4-20250514' },
    { model: 'Claude Opus 4', id: 'claude-opus-4-20250514' },
    { model: 'Claude Haiku 3.5', id: 'claude-3-5-haiku-20241022' },
  ],
  codex: [
    { model: 'o3-mini', id: 'o3-mini' },
    { model: 'o4-mini', id: 'o4-mini' },
  ],
  opencode: [
    // opencode uses claude or codex under the hood
    { model: 'Claude Sonnet 4', id: 'claude-sonnet-4-20250514' },
    { model: 'Claude Opus 4', id: 'claude-opus-4-20250514' },
    { model: 'Claude Haiku 3.5', id: 'claude-3-5-haiku-20241022' },
    { model: 'o3-mini', id: 'o3-mini' },
    { model: 'o4-mini', id: 'o4-mini' },
  ],
}

/** Schema for provider models output */
export const providerModelsSchema: OutputSchema<ModelListItem> = {
  idField: 'id',
  columns: [
    { header: 'MODEL', field: 'model', width: 30 },
    { header: 'ID', field: 'id', width: 30 },
  ],
}

export type ProviderModelsResult = ListResult<ModelListItem>

export interface ProviderModelsOptions extends CommandOptions {
  host?: string
}

export async function runModelsCommand(
  provider: string,
  _options: ProviderModelsOptions,
  _command: Command
): Promise<ProviderModelsResult> {
  const normalizedProvider = provider.toLowerCase()
  const models = MODELS_BY_PROVIDER[normalizedProvider]

  if (!models) {
    const validProviders = Object.keys(MODELS_BY_PROVIDER).join(', ')
    const error: CommandError = {
      code: 'UNKNOWN_PROVIDER',
      message: `Unknown provider: ${provider}`,
      details: `Valid providers: ${validProviders}`,
    }
    throw error
  }

  return {
    type: 'list',
    data: models,
    schema: providerModelsSchema,
  }
}
