import type { Command } from 'commander'
import type { CommandOptions, ListResult, OutputSchema } from '../../output/index.js'

/** Provider list item for display */
export interface ProviderListItem {
  provider: string
  status: string
  defaultMode: string
  modes: string
}

/** Static provider data - providers are built-in and don't require daemon */
const PROVIDERS: ProviderListItem[] = [
  {
    provider: 'claude',
    status: 'available',
    defaultMode: 'default',
    modes: 'plan, default, bypass',
  },
  {
    provider: 'codex',
    status: 'available',
    defaultMode: 'auto',
    modes: 'read-only, auto, full-access',
  },
  {
    provider: 'opencode',
    status: 'available',
    defaultMode: 'default',
    modes: 'plan, default, bypass',
  },
]

/** Schema for provider ls output */
export const providerLsSchema: OutputSchema<ProviderListItem> = {
  idField: 'provider',
  columns: [
    { header: 'PROVIDER', field: 'provider', width: 12 },
    {
      header: 'STATUS',
      field: 'status',
      width: 12,
      color: (value) => {
        if (value === 'available') return 'green'
        if (value === 'unavailable') return 'red'
        return undefined
      },
    },
    { header: 'DEFAULT MODE', field: 'defaultMode', width: 14 },
    { header: 'MODES', field: 'modes', width: 30 },
  ],
}

export type ProviderLsResult = ListResult<ProviderListItem>

export interface ProviderLsOptions extends CommandOptions {
  host?: string
}

export async function runLsCommand(
  _options: ProviderLsOptions,
  _command: Command
): Promise<ProviderLsResult> {
  // Provider data is static - no daemon connection needed
  return {
    type: 'list',
    data: PROVIDERS,
    schema: providerLsSchema,
  }
}
