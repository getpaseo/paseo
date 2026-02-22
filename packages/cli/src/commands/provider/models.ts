import type { Command } from 'commander'
import { connectToDaemon } from '../../utils/client.js'
import type { CommandOptions, ListResult, OutputSchema } from '../../output/index.js'

/** Model list item for display */
export interface ModelListItem {
  model: string
  id: string
  description: string
  thinkingOptionIds: string[]
  defaultThinkingOptionId: string | null
  thinkingOptions: string
}

/** Schema for provider models output */
export const providerModelsSchema: OutputSchema<ModelListItem> = {
  idField: 'id',
  columns: [
    { header: 'ID', field: 'id', width: 30 },
    { header: 'MODEL', field: 'model', width: 30 },
    { header: 'DESCRIPTION', field: 'description', width: 40 },
  ],
}

const providerModelsWithThinkingSchema: OutputSchema<ModelListItem> = {
  idField: 'id',
  columns: [
    { header: 'ID', field: 'id', width: 30 },
    { header: 'MODEL', field: 'model', width: 30 },
    { header: 'THINKING IDS', field: 'thinkingOptions', width: 40 },
    {
      header: 'DEFAULT THINKING',
      field: (item) => item.defaultThinkingOptionId ?? 'auto',
      width: 18,
    },
  ],
}

export type ProviderModelsResult = ListResult<ModelListItem>

export interface ProviderModelsOptions extends CommandOptions {
  host?: string
  thinking?: boolean
}

export async function runModelsCommand(
  provider: string,
  options: ProviderModelsOptions,
  _command: Command
): Promise<ProviderModelsResult> {
  const normalizedProvider = provider.toLowerCase()

  const client = await connectToDaemon({ host: options.host })
  try {
    const result = await client.listProviderModels(normalizedProvider)

    if (result.error) {
      throw {
        code: 'PROVIDER_ERROR',
        message: `Failed to fetch models for ${provider}: ${result.error}`,
      }
    }

    const models: ModelListItem[] = (result.models ?? []).map((m) => ({
      model: m.label,
      id: m.id,
      description: m.description ?? '',
      thinkingOptionIds: (m.thinkingOptions ?? []).map((option) => option.id),
      defaultThinkingOptionId: m.defaultThinkingOptionId ?? null,
      thinkingOptions:
        (m.thinkingOptions ?? []).map((option) => option.id).join(', ') || 'none',
    }))

    return {
      type: 'list',
      data: models,
      schema: options.thinking ? providerModelsWithThinkingSchema : providerModelsSchema,
    }
  } finally {
    await client.close()
  }
}
