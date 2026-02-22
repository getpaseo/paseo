import { useCallback, useMemo } from 'react'
import { keepPreviousData, useQuery } from '@tanstack/react-query'
import type { AutocompleteOption } from '@/components/ui/autocomplete'
import { useAgentCommandsQuery, type DraftCommandConfig } from './use-agent-commands-query'
import { orderAutocompleteOptions } from '@/components/ui/autocomplete-utils'
import { useAutocomplete } from './use-autocomplete'
import { useSessionStore } from '@/stores/session-store'
import { useHostRuntimeSession } from '@/runtime/host-runtime'
import {
  applyFileMentionReplacement,
  findActiveFileMention,
  type FileMentionRange,
} from '@/utils/file-mention-autocomplete'

interface UseAgentAutocompleteInput {
  userInput: string
  cursorIndex: number
  setUserInput: (nextValue: string) => void
  serverId: string
  agentId: string
  draftConfig?: DraftCommandConfig
  onAutocompleteApplied?: () => void
}

type AgentAutocompleteOption =
  | (AutocompleteOption & { type: 'command' })
  | (AutocompleteOption & {
      type: 'workspace_entry'
      entryPath: string
      mention: FileMentionRange
    })

interface AgentAutocompleteResult {
  isVisible: boolean
  options: AutocompleteOption[]
  selectedIndex: number
  isLoading: boolean
  errorMessage?: string
  loadingText: string
  emptyText: string
  onSelectOption: (option: AutocompleteOption) => void
  onKeyPress: (event: { key: string; preventDefault: () => void }) => boolean
}

interface DirectorySuggestionEntry {
  path: string
  kind: 'file' | 'directory'
}

function normalizeDraftCommandConfig(
  draftConfig?: DraftCommandConfig
): DraftCommandConfig | undefined {
  if (!draftConfig) {
    return undefined
  }

  const cwd = draftConfig.cwd.trim()
  if (!cwd) {
    return undefined
  }

  const modeId = draftConfig.modeId?.trim() ?? ''
  const model = draftConfig.model?.trim() ?? ''
  const thinkingOptionId = draftConfig.thinkingOptionId?.trim() ?? ''
  return {
    provider: draftConfig.provider,
    cwd,
    ...(modeId ? { modeId } : {}),
    ...(model ? { model } : {}),
    ...(thinkingOptionId ? { thinkingOptionId } : {}),
  }
}

function mapDirectorySuggestionsToEntries(payload: {
  entries?: Array<{ path: string; kind: string }>
  directories?: string[]
}): DirectorySuggestionEntry[] {
  if (Array.isArray(payload.entries) && payload.entries.length > 0) {
    return payload.entries.flatMap((entry) => {
      if (
        !entry ||
        typeof entry.path !== 'string' ||
        (entry.kind !== 'file' && entry.kind !== 'directory')
      ) {
        return []
      }
      return [{ path: entry.path, kind: entry.kind }]
    })
  }

  return (payload.directories ?? []).map((path) => ({
    path,
    kind: 'directory' as const,
  }))
}

export function useAgentAutocomplete(input: UseAgentAutocompleteInput): AgentAutocompleteResult {
  const {
    userInput,
    cursorIndex,
    setUserInput,
    serverId,
    agentId,
    draftConfig,
    onAutocompleteApplied,
  } = input

  const showCommandAutocomplete = userInput.startsWith('/') && !userInput.includes(' ')
  const commandFilterQuery = showCommandAutocomplete ? userInput.slice(1) : ''

  const activeFileMention = useMemo(
    () =>
      findActiveFileMention({
        text: userInput,
        cursorIndex,
      }),
    [cursorIndex, userInput]
  )
  const showFileAutocomplete = activeFileMention !== null
  const fileFilterQuery = activeFileMention?.query ?? ''

  const normalizedDraftConfig = useMemo(
    () => normalizeDraftCommandConfig(draftConfig),
    [draftConfig]
  )

  const isRealAgent = Boolean(agentId) && !agentId.startsWith('__')
  const queryDraftConfig = isRealAgent ? undefined : normalizedDraftConfig
  const canLoadCommands = Boolean(serverId) && (isRealAgent || !!queryDraftConfig)

  const agentCwd = useSessionStore(
    (state) => state.sessions[serverId]?.agents?.get(agentId)?.cwd ?? ''
  )
  const autocompleteCwd = useMemo(() => {
    if (isRealAgent) {
      return agentCwd.trim()
    }
    return queryDraftConfig?.cwd ?? ''
  }, [agentCwd, isRealAgent, queryDraftConfig])

  const { client, isConnected } = useHostRuntimeSession(serverId)

  const mode: 'command' | 'file' | null = showFileAutocomplete
    ? 'file'
    : showCommandAutocomplete
      ? 'command'
      : null
  const isVisible =
    mode === 'command'
      ? canLoadCommands
      : mode === 'file'
        ? Boolean(serverId) && autocompleteCwd.length > 0
        : false

  const {
    commands,
    isLoading: isCommandsLoading,
    isError,
    error,
  } = useAgentCommandsQuery({
    serverId,
    agentId,
    enabled: mode === 'command' && canLoadCommands,
    draftConfig: queryDraftConfig,
  })

  const fileSuggestionsQuery = useQuery({
    queryKey: ['directorySuggestions', serverId, autocompleteCwd, fileFilterQuery, true, true],
    queryFn: async (): Promise<DirectorySuggestionEntry[]> => {
      if (!client) {
        throw new Error('Daemon client unavailable')
      }
      const response = await client.getDirectorySuggestions({
        cwd: autocompleteCwd,
        query: fileFilterQuery,
        limit: 50,
        includeFiles: true,
        includeDirectories: true,
      })
      if (response.error) {
        throw new Error(response.error)
      }
      return mapDirectorySuggestionsToEntries(response)
    },
    enabled:
      mode === 'file' &&
      Boolean(serverId) &&
      autocompleteCwd.length > 0 &&
      Boolean(client) &&
      isConnected,
    retry: false,
    staleTime: 15_000,
    placeholderData: keepPreviousData,
  })

  const options = useMemo<AgentAutocompleteOption[]>(() => {
    if (!isVisible) {
      return []
    }

    if (mode === 'command') {
      const filterLower = commandFilterQuery.toLowerCase()
      const matches = commands.filter((cmd) => cmd.name.toLowerCase().includes(filterLower))
      const orderedMatches = orderAutocompleteOptions(matches)
      return orderedMatches.map((cmd) => ({
        type: 'command' as const,
        id: cmd.name,
        label: `/${cmd.name}`,
        detail: cmd.argumentHint || undefined,
        description: cmd.description,
        kind: 'command',
      }))
    }

    if (mode === 'file' && activeFileMention) {
      const orderedEntries = orderAutocompleteOptions(fileSuggestionsQuery.data ?? [])
      return orderedEntries.map((entry) => ({
        type: 'workspace_entry' as const,
        id: `${entry.kind}:${entry.path}`,
        label: entry.path,
        kind: entry.kind,
        entryPath: entry.path,
        mention: activeFileMention,
      }))
    }

    return []
  }, [activeFileMention, commandFilterQuery, commands, fileSuggestionsQuery.data, isVisible, mode])

  const onSelectOption = useCallback(
    (option: AutocompleteOption) => {
      const selected = option as AgentAutocompleteOption
      if (selected.type === 'command') {
        setUserInput(`/${selected.id} `)
        onAutocompleteApplied?.()
        return
      }

      const nextInput = applyFileMentionReplacement({
        text: userInput,
        mention: selected.mention,
        relativePath: selected.entryPath,
      })
      setUserInput(nextInput)
      onAutocompleteApplied?.()
    },
    [onAutocompleteApplied, setUserInput, userInput]
  )

  const { selectedIndex, onKeyPress } = useAutocomplete({
    isVisible,
    options,
    query: mode === 'command' ? commandFilterQuery : fileFilterQuery,
    onSelectOption,
    onEscape: mode === 'command' ? () => setUserInput('') : undefined,
  })

  const isLoading =
    mode === 'command'
      ? isCommandsLoading
      : mode === 'file'
        ? fileSuggestionsQuery.isPending || (fileSuggestionsQuery.isLoading && options.length === 0)
        : false
  const errorMessage =
    mode === 'command'
      ? isError
        ? (error?.message ?? 'Failed to load')
        : undefined
      : mode === 'file'
        ? fileSuggestionsQuery.error instanceof Error
          ? fileSuggestionsQuery.error.message
          : undefined
        : undefined

  const loadingText = mode === 'file' ? 'Searching workspace...' : 'Loading commands...'
  const emptyText = mode === 'file' ? 'No files or directories found' : 'No commands found'

  return {
    isVisible,
    options,
    selectedIndex,
    isLoading,
    errorMessage,
    loadingText,
    emptyText,
    onSelectOption,
    onKeyPress,
  }
}
