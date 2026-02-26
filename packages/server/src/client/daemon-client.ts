import type { z } from 'zod'
import {
  AgentCreateFailedStatusPayloadSchema,
  AgentCreatedStatusPayloadSchema,
  AgentRefreshedStatusPayloadSchema,
  AgentResumedStatusPayloadSchema,
  RestartRequestedStatusPayloadSchema,
  ShutdownRequestedStatusPayloadSchema,
  SessionInboundMessageSchema,
  type WSWelcomeMessage,
  WSOutboundMessageSchema,
} from '../shared/messages.js'
import type {
  AgentStreamEventPayload,
  AgentSnapshotPayload,
  ProjectPlacementPayload,
  AgentPermissionResolvedMessage,
  CreateAgentRequestMessage,
  FileDownloadTokenResponse,
  FileExplorerResponse,
  FetchAgentTimelineResponseMessage,
  GitSetupOptions,
  CheckoutStatusResponse,
  CheckoutCommitResponse,
  CheckoutMergeResponse,
  CheckoutMergeFromBaseResponse,
  CheckoutPushResponse,
  CheckoutPrCreateResponse,
  CheckoutPrStatusResponse,
  ValidateBranchResponse,
  BranchSuggestionsResponse,
  DirectorySuggestionsResponse,
  JunctionWorktreeListResponse,
  JunctionWorktreeArchiveResponse,
  ProjectIconResponse,
  ListCommandsResponse,
  ListProviderModelsResponseMessage,
  ListAvailableProvidersResponse,
  ListTerminalsResponse,
  CreateTerminalResponse,
  SubscribeTerminalResponse,
  TerminalOutput,
  KillTerminalResponse,
  AttachTerminalStreamResponse,
  DetachTerminalStreamResponse,
  TerminalInput,
  SessionInboundMessage,
  SessionOutboundMessage,
} from '../shared/messages.js'
import type {
  AgentPermissionRequest,
  AgentPermissionResponse,
  AgentPersistenceHandle,
  AgentProvider,
  AgentSessionConfig,
} from '../server/agent/agent-sdk-types.js'
import { getAgentProviderDefinition } from '../server/agent/provider-manifest.js'
import { isRelayClientWebSocketUrl } from '../shared/daemon-endpoints.js'
import {
  asUint8Array,
  decodeBinaryMuxFrame,
  encodeBinaryMuxFrame,
  BinaryMuxChannel,
  TerminalBinaryFlags,
  TerminalBinaryMessageType,
  type BinaryMuxFrame,
} from '../shared/binary-mux.js'
import { encodeTerminalKeyInput, type TerminalKeyInput } from '../shared/terminal-key-input.js'
import {
  TerminalStreamManager,
  type TerminalStreamChunk,
} from './daemon-client-terminal-stream-manager.js'
import {
  createRelayE2eeTransportFactory,
  createWebSocketTransportFactory,
  decodeMessageData,
  defaultWebSocketFactory,
  describeTransportClose,
  describeTransportError,
  encodeUtf8String,
  type DaemonTransport,
  type DaemonTransportFactory,
  type WebSocketFactory,
} from './daemon-client-transport.js'

export interface Logger {
  debug(obj: object, msg?: string): void
  info(obj: object, msg?: string): void
  warn(obj: object, msg?: string): void
  error(obj: object, msg?: string): void
}

const consoleLogger: Logger = {
  debug: () => {},
  info: (obj, msg) => console.info(msg, obj),
  warn: (obj, msg) => console.warn(msg, obj),
  error: (obj, msg) => console.error(msg, obj),
}

function getNowMs(): number {
  if (typeof performance !== 'undefined' && typeof performance.now === 'function') {
    return performance.now()
  }
  return Date.now()
}

export type {
  DaemonTransport,
  DaemonTransportFactory,
  WebSocketFactory,
  WebSocketLike,
} from './daemon-client-transport.js'
export type { TerminalStreamChunk } from './daemon-client-terminal-stream-manager.js'

export type ConnectionState =
  | { status: 'idle' }
  | { status: 'connecting'; attempt: number }
  | { status: 'connected' }
  | { status: 'disconnected'; reason?: string }
  | { status: 'disposed' }

export type DaemonEvent =
  | {
      type: 'agent_update'
      agentId: string
      payload: Extract<SessionOutboundMessage, { type: 'agent_update' }>['payload']
    }
  | {
      type: 'agent_stream'
      agentId: string
      event: AgentStreamEventPayload
      timestamp: string
      seq?: number
      epoch?: string
    }
  | { type: 'status'; payload: { status: string } & Record<string, unknown> }
  | { type: 'agent_deleted'; agentId: string }
  | {
      type: 'agent_permission_request'
      agentId: string
      request: AgentPermissionRequest
    }
  | {
      type: 'agent_permission_resolved'
      agentId: string
      requestId: string
      resolution: AgentPermissionResponse
    }
  | { type: 'error'; message: string }

export type DaemonEventHandler = (event: DaemonEvent) => void

export type DaemonClientConfig = {
  url: string
  clientId: string
  clientType?: 'mobile' | 'browser' | 'cli' | 'mcp'
  runtimeGeneration?: number | null
  authHeader?: string
  token?: string
  suppressSendErrors?: boolean
  transportFactory?: DaemonTransportFactory
  webSocketFactory?: WebSocketFactory
  logger?: Logger
  connectTimeoutMs?: number
  e2ee?: {
    enabled?: boolean
    daemonPublicKeyB64?: string
  }
  reconnect?: {
    enabled?: boolean
    baseDelayMs?: number
    maxDelayMs?: number
  }
  onDiagnosticsEvent?: (event: DaemonClientDiagnosticsEvent) => void
}

export type DaemonClientDiagnosticsEvent =
  | {
      type: 'transport_message_timing'
      messageType: string
      payloadBytes: number
      parseMs: number
      validateMs: number
      totalMs: number
      outcome: 'ok' | 'parse_error' | 'validation_error'
    }
  | {
      type: 'transport_binary_frame'
      channel: BinaryMuxChannel
      messageType: number
      payloadBytes: number
    }

export type SendMessageOptions = {
  messageId?: string
  images?: Array<{ data: string; mimeType: string }>
}

type AgentConfigOverrides = Partial<Omit<AgentSessionConfig, 'provider' | 'cwd'>>

export type CreateAgentRequestOptions = {
  config?: AgentSessionConfig
  provider?: AgentProvider
  cwd?: string
  initialPrompt?: string
  clientMessageId?: string
  outputSchema?: Record<string, unknown>
  images?: CreateAgentRequestMessage['images']
  git?: GitSetupOptions
  worktreeName?: string
  requestId?: string
  labels?: Record<string, string>
} & AgentConfigOverrides

type CheckoutStatusPayload = CheckoutStatusResponse['payload']
type SubscribeCheckoutDiffPayload = Extract<
  SessionOutboundMessage,
  { type: 'subscribe_checkout_diff_response' }
>['payload']
type CheckoutDiffPayload = Omit<SubscribeCheckoutDiffPayload, 'subscriptionId'>
type CheckoutCommitPayload = CheckoutCommitResponse['payload']
type CheckoutMergePayload = CheckoutMergeResponse['payload']
type CheckoutMergeFromBasePayload = CheckoutMergeFromBaseResponse['payload']
type CheckoutPushPayload = CheckoutPushResponse['payload']
type CheckoutPrCreatePayload = CheckoutPrCreateResponse['payload']
type CheckoutPrStatusPayload = CheckoutPrStatusResponse['payload']
type ValidateBranchPayload = ValidateBranchResponse['payload']
type BranchSuggestionsPayload = BranchSuggestionsResponse['payload']
type DirectorySuggestionsPayload = DirectorySuggestionsResponse['payload']
type JunctionWorktreeListPayload = JunctionWorktreeListResponse['payload']
type JunctionWorktreeArchivePayload = JunctionWorktreeArchiveResponse['payload']
type FileExplorerPayload = FileExplorerResponse['payload']
type FileDownloadTokenPayload = FileDownloadTokenResponse['payload']
type ListProviderModelsPayload = ListProviderModelsResponseMessage['payload']
type ListAvailableProvidersPayload = ListAvailableProvidersResponse['payload']
type ListCommandsPayload = ListCommandsResponse['payload']
type ListCommandsDraftConfig = Pick<
  AgentSessionConfig,
  'provider' | 'cwd' | 'modeId' | 'model' | 'thinkingOptionId'
>
type ListCommandsOptions = {
  requestId?: string
  draftConfig?: ListCommandsDraftConfig
}
type AgentPermissionResolvedPayload = AgentPermissionResolvedMessage['payload']
type ListTerminalsPayload = ListTerminalsResponse['payload']
type CreateTerminalPayload = CreateTerminalResponse['payload']
type SubscribeTerminalPayload = SubscribeTerminalResponse['payload']
type TerminalOutputPayload = TerminalOutput['payload']
type KillTerminalPayload = KillTerminalResponse['payload']
type AttachTerminalStreamPayload = AttachTerminalStreamResponse['payload']
type DetachTerminalStreamPayload = DetachTerminalStreamResponse['payload']
export type FetchAgentTimelinePayload = FetchAgentTimelineResponseMessage['payload']

export type FetchAgentTimelineDirection = FetchAgentTimelinePayload['direction']
export type FetchAgentTimelineProjection = FetchAgentTimelinePayload['projection']
export type FetchAgentTimelineCursor = NonNullable<FetchAgentTimelinePayload['startCursor']>
export type FetchAgentTimelineOptions = {
  direction?: FetchAgentTimelineDirection
  cursor?: FetchAgentTimelineCursor
  limit?: number
  projection?: FetchAgentTimelineProjection
  requestId?: string
}

type AgentRefreshedStatusPayload = z.infer<typeof AgentRefreshedStatusPayloadSchema>
type RestartRequestedStatusPayload = z.infer<typeof RestartRequestedStatusPayloadSchema>
type ShutdownRequestedStatusPayload = z.infer<typeof ShutdownRequestedStatusPayloadSchema>
type FetchAgentsPayload = Extract<
  SessionOutboundMessage,
  { type: 'fetch_agents_response' }
>['payload']
type FetchAgentsRequest = Extract<SessionInboundMessage, { type: 'fetch_agents_request' }>
export type FetchAgentsOptions = Omit<FetchAgentsRequest, 'type' | 'requestId'> & {
  requestId?: string
}
export type FetchAgentsEntry = FetchAgentsPayload['entries'][number]
export type FetchAgentsPageInfo = FetchAgentsPayload['pageInfo']

export type FetchAgentResult = {
  agent: AgentSnapshotPayload
  project: ProjectPlacementPayload | null
}

export type WaitForFinishResult = {
  status: 'idle' | 'error' | 'permission' | 'timeout'
  final: AgentSnapshotPayload | null
  error: string | null
  lastMessage: string | null
}

type Waiter<T> = {
  predicate: (msg: SessionOutboundMessage) => T | null
  resolve: (value: T) => void
  reject: (error: Error) => void
  timeoutHandle: ReturnType<typeof setTimeout> | null
}

type WaitHandle<T> = {
  promise: Promise<T>
  cancel: (error: Error) => void
}

type RpcWaitResult<T> = { kind: 'ok'; value: T } | { kind: 'error'; error: DaemonRpcError }
type CorrelatedResponseMessage = Extract<SessionOutboundMessage, { payload: { requestId: string } }>
type CorrelatedResponseType = CorrelatedResponseMessage['type']
type CorrelatedResponsePayload<TType extends CorrelatedResponseType> = Extract<
  CorrelatedResponseMessage,
  { type: TType }
>['payload']

class DaemonRpcError extends Error {
  readonly requestId: string
  readonly requestType?: string
  readonly code?: string

  constructor(params: { requestId: string; error: string; requestType?: string; code?: string }) {
    super(params.error)
    this.name = 'DaemonRpcError'
    this.requestId = params.requestId
    this.requestType = params.requestType
    this.code = params.code
  }
}

const DEFAULT_RECONNECT_BASE_DELAY_MS = 1500
const DEFAULT_RECONNECT_MAX_DELAY_MS = 30000
const DEFAULT_CONNECT_TIMEOUT_MS = 15000

/** Default timeout for waiting for connection before sending queued messages */
const DEFAULT_SEND_QUEUE_TIMEOUT_MS = 10000

function normalizeClientId(value: unknown): string | null {
  if (typeof value !== 'string') {
    return null
  }
  const trimmed = value.trim()
  return trimmed.length > 0 ? trimmed : null
}

function hashForLog(value: string): string {
  let hash = 0
  for (let index = 0; index < value.length; index += 1) {
    hash = (hash * 31 + value.charCodeAt(index)) | 0
  }
  return `h_${Math.abs(hash).toString(16)}`
}

function toReasonCode(reason: string | null | undefined): string | null {
  if (!reason) {
    return null
  }
  const normalized = reason.toLowerCase()
  if (normalized.includes('timed out')) {
    return 'connect_timeout'
  }
  if (normalized.includes('disposed')) {
    return 'disposed'
  }
  if (normalized.includes('client closed')) {
    return 'client_closed'
  }
  if (normalized.includes('transport')) {
    return 'transport_error'
  }
  if (normalized.includes('failed to connect')) {
    return 'connect_failed'
  }
  return 'unknown'
}

interface PendingSend {
  message: SessionInboundMessage
  resolve: () => void
  reject: (error: Error) => void
  timeoutHandle: ReturnType<typeof setTimeout>
}

export class DaemonClient {
  private transport: DaemonTransport | null = null
  private transportCleanup: Array<() => void> = []
  private rawMessageListeners: Set<(message: SessionOutboundMessage) => void> = new Set()
  private messageHandlers: Map<
    SessionOutboundMessage['type'],
    Set<(message: SessionOutboundMessage) => void>
  > = new Map()
  private eventListeners: Set<DaemonEventHandler> = new Set()
  private waiters: Set<Waiter<any>> = new Set()
  private checkoutStatusInFlight: Map<string, Promise<CheckoutStatusPayload>> = new Map()
  private connectionListeners: Set<(status: ConnectionState) => void> = new Set()
  private reconnectTimeout: ReturnType<typeof setTimeout> | null = null
  private connectTimeout: ReturnType<typeof setTimeout> | null = null
  private pendingGenericTransportErrorTimeout: ReturnType<typeof setTimeout> | null = null
  private reconnectAttempt = 0
  private shouldReconnect = true
  private connectPromise: Promise<void> | null = null
  private connectResolve: (() => void) | null = null
  private connectReject: ((error: Error) => void) | null = null
  private lastErrorValue: string | null = null
  private connectionState: ConnectionState = { status: 'idle' }
  private checkoutDiffSubscriptions = new Map<
    string,
    { cwd: string; compare: { mode: 'uncommitted' | 'base'; baseRef?: string } }
  >()
  private terminalDirectorySubscriptions = new Set<string>()
  private logger: Logger
  private pendingSendQueue: PendingSend[] = []
  private terminalStreams: TerminalStreamManager
  private readonly logConnectionPath: 'direct' | 'relay'
  private readonly logServerId: string | null
  private readonly logClientIdHash: string
  private readonly logGeneration: number | null
  private lastWelcomeMessage: WSWelcomeMessage | null = null

  constructor(private config: DaemonClientConfig) {
    this.logger = config.logger ?? consoleLogger
    this.logConnectionPath = isRelayClientWebSocketUrl(this.config.url) ? 'relay' : 'direct'
    let parsedUrlForLog: URL | null = null
    try {
      parsedUrlForLog = new URL(this.config.url)
    } catch {
      parsedUrlForLog = null
    }
    const parsedServerIdForLog = normalizeClientId(
      parsedUrlForLog?.searchParams.get('serverId')
    )
    this.logServerId = parsedServerIdForLog ?? parsedUrlForLog?.host ?? null
    const resolvedClientId = normalizeClientId(this.config.clientId)
    if (!resolvedClientId) {
      throw new Error('Daemon client requires a non-empty clientId')
    }
    this.config.clientId = resolvedClientId
    this.logClientIdHash = hashForLog(resolvedClientId)
    this.logGeneration =
      typeof this.config.runtimeGeneration === 'number' && Number.isFinite(this.config.runtimeGeneration)
        ? this.config.runtimeGeneration
        : null
    this.terminalStreams = new TerminalStreamManager({
      sendAck: (ack) => {
        this.sendBinaryFrame({
          channel: BinaryMuxChannel.Terminal,
          messageType: TerminalBinaryMessageType.Ack,
          streamId: ack.streamId,
          offset: ack.offset,
          payload: new Uint8Array(0),
        })
      },
    })
  }

  private emitDiagnosticsEvent(event: DaemonClientDiagnosticsEvent): void {
    try {
      this.config.onDiagnosticsEvent?.(event)
    } catch {
      // Diagnostics hooks must never break daemon message handling.
    }
  }

  // ============================================================================
  // Connection
  // ============================================================================

  async connect(): Promise<void> {
    if (this.connectionState.status === 'disposed') {
      throw new Error('Daemon client is disposed')
    }
    if (this.connectionState.status === 'connected') {
      return
    }
    if (this.connectPromise) {
      return this.connectPromise
    }

    this.shouldReconnect = true
    this.connectPromise = new Promise((resolve, reject) => {
      this.connectResolve = resolve
      this.connectReject = reject
      this.attemptConnect()
    })

    return this.connectPromise
  }

  private attemptConnect(): void {
    if (this.connectionState.status === 'disposed') {
      this.rejectConnect(new Error('Daemon client is disposed'))
      return
    }
    if (!this.shouldReconnect) {
      this.rejectConnect(new Error('Daemon client is closed'))
      return
    }

    if (this.connectionState.status === 'connecting') {
      return
    }

    const headers: Record<string, string> = {}
    if (this.config.authHeader) {
      headers['Authorization'] = this.config.authHeader
    }

    try {
      // Reconnect can overlap with browser close/error delivery ordering.
      // Always dispose previous transport before constructing the next one.
      this.disposeTransport()
      const baseTransportFactory =
        this.config.transportFactory ??
        createWebSocketTransportFactory(this.config.webSocketFactory ?? defaultWebSocketFactory)
      const shouldUseRelayE2ee =
        this.config.e2ee?.enabled === true && isRelayClientWebSocketUrl(this.config.url)

      let transportFactory = baseTransportFactory
      if (shouldUseRelayE2ee) {
        const daemonPublicKeyB64 = this.config.e2ee?.daemonPublicKeyB64
        if (!daemonPublicKeyB64) {
          throw new Error('daemonPublicKeyB64 is required for relay E2EE')
        }
        transportFactory = createRelayE2eeTransportFactory({
          baseFactory: baseTransportFactory,
          daemonPublicKeyB64,
          logger: this.logger,
        })
      }
      const transportUrl = this.resolveTransportUrlForAttempt()
      const transport = transportFactory({ url: transportUrl, headers })
      this.transport = transport
      this.lastWelcomeMessage = null

      this.updateConnectionState({
        status: 'connecting',
        attempt: this.reconnectAttempt,
      }, { event: 'CONNECT_REQUEST' })
      this.resetConnectTimeout()
      const timeoutMs = Math.max(1, this.config.connectTimeoutMs ?? DEFAULT_CONNECT_TIMEOUT_MS)
      this.connectTimeout = setTimeout(() => {
        if (this.connectionState.status !== 'connecting') {
          return
        }
        this.lastErrorValue = 'Connection timed out'
        this.disposeTransport(1001, 'Connection timed out')
        this.scheduleReconnect({
          reason: 'Connection timed out',
          event: 'CONNECT_TIMEOUT',
          reasonCode: 'connect_timeout',
        })
      }, timeoutMs)

      this.transportCleanup = [
        transport.onOpen(() => {
          if (this.pendingGenericTransportErrorTimeout) {
            clearTimeout(this.pendingGenericTransportErrorTimeout)
            this.pendingGenericTransportErrorTimeout = null
          }
          this.lastErrorValue = null
          this.sendHelloMessage()
        }),
        transport.onClose((event) => {
          this.resetConnectTimeout()
          if (this.pendingGenericTransportErrorTimeout) {
            clearTimeout(this.pendingGenericTransportErrorTimeout)
            this.pendingGenericTransportErrorTimeout = null
          }
          const reason = describeTransportClose(event)
          if (reason) {
            this.lastErrorValue = reason
          }
          this.scheduleReconnect({
            reason,
            event: 'TRANSPORT_CLOSE',
            reasonCode: 'transport_closed',
          })
        }),
        transport.onError((event) => {
          this.resetConnectTimeout()
          const reason = describeTransportError(event)
          const isGeneric = reason === 'Transport error'
          // Browser WebSocket.onerror often provides no useful details and is followed
          // by a close event (often with code 1006). Prefer surfacing the close details
          // instead of immediately disconnecting with a generic "Transport error".
          if (isGeneric) {
            this.lastErrorValue ??= reason
            if (!this.pendingGenericTransportErrorTimeout) {
              this.pendingGenericTransportErrorTimeout = setTimeout(() => {
                this.pendingGenericTransportErrorTimeout = null
                if (
                  this.connectionState.status === 'connected' ||
                  this.connectionState.status === 'connecting'
                ) {
                  this.lastErrorValue = reason
                  this.scheduleReconnect({
                    reason,
                    event: 'TRANSPORT_ERROR',
                    reasonCode: 'transport_error',
                  })
                }
              }, 250)
            }
            return
          }

          if (this.pendingGenericTransportErrorTimeout) {
            clearTimeout(this.pendingGenericTransportErrorTimeout)
            this.pendingGenericTransportErrorTimeout = null
          }
          this.lastErrorValue = reason
          this.scheduleReconnect({
            reason,
            event: 'TRANSPORT_ERROR',
            reasonCode: 'transport_error',
          })
        }),
        transport.onMessage((data) => this.handleTransportMessage(data)),
      ]
    } catch (error) {
      this.resetConnectTimeout()
      const message = error instanceof Error ? error.message : 'Failed to connect'
      this.lastErrorValue = message
      this.scheduleReconnect({
        reason: message,
        event: 'CONNECT_FAILED',
        reasonCode: 'connect_failed',
      })
      this.rejectConnect(error instanceof Error ? error : new Error(message))
    }
  }

  private resolveConnect(): void {
    if (this.connectResolve) {
      this.connectResolve()
    }
    this.connectPromise = null
    this.connectResolve = null
    this.connectReject = null
  }

  private rejectConnect(error: Error): void {
    if (this.connectReject) {
      this.connectReject(error)
    }
    this.connectPromise = null
    this.connectResolve = null
    this.connectReject = null
  }

  async close(): Promise<void> {
    if (this.connectionState.status === 'disposed') {
      return
    }
    this.shouldReconnect = false
    this.connectPromise = null
    this.connectResolve = null
    this.connectReject = null
    if (this.reconnectTimeout) {
      clearTimeout(this.reconnectTimeout)
      this.reconnectTimeout = null
    }
    this.resetConnectTimeout()
    this.disposeTransport(1000, 'Client closed')
    this.clearWaiters(new Error('Daemon client closed'))
    this.rejectPendingSendQueue(new Error('Daemon client closed'))
    this.terminalStreams.clearAll()
    this.lastWelcomeMessage = null
    this.updateConnectionState(
      { status: 'disposed' },
      { event: 'DISPOSE', reason: 'Client closed', reasonCode: 'disposed' }
    )
  }

  ensureConnected(): void {
    if (this.connectionState.status === 'disposed') {
      return
    }
    if (!this.shouldReconnect) {
      this.shouldReconnect = true
    }
    if (
      this.connectionState.status === 'connected' ||
      this.connectionState.status === 'connecting'
    ) {
      return
    }
    void this.connect()
  }

  getConnectionState(): ConnectionState {
    return this.connectionState
  }

  subscribeConnectionStatus(listener: (status: ConnectionState) => void): () => void {
    this.connectionListeners.add(listener)
    listener(this.connectionState)
    return () => {
      this.connectionListeners.delete(listener)
    }
  }

  get isConnected(): boolean {
    return this.connectionState.status === 'connected'
  }

  get isConnecting(): boolean {
    return this.connectionState.status === 'connecting'
  }

  get lastError(): string | null {
    return this.lastErrorValue
  }

  // ============================================================================
  // Message Subscription
  // ============================================================================

  subscribe(handler: DaemonEventHandler): () => void {
    this.eventListeners.add(handler)
    return () => this.eventListeners.delete(handler)
  }

  subscribeRawMessages(handler: (message: SessionOutboundMessage) => void): () => void {
    this.rawMessageListeners.add(handler)
    return () => {
      this.rawMessageListeners.delete(handler)
    }
  }

  on(
    type: SessionOutboundMessage['type'],
    handler: (message: SessionOutboundMessage) => void
  ): () => void
  on(handler: DaemonEventHandler): () => void
  on(
    arg1: SessionOutboundMessage['type'] | DaemonEventHandler,
    arg2?: (message: SessionOutboundMessage) => void
  ): () => void {
    if (typeof arg1 === 'function') {
      return this.subscribe(arg1)
    }

    const type = arg1 as SessionOutboundMessage['type']
    const handler = arg2 as (message: SessionOutboundMessage) => void

    if (!this.messageHandlers.has(type)) {
      this.messageHandlers.set(type, new Set())
    }
    this.messageHandlers.get(type)!.add(handler)

    return () => {
      const handlers = this.messageHandlers.get(type)
      if (!handlers) {
        return
      }
      handlers.delete(handler)
      if (handlers.size === 0) {
        this.messageHandlers.delete(type)
      }
    }
  }

  // ============================================================================
  // Core Send Helpers
  // ============================================================================

  /**
   * Send a session message. For fire-and-forget messages (heartbeats, etc.),
   * failures are suppressed if `suppressSendErrors` is configured.
   * For RPC methods that wait for responses, use `sendSessionMessageOrThrow` instead.
   */
  private sendSessionMessage(message: SessionInboundMessage): void {
    if (!this.transport || this.connectionState.status !== 'connected') {
      if (this.config.suppressSendErrors) {
        return
      }
      throw new Error(`Transport not connected (status: ${this.connectionState.status})`)
    }
    const payload = SessionInboundMessageSchema.parse(message)
    try {
      this.transport.send(JSON.stringify({ type: 'session', message: payload }))
    } catch (error) {
      if (this.config.suppressSendErrors) {
        return
      }
      throw error instanceof Error ? error : new Error(String(error))
    }
  }

  private sendBinaryFrame(frame: BinaryMuxFrame): void {
    if (!this.transport || this.connectionState.status !== 'connected') {
      if (this.config.suppressSendErrors) {
        return
      }
      throw new Error(`Transport not connected (status: ${this.connectionState.status})`)
    }
    try {
      this.transport.send(encodeBinaryMuxFrame(frame))
    } catch (error) {
      if (this.config.suppressSendErrors) {
        return
      }
      throw error instanceof Error ? error : new Error(String(error))
    }
  }

  /**
   * Send a session message for RPC methods that create waiters.
   * If the connection is still being established ("connecting"), the message
   * is queued and will be sent once connected (or rejected after timeout).
   * This prevents waiters from hanging forever when called during connection.
   */
  private sendSessionMessageOrThrow(message: SessionInboundMessage): Promise<void> {
    const status = this.connectionState.status

    // If connected, send immediately
    if (this.transport && status === 'connected') {
      const payload = SessionInboundMessageSchema.parse(message)
      this.transport.send(JSON.stringify({ type: 'session', message: payload }))
      return Promise.resolve()
    }

    // If connecting, queue the message to be sent once connected
    if (status === 'connecting') {
      return new Promise((resolve, reject) => {
        const timeoutHandle = setTimeout(() => {
          // Remove from queue
          const idx = this.pendingSendQueue.findIndex((p) => p.resolve === resolve)
          if (idx !== -1) {
            this.pendingSendQueue.splice(idx, 1)
          }
          reject(new Error(`Timed out waiting for connection to send message`))
        }, DEFAULT_SEND_QUEUE_TIMEOUT_MS)

        this.pendingSendQueue.push({ message, resolve, reject, timeoutHandle })
      })
    }

    // Not connected and not connecting - fail immediately
    return Promise.reject(new Error(`Transport not connected (status: ${status})`))
  }

  /**
   * Flush pending send queue - called when connection is established.
   */
  private flushPendingSendQueue(): void {
    const queue = this.pendingSendQueue
    this.pendingSendQueue = []

    for (const pending of queue) {
      clearTimeout(pending.timeoutHandle)
      try {
        if (this.transport && this.connectionState.status === 'connected') {
          const payload = SessionInboundMessageSchema.parse(pending.message)
          this.transport.send(JSON.stringify({ type: 'session', message: payload }))
          pending.resolve()
        } else {
          pending.reject(new Error('Connection lost before message could be sent'))
        }
      } catch (error) {
        pending.reject(error instanceof Error ? error : new Error(String(error)))
      }
    }
  }

  /**
   * Reject all pending sends - called when connection fails or is closed.
   */
  private rejectPendingSendQueue(error: Error): void {
    const queue = this.pendingSendQueue
    this.pendingSendQueue = []

    for (const pending of queue) {
      clearTimeout(pending.timeoutHandle)
      pending.reject(error)
    }
  }

  private async sendRequest<T>(params: {
    requestId: string
    message: SessionInboundMessage
    timeout: number
    select: (msg: SessionOutboundMessage) => T | null
    options?: { skipQueue?: boolean }
  }): Promise<T> {
    const { promise, cancel } = this.waitForWithCancel<RpcWaitResult<T>>(
      (msg) => {
        if (msg.type === 'rpc_error' && msg.payload.requestId === params.requestId) {
          return {
            kind: 'error',
            error: new DaemonRpcError({
              requestId: msg.payload.requestId,
              error: msg.payload.error,
              requestType: msg.payload.requestType,
              code: msg.payload.code,
            }),
          }
        }
        const value = params.select(msg)
        if (value === null) {
          return null
        }
        return { kind: 'ok', value }
      },
      params.timeout,
      params.options
    )

    try {
      await this.sendSessionMessageOrThrow(params.message)
    } catch (error) {
      const err = error instanceof Error ? error : new Error(String(error))
      cancel(err)
      void promise.catch(() => undefined)
      throw err
    }

    const result = await promise
    if (result.kind === 'error') {
      throw result.error
    }
    return result.value
  }

  private async sendCorrelatedRequest<
    TResponseType extends CorrelatedResponseType,
    TResult = CorrelatedResponsePayload<TResponseType>,
  >(params: {
    requestId: string
    message: SessionInboundMessage
    timeout: number
    responseType: TResponseType
    options?: { skipQueue?: boolean }
    selectPayload?: (payload: CorrelatedResponsePayload<TResponseType>) => TResult | null
  }): Promise<TResult> {
    return this.sendRequest({
      requestId: params.requestId,
      message: params.message,
      timeout: params.timeout,
      options: params.options,
      select: (msg) => {
        const correlated = msg as CorrelatedResponseMessage
        if (correlated.type !== params.responseType) {
          return null
        }
        const payload = correlated.payload as unknown as CorrelatedResponsePayload<TResponseType>
        if (payload.requestId !== params.requestId) {
          return null
        }
        if (!params.selectPayload) {
          return payload as TResult
        }
        return params.selectPayload(payload)
      },
    })
  }

  private sendCorrelatedSessionRequest<
    TResponseType extends CorrelatedResponseType,
    TResult = CorrelatedResponsePayload<TResponseType>,
  >(params: {
    requestId?: string
    message: { type: SessionInboundMessage['type'] } & Record<string, unknown>
    responseType: TResponseType
    timeout: number
    selectPayload?: (payload: CorrelatedResponsePayload<TResponseType>) => TResult | null
  }): Promise<TResult> {
    const resolvedRequestId = this.createRequestId(params.requestId)
    const message = SessionInboundMessageSchema.parse({
      ...params.message,
      requestId: resolvedRequestId,
    })
    return this.sendCorrelatedRequest({
      requestId: resolvedRequestId,
      message,
      responseType: params.responseType,
      timeout: params.timeout,
      options: { skipQueue: true },
      ...(params.selectPayload ? { selectPayload: params.selectPayload } : {}),
    })
  }


  clearAgentAttention(agentId: string | string[]): void {
    this.sendSessionMessage({ type: 'clear_agent_attention', agentId })
  }

  sendHeartbeat(params: {
    deviceType: 'web' | 'mobile'
    focusedAgentId: string | null
    lastActivityAt: string
    appVisible: boolean
    appVisibilityChangedAt?: string
  }): void {
    this.sendSessionMessage({
      type: 'client_heartbeat',
      deviceType: params.deviceType,
      focusedAgentId: params.focusedAgentId,
      lastActivityAt: params.lastActivityAt,
      appVisible: params.appVisible,
      appVisibilityChangedAt: params.appVisibilityChangedAt,
    })
  }

  async ping(params?: { requestId?: string; timeoutMs?: number }): Promise<{
    requestId: string
    clientSentAt: number
    serverReceivedAt: number
    serverSentAt: number
    rttMs: number
  }> {
    const requestId =
      params?.requestId ?? `ping-${Date.now()}-${Math.random().toString(36).slice(2)}`
    const clientSentAt = Date.now()

    const payload = await this.sendRequest({
      requestId,
      message: { type: 'ping', requestId, clientSentAt },
      timeout: params?.timeoutMs ?? 5000,
      select: (msg) => {
        if (msg.type !== 'pong') return null
        if (msg.payload.requestId !== requestId) return null
        if (typeof msg.payload.serverReceivedAt !== 'number') return null
        if (typeof msg.payload.serverSentAt !== 'number') return null
        return msg.payload
      },
    })

    return {
      requestId,
      clientSentAt,
      serverReceivedAt: payload.serverReceivedAt,
      serverSentAt: payload.serverSentAt,
      rttMs: Date.now() - clientSentAt,
    }
  }

  // ============================================================================
  // Agent RPCs (requestId-correlated)
  // ============================================================================

  async fetchAgents(options?: FetchAgentsOptions): Promise<FetchAgentsPayload> {
    const resolvedRequestId = this.createRequestId(options?.requestId)
    const message = SessionInboundMessageSchema.parse({
      type: 'fetch_agents_request',
      requestId: resolvedRequestId,
      ...(options?.filter ? { filter: options.filter } : {}),
      ...(options?.sort ? { sort: options.sort } : {}),
      ...(options?.page ? { page: options.page } : {}),
      ...(options?.subscribe ? { subscribe: options.subscribe } : {}),
    })
    return this.sendRequest({
      requestId: resolvedRequestId,
      message,
      timeout: 10000,
      options: { skipQueue: true },
      select: (msg) => {
        if (msg.type !== 'fetch_agents_response') {
          return null
        }
        if (msg.payload.requestId !== resolvedRequestId) {
          return null
        }
        return msg.payload
      },
    })
  }

  async fetchAgent(agentId: string, requestId?: string): Promise<FetchAgentResult | null> {
    const resolvedRequestId = this.createRequestId(requestId)
    const message = SessionInboundMessageSchema.parse({
      type: 'fetch_agent_request',
      requestId: resolvedRequestId,
      agentId,
    })
    const payload = await this.sendRequest({
      requestId: resolvedRequestId,
      message,
      timeout: 10000,
      options: { skipQueue: true },
      select: (msg) => {
        if (msg.type !== 'fetch_agent_response') {
          return null
        }
        if (msg.payload.requestId !== resolvedRequestId) {
          return null
        }
        return msg.payload
      },
    })
    if (payload.error) {
      throw new Error(payload.error)
    }
    if (!payload.agent) {
      return null
    }
    return { agent: payload.agent, project: payload.project ?? null }
  }

  private resubscribeCheckoutDiffSubscriptions(): void {
    if (this.checkoutDiffSubscriptions.size === 0) {
      return
    }
    for (const [subscriptionId, subscription] of this.checkoutDiffSubscriptions) {
      const message = SessionInboundMessageSchema.parse({
        type: 'subscribe_checkout_diff_request',
        subscriptionId,
        cwd: subscription.cwd,
        compare: subscription.compare,
        requestId: this.createRequestId(),
      })
      this.sendSessionMessage(message)
    }
  }

  private resubscribeTerminalDirectorySubscriptions(): void {
    if (this.terminalDirectorySubscriptions.size === 0) {
      return
    }
    for (const cwd of this.terminalDirectorySubscriptions) {
      this.sendSessionMessage({
        type: 'subscribe_terminals_request',
        cwd,
      })
    }
  }

  // ============================================================================
  // Agent Lifecycle
  // ============================================================================

  async createAgent(options: CreateAgentRequestOptions): Promise<AgentSnapshotPayload> {
    const requestId = this.createRequestId(options.requestId)
    const config = resolveAgentConfig(options)

    const message = SessionInboundMessageSchema.parse({
      type: 'create_agent_request',
      requestId,
      config,
      ...(options.initialPrompt ? { initialPrompt: options.initialPrompt } : {}),
      ...(options.clientMessageId ? { clientMessageId: options.clientMessageId } : {}),
      ...(options.outputSchema ? { outputSchema: options.outputSchema } : {}),
      ...(options.images && options.images.length > 0 ? { images: options.images } : {}),
      ...(options.git ? { git: options.git } : {}),
      ...(options.worktreeName ? { worktreeName: options.worktreeName } : {}),
      ...(options.labels && Object.keys(options.labels).length > 0
        ? { labels: options.labels }
        : {}),
    })

    const status = await this.sendRequest({
      requestId,
      message,
      timeout: 15000,
      options: { skipQueue: true },
      select: (msg) => {
        if (msg.type !== 'status') {
          return null
        }
        const created = AgentCreatedStatusPayloadSchema.safeParse(msg.payload)
        if (created.success && created.data.requestId === requestId) {
          return created.data
        }
        const failed = AgentCreateFailedStatusPayloadSchema.safeParse(msg.payload)
        if (failed.success && failed.data.requestId === requestId) {
          return failed.data
        }
        return null
      },
    })
    if (status.status === 'agent_create_failed') {
      throw new Error(status.error)
    }

    return status.agent
  }

  async deleteAgent(agentId: string): Promise<void> {
    const requestId = this.createRequestId()
    const message = SessionInboundMessageSchema.parse({
      type: 'delete_agent_request',
      agentId,
      requestId,
    })
    await this.sendRequest({
      requestId,
      message,
      timeout: 10000,
      options: { skipQueue: true },
      select: (msg) => {
        if (msg.type !== 'agent_deleted') {
          return null
        }
        if (msg.payload.requestId !== requestId) {
          return null
        }
        return msg.payload
      },
    })
  }

  async archiveAgent(agentId: string): Promise<{ archivedAt: string }> {
    const requestId = this.createRequestId()
    const message = SessionInboundMessageSchema.parse({
      type: 'archive_agent_request',
      agentId,
      requestId,
    })
    const result = await this.sendRequest({
      requestId,
      message,
      timeout: 10000,
      options: { skipQueue: true },
      select: (msg) => {
        if (msg.type !== 'agent_archived') {
          return null
        }
        if (msg.payload.requestId !== requestId) {
          return null
        }
        return msg.payload
      },
    })
    return { archivedAt: result.archivedAt }
  }

  async updateAgent(
    agentId: string,
    updates: { name?: string; labels?: Record<string, string> }
  ): Promise<void> {
    const requestId = this.createRequestId()
    const message = SessionInboundMessageSchema.parse({
      type: 'update_agent_request',
      agentId,
      ...(updates.name !== undefined ? { name: updates.name } : {}),
      ...(updates.labels && Object.keys(updates.labels).length > 0
        ? { labels: updates.labels }
        : {}),
      requestId,
    })
    const payload = await this.sendRequest({
      requestId,
      message,
      timeout: 10000,
      options: { skipQueue: true },
      select: (msg) => {
        if (msg.type !== 'update_agent_response') {
          return null
        }
        if (msg.payload.requestId !== requestId) {
          return null
        }
        return msg.payload
      },
    })
    if (!payload.accepted) {
      throw new Error(payload.error ?? 'updateAgent rejected')
    }
  }

  async resumeAgent(
    handle: AgentPersistenceHandle,
    overrides?: Partial<AgentSessionConfig>
  ): Promise<AgentSnapshotPayload> {
    const requestId = this.createRequestId()
    const message = SessionInboundMessageSchema.parse({
      type: 'resume_agent_request',
      requestId,
      handle,
      ...(overrides ? { overrides } : {}),
    })

    const status = await this.sendRequest({
      requestId,
      message,
      timeout: 15000,
      options: { skipQueue: true },
      select: (msg) => {
        if (msg.type !== 'status') {
          return null
        }
        const resumed = AgentResumedStatusPayloadSchema.safeParse(msg.payload)
        if (resumed.success && resumed.data.requestId === requestId) {
          return resumed.data
        }
        return null
      },
    })

    return status.agent
  }

  async refreshAgent(agentId: string, requestId?: string): Promise<AgentRefreshedStatusPayload> {
    const resolvedRequestId = this.createRequestId(requestId)
    const message = SessionInboundMessageSchema.parse({
      type: 'refresh_agent_request',
      agentId,
      requestId: resolvedRequestId,
    })
    return this.sendRequest({
      requestId: resolvedRequestId,
      message,
      timeout: 15000,
      options: { skipQueue: true },
      select: (msg) => {
        if (msg.type !== 'status') {
          return null
        }
        const refreshed = AgentRefreshedStatusPayloadSchema.safeParse(msg.payload)
        if (refreshed.success && refreshed.data.requestId === resolvedRequestId) {
          return refreshed.data
        }
        return null
      },
    })
  }

  async fetchAgentTimeline(
    agentId: string,
    options: FetchAgentTimelineOptions = {}
  ): Promise<FetchAgentTimelinePayload> {
    const resolvedRequestId = this.createRequestId(options.requestId)
    const message = SessionInboundMessageSchema.parse({
      type: 'fetch_agent_timeline_request',
      agentId,
      requestId: resolvedRequestId,
      ...(options.direction ? { direction: options.direction } : {}),
      ...(options.cursor ? { cursor: options.cursor } : {}),
      ...(typeof options.limit === 'number' ? { limit: options.limit } : {}),
      ...(options.projection ? { projection: options.projection } : {}),
    })

    const payload = await this.sendRequest({
      requestId: resolvedRequestId,
      message,
      timeout: 15000,
      options: { skipQueue: true },
      select: (msg) => {
        if (msg.type !== 'fetch_agent_timeline_response') {
          return null
        }
        if (msg.payload.requestId !== resolvedRequestId) {
          return null
        }
        return msg.payload
      },
    })

    if (payload.error) {
      throw new Error(payload.error)
    }

    return payload
  }

  // ============================================================================
  // Agent Interaction
  // ============================================================================

  async sendAgentMessage(
    agentId: string,
    text: string,
    options?: SendMessageOptions
  ): Promise<void> {
    const requestId = this.createRequestId()
    const messageId = options?.messageId ?? crypto.randomUUID()
    const message = SessionInboundMessageSchema.parse({
      type: 'send_agent_message_request',
      requestId,
      agentId,
      text,
      ...(messageId ? { messageId } : {}),
      ...(options?.images ? { images: options.images } : {}),
    })
    const payload = await this.sendRequest({
      requestId,
      message,
      timeout: 15000,
      options: { skipQueue: true },
      select: (msg) => {
        if (msg.type !== 'send_agent_message_response') {
          return null
        }
        if (msg.payload.requestId !== requestId) {
          return null
        }
        return msg.payload
      },
    })
    if (!payload.accepted) {
      throw new Error(payload.error ?? 'sendAgentMessage rejected')
    }
  }

  async sendMessage(agentId: string, text: string, options?: SendMessageOptions): Promise<void> {
    await this.sendAgentMessage(agentId, text, options)
  }

  async cancelAgent(agentId: string): Promise<void> {
    this.sendSessionMessage({ type: 'cancel_agent_request', agentId })
  }

  async setAgentMode(agentId: string, modeId: string): Promise<void> {
    const requestId = this.createRequestId()
    const message = SessionInboundMessageSchema.parse({
      type: 'set_agent_mode_request',
      agentId,
      modeId,
      requestId,
    })
    const payload = await this.sendRequest({
      requestId,
      message,
      timeout: 15000,
      options: { skipQueue: true },
      select: (msg) => {
        if (msg.type !== 'set_agent_mode_response') {
          return null
        }
        if (msg.payload.requestId !== requestId) {
          return null
        }
        return msg.payload
      },
    })
    if (!payload.accepted) {
      throw new Error(payload.error ?? 'setAgentMode rejected')
    }
  }

  async setAgentModel(agentId: string, modelId: string | null): Promise<void> {
    const requestId = this.createRequestId()
    const message = SessionInboundMessageSchema.parse({
      type: 'set_agent_model_request',
      agentId,
      modelId,
      requestId,
    })
    const payload = await this.sendRequest({
      requestId,
      message,
      timeout: 15000,
      options: { skipQueue: true },
      select: (msg) => {
        if (msg.type !== 'set_agent_model_response') {
          return null
        }
        if (msg.payload.requestId !== requestId) {
          return null
        }
        return msg.payload
      },
    })
    if (!payload.accepted) {
      throw new Error(payload.error ?? 'setAgentModel rejected')
    }
  }

  async setAgentThinkingOption(agentId: string, thinkingOptionId: string | null): Promise<void> {
    const requestId = this.createRequestId()
    const message = SessionInboundMessageSchema.parse({
      type: 'set_agent_thinking_request',
      agentId,
      thinkingOptionId,
      requestId,
    })
    const payload = await this.sendRequest({
      requestId,
      message,
      timeout: 15000,
      options: { skipQueue: true },
      select: (msg) => {
        if (msg.type !== 'set_agent_thinking_response') {
          return null
        }
        if (msg.payload.requestId !== requestId) {
          return null
        }
        return msg.payload
      },
    })
    if (!payload.accepted) {
      throw new Error(payload.error ?? 'setAgentThinkingOption rejected')
    }
  }

  async restartServer(reason?: string, requestId?: string): Promise<RestartRequestedStatusPayload> {
    const resolvedRequestId = this.createRequestId(requestId)
    const message = SessionInboundMessageSchema.parse({
      type: 'restart_server_request',
      ...(reason && reason.trim().length > 0 ? { reason } : {}),
      requestId: resolvedRequestId,
    })
    return this.sendRequest({
      requestId: resolvedRequestId,
      message,
      timeout: 10000,
      options: { skipQueue: true },
      select: (msg) => {
        if (msg.type !== 'status') {
          return null
        }
        const restarted = RestartRequestedStatusPayloadSchema.safeParse(msg.payload)
        if (!restarted.success) {
          return null
        }
        if (restarted.data.requestId !== resolvedRequestId) {
          return null
        }
        return restarted.data
      },
    })
  }

  async shutdownServer(requestId?: string): Promise<ShutdownRequestedStatusPayload> {
    const resolvedRequestId = this.createRequestId(requestId)
    const message = SessionInboundMessageSchema.parse({
      type: 'shutdown_server_request',
      requestId: resolvedRequestId,
    })
    return this.sendRequest({
      requestId: resolvedRequestId,
      message,
      timeout: 10000,
      options: { skipQueue: true },
      select: (msg) => {
        if (msg.type !== 'status') {
          return null
        }
        const shutdown = ShutdownRequestedStatusPayloadSchema.safeParse(msg.payload)
        if (!shutdown.success) {
          return null
        }
        if (shutdown.data.requestId !== resolvedRequestId) {
          return null
        }
        return shutdown.data
      },
    })
  }

  async abortRequest(): Promise<void> {
    this.sendSessionMessage({ type: 'abort_request' })
  }

  // ============================================================================
  // Git Operations
  // ============================================================================

  async getCheckoutStatus(
    cwd: string,
    options?: { requestId?: string }
  ): Promise<CheckoutStatusPayload> {
    const requestId = options?.requestId

    if (!requestId) {
      const existing = this.checkoutStatusInFlight.get(cwd)
      if (existing) {
        return existing
      }
    }

    const resolvedRequestId = this.createRequestId(requestId)
    const message = SessionInboundMessageSchema.parse({
      type: 'checkout_status_request',
      cwd,
      requestId: resolvedRequestId,
    })

    const responsePromise = this.sendRequest({
      requestId: resolvedRequestId,
      message,
      timeout: 60000,
      options: { skipQueue: true },
      select: (msg) => {
        if (msg.type !== 'checkout_status_response') {
          return null
        }
        if (msg.payload.requestId !== resolvedRequestId) {
          return null
        }
        return msg.payload
      },
    })

    if (!requestId) {
      this.checkoutStatusInFlight.set(cwd, responsePromise)
      void responsePromise
        .finally(() => {
          if (this.checkoutStatusInFlight.get(cwd) === responsePromise) {
            this.checkoutStatusInFlight.delete(cwd)
          }
        })
        .catch(() => undefined)
    }

    return responsePromise
  }

  private normalizeCheckoutDiffCompare(compare: {
    mode: 'uncommitted' | 'base'
    baseRef?: string
  }): { mode: 'uncommitted' | 'base'; baseRef?: string } {
    if (compare.mode === 'uncommitted') {
      return { mode: 'uncommitted' }
    }
    const trimmedBaseRef = compare.baseRef?.trim()
    if (!trimmedBaseRef) {
      return { mode: 'base' }
    }
    return { mode: 'base', baseRef: trimmedBaseRef }
  }

  async getCheckoutDiff(
    cwd: string,
    compare: { mode: 'uncommitted' | 'base'; baseRef?: string },
    requestId?: string
  ): Promise<CheckoutDiffPayload> {
    const oneShotSubscriptionId = `oneshot-checkout-diff:${crypto.randomUUID()}`
    try {
      const payload = await this.subscribeCheckoutDiff(cwd, compare, {
        subscriptionId: oneShotSubscriptionId,
        requestId,
      })
      return {
        cwd: payload.cwd,
        files: payload.files,
        error: payload.error,
        requestId: payload.requestId,
      }
    } finally {
      try {
        this.unsubscribeCheckoutDiff(oneShotSubscriptionId)
      } catch {
        // Ignore disconnect races during one-shot cleanup.
      }
    }
  }

  async subscribeCheckoutDiff(
    cwd: string,
    compare: { mode: 'uncommitted' | 'base'; baseRef?: string },
    options?: { subscriptionId?: string; requestId?: string }
  ): Promise<SubscribeCheckoutDiffPayload> {
    const subscriptionId = options?.subscriptionId ?? crypto.randomUUID()
    const normalizedCompare = this.normalizeCheckoutDiffCompare(compare)
    const previousSubscription = this.checkoutDiffSubscriptions.get(subscriptionId) ?? null
    this.checkoutDiffSubscriptions.set(subscriptionId, {
      cwd,
      compare: normalizedCompare,
    })

    const resolvedRequestId = this.createRequestId(options?.requestId)
    const message = SessionInboundMessageSchema.parse({
      type: 'subscribe_checkout_diff_request',
      subscriptionId,
      cwd,
      compare: normalizedCompare,
      requestId: resolvedRequestId,
    })

    try {
      return await this.sendCorrelatedRequest({
        requestId: resolvedRequestId,
        message,
        responseType: 'subscribe_checkout_diff_response',
        timeout: 60000,
        options: { skipQueue: true },
        selectPayload: (payload) => {
          if (payload.subscriptionId !== subscriptionId) {
            return null
          }
          return payload
        },
      })
    } catch (error) {
      if (previousSubscription) {
        this.checkoutDiffSubscriptions.set(subscriptionId, previousSubscription)
      } else {
        this.checkoutDiffSubscriptions.delete(subscriptionId)
      }
      throw error
    }
  }

  unsubscribeCheckoutDiff(subscriptionId: string): void {
    this.checkoutDiffSubscriptions.delete(subscriptionId)
    this.sendSessionMessage({
      type: 'unsubscribe_checkout_diff_request',
      subscriptionId,
    })
  }

  async checkoutCommit(
    cwd: string,
    input: { message?: string; addAll?: boolean },
    requestId?: string
  ): Promise<CheckoutCommitPayload> {
    return this.sendCorrelatedSessionRequest({
      requestId,
      message: {
        type: 'checkout_commit_request',
        cwd,
        message: input.message,
        addAll: input.addAll,
      },
      responseType: 'checkout_commit_response',
      timeout: 60000,
    })
  }

  async checkoutMerge(
    cwd: string,
    input: { baseRef?: string; strategy?: 'merge' | 'squash'; requireCleanTarget?: boolean },
    requestId?: string
  ): Promise<CheckoutMergePayload> {
    return this.sendCorrelatedSessionRequest({
      requestId,
      message: {
        type: 'checkout_merge_request',
        cwd,
        baseRef: input.baseRef,
        strategy: input.strategy,
        requireCleanTarget: input.requireCleanTarget,
      },
      responseType: 'checkout_merge_response',
      timeout: 60000,
    })
  }

  async checkoutMergeFromBase(
    cwd: string,
    input: { baseRef?: string; requireCleanTarget?: boolean },
    requestId?: string
  ): Promise<CheckoutMergeFromBasePayload> {
    return this.sendCorrelatedSessionRequest({
      requestId,
      message: {
        type: 'checkout_merge_from_base_request',
        cwd,
        baseRef: input.baseRef,
        requireCleanTarget: input.requireCleanTarget,
      },
      responseType: 'checkout_merge_from_base_response',
      timeout: 60000,
    })
  }

  async checkoutPush(cwd: string, requestId?: string): Promise<CheckoutPushPayload> {
    return this.sendCorrelatedSessionRequest({
      requestId,
      message: {
        type: 'checkout_push_request',
        cwd,
      },
      responseType: 'checkout_push_response',
      timeout: 60000,
    })
  }

  async checkoutPrCreate(
    cwd: string,
    input: { title?: string; body?: string; baseRef?: string },
    requestId?: string
  ): Promise<CheckoutPrCreatePayload> {
    return this.sendCorrelatedSessionRequest({
      requestId,
      message: {
        type: 'checkout_pr_create_request',
        cwd,
        title: input.title,
        body: input.body,
        baseRef: input.baseRef,
      },
      responseType: 'checkout_pr_create_response',
      timeout: 60000,
    })
  }

  async checkoutPrStatus(cwd: string, requestId?: string): Promise<CheckoutPrStatusPayload> {
    return this.sendCorrelatedSessionRequest({
      requestId,
      message: {
        type: 'checkout_pr_status_request',
        cwd,
      },
      responseType: 'checkout_pr_status_response',
      timeout: 60000,
    })
  }

  async getJunctionWorktreeList(
    input: { cwd?: string; repoRoot?: string },
    requestId?: string
  ): Promise<JunctionWorktreeListPayload> {
    return this.sendCorrelatedSessionRequest({
      requestId,
      message: {
        type: 'junction_worktree_list_request',
        cwd: input.cwd,
        repoRoot: input.repoRoot,
      },
      responseType: 'junction_worktree_list_response',
      timeout: 60000,
    })
  }

  async archiveJunctionWorktree(
    input: { worktreePath?: string; repoRoot?: string; branchName?: string },
    requestId?: string
  ): Promise<JunctionWorktreeArchivePayload> {
    return this.sendCorrelatedSessionRequest({
      requestId,
      message: {
        type: 'junction_worktree_archive_request',
        worktreePath: input.worktreePath,
        repoRoot: input.repoRoot,
        branchName: input.branchName,
      },
      responseType: 'junction_worktree_archive_response',
      timeout: 20000,
    })
  }

  async validateBranch(
    options: { cwd: string; branchName: string },
    requestId?: string
  ): Promise<ValidateBranchPayload> {
    return this.sendCorrelatedSessionRequest({
      requestId,
      message: {
        type: 'validate_branch_request',
        cwd: options.cwd,
        branchName: options.branchName,
      },
      responseType: 'validate_branch_response',
      timeout: 10000,
    })
  }

  async getBranchSuggestions(
    options: { cwd: string; query?: string; limit?: number },
    requestId?: string
  ): Promise<BranchSuggestionsPayload> {
    return this.sendCorrelatedSessionRequest({
      requestId,
      message: {
        type: 'branch_suggestions_request',
        cwd: options.cwd,
        query: options.query,
        limit: options.limit,
      },
      responseType: 'branch_suggestions_response',
      timeout: 10000,
    })
  }

  async getDirectorySuggestions(
    options: {
      query: string
      limit?: number
      cwd?: string
      includeFiles?: boolean
      includeDirectories?: boolean
    },
    requestId?: string
  ): Promise<DirectorySuggestionsPayload> {
    return this.sendCorrelatedSessionRequest({
      requestId,
      message: {
        type: 'directory_suggestions_request',
        query: options.query,
        cwd: options.cwd,
        includeFiles: options.includeFiles,
        includeDirectories: options.includeDirectories,
        limit: options.limit,
      },
      responseType: 'directory_suggestions_response',
      timeout: 10000,
    })
  }

  // ============================================================================
  // File Explorer
  // ============================================================================

  async exploreFileSystem(
    agentId: string,
    path: string,
    mode: 'list' | 'file' = 'list',
    requestId?: string
  ): Promise<FileExplorerPayload> {
    return this.sendCorrelatedSessionRequest({
      requestId,
      message: {
        type: 'file_explorer_request',
        agentId,
        path,
        mode,
      },
      responseType: 'file_explorer_response',
      timeout: 10000,
    })
  }

  async requestDownloadToken(
    agentId: string,
    path: string,
    requestId?: string
  ): Promise<FileDownloadTokenPayload> {
    return this.sendCorrelatedSessionRequest({
      requestId,
      message: {
        type: 'file_download_token_request',
        agentId,
        path,
      },
      responseType: 'file_download_token_response',
      timeout: 10000,
    })
  }

  async requestProjectIcon(
    cwd: string,
    requestId?: string
  ): Promise<ProjectIconResponse['payload']> {
    return this.sendCorrelatedSessionRequest({
      requestId,
      message: {
        type: 'project_icon_request',
        cwd,
      },
      responseType: 'project_icon_response',
      timeout: 10000,
    })
  }

  // ============================================================================
  // Provider Models / Commands
  // ============================================================================

  async listProviderModels(
    provider: AgentProvider,
    options?: { cwd?: string; requestId?: string }
  ): Promise<ListProviderModelsPayload> {
    return this.sendCorrelatedSessionRequest({
      requestId: options?.requestId,
      message: {
        type: 'list_provider_models_request',
        provider,
        cwd: options?.cwd,
      },
      responseType: 'list_provider_models_response',
      // Provider SDK cold starts (especially model discovery) can exceed 30s.
      timeout: 45000,
    })
  }

  async listAvailableProviders(options?: {
    requestId?: string
  }): Promise<ListAvailableProvidersPayload> {
    return this.sendCorrelatedSessionRequest({
      requestId: options?.requestId,
      message: {
        type: 'list_available_providers_request',
      },
      responseType: 'list_available_providers_response',
      timeout: 30000,
    })
  }

  async listCommands(agentId: string, requestId?: string): Promise<ListCommandsPayload>
  async listCommands(agentId: string, options?: ListCommandsOptions): Promise<ListCommandsPayload>
  async listCommands(
    agentId: string,
    requestIdOrOptions?: string | ListCommandsOptions
  ): Promise<ListCommandsPayload> {
    const requestId =
      typeof requestIdOrOptions === 'string' ? requestIdOrOptions : requestIdOrOptions?.requestId
    const draftConfig =
      typeof requestIdOrOptions === 'string' ? undefined : requestIdOrOptions?.draftConfig

    return this.sendCorrelatedSessionRequest({
      requestId,
      message: {
        type: 'list_commands_request',
        agentId,
        ...(draftConfig ? { draftConfig } : {}),
      },
      responseType: 'list_commands_response',
      timeout: 30000,
    })
  }

  // ============================================================================
  // Permissions
  // ============================================================================

  async respondToPermission(
    agentId: string,
    requestId: string,
    response: AgentPermissionResponse
  ): Promise<void> {
    this.sendSessionMessage({
      type: 'agent_permission_response',
      agentId,
      requestId,
      response,
    })
  }

  async respondToPermissionAndWait(
    agentId: string,
    requestId: string,
    response: AgentPermissionResponse,
    timeout = 15000
  ): Promise<AgentPermissionResolvedPayload> {
    const message = SessionInboundMessageSchema.parse({
      type: 'agent_permission_response',
      agentId,
      requestId,
      response,
    })
    return this.sendRequest({
      requestId,
      message,
      timeout,
      options: { skipQueue: true },
      select: (msg) => {
        if (msg.type !== 'agent_permission_resolved') {
          return null
        }
        if (msg.payload.requestId !== requestId) {
          return null
        }
        if (msg.payload.agentId !== agentId) {
          return null
        }
        return msg.payload
      },
    })
  }

  // ============================================================================
  // Waiting / Streaming Helpers
  // ============================================================================

  async waitForAgentUpsert(
    agentId: string,
    predicate: (snapshot: AgentSnapshotPayload) => boolean,
    timeout = 60000
  ): Promise<AgentSnapshotPayload> {
    const initialResult = await this.fetchAgent(agentId).catch(() => null)
    if (initialResult && predicate(initialResult.agent)) {
      return initialResult.agent
    }

    const deadline = Date.now() + timeout
    return await new Promise<AgentSnapshotPayload>((resolve, reject) => {
      let settled = false
      let pollInFlight = false
      let pollTimer: ReturnType<typeof setInterval> | null = null
      let timeoutTimer: ReturnType<typeof setTimeout> | null = null
      let unsubscribe: (() => void) | null = null

      const finish = (
        result:
          | { kind: 'ok'; snapshot: AgentSnapshotPayload }
          | { kind: 'error'; error: Error }
      ) => {
        if (settled) {
          return
        }
        settled = true
        if (timeoutTimer) {
          clearTimeout(timeoutTimer)
          timeoutTimer = null
        }
        if (pollTimer) {
          clearInterval(pollTimer)
          pollTimer = null
        }
        if (unsubscribe) {
          unsubscribe()
          unsubscribe = null
        }
        if (result.kind === 'ok') {
          resolve(result.snapshot)
          return
        }
        reject(result.error)
      }

      const maybeResolve = (snapshot: AgentSnapshotPayload | null) => {
        if (!snapshot) {
          return false
        }
        if (!predicate(snapshot)) {
          return false
        }
        finish({ kind: 'ok', snapshot })
        return true
      }

      const poll = async () => {
        if (settled || pollInFlight) {
          return
        }
        pollInFlight = true
        try {
          const result = await this.fetchAgent(agentId).catch(() => null)
          maybeResolve(result?.agent ?? null)
        } finally {
          pollInFlight = false
        }
      }

      unsubscribe = this.on('agent_update', (message) => {
        if (settled) {
          return
        }
        if (message.type !== 'agent_update') {
          return
        }
        if (message.payload.kind !== 'upsert') {
          return
        }
        const snapshot = message.payload.agent
        if (snapshot.id !== agentId) {
          return
        }
        maybeResolve(snapshot)
      })

      const remaining = Math.max(1, deadline - Date.now())
      timeoutTimer = setTimeout(() => {
        finish({
          kind: 'error',
          error: new Error(`Timed out waiting for agent ${agentId}`),
        })
      }, remaining)

      pollTimer = setInterval(() => {
        void poll()
      }, 250)
      void poll()
    })
  }

  async waitForFinish(agentId: string, timeout = 60000): Promise<WaitForFinishResult> {
    const requestId = this.createRequestId()
    const hasTimeout = Number.isFinite(timeout) && timeout > 0
    const message = SessionInboundMessageSchema.parse({
      type: 'wait_for_finish_request',
      requestId,
      agentId,
      ...(hasTimeout ? { timeoutMs: timeout } : {}),
    })
    const payload = await this.sendCorrelatedRequest({
      requestId,
      message,
      responseType: 'wait_for_finish_response',
      timeout: hasTimeout ? timeout + 5000 : 0,
      options: { skipQueue: true },
    })
    return {
      status: payload.status,
      final: payload.final,
      error: payload.error,
      lastMessage: payload.lastMessage,
    }
  }

  // ============================================================================
  // Terminals
  // ============================================================================

  subscribeTerminals(input: { cwd: string }): void {
    this.terminalDirectorySubscriptions.add(input.cwd)
    if (!this.transport || this.connectionState.status !== 'connected') {
      return
    }
    this.sendSessionMessage({
      type: 'subscribe_terminals_request',
      cwd: input.cwd,
    })
  }

  unsubscribeTerminals(input: { cwd: string }): void {
    this.terminalDirectorySubscriptions.delete(input.cwd)
    if (!this.transport || this.connectionState.status !== 'connected') {
      return
    }
    this.sendSessionMessage({
      type: 'unsubscribe_terminals_request',
      cwd: input.cwd,
    })
  }

  async listTerminals(cwd: string, requestId?: string): Promise<ListTerminalsPayload> {
    const resolvedRequestId = this.createRequestId(requestId)
    const message = SessionInboundMessageSchema.parse({
      type: 'list_terminals_request',
      cwd,
      requestId: resolvedRequestId,
    })
    return this.sendCorrelatedRequest({
      requestId: resolvedRequestId,
      message,
      responseType: 'list_terminals_response',
      timeout: 10000,
      options: { skipQueue: true },
    })
  }

  async createTerminal(
    cwd: string,
    name?: string,
    requestId?: string
  ): Promise<CreateTerminalPayload> {
    const resolvedRequestId = this.createRequestId(requestId)
    const message = SessionInboundMessageSchema.parse({
      type: 'create_terminal_request',
      cwd,
      name,
      requestId: resolvedRequestId,
    })
    return this.sendCorrelatedRequest({
      requestId: resolvedRequestId,
      message,
      responseType: 'create_terminal_response',
      timeout: 10000,
      options: { skipQueue: true },
    })
  }

  async subscribeTerminal(
    terminalId: string,
    requestId?: string
  ): Promise<SubscribeTerminalPayload> {
    const resolvedRequestId = this.createRequestId(requestId)
    const message = SessionInboundMessageSchema.parse({
      type: 'subscribe_terminal_request',
      terminalId,
      requestId: resolvedRequestId,
    })
    return this.sendCorrelatedRequest({
      requestId: resolvedRequestId,
      message,
      responseType: 'subscribe_terminal_response',
      timeout: 10000,
      options: { skipQueue: true },
    })
  }

  unsubscribeTerminal(terminalId: string): void {
    this.sendSessionMessage({
      type: 'unsubscribe_terminal_request',
      terminalId,
    })
  }

  sendTerminalInput(terminalId: string, message: TerminalInput['message']): void {
    this.sendSessionMessage({
      type: 'terminal_input',
      terminalId,
      message,
    })
  }

  async killTerminal(terminalId: string, requestId?: string): Promise<KillTerminalPayload> {
    const resolvedRequestId = this.createRequestId(requestId)
    const message = SessionInboundMessageSchema.parse({
      type: 'kill_terminal_request',
      terminalId,
      requestId: resolvedRequestId,
    })
    return this.sendCorrelatedRequest({
      requestId: resolvedRequestId,
      message,
      responseType: 'kill_terminal_response',
      timeout: 10000,
      options: { skipQueue: true },
    })
  }

  async attachTerminalStream(
    terminalId: string,
    options?: {
      resumeOffset?: number
      rows?: number
      cols?: number
    },
    requestId?: string
  ): Promise<AttachTerminalStreamPayload> {
    const resolvedRequestId = this.createRequestId(requestId)
    const message = SessionInboundMessageSchema.parse({
      type: 'attach_terminal_stream_request',
      terminalId,
      requestId: resolvedRequestId,
      ...(options?.resumeOffset !== undefined ? { resumeOffset: options.resumeOffset } : {}),
      ...(options?.rows !== undefined ? { rows: options.rows } : {}),
      ...(options?.cols !== undefined ? { cols: options.cols } : {}),
    })
    return this.sendCorrelatedRequest({
      requestId: resolvedRequestId,
      message,
      responseType: 'attach_terminal_stream_response',
      timeout: 10000,
      options: { skipQueue: true },
    })
  }

  async detachTerminalStream(
    streamId: number,
    requestId?: string
  ): Promise<DetachTerminalStreamPayload> {
    const resolvedRequestId = this.createRequestId(requestId)
    const message = SessionInboundMessageSchema.parse({
      type: 'detach_terminal_stream_request',
      streamId,
      requestId: resolvedRequestId,
    })
    const payload = await this.sendCorrelatedRequest({
      requestId: resolvedRequestId,
      message,
      responseType: 'detach_terminal_stream_response',
      timeout: 10000,
      options: { skipQueue: true },
    })
    this.terminalStreams.clearStream({ streamId })
    return payload
  }

  onTerminalStreamData(
    streamId: number,
    handler: (chunk: TerminalStreamChunk) => void
  ): () => void {
    return this.terminalStreams.subscribe({ streamId, handler })
  }

  async waitForTerminalStreamData(
    streamId: number,
    predicate: (chunk: TerminalStreamChunk) => boolean,
    timeout = 5000
  ): Promise<TerminalStreamChunk> {
    return new Promise<TerminalStreamChunk>((resolve, reject) => {
      const timeoutHandle = setTimeout(() => {
        unsubscribe()
        reject(new Error(`Timeout waiting for terminal stream data (${timeout}ms)`))
      }, timeout)

      const unsubscribe = this.onTerminalStreamData(streamId, (chunk) => {
        if (!predicate(chunk)) {
          return
        }
        clearTimeout(timeoutHandle)
        unsubscribe()
        resolve(chunk)
      })
    })
  }

  sendTerminalStreamInput(streamId: number, data: string | Uint8Array): void {
    const payload = typeof data === 'string' ? encodeUtf8String(data) : data
    this.sendBinaryFrame({
      channel: BinaryMuxChannel.Terminal,
      messageType: TerminalBinaryMessageType.InputUtf8,
      streamId,
      offset: 0,
      payload,
    })
  }

  sendTerminalStreamKey(streamId: number, input: TerminalKeyInput): void {
    const encoded = encodeTerminalKeyInput(input)
    if (!encoded) {
      return
    }
    this.sendTerminalStreamInput(streamId, encoded)
  }

  sendTerminalStreamAck(streamId: number, offset: number): void {
    const normalizedOffset = Math.max(0, Math.floor(offset))
    this.terminalStreams.noteAck({ streamId, offset: normalizedOffset })
    this.sendBinaryFrame({
      channel: BinaryMuxChannel.Terminal,
      messageType: TerminalBinaryMessageType.Ack,
      streamId,
      offset: normalizedOffset,
      payload: new Uint8Array(0),
    })
  }

  async waitForTerminalOutput(terminalId: string, timeout = 5000): Promise<TerminalOutputPayload> {
    return this.waitFor(
      (msg) => {
        if (msg.type !== 'terminal_output') {
          return null
        }
        if (msg.payload.terminalId !== terminalId) {
          return null
        }
        return msg.payload
      },
      timeout,
      { skipQueue: true }
    )
  }

  // ============================================================================
  // Internals
  // ============================================================================

  private createRequestId(requestId?: string): string {
    return requestId ?? crypto.randomUUID()
  }

  getLastWelcomeMessage(): WSWelcomeMessage | null {
    return this.lastWelcomeMessage
  }

  private resolveTransportUrlForAttempt(): string {
    return this.config.url
  }

  private sendHelloMessage(): void {
    if (!this.transport) {
      this.scheduleReconnect({
        reason: 'Transport unavailable before hello',
        event: 'HELLO_TRANSPORT_MISSING',
        reasonCode: 'transport_error',
      })
      return
    }

    try {
      const hello: Record<string, unknown> = {
          type: 'hello',
          clientId: this.config.clientId,
          clientType: this.config.clientType ?? 'cli',
          protocolVersion: 1,
        }
      if (this.config.token) {
        hello.token = this.config.token
      }
      this.transport.send(JSON.stringify(hello))
    } catch (error) {
      const message =
        error instanceof Error ? error.message : 'Failed to send hello message'
      this.lastErrorValue = message
      this.scheduleReconnect({
        reason: message,
        event: 'HELLO_SEND_FAILED',
        reasonCode: 'transport_error',
      })
    }
  }

  private disposeTransport(code = 1001, reason = 'Reconnecting'): void {
    this.cleanupTransport()
    if (this.transport) {
      try {
        this.transport.close(code, reason)
      } catch {
        // no-op
      }
      this.transport = null
    }
  }

  private cleanupTransport(): void {
    this.resetConnectTimeout()
    if (this.pendingGenericTransportErrorTimeout) {
      clearTimeout(this.pendingGenericTransportErrorTimeout)
      this.pendingGenericTransportErrorTimeout = null
    }
    for (const cleanup of this.transportCleanup) {
      try {
        cleanup()
      } catch {
        // no-op
      }
    }
    this.transportCleanup = []
  }

  private resetConnectTimeout(): void {
    if (!this.connectTimeout) {
      return
    }
    clearTimeout(this.connectTimeout)
    this.connectTimeout = null
  }

  private handleTransportMessage(data: unknown): void {
    const startedAtMs = getNowMs()
    const rawData =
      data && typeof data === 'object' && 'data' in data ? (data as { data: unknown }).data : data
    const rawBytes = asUint8Array(rawData)
    if (rawBytes) {
      const frame = decodeBinaryMuxFrame(rawBytes)
      if (frame) {
        this.emitDiagnosticsEvent({
          type: 'transport_binary_frame',
          channel: frame.channel,
          messageType: frame.messageType,
          payloadBytes: frame.payload?.byteLength ?? 0,
        })
        this.handleBinaryFrame(frame)
        return
      }
    }
    const payload = decodeMessageData(rawData)
    if (!payload) {
      return
    }

    let parsedJson: unknown
    let parseMs = 0
    try {
      const parseStartedAtMs = getNowMs()
      parsedJson = JSON.parse(payload)
      parseMs = getNowMs() - parseStartedAtMs
    } catch {
      this.emitDiagnosticsEvent({
        type: 'transport_message_timing',
        messageType: 'unknown',
        payloadBytes: payload.length,
        parseMs: 0,
        validateMs: 0,
        totalMs: getNowMs() - startedAtMs,
        outcome: 'parse_error',
      })
      return
    }

    const validateStartedAtMs = getNowMs()
    const parsed = WSOutboundMessageSchema.safeParse(parsedJson)
    const validateMs = getNowMs() - validateStartedAtMs
    if (!parsed.success) {
      const msgType = (parsedJson as { type?: string })?.type ?? 'unknown'
      this.emitDiagnosticsEvent({
        type: 'transport_message_timing',
        messageType: msgType,
        payloadBytes: payload.length,
        parseMs,
        validateMs,
        totalMs: getNowMs() - startedAtMs,
        outcome: 'validation_error',
      })
      this.logger.warn({ msgType, error: parsed.error.message }, 'Message validation failed')
      return
    }

    this.emitDiagnosticsEvent({
      type: 'transport_message_timing',
      messageType: parsed.data.type,
      payloadBytes: payload.length,
      parseMs,
      validateMs,
      totalMs: getNowMs() - startedAtMs,
      outcome: 'ok',
    })

    if (parsed.data.type === 'pong') {
      return
    }

    if (parsed.data.type === 'welcome') {
      this.lastWelcomeMessage = parsed.data
      this.resetConnectTimeout()
      this.reconnectAttempt = 0
      this.updateConnectionState({ status: 'connected' }, { event: 'HELLO_WELCOME' })
      this.resubscribeCheckoutDiffSubscriptions()
      this.resubscribeTerminalDirectorySubscriptions()
      this.flushPendingSendQueue()
      this.resolveConnect()
      return
    }

    this.handleSessionMessage(parsed.data.message)
  }

  private handleBinaryFrame(frame: BinaryMuxFrame): void {
    if (
      frame.channel === BinaryMuxChannel.Terminal &&
      frame.messageType === TerminalBinaryMessageType.OutputUtf8
    ) {
      const chunk: TerminalStreamChunk = {
        streamId: frame.streamId,
        offset: frame.offset,
        endOffset: frame.offset + (frame.payload?.byteLength ?? 0),
        replay: Boolean((frame.flags ?? 0) & TerminalBinaryFlags.Replay),
        data: frame.payload ?? new Uint8Array(0),
      }
      this.terminalStreams.receiveChunk({ chunk })
      return
    }
  }

  private updateConnectionState(
    next: ConnectionState,
    metadata?: { event: string; reason?: string; reasonCode?: string }
  ): void {
    const previous = this.connectionState
    this.connectionState = next
    const reasonFromNext =
      next.status === 'disconnected' && typeof next.reason === 'string'
        ? next.reason
        : null
    const reason = metadata?.reason ?? reasonFromNext
    const reasonCode = metadata?.reasonCode ?? toReasonCode(reason)
    this.logger.debug(
      {
        serverId: this.logServerId,
        clientIdHash: this.logClientIdHash,
        from: previous.status,
        to: next.status,
        event: metadata?.event ?? 'STATE_UPDATE',
        connectionPath: this.logConnectionPath,
        generation: this.logGeneration,
        reasonCode,
        reason,
      },
      'DaemonClientTransition'
    )
    for (const listener of this.connectionListeners) {
      try {
        listener(next)
      } catch {
        // no-op
      }
    }
  }

  private scheduleReconnect(input?: {
    reason?: string
    event?: string
    reasonCode?: string
  }): void {
    if (this.reconnectTimeout) {
      clearTimeout(this.reconnectTimeout)
      this.reconnectTimeout = null
    }
    const wasDisposed = this.connectionState.status === 'disposed'
    const reason = input?.reason

    if (typeof reason === 'string' && reason.trim().length > 0) {
      this.lastErrorValue = reason.trim()
    }

    // Clear all pending waiters and queued sends since the connection was lost
    // and responses from the previous connection will never arrive.
    this.clearWaiters(new Error(reason ?? 'Connection lost'))
    this.rejectPendingSendQueue(new Error(reason ?? 'Connection lost'))
    this.terminalStreams.clearAll()
    this.lastWelcomeMessage = null

    if (wasDisposed) {
      this.rejectConnect(new Error(reason ?? 'Daemon client is disposed'))
      return
    }
    this.updateConnectionState({
      status: 'disconnected',
      ...(reason ? { reason } : {}),
    }, {
      event: input?.event ?? 'TRANSPORT_CLOSE',
      ...(reason ? { reason } : {}),
      ...(input?.reasonCode ? { reasonCode: input.reasonCode } : {}),
    })
    if (!this.shouldReconnect || this.config.reconnect?.enabled === false) {
      this.rejectConnect(new Error(reason ?? 'Transport disconnected before connect'))
      return
    }

    const attempt = this.reconnectAttempt
    const baseDelay = this.config.reconnect?.baseDelayMs ?? DEFAULT_RECONNECT_BASE_DELAY_MS
    const maxDelay = this.config.reconnect?.maxDelayMs ?? DEFAULT_RECONNECT_MAX_DELAY_MS
    const delay = Math.min(baseDelay * 2 ** attempt, maxDelay)
    this.reconnectAttempt = attempt + 1
    this.reconnectTimeout = setTimeout(() => {
      this.reconnectTimeout = null
      if (!this.shouldReconnect) {
        return
      }
      this.attemptConnect()
    }, delay)
  }

  private handleSessionMessage(msg: SessionOutboundMessage): void {
    if (msg.type === 'terminal_stream_exit') {
      this.terminalStreams.clearStream({ streamId: msg.payload.streamId })
    }

    if (this.rawMessageListeners.size > 0) {
      for (const handler of this.rawMessageListeners) {
        try {
          handler(msg)
        } catch {
          // no-op
        }
      }
    }

    const handlers = this.messageHandlers.get(msg.type)
    if (handlers) {
      for (const handler of handlers) {
        try {
          handler(msg)
        } catch {
          // no-op
        }
      }
    }

    const event = this.toEvent(msg)
    if (event) {
      for (const handler of this.eventListeners) {
        handler(event)
      }
    }

    this.resolveWaiters(msg)
  }

  private resolveWaiters(msg: SessionOutboundMessage): void {
    for (const waiter of Array.from(this.waiters)) {
      const result = waiter.predicate(msg)
      if (result !== null) {
        this.waiters.delete(waiter)
        if (waiter.timeoutHandle) {
          clearTimeout(waiter.timeoutHandle)
        }
        waiter.resolve(result)
      }
    }
  }

  private clearWaiters(error: Error): void {
    for (const waiter of Array.from(this.waiters)) {
      if (waiter.timeoutHandle) {
        clearTimeout(waiter.timeoutHandle)
      }
      waiter.reject(error)
    }
    this.waiters.clear()
  }

  private toEvent(msg: SessionOutboundMessage): DaemonEvent | null {
    switch (msg.type) {
      case 'agent_update':
        return {
          type: 'agent_update',
          agentId: msg.payload.kind === 'upsert' ? msg.payload.agent.id : msg.payload.agentId,
          payload: msg.payload,
        }
      case 'agent_stream':
        return {
          type: 'agent_stream',
          agentId: msg.payload.agentId,
          event: msg.payload.event,
          timestamp: msg.payload.timestamp,
          ...(typeof msg.payload.seq === 'number' ? { seq: msg.payload.seq } : {}),
          ...(typeof msg.payload.epoch === 'string' ? { epoch: msg.payload.epoch } : {}),
        }
      case 'status':
        return { type: 'status', payload: msg.payload }
      case 'agent_deleted':
        return { type: 'agent_deleted', agentId: msg.payload.agentId }
      case 'agent_permission_request':
        return {
          type: 'agent_permission_request',
          agentId: msg.payload.agentId,
          request: msg.payload.request,
        }
      case 'agent_permission_resolved':
        return {
          type: 'agent_permission_resolved',
          agentId: msg.payload.agentId,
          requestId: msg.payload.requestId,
          resolution: msg.payload.resolution,
        }
      default:
        return null
    }
  }

  private async waitFor<T>(
    predicate: (msg: SessionOutboundMessage) => T | null,
    timeout = 30000,
    _options?: { skipQueue?: boolean }
  ): Promise<T> {
    return this.waitForWithCancel(predicate, timeout, _options).promise
  }

  private waitForWithCancel<T>(
    predicate: (msg: SessionOutboundMessage) => T | null,
    timeout = 30000,
    _options?: { skipQueue?: boolean }
  ): WaitHandle<T> {
    // Capture stack trace at call site, not inside setTimeout
    const timeoutError = new Error(`Timeout waiting for message (${timeout}ms)`)

    let waiter: Waiter<T> | null = null
    let settled = false
    let rejectFn: ((error: Error) => void) | null = null

    const promise = new Promise<T>((resolve, reject) => {
      const wrappedResolve = (value: T) => {
        if (settled) return
        settled = true
        resolve(value)
      }
      const wrappedReject = (error: Error) => {
        if (settled) return
        settled = true
        reject(error)
      }
      rejectFn = wrappedReject

      const timeoutHandle =
        timeout > 0
          ? setTimeout(() => {
              if (waiter) {
                this.waiters.delete(waiter)
              }
              wrappedReject(timeoutError)
            }, timeout)
          : null

      waiter = {
        predicate,
        resolve: wrappedResolve,
        reject: wrappedReject,
        timeoutHandle,
      }
      this.waiters.add(waiter)
    })

    const cancel = (error: Error) => {
      if (settled) {
        return
      }

      if (waiter) {
        this.waiters.delete(waiter)
        if (waiter.timeoutHandle) {
          clearTimeout(waiter.timeoutHandle)
        }
      }

      if (rejectFn) {
        rejectFn(error)
        return
      }

      // Extremely unlikely: cancel called before the Promise executor ran.
      queueMicrotask(() => {
        if (!settled && rejectFn) {
          rejectFn(error)
        }
      })
    }

    return { promise, cancel }
  }
}

function resolveAgentConfig(options: CreateAgentRequestOptions): AgentSessionConfig {
  const {
    config,
    provider,
    cwd,
    initialPrompt: _initialPrompt,
    images: _images,
    git: _git,
    worktreeName: _worktreeName,
    requestId: _requestId,
    labels: _labels,
    ...overrides
  } = options

  const baseConfig: Partial<AgentSessionConfig> = {
    ...(provider ? { provider } : {}),
    ...(cwd ? { cwd } : {}),
    ...overrides,
  }

  const merged = config ? { ...baseConfig, ...config } : baseConfig

  if (!merged.provider || !merged.cwd) {
    throw new Error('createAgent requires provider and cwd')
  }

  if (!merged.modeId) {
    merged.modeId = getAgentProviderDefinition(merged.provider).defaultModeId ?? undefined
  }

  return {
    ...merged,
    provider: merged.provider,
    cwd: merged.cwd,
  }
}
