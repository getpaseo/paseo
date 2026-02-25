import { useCallback, useEffect, useMemo, useReducer, useRef, useState, useSyncExternalStore } from 'react'
import { createNameId } from 'mnemonic-id'
import type { ImageAttachment } from '@/components/message-input'
import { View, Text, Pressable, ScrollView, Keyboard, Platform } from 'react-native'
import { useLocalSearchParams, useRouter } from 'expo-router'
import { useIsFocused } from '@react-navigation/native'
import { StyleSheet, UnistylesRuntime, useUnistyles } from 'react-native-unistyles'
import { useSafeAreaInsets } from 'react-native-safe-area-context'
import { useReanimatedKeyboardAnimation } from 'react-native-keyboard-controller'
import { GestureDetector } from 'react-native-gesture-handler'
import Animated, { useAnimatedStyle, useSharedValue } from 'react-native-reanimated'
import { Folder, GitBranch, PanelRight } from 'lucide-react-native'
import { SidebarMenuToggle } from '@/components/headers/menu-header'
import { HeaderToggleButton } from '@/components/headers/header-toggle-button'
import { AgentInputArea } from '@/components/agent-input-area'
import { AgentStreamView } from '@/components/agent-stream-view'
import { AgentConfigRow, FormSelectTrigger } from '@/components/agent-form/agent-form-dropdowns'
import { ExplorerSidebar } from '@/components/explorer-sidebar'
import { Combobox } from '@/components/ui/combobox'
import { FileDropZone } from '@/components/file-drop-zone'
import { useQuery } from '@tanstack/react-query'
import { useAgentFormState, type CreateAgentInitialValues } from '@/hooks/use-agent-form-state'
import type { DraftCommandConfig } from '@/hooks/use-agent-commands-query'
import {
  CHECKOUT_STATUS_STALE_TIME,
  checkoutStatusQueryKey,
} from '@/hooks/use-checkout-status-query'
import { useAllAgentsList } from '@/hooks/use-all-agents-list'
import { useDaemonRegistry } from '@/contexts/daemon-registry-context'
import { buildBranchComboOptions, normalizeBranchOptionName } from '@/utils/branch-suggestions'
import { shortenPath } from '@/utils/shorten-path'
import { collectAgentWorkingDirectorySuggestions } from '@/utils/agent-working-directory-suggestions'
import { buildWorkingDirectorySuggestions } from '@/utils/working-directory-suggestions'
import { useExplorerOpenGesture } from '@/hooks/use-explorer-open-gesture'
import { useSessionStore } from '@/stores/session-store'
import { useCreateFlowStore } from '@/stores/create-flow-store'
import { generateDraftId } from '@/stores/draft-keys'
import { getHostRuntimeStore, useHostRuntimeSession } from '@/runtime/host-runtime'
import { ExplorerSidebarAnimationProvider } from '@/contexts/explorer-sidebar-animation-context'
import { usePanelStore, type ExplorerCheckoutContext } from '@/stores/panel-store'
import { MAX_CONTENT_WIDTH } from '@/constants/layout'
import { WelcomeScreen } from '@/components/welcome-screen'
import type { Agent } from '@/contexts/session-context'
import { generateMessageId, type StreamItem, type UserMessageImageAttachment } from '@/types/stream'
import { encodeImages } from '@/utils/encode-images'
import type {
  AgentProvider,
  AgentCapabilityFlags,
  AgentSessionConfig,
} from '@server/server/agent/agent-sdk-types'
import { AGENT_PROVIDER_DEFINITIONS } from '@server/server/agent/provider-manifest'
import { buildHostAgentDetailRoute } from '@/utils/host-routes'
import { useTauriDragHandlers } from '@/utils/tauri-window'

const DRAFT_AGENT_ID = '__new_agent__'
const EMPTY_PENDING_PERMISSIONS = new Map()
const EMPTY_STREAM_ITEMS: StreamItem[] = []
const DRAFT_CAPABILITIES: AgentCapabilityFlags = {
  supportsStreaming: true,
  supportsSessionPersistence: false,
  supportsDynamicModes: false,
  supportsMcpServers: false,
  supportsReasoningStream: false,
  supportsToolInvocations: false,
}
const PROVIDER_DEFINITION_MAP = new Map(
  AGENT_PROVIDER_DEFINITIONS.map((definition) => [definition.id, definition])
)

function getParamValue(value: string | string[] | undefined) {
  if (typeof value === 'string') {
    const trimmed = value.trim()
    return trimmed.length > 0 ? trimmed : undefined
  }
  if (Array.isArray(value)) {
    for (const entry of value) {
      const trimmed = entry.trim()
      if (trimmed.length > 0) {
        return trimmed
      }
    }
  }
  return undefined
}

function getValidProvider(value: string | undefined) {
  if (!value) {
    return undefined
  }
  return PROVIDER_DEFINITION_MAP.has(value as AgentProvider) ? (value as AgentProvider) : undefined
}

function getValidMode(provider: AgentProvider | undefined, value: string | undefined) {
  if (!provider || !value) {
    return undefined
  }
  const definition = PROVIDER_DEFINITION_MAP.get(provider)
  const modes = definition?.modes ?? []
  return modes.some((mode) => mode.id === value) ? value : undefined
}

type DraftAgentParams = {
  serverId?: string
  provider?: string
  modeId?: string
  model?: string
  thinkingOptionId?: string
  workingDir?: string
}

type DraftAgentScreenProps = {
  isVisible?: boolean
  onCreateFlowActiveChange?: (active: boolean) => void
  forcedServerId?: string
}

export function DraftAgentScreen({
  isVisible = true,
  onCreateFlowActiveChange,
  forcedServerId,
}: DraftAgentScreenProps = {}) {
  return (
    <ExplorerSidebarAnimationProvider>
      <DraftAgentScreenContent
        isVisible={isVisible}
        onCreateFlowActiveChange={onCreateFlowActiveChange}
        forcedServerId={forcedServerId}
      />
    </ExplorerSidebarAnimationProvider>
  )
}

function DraftAgentScreenContent({
  isVisible = true,
  onCreateFlowActiveChange,
  forcedServerId,
}: DraftAgentScreenProps = {}) {
  const isFocused = useIsFocused()
  const { theme } = useUnistyles()
  const router = useRouter()
  const insets = useSafeAreaInsets()
  const { daemons } = useDaemonRegistry()
  const runtime = getHostRuntimeStore()
  const runtimeVersion = useSyncExternalStore(
    (onStoreChange) => runtime.subscribeAll(onStoreChange),
    () => runtime.getVersion(),
    () => runtime.getVersion()
  )
  const params = useLocalSearchParams<DraftAgentParams>()

  const { height: keyboardHeight } = useReanimatedKeyboardAnimation()
  const bottomInset = useSharedValue(insets.bottom)

  useEffect(() => {
    bottomInset.value = insets.bottom
  }, [insets.bottom, bottomInset])

  const animatedKeyboardStyle = useAnimatedStyle(() => {
    'worklet'
    const absoluteHeight = Math.abs(keyboardHeight.value)
    const shift = Math.max(0, absoluteHeight - bottomInset.value)
    return {
      transform: [{ translateY: -shift }],
    }
  })

  const forcedServerIdParam = forcedServerId?.trim()
  const resolvedServerId =
    forcedServerIdParam && forcedServerIdParam.length > 0
      ? forcedServerIdParam
      : getParamValue(params.serverId)
  const resolvedProvider = getValidProvider(getParamValue(params.provider))
  const resolvedMode = getValidMode(resolvedProvider, getParamValue(params.modeId))
  const resolvedModel = getParamValue(params.model)
  const resolvedThinkingOptionId = getParamValue(params.thinkingOptionId)
  const resolvedWorkingDir = getParamValue(params.workingDir)

  const onlineServerIds = useMemo(() => {
    if (daemons.length === 0) return []
    const out: string[] = []
    for (const daemon of daemons) {
      const status = runtime.getSnapshot(daemon.serverId)?.connectionStatus ?? 'connecting'
      if (status === 'online') out.push(daemon.serverId)
    }
    return out
  }, [daemons, runtime, runtimeVersion])

  const initialValues = useMemo((): CreateAgentInitialValues => {
    const values: CreateAgentInitialValues = {}
    if (resolvedWorkingDir) {
      values.workingDir = resolvedWorkingDir
    }
    if (resolvedProvider) {
      values.provider = resolvedProvider
    }
    if (resolvedMode) {
      values.modeId = resolvedMode
    }
    if (resolvedModel) {
      values.model = resolvedModel
    }
    if (resolvedThinkingOptionId) {
      values.thinkingOptionId = resolvedThinkingOptionId
    }
    return values
  }, [resolvedMode, resolvedModel, resolvedProvider, resolvedThinkingOptionId, resolvedWorkingDir])

  const {
    selectedServerId,
    setSelectedServerIdFromUser,
    selectedProvider,
    setProviderFromUser,
    selectedMode,
    setModeFromUser,
    selectedModel,
    setModelFromUser,
    selectedThinkingOptionId,
    setThinkingOptionFromUser,
    workingDir,
    setWorkingDirFromUser,
    providerDefinitions,
    modeOptions,
    availableModels,
    availableThinkingOptions,
    isModelLoading,
    modelError,
    refreshProviderModels,
    persistFormPreferences,
  } = useAgentFormState({
    initialServerId: resolvedServerId ?? null,
    initialValues,
    isVisible,
    isCreateFlow: true,
    onlineServerIds,
  })
  const isMobile = UnistylesRuntime.breakpoint === 'xs' || UnistylesRuntime.breakpoint === 'sm'
  const mobileView = usePanelStore((state) => state.mobileView)
  const desktopFileExplorerOpen = usePanelStore((state) => state.desktop.fileExplorerOpen)
  const toggleFileExplorer = usePanelStore((state) => state.toggleFileExplorer)
  const openFileExplorer = usePanelStore((state) => state.openFileExplorer)
  const closeFileExplorer = usePanelStore((state) => state.closeFileExplorer)
  const setActiveExplorerCheckout = usePanelStore((state) => state.setActiveExplorerCheckout)
  const activateExplorerTabForCheckout = usePanelStore(
    (state) => state.activateExplorerTabForCheckout
  )
  const tauriDragHandlers = useTauriDragHandlers()
  const isExplorerOpen = isMobile ? mobileView === 'file-explorer' : desktopFileExplorerOpen
  const draftIdRef = useRef(generateDraftId())

  const [worktreeMode, setWorktreeMode] = useState<'none' | 'create' | 'attach'>('none')
  const [baseBranch, setBaseBranch] = useState('')
  const [worktreeSlug, setWorktreeSlug] = useState('')
  const [selectedWorktreePath, setSelectedWorktreePath] = useState('')
  const [isWorkingDirOpen, setIsWorkingDirOpen] = useState(false)
  const [isWorktreePickerOpen, setIsWorktreePickerOpen] = useState(false)
  const [isBranchOpen, setIsBranchOpen] = useState(false)
  const [branchSearchQuery, setBranchSearchQuery] = useState('')
  const [debouncedBranchSearchQuery, setDebouncedBranchSearchQuery] = useState('')
  const [workingDirSearchQuery, setWorkingDirSearchQuery] = useState('')
  const [debouncedWorkingDirSearchQuery, setDebouncedWorkingDirSearchQuery] = useState('')
  const workingDirAnchorRef = useRef<View>(null)
  const worktreeAnchorRef = useRef<View>(null)
  const branchAnchorRef = useRef<View>(null)
  const addImagesRef = useRef<((images: ImageAttachment[]) => void) | null>(null)
  const setPendingCreateAttempt = useCreateFlowStore((state) => state.setPending)
  const updatePendingAgentId = useCreateFlowStore((state) => state.updateAgentId)
  const markPendingCreateLifecycle = useCreateFlowStore((state) => state.markLifecycle)
  const clearPendingCreateAttempt = useCreateFlowStore((state) => state.clear)

  useEffect(() => {
    const trimmed = branchSearchQuery.trim()
    const timer = setTimeout(() => setDebouncedBranchSearchQuery(trimmed), 180)
    return () => clearTimeout(timer)
  }, [branchSearchQuery])

  useEffect(() => {
    const trimmed = workingDirSearchQuery.trim()
    const timer = setTimeout(() => setDebouncedWorkingDirSearchQuery(trimmed), 180)
    return () => clearTimeout(timer)
  }, [workingDirSearchQuery])

  type CreateAttempt = {
    clientMessageId: string
    text: string
    timestamp: Date
    images?: UserMessageImageAttachment[]
  }

  type DraftAgentMachineState =
    | { tag: 'draft'; promptText: string; errorMessage: string }
    | { tag: 'creating'; attempt: CreateAttempt }

  type DraftAgentMachineEvent =
    | { type: 'DRAFT_SET_PROMPT'; text: string }
    | { type: 'DRAFT_SET_ERROR'; message: string }
    | { type: 'SUBMIT'; attempt: CreateAttempt }
    | { type: 'CREATE_FAILED'; message: string }

  function assertNever(value: never): never {
    throw new Error(`Unhandled state: ${JSON.stringify(value)}`)
  }

  const [machine, dispatch] = useReducer(
    (state: DraftAgentMachineState, event: DraftAgentMachineEvent): DraftAgentMachineState => {
      switch (event.type) {
        case 'DRAFT_SET_PROMPT': {
          if (state.tag !== 'draft') {
            return state
          }
          return { ...state, promptText: event.text }
        }
        case 'DRAFT_SET_ERROR': {
          if (state.tag !== 'draft') {
            return state
          }
          return { ...state, errorMessage: event.message }
        }
        case 'SUBMIT': {
          return { tag: 'creating', attempt: event.attempt }
        }
        case 'CREATE_FAILED': {
          if (state.tag !== 'creating') {
            return state
          }
          return { tag: 'draft', promptText: state.attempt.text, errorMessage: event.message }
        }
        default:
          return assertNever(event)
      }
    },
    { tag: 'draft', promptText: '', errorMessage: '' }
  )

  const handleFilesDropped = useCallback((files: ImageAttachment[]) => {
    addImagesRef.current?.(files)
  }, [])

  const handleAddImagesCallback = useCallback((addImages: (images: ImageAttachment[]) => void) => {
    addImagesRef.current = addImages
  }, [])
  const sessionAgents = useSessionStore((state) =>
    selectedServerId ? state.sessions[selectedServerId]?.agents : undefined
  )
  const { agents: allAgents } = useAllAgentsList({ serverId: selectedServerId })
  const worktreePathLastCreatedAt = useMemo(() => {
    const map = new Map<string, number>()
    if (!sessionAgents) {
      return map
    }
    sessionAgents.forEach((agent) => {
      if (!agent.cwd) {
        return
      }
      const ts = agent.createdAt.getTime()
      const prev = map.get(agent.cwd)
      if (!prev || ts > prev) {
        map.set(agent.cwd, ts)
      }
    })
    return map
  }, [sessionAgents])
  const agentWorkingDirSuggestions = useMemo(() => {
    const liveSources = sessionAgents
      ? Array.from(sessionAgents.values()).map((agent) => ({
          cwd: agent.cwd,
          createdAt: agent.createdAt,
          lastActivityAt: agent.lastActivityAt,
        }))
      : []
    const fetchedSources = allAgents.map((agent) => ({
      cwd: agent.cwd,
      lastActivityAt: agent.lastActivityAt,
    }))

    return collectAgentWorkingDirectorySuggestions([...liveSources, ...fetchedSources])
  }, [allAgents, sessionAgents])

  const { client: runtimeClient, isConnected: isHostOnline } = useHostRuntimeSession(
    selectedServerId ?? ''
  )
  const sessionClient = runtimeClient
  const trimmedWorkingDir = workingDir.trim()
  const shouldInspectRepo = trimmedWorkingDir.length > 0
  const canQuerySelectedHost = Boolean(selectedServerId) && Boolean(sessionClient) && isHostOnline

  const checkoutStatusQuery = useQuery({
    queryKey: checkoutStatusQueryKey(selectedServerId ?? '', trimmedWorkingDir),
    queryFn: async () => {
      const client = sessionClient
      if (!client) {
        throw new Error('Daemon client unavailable')
      }
      return await client.getCheckoutStatus(trimmedWorkingDir)
    },
    enabled: Boolean(trimmedWorkingDir) && canQuerySelectedHost,
    retry: false,
    staleTime: CHECKOUT_STATUS_STALE_TIME,
    refetchOnMount: 'always',
  })

  const checkout = checkoutStatusQuery.data ?? null
  const checkoutQueryError =
    checkoutStatusQuery.error instanceof Error ? checkoutStatusQuery.error.message : null
  const checkoutPayloadError = checkout?.error ? checkout.error.message : null
  const isGitDirectory = checkoutStatusQuery.isSuccess && checkout?.isGit === true

  const isNonGitDirectory =
    Boolean(trimmedWorkingDir) &&
    checkoutStatusQuery.isSuccess &&
    checkout?.isGit === false &&
    checkout?.error == null

  const isDirectoryNotExists =
    checkoutStatusQuery.isError &&
    /does not exist|no such file or directory|ENOENT/i.test(checkoutQueryError ?? '')

  const repoInfoStatus: 'idle' | 'loading' | 'ready' | 'error' = !shouldInspectRepo
    ? 'idle'
    : !canQuerySelectedHost
      ? 'idle'
      : checkoutStatusQuery.isPending || checkoutStatusQuery.isFetching
        ? 'loading'
        : checkoutStatusQuery.isError || Boolean(checkoutPayloadError)
          ? 'error'
          : checkout?.isGit
            ? 'ready'
            : 'idle'

  const repoInfoError =
    (checkoutStatusQuery.isError ? checkoutQueryError : null) ?? checkoutPayloadError
  const isCreateWorktree = worktreeMode === 'create'
  const isAttachWorktree = worktreeMode === 'attach'

  const worktreeListRoot = checkout?.isGit ? checkout.repoRoot : ''
  const worktreeListQuery = useQuery({
    queryKey: ['paseoWorktreeList', selectedServerId, worktreeListRoot],
    queryFn: async () => {
      const client = sessionClient
      if (!client) {
        throw new Error('Daemon client unavailable')
      }
      const payload = await client.getPaseoWorktreeList({
        repoRoot: worktreeListRoot || undefined,
        cwd: worktreeListRoot ? undefined : trimmedWorkingDir || undefined,
      })
      if (payload.error) {
        throw new Error(payload.error.message)
      }
      return payload.worktrees ?? []
    },
    enabled:
      isGitDirectory &&
      Boolean(worktreeListRoot) &&
      canQuerySelectedHost &&
      !isNonGitDirectory,
    retry: false,
    staleTime: 0,
    refetchOnMount: 'always',
  })
  const worktreeOptions = useMemo(() => {
    const options = (worktreeListQuery.data ?? []).map((worktree) => ({
      path: worktree.worktreePath,
      label: worktree.branchName ?? worktree.head ?? 'Unknown branch',
    }))
    return options.sort((a, b) => {
      const aTs = worktreePathLastCreatedAt.get(a.path) ?? 0
      const bTs = worktreePathLastCreatedAt.get(b.path) ?? 0
      if (aTs !== bTs) {
        return bTs - aTs
      }
      return a.label.localeCompare(b.label)
    })
  }, [worktreeListQuery.data, worktreePathLastCreatedAt])
  const worktreeOptionsError =
    worktreeListQuery.error instanceof Error ? worktreeListQuery.error.message : null
  const worktreeOptionsStatus: 'idle' | 'loading' | 'ready' | 'error' =
    worktreeListQuery.isPending || worktreeListQuery.isFetching
      ? 'loading'
      : worktreeListQuery.isError
        ? 'error'
        : 'ready'
  const attachWorktreeError =
    isAttachWorktree &&
    worktreeOptionsStatus === 'ready' &&
    worktreeOptions.length > 0 &&
    !selectedWorktreePath
      ? 'Select a worktree to attach'
      : null

  const branchSuggestionsQuery = useQuery({
    queryKey: [
      'branchSuggestions',
      selectedServerId,
      trimmedWorkingDir,
      debouncedBranchSearchQuery,
    ],
    queryFn: async () => {
      const client = sessionClient
      if (!client) {
        throw new Error('Daemon client unavailable')
      }
      const payload = await client.getBranchSuggestions({
        cwd: trimmedWorkingDir || '.',
        query: debouncedBranchSearchQuery || undefined,
        limit: 50,
      })
      if (payload.error) {
        throw new Error(payload.error)
      }
      return payload.branches ?? []
    },
    enabled:
      isCreateWorktree &&
      isGitDirectory &&
      !isNonGitDirectory &&
      Boolean(trimmedWorkingDir) &&
      canQuerySelectedHost,
    retry: false,
    staleTime: 15_000,
  })

  const directorySuggestionsQuery = useQuery({
    queryKey: ['directorySuggestions', selectedServerId, debouncedWorkingDirSearchQuery],
    queryFn: async () => {
      const client = sessionClient
      if (!client) {
        throw new Error('Daemon client unavailable')
      }
      const payload = await client.getDirectorySuggestions({
        query: debouncedWorkingDirSearchQuery,
        limit: 50,
        includeDirectories: true,
        includeFiles: false,
      })
      if (payload.error) {
        throw new Error(payload.error)
      }
      if (payload.entries.length > 0) {
        return payload.entries
          .filter((entry) => entry.kind === 'directory')
          .map((entry) => entry.path)
      }
      return payload.directories ?? []
    },
    enabled:
      Boolean(debouncedWorkingDirSearchQuery) &&
      canQuerySelectedHost,
    retry: false,
    staleTime: 15_000,
  })

  const validateWorktreeName = useCallback((name: string): { valid: boolean; error?: string } => {
    if (!name) {
      return { valid: true }
    }
    if (name.length > 100) {
      return {
        valid: false,
        error: 'Worktree name too long (max 100 characters)',
      }
    }
    if (!/^[a-z0-9-/]+$/.test(name)) {
      return {
        valid: false,
        error: 'Must contain only lowercase letters, numbers, hyphens, and forward slashes',
      }
    }
    if (name.startsWith('-') || name.endsWith('-')) {
      return { valid: false, error: 'Cannot start or end with a hyphen' }
    }
    if (name.includes('--')) {
      return { valid: false, error: 'Cannot have consecutive hyphens' }
    }
    return { valid: true }
  }, [])

  const gitBlockingError = useMemo(() => {
    if (!isCreateWorktree || isNonGitDirectory) {
      return null
    }
    if (!worktreeSlug) {
      return null
    }
    const validation = validateWorktreeName(worktreeSlug)
    if (!validation.valid) {
      return `Invalid worktree name: ${
        validation.error ?? 'Must use lowercase letters, numbers, or hyphens'
      }`
    }
    return null
  }, [isCreateWorktree, isNonGitDirectory, worktreeSlug, validateWorktreeName])

  // Validate branch exists (checks local first, then remote)
  const branchValidationQuery = useQuery({
    queryKey: ['validateBranch', selectedServerId, trimmedWorkingDir, baseBranch],
    queryFn: async () => {
      const client = sessionClient
      if (!client) {
        throw new Error('Daemon client unavailable')
      }
      return client.validateBranch({
        cwd: trimmedWorkingDir || '.',
        branchName: baseBranch,
      })
    },
    enabled:
      isCreateWorktree &&
      isGitDirectory &&
      !isNonGitDirectory &&
      Boolean(baseBranch) &&
      Boolean(trimmedWorkingDir) &&
      Boolean(sessionClient) &&
      isHostOnline,
    retry: false,
    staleTime: 30_000,
  })

  const baseBranchError = useMemo(() => {
    if (!isCreateWorktree || isNonGitDirectory) {
      return null
    }
    if (!baseBranch) {
      return 'Base branch is required'
    }
    // While validating, don't show error
    if (branchValidationQuery.isPending || branchValidationQuery.isFetching) {
      return null
    }
    // If validation query errored, show generic error
    if (branchValidationQuery.isError) {
      return 'Failed to validate branch'
    }
    // If validation completed and branch doesn't exist
    const validationResult = branchValidationQuery.data
    if (validationResult && !validationResult.exists) {
      return `Branch "${baseBranch}" not found in repository`
    }
    return null
  }, [isCreateWorktree, isNonGitDirectory, baseBranch, branchValidationQuery])

  const handleBaseBranchChange = useCallback((value: string) => {
    setBaseBranch(value)
  }, [])

  const handleSelectWorktreePath = useCallback((path: string) => {
    setSelectedWorktreePath(path)
  }, [])

  useEffect(() => {
    if (!isCreateWorktree || isNonGitDirectory) {
      return
    }
    if (baseBranch) {
      return
    }
    const current = checkout?.isGit ? checkout.currentBranch?.trim() : null
    if (!current || current === 'HEAD') {
      return
    }
    if (current) {
      setBaseBranch(current)
    }
  }, [isCreateWorktree, isNonGitDirectory, baseBranch, checkout])

  useEffect(() => {
    if (isNonGitDirectory && worktreeMode !== 'none') {
      setWorktreeMode('none')
      setSelectedWorktreePath('')
    }
  }, [isNonGitDirectory, worktreeMode])

  const selectedWorktreeLabel =
    worktreeOptions.find((option) => option.path === selectedWorktreePath)?.label ?? ''
  const explorerCwd = useMemo(
    () => (isAttachWorktree && selectedWorktreePath ? selectedWorktreePath : workingDir).trim(),
    [isAttachWorktree, selectedWorktreePath, workingDir]
  )
  const draftExplorerCheckout = useMemo<ExplorerCheckoutContext | null>(() => {
    if (!selectedServerId || !explorerCwd) {
      return null
    }
    return {
      serverId: selectedServerId,
      cwd: explorerCwd,
      isGit: isAttachWorktree && selectedWorktreePath ? true : checkout?.isGit === true,
    }
  }, [selectedServerId, explorerCwd, isAttachWorktree, selectedWorktreePath, checkout?.isGit])
  const canOpenExplorer = draftExplorerCheckout !== null
  const openExplorerForDraftCheckout = useCallback(() => {
    if (!draftExplorerCheckout) {
      return
    }
    activateExplorerTabForCheckout(draftExplorerCheckout)
    openFileExplorer()
  }, [activateExplorerTabForCheckout, draftExplorerCheckout, openFileExplorer])
  const handleToggleExplorer = useCallback(() => {
    if (!canOpenExplorer) {
      return
    }
    if (isExplorerOpen) {
      toggleFileExplorer()
      return
    }
    openExplorerForDraftCheckout()
  }, [canOpenExplorer, isExplorerOpen, openExplorerForDraftCheckout, toggleFileExplorer])
  const explorerOpenGesture = useExplorerOpenGesture({
    enabled: isMobile && mobileView === 'agent' && canOpenExplorer,
    onOpen: openExplorerForDraftCheckout,
  })
  const hasWorkingDirectorySearch = debouncedWorkingDirSearchQuery.length > 0
  const workingDirSearchError =
    directorySuggestionsQuery.error instanceof Error
      ? directorySuggestionsQuery.error.message
      : null
  const workingDirSuggestionPaths = useMemo(
    () =>
      buildWorkingDirectorySuggestions({
        recommendedPaths: agentWorkingDirSuggestions,
        serverPaths: hasWorkingDirectorySearch ? (directorySuggestionsQuery.data ?? []) : [],
        query: workingDirSearchQuery,
      }),
    [
      agentWorkingDirSuggestions,
      directorySuggestionsQuery.data,
      hasWorkingDirectorySearch,
      workingDirSearchQuery,
    ]
  )
  const workingDirComboOptions = useMemo(
    () =>
      workingDirSuggestionPaths.map((path) => ({
        id: path,
        label: shortenPath(path),
        kind: 'directory' as const,
      })),
    [workingDirSuggestionPaths]
  )
  const workingDirEmptyText = useMemo(() => {
    if (hasWorkingDirectorySearch) {
      if (workingDirSearchError) {
        return 'Failed to search directories on this host.'
      }
      return 'No directories match your search.'
    }

    return agentWorkingDirSuggestions.length > 0
      ? 'No agent directories match your search.'
      : 'No agent directories match your search.'
  }, [agentWorkingDirSuggestions.length, hasWorkingDirectorySearch, workingDirSearchError])
  const displayWorkingDir = shortenPath(workingDir)
  const worktreeTriggerValue =
    worktreeMode === 'create' ? 'Create new worktree' : selectedWorktreeLabel || 'Select worktree'
  const worktreeComboOptions = useMemo(
    () => [
      {
        id: '__none__',
        label: 'None',
      },
      {
        id: '__create_new__',
        label: 'Create new worktree',
      },
      ...worktreeOptions.map((option) => ({
        id: option.path,
        label: option.label,
        description: shortenPath(option.path),
      })),
    ],
    [worktreeOptions]
  )

  const branchComboOptions = useMemo(() => {
    const options = buildBranchComboOptions({
      suggestedBranches: branchSuggestionsQuery.data ?? [],
      currentBranch: checkout?.isGit ? checkout.currentBranch : null,
      baseRef: checkout?.isGit ? checkout.baseRef : null,
      typedBaseBranch: baseBranch,
      worktreeBranchLabels: worktreeOptions.map((option) => option.label),
    })

    const normalizedQuery = normalizeBranchOptionName(branchSearchQuery)?.toLowerCase() ?? ''
    if (!normalizedQuery) {
      return options
    }

    return options.sort((a, b) => {
      const aLower = a.label.toLowerCase()
      const bLower = b.label.toLowerCase()
      const aPrefix = aLower.startsWith(normalizedQuery)
      const bPrefix = bLower.startsWith(normalizedQuery)
      if (aPrefix !== bPrefix) {
        return aPrefix ? -1 : 1
      }
      return aLower.localeCompare(bLower)
    })
  }, [baseBranch, branchSearchQuery, branchSuggestionsQuery.data, checkout, worktreeOptions])

  const createAgentClient = sessionClient
  const draftCommandConfig = useMemo<DraftCommandConfig | undefined>(() => {
    const cwd = (
      isAttachWorktree && selectedWorktreePath ? selectedWorktreePath : workingDir
    ).trim()
    if (!cwd) {
      return undefined
    }

    return {
      provider: selectedProvider,
      cwd,
      ...(modeOptions.length > 0 && selectedMode !== '' ? { modeId: selectedMode } : {}),
      ...(selectedModel.trim() ? { model: selectedModel.trim() } : {}),
      ...(selectedThinkingOptionId.trim()
        ? { thinkingOptionId: selectedThinkingOptionId.trim() }
        : {}),
    }
  }, [
    isAttachWorktree,
    modeOptions.length,
    selectedMode,
    selectedModel,
    selectedProvider,
    selectedThinkingOptionId,
    selectedWorktreePath,
    workingDir,
  ])

  const promptValue = machine.tag === 'draft' ? machine.promptText : ''
  const formErrorMessage = machine.tag === 'draft' ? machine.errorMessage : ''
  const isSubmitting = machine.tag === 'creating'

  const optimisticStreamItems = useMemo<StreamItem[]>(() => {
    if (machine.tag !== 'creating') {
      return EMPTY_STREAM_ITEMS
    }
    return [
      {
        kind: 'user_message',
        id: machine.attempt.clientMessageId,
        text: machine.attempt.text,
        timestamp: machine.attempt.timestamp,
        ...(machine.attempt.images && machine.attempt.images.length > 0
          ? { images: machine.attempt.images }
          : {}),
      },
    ]
  }, [machine])

  const draftAgent = useMemo<Agent | null>(() => {
    if (machine.tag !== 'creating') {
      return null
    }
    const serverId = selectedServerId ?? ''
    const now = machine.attempt.timestamp
    const cwd =
      (isAttachWorktree && selectedWorktreePath ? selectedWorktreePath : workingDir).trim() || '.'
    const provider = selectedProvider
    const model = selectedModel.trim() || null
    const thinkingOptionId = selectedThinkingOptionId.trim() || null
    const modeId = modeOptions.length > 0 && selectedMode !== '' ? selectedMode : null

    return {
      serverId,
      id: DRAFT_AGENT_ID,
      provider,
      status: 'running',
      createdAt: now,
      updatedAt: now,
      lastUserMessageAt: now,
      lastActivityAt: now,
      capabilities: DRAFT_CAPABILITIES,
      currentModeId: modeId,
      availableModes: [],
      pendingPermissions: [],
      persistence: null,
      runtimeInfo: {
        provider,
        sessionId: null,
        model,
        modeId,
      },
      title: 'New agent',
      cwd,
      model,
      thinkingOptionId,
      labels: {},
    }
  }, [
    machine.tag,
    machine.tag === 'creating' ? machine.attempt.timestamp : null,
    isAttachWorktree,
    modeOptions.length,
    selectedMode,
    selectedModel,
    selectedThinkingOptionId,
    selectedProvider,
    selectedServerId,
    selectedWorktreePath,
    workingDir,
  ])
  useEffect(() => {
    if (!isFocused) {
      return
    }
    setActiveExplorerCheckout(draftExplorerCheckout)
  }, [draftExplorerCheckout, isFocused, setActiveExplorerCheckout])
  useEffect(() => {
    if (!isFocused || !draftExplorerCheckout) {
      return
    }
    activateExplorerTabForCheckout(draftExplorerCheckout)
  }, [activateExplorerTabForCheckout, draftExplorerCheckout, isFocused])
  useEffect(() => {
    if (!isFocused || canOpenExplorer || !isExplorerOpen) {
      return
    }
    closeFileExplorer()
  }, [canOpenExplorer, closeFileExplorer, isExplorerOpen, isFocused])
  useEffect(() => {
    return () => {
      setActiveExplorerCheckout(null)
    }
  }, [setActiveExplorerCheckout])

  const handleCreateFromInput = useCallback(
    async ({ text, images }: { text: string; images?: UserMessageImageAttachment[] }) => {
      if (isSubmitting) {
        throw new Error('Already loading')
      }
      dispatch({ type: 'DRAFT_SET_ERROR', message: '' })
      const trimmedPath = workingDir.trim()
      const trimmedPrompt = text.trim()
      const resolvedWorkingDir =
        isAttachWorktree && selectedWorktreePath ? selectedWorktreePath : trimmedPath
      if (!trimmedPath) {
        dispatch({ type: 'DRAFT_SET_ERROR', message: 'Working directory is required' })
        throw new Error('Working directory is required')
      }
      if (isDirectoryNotExists) {
        dispatch({
          type: 'DRAFT_SET_ERROR',
          message: 'Working directory does not exist on the selected host',
        })
        throw new Error('Working directory does not exist on the selected host')
      }
      if (!trimmedPrompt) {
        dispatch({ type: 'DRAFT_SET_ERROR', message: 'Initial prompt is required' })
        throw new Error('Initial prompt is required')
      }
      if (!selectedServerId) {
        dispatch({ type: 'DRAFT_SET_ERROR', message: 'No host selected' })
        throw new Error('No host selected')
      }
      if (providerDefinitions.length === 0) {
        dispatch({
          type: 'DRAFT_SET_ERROR',
          message: 'No available providers on the selected host',
        })
        throw new Error('No available providers on the selected host')
      }
      if (gitBlockingError) {
        dispatch({ type: 'DRAFT_SET_ERROR', message: gitBlockingError })
        throw new Error(gitBlockingError)
      }
      if (isAttachWorktree && !selectedWorktreePath) {
        const message = 'Select a worktree to attach'
        dispatch({ type: 'DRAFT_SET_ERROR', message })
        throw new Error(message)
      }
      if (baseBranchError) {
        dispatch({ type: 'DRAFT_SET_ERROR', message: baseBranchError })
        throw new Error(baseBranchError)
      }
      if (!createAgentClient) {
        dispatch({ type: 'DRAFT_SET_ERROR', message: 'Host is not connected' })
        throw new Error('Host is not connected')
      }
      const attempt = {
        clientMessageId: generateMessageId(),
        text: trimmedPrompt,
        timestamp: new Date(),
        ...(images && images.length > 0 ? { images } : {}),
      }
      setPendingCreateAttempt({
        draftId: draftIdRef.current,
        serverId: selectedServerId,
        agentId: null,
        clientMessageId: attempt.clientMessageId,
        text: attempt.text,
        timestamp: attempt.timestamp.getTime(),
        ...(attempt.images && attempt.images.length > 0 ? { images: attempt.images } : {}),
      })
      const modeId = modeOptions.length > 0 && selectedMode !== '' ? selectedMode : undefined
      const trimmedModel = selectedModel.trim()
      const trimmedThinkingOptionId = selectedThinkingOptionId.trim()
      const config: AgentSessionConfig = {
        provider: selectedProvider,
        cwd: resolvedWorkingDir,
        ...(modeId ? { modeId } : {}),
        ...(trimmedModel ? { model: trimmedModel } : {}),
        ...(trimmedThinkingOptionId ? { thinkingOptionId: trimmedThinkingOptionId } : {}),
      }
      const effectiveBaseBranch = baseBranch.trim()
      const effectiveWorktreeSlug =
        isCreateWorktree && !worktreeSlug ? createNameId() : worktreeSlug
      if (isCreateWorktree && !worktreeSlug && effectiveWorktreeSlug) {
        setWorktreeSlug(effectiveWorktreeSlug)
      }
      const gitOptions =
        isCreateWorktree && !isNonGitDirectory && effectiveWorktreeSlug
          ? {
              createWorktree: true,
              createNewBranch: true,
              newBranchName: effectiveWorktreeSlug,
              worktreeSlug: effectiveWorktreeSlug,
              baseBranch: effectiveBaseBranch,
            }
          : undefined

      void persistFormPreferences()
      if (Platform.OS === 'web') {
        ;(document.activeElement as HTMLElement | null)?.blur?.()
      }
      Keyboard.dismiss()
      dispatch({ type: 'SUBMIT', attempt })
      onCreateFlowActiveChange?.(true)

      try {
        const imagesData = await encodeImages(images)
        const result = await createAgentClient.createAgent({
          config,
          labels: { ui: 'true' },
          initialPrompt: trimmedPrompt,
          clientMessageId: attempt.clientMessageId,
          ...(imagesData && imagesData.length > 0 ? { images: imagesData } : {}),
          git: gitOptions,
        })

        const agentId = (result as { id?: string })?.id
        if (agentId && selectedServerId) {
          updatePendingAgentId(agentId)
          router.replace(buildHostAgentDetailRoute(selectedServerId, agentId) as any)
          return
        }

        dispatch({
          type: 'CREATE_FAILED',
          message: 'Failed to create agent',
        })
        onCreateFlowActiveChange?.(false)
        markPendingCreateLifecycle('abandoned')
        clearPendingCreateAttempt()
        throw new Error('Failed to create agent')
      } catch (error) {
        const message = error instanceof Error ? error.message : 'Failed to create agent'
        dispatch({ type: 'CREATE_FAILED', message })
        onCreateFlowActiveChange?.(false)
        markPendingCreateLifecycle('abandoned')
        clearPendingCreateAttempt()
        throw error // Re-throw so AgentInputArea knows it failed
      }
    },
    [
      worktreeMode,
      baseBranch,
      worktreeSlug,
      selectedWorktreePath,
      gitBlockingError,
      baseBranchError,
      isDirectoryNotExists,
      isNonGitDirectory,
      modeOptions,
      providerDefinitions,
      persistFormPreferences,
      router,
      selectedMode,
      selectedModel,
      selectedThinkingOptionId,
      selectedProvider,
      selectedServerId,
      createAgentClient,
      setPendingCreateAttempt,
      updatePendingAgentId,
      markPendingCreateLifecycle,
      clearPendingCreateAttempt,
      workingDir,
      isAttachWorktree,
      isSubmitting,
      onCreateFlowActiveChange,
    ]
  )

  if (daemons.length === 0) {
    return (
      <WelcomeScreen
        onHostAdded={(profile) => {
          setSelectedServerIdFromUser(profile.serverId)
        }}
      />
    )
  }

  const explorerServerId = draftExplorerCheckout?.serverId ?? null
  const explorerIsGit = draftExplorerCheckout?.isGit ?? false
  const mainContent = (
    <View style={styles.container} {...tauriDragHandlers}>
      <View style={styles.outerContainer}>
        <View style={styles.agentPanel}>
          <View
            style={[
              styles.menuToggleContainer,
              isMobile ? { paddingTop: insets.top + theme.spacing[2] } : null,
            ]}
          >
            <View style={styles.menuToggleRow}>
              <SidebarMenuToggle />
              {!isMobile && canOpenExplorer ? (
                <HeaderToggleButton
                  onPress={handleToggleExplorer}
                  tooltipLabel="Toggle explorer"
                  tooltipKeys={['mod', 'E']}
                  tooltipSide="left"
                  style={styles.menuButton}
                  accessible
                  accessibilityRole="button"
                  accessibilityLabel={isExplorerOpen ? 'Close explorer' : 'Open explorer'}
                  accessibilityState={{ expanded: isExplorerOpen }}
                >
                  <PanelRight
                    size={theme.iconSize.md}
                    color={isExplorerOpen ? theme.colors.foreground : theme.colors.foregroundMuted}
                  />
                </HeaderToggleButton>
              ) : null}
            </View>
          </View>

          <Animated.View style={[styles.contentContainer, animatedKeyboardStyle]}>
            {machine.tag === 'creating' && draftAgent && selectedServerId ? (
              <View style={styles.streamContainer}>
                <AgentStreamView
                  agentId={DRAFT_AGENT_ID}
                  serverId={selectedServerId}
                  agent={draftAgent}
                  streamItems={optimisticStreamItems}
                  pendingPermissions={EMPTY_PENDING_PERMISSIONS}
                />
              </View>
            ) : (
              <ScrollView
                style={styles.scrollView}
                contentContainerStyle={styles.configScrollContent}
              >
                <View style={styles.configSection}>
                  <View style={isMobile ? styles.stackedSelectorGroup : styles.topSelectorRow}>
                    <FormSelectTrigger
                      controlRef={workingDirAnchorRef}
                      containerStyle={styles.fullSelector}
                      label="Working directory"
                      value={displayWorkingDir}
                      placeholder="Choose a working directory"
                      onPress={() => setIsWorkingDirOpen(true)}
                      icon={<Folder size={theme.iconSize.md} color={theme.colors.foregroundMuted} />}
                      showLabel={false}
                      valueEllipsizeMode="middle"
                      testID="working-directory-select"
                    />
                  </View>
                  {isDirectoryNotExists && (
                    <View style={styles.warningContainer}>
                      <Text style={styles.warningText}>
                        Directory does not exist on the selected host
                      </Text>
                    </View>
                  )}
                  {isMobile ? <View style={styles.formSeparator} /> : null}
                  <AgentConfigRow
                    providerDefinitions={providerDefinitions}
                    selectedProvider={selectedProvider}
                    onSelectProvider={setProviderFromUser}
                    modeOptions={modeOptions}
                    selectedMode={selectedMode}
                    onSelectMode={setModeFromUser}
                    models={availableModels}
                    selectedModel={selectedModel}
                    isModelLoading={isModelLoading}
                    onSelectModel={setModelFromUser}
                    thinkingOptions={availableThinkingOptions}
                    selectedThinkingOptionId={selectedThinkingOptionId}
                    onSelectThinkingOption={setThinkingOptionFromUser}
                  />
                  {isMobile && trimmedWorkingDir.length > 0 && !isNonGitDirectory ? (
                    <View style={styles.formSeparator} />
                  ) : null}
                  {trimmedWorkingDir.length > 0 && !isNonGitDirectory ? (
                    <View style={isMobile ? styles.stackedSelectorGroup : styles.topSelectorRow}>
                      <FormSelectTrigger
                        controlRef={worktreeAnchorRef}
                        containerStyle={
                          isMobile
                            ? styles.fullSelector
                            : worktreeMode === 'create'
                              ? styles.halfSelector
                              : styles.topSelectorPrimary
                        }
                        label="Worktree"
                        value={worktreeTriggerValue}
                        placeholder="Select worktree"
                        onPress={() => setIsWorktreePickerOpen(true)}
                        icon={<GitBranch size={theme.iconSize.md} color={theme.colors.foregroundMuted} />}
                        showLabel={false}
                        valueEllipsizeMode="middle"
                        testID="worktree-select-trigger"
                      />
                      {worktreeMode === 'create' ? (
                        <FormSelectTrigger
                          controlRef={branchAnchorRef}
                          containerStyle={isMobile ? styles.fullSelector : styles.halfSelector}
                          label="Base branch"
                          value={baseBranch}
                          placeholder="From branch"
                          onPress={() => setIsBranchOpen(true)}
                          disabled={repoInfoStatus === 'loading'}
                          icon={<GitBranch size={theme.iconSize.md} color={theme.colors.foregroundMuted} />}
                          showLabel={false}
                          testID="worktree-base-branch-trigger"
                        />
                      ) : null}
                    </View>
                  ) : null}
                  {baseBranchError ? (
                    <Text style={styles.errorInlineText}>{baseBranchError}</Text>
                  ) : null}
                  {repoInfoError ? (
                    <Text style={styles.errorInlineText}>{repoInfoError}</Text>
                  ) : null}
                  {gitBlockingError ? (
                    <Text style={styles.errorInlineText}>{gitBlockingError}</Text>
                  ) : null}
                  {attachWorktreeError ? (
                    <Text style={styles.errorInlineText}>{attachWorktreeError}</Text>
                  ) : null}
                  {worktreeOptionsError ? (
                    <Text style={styles.errorInlineText}>{worktreeOptionsError}</Text>
                  ) : null}
                </View>
                <Combobox
                  options={worktreeComboOptions}
                  value={
                    worktreeMode === 'create'
                      ? '__create_new__'
                      : worktreeMode === 'attach'
                        ? selectedWorktreePath
                        : '__none__'
                  }
                  onSelect={(id) => {
                    if (id === '__create_new__') {
                      setWorktreeMode('create')
                      if (!worktreeSlug) {
                        setWorktreeSlug(createNameId())
                      }
                      setSelectedWorktreePath('')
                      return
                    }
                    if (id === '__none__') {
                      setWorktreeMode('none')
                      setSelectedWorktreePath('')
                      return
                    }
                    handleSelectWorktreePath(id)
                    setWorktreeMode('attach')
                  }}
                  title="Select worktree"
                  searchPlaceholder="Search worktrees..."
                  open={isWorktreePickerOpen}
                  onOpenChange={setIsWorktreePickerOpen}
                  emptyText="No worktrees found"
                  anchorRef={worktreeAnchorRef}
                />

                <Combobox
                  options={workingDirComboOptions}
                  value={workingDir}
                  onSelect={setWorkingDirFromUser}
                  onSearchQueryChange={setWorkingDirSearchQuery}
                  searchPlaceholder="Search directories..."
                  emptyText={workingDirEmptyText}
                  allowCustomValue
                  customValuePrefix=""
                  customValueKind="directory"
                  optionsPosition="above-search"
                  title="Working directory"
                  open={isWorkingDirOpen}
                  onOpenChange={setIsWorkingDirOpen}
                  anchorRef={workingDirAnchorRef}
                />

                <Combobox
                  options={branchComboOptions}
                  value={baseBranch}
                  onSelect={handleBaseBranchChange}
                  onSearchQueryChange={setBranchSearchQuery}
                  searchPlaceholder="Choose a base branch..."
                  allowCustomValue
                  customValuePrefix="Use"
                  customValueDescription="Use this branch name"
                  title="Select base branch"
                  open={isBranchOpen}
                  onOpenChange={(nextOpen) => {
                    setIsBranchOpen(nextOpen)
                    if (!nextOpen) {
                      setBranchSearchQuery('')
                    }
                  }}
                  anchorRef={branchAnchorRef}
                />

                {formErrorMessage ? (
                  <View style={styles.errorContainer}>
                    <Text style={styles.errorText}>{formErrorMessage}</Text>
                  </View>
                ) : null}
              </ScrollView>
            )}
          </Animated.View>
          <View style={styles.inputAreaWrapper}>
            <AgentInputArea
              agentId={DRAFT_AGENT_ID}
              serverId={selectedServerId ?? ''}
              onSubmitMessage={handleCreateFromInput}
              isSubmitLoading={isSubmitting}
              blurOnSubmit={true}
              value={promptValue}
              onChangeText={(next) => dispatch({ type: 'DRAFT_SET_PROMPT', text: next })}
              autoFocus={machine.tag === 'draft'}
              onAddImages={handleAddImagesCallback}
              commandDraftConfig={draftCommandConfig}
              draftId={draftIdRef.current}
            />
          </View>
        </View>

        {!isMobile && isExplorerOpen && explorerServerId && draftExplorerCheckout ? (
          <ExplorerSidebar
            serverId={explorerServerId}
            agentId={DRAFT_AGENT_ID}
            cwd={draftExplorerCheckout.cwd}
            isGit={explorerIsGit}
          />
        ) : null}
      </View>
    </View>
  )

  return (
    <FileDropZone onFilesDropped={handleFilesDropped}>
      <>
        {isMobile ? (
          <GestureDetector gesture={explorerOpenGesture} touchAction="pan-y">
            {mainContent}
          </GestureDetector>
        ) : (
          mainContent
        )}

        {isMobile && explorerServerId && draftExplorerCheckout ? (
          <ExplorerSidebar
            serverId={explorerServerId}
            agentId={DRAFT_AGENT_ID}
            cwd={draftExplorerCheckout.cwd}
            isGit={explorerIsGit}
          />
        ) : null}
      </>
    </FileDropZone>
  )
}

const styles = StyleSheet.create((theme) => ({
  container: {
    flex: 1,
    backgroundColor: theme.colors.surface0,
  },
  outerContainer: {
    flex: 1,
    flexDirection: 'row',
  },
  agentPanel: {
    flex: 1,
  },
  menuToggleContainer: {
    paddingHorizontal: theme.spacing[2],
    paddingTop: theme.spacing[2],
  },
  menuToggleRow: {
    width: '100%',
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
  },
  menuButton: {
    marginLeft: theme.spacing[2],
  },
  contentContainer: {
    flex: 1,
    overflow: 'hidden',
  },
  scrollView: {
    flex: 1,
  },
  inputAreaWrapper: {
    backgroundColor: theme.colors.surface0,
  },
  streamContainer: {
    flex: 1,
  },
  configScrollContent: {
    flexGrow: 1,
    justifyContent: 'flex-end',
  },
  configSection: {
    paddingHorizontal: {
      xs: theme.spacing[4],
      md: theme.spacing[0],
    },
    paddingTop: theme.spacing[3],
    paddingBottom: theme.spacing[4],
    gap: theme.spacing[2],
    maxWidth: MAX_CONTENT_WIDTH,
    alignSelf: 'center',
    width: '100%',
  },
  topSelectorRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: theme.spacing[2],
  },
  stackedSelectorGroup: {
    gap: theme.spacing[2],
  },
  fullSelector: {
    width: '100%',
  },
  formSeparator: {
    height: theme.borderWidth[1],
    backgroundColor: {
      xs: theme.colors.surface1,
      sm: theme.colors.surface1,
      md: theme.colors.border,
    },
    marginHorizontal: theme.spacing[1],
    marginVertical: theme.spacing[2],
  },
  topSelectorPrimary: {
    flex: 7,
  },
  topSelectorSecondary: {
    flex: 3,
  },
  halfSelector: {
    flex: 1,
  },
  errorContainer: {
    paddingHorizontal: theme.spacing[4],
    paddingVertical: theme.spacing[3],
    marginHorizontal: theme.spacing[0],
    marginBottom: theme.spacing[2],
    borderRadius: theme.borderRadius.lg,
    backgroundColor: theme.colors.destructive,
  },
  errorText: {
    color: theme.colors.destructiveForeground,
    fontSize: theme.fontSize.base,
  },
  warningContainer: {
    paddingHorizontal: theme.spacing[3],
    paddingVertical: theme.spacing[2],
    borderRadius: theme.borderRadius.md,
    backgroundColor: theme.colors.palette.yellow[400],
  },
  warningText: {
    color: '#000000',
    fontSize: theme.fontSize.base,
    fontWeight: theme.fontWeight.semibold,
  },
  errorInlineText: {
    color: theme.colors.palette.red[500],
    fontSize: theme.fontSize.base,
  },
}))
