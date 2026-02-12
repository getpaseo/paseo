import { cancel, confirm, intro, isCancel, log, note, outro, spinner } from '@clack/prompts'
import { Command } from 'commander'
import { writeFileSync } from 'node:fs'
import path from 'node:path'
import {
  ensureLocalSpeechModels,
  generateLocalPairingOffer,
  loadConfig,
  loadPersistedConfig,
  type LocalSpeechModelId,
  type CliConfigOverrides,
  type PersistedConfig,
} from '@getpaseo/server'
import {
  resolveLocalPaseoHome,
  resolveLocalDaemonState,
  resolveTcpHostFromListen,
  startLocalDaemonDetached,
  tailDaemonLog,
  type DaemonStartOptions,
} from './daemon/local-daemon.js'
import { tryConnectToDaemon } from '../utils/client.js'

interface OnboardOptions extends DaemonStartOptions {
  timeout?: string
  voice?: 'ask' | 'enable' | 'disable'
}

type OnboardPersistedConfig = PersistedConfig & {
  providers?: PersistedConfig['providers'] & {
    local?: PersistedConfig['providers'] extends { local?: infer T } ? T : { autoDownload?: boolean }
  }
  features?: PersistedConfig['features'] & {
    dictation?: PersistedConfig['features'] extends { dictation?: infer T }
      ? T & { enabled?: boolean }
      : { enabled?: boolean }
    voiceMode?: PersistedConfig['features'] extends { voiceMode?: infer T }
      ? T & { enabled?: boolean }
      : { enabled?: boolean }
  }
}

const DEFAULT_READY_TIMEOUT_MS = 10 * 60 * 1000

class OnboardCancelledError extends Error {}

const plainNoteFormat = (line: string): string => line

function renderNote(message: string, title: string): void {
  note(message, title, { format: plainNoteFormat })
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
}

function parseTimeoutMs(raw: string | undefined): number {
  if (!raw || raw.trim().length === 0) {
    return DEFAULT_READY_TIMEOUT_MS
  }

  const seconds = Number(raw)
  if (!Number.isFinite(seconds) || seconds <= 0) {
    throw new Error(`Invalid timeout value: ${raw}`)
  }

  return Math.ceil(seconds * 1000)
}

function toCliOverrides(options: DaemonStartOptions): CliConfigOverrides {
  const cliOverrides: CliConfigOverrides = {}

  if (options.listen) {
    cliOverrides.listen = options.listen
  } else if (options.port) {
    cliOverrides.listen = `127.0.0.1:${options.port}`
  }

  if (options.relay === false) {
    cliOverrides.relayEnabled = false
  }

  if (options.allowedHosts) {
    const raw = options.allowedHosts.trim()
    cliOverrides.allowedHosts =
      raw.toLowerCase() === 'true'
        ? true
        : raw.split(',').map(host => host.trim()).filter(Boolean)
  }

  if (options.mcp === false) {
    cliOverrides.mcpEnabled = false
  }

  return cliOverrides
}

function savePersistedConfig(paseoHome: string, config: OnboardPersistedConfig): void {
  const configPath = path.join(paseoHome, 'config.json')
  writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`)
}

function applyVoiceSelection(config: OnboardPersistedConfig, enabled: boolean): OnboardPersistedConfig {
  return {
    ...config,
    providers: {
      ...config.providers,
      local: {
        ...config.providers?.local,
        autoDownload: enabled,
      },
    },
    features: {
      ...config.features,
      dictation: {
        ...config.features?.dictation,
        enabled,
      },
      voiceMode: {
        ...config.features?.voiceMode,
        enabled,
      },
    },
  }
}

function resolvePersistedVoiceSelection(config: OnboardPersistedConfig): boolean | null {
  const voiceModeEnabled = config.features?.voiceMode?.enabled
  if (typeof voiceModeEnabled === 'boolean') {
    return voiceModeEnabled
  }

  const dictationEnabled = config.features?.dictation?.enabled
  if (typeof dictationEnabled === 'boolean') {
    return dictationEnabled
  }

  return null
}

async function resolveVoiceSelection(mode: OnboardOptions['voice']): Promise<boolean> {
  if (mode === 'enable') {
    return true
  }
  if (mode === 'disable') {
    return false
  }

  if (!process.stdin.isTTY || !process.stdout.isTTY) {
    log.message('Non-interactive terminal detected; voice setup defaults to disabled.')
    return false
  }

  const answer = await confirm({
    message: 'Enable voice features? (downloads local STT/TTS models now)',
    active: 'Yes',
    inactive: 'No',
    initialValue: false,
  })

  if (isCancel(answer)) {
    throw new OnboardCancelledError('Onboarding cancelled by user.')
  }

  return answer
}

type DownloadProgress = {
  modelId: string | null
  pct: number | null
}

type LocalModelDownloadProgress = {
  modelId: string | null
  pct: number | null
}

type LocalSpeechDownloadLogger = {
  child: (_bindings: Record<string, unknown>) => LocalSpeechDownloadLogger
  info: (obj?: unknown, msg?: string) => void
  error: (_obj?: unknown, _msg?: string) => void
}

type LocalSpeechDownloadEvent =
  | {
      type: 'progress'
      progress: LocalModelDownloadProgress
    }
  | {
      type: 'phase'
      phase: 'extracting' | 'verifying' | 'finalizing' | 'completed'
    }

function resolveRequiredLocalModelIds(config: ReturnType<typeof loadConfig>): LocalSpeechModelId[] {
  const providers = config.speech?.providers
  const local = config.speech?.local

  if (!providers || !local) {
    return []
  }

  const ids = new Set<LocalSpeechModelId>()

  if (providers.dictationStt.enabled !== false && providers.dictationStt.provider === 'local') {
    ids.add(local.models.dictationStt)
  }
  if (providers.voiceStt.enabled !== false && providers.voiceStt.provider === 'local') {
    ids.add(local.models.voiceStt)
  }
  if (providers.voiceTts.enabled !== false && providers.voiceTts.provider === 'local') {
    ids.add(local.models.voiceTts)
  }

  return Array.from(ids)
}

function parseLocalModelDownloadProgress(payload: unknown): LocalModelDownloadProgress | null {
  if (!payload || typeof payload !== 'object') {
    return null
  }

  const value = payload as Record<string, unknown>
  const modelId = typeof value.modelId === 'string' ? value.modelId : null
  const pctRaw = value.pct
  const pct = typeof pctRaw === 'number' && Number.isFinite(pctRaw) ? Math.max(0, Math.min(100, Math.floor(pctRaw))) : null

  return {
    modelId,
    pct,
  }
}

function renderLocalModelProgress(params: {
  modelId: LocalSpeechModelId
  modelIndex: number
  modelCount: number
  pct: number | null
}): string {
  const prefix = `Downloading speech model ${params.modelIndex}/${params.modelCount}: ${params.modelId}`
  if (params.pct === null) {
    return `${prefix}...`
  }
  return `${prefix} (${params.pct}%)`
}

function createLocalSpeechDownloadLogger(
  onEvent: (event: LocalSpeechDownloadEvent) => void
): LocalSpeechDownloadLogger {
  const logger: LocalSpeechDownloadLogger = {
    child: () => logger,
    info: (obj?: unknown, msg?: string) => {
      if (msg === 'Downloading model artifact') {
        const progress = parseLocalModelDownloadProgress(obj)
        if (!progress) {
          return
        }
        onEvent({
          type: 'progress',
          progress,
        })
        return
      }
      if (msg === 'Extracting model archive') {
        onEvent({ type: 'phase', phase: 'extracting' })
        return
      }
      if (msg === 'Verifying downloaded model files') {
        onEvent({ type: 'phase', phase: 'verifying' })
        return
      }
      if (msg === 'Finalizing model artifacts') {
        onEvent({ type: 'phase', phase: 'finalizing' })
        return
      }
      if (msg === 'Model download completed') {
        onEvent({ type: 'phase', phase: 'completed' })
        return
      }
    },
    error: () => {
      // no-op: onboarding handles surfaced errors from ensureLocalSpeechModels.
    },
  }
  return logger
}

async function prepareLocalSpeechModelsBeforeStart(args: {
  config: ReturnType<typeof loadConfig>
  richUi: boolean
}): Promise<void> {
  const local = args.config.speech?.local
  const modelIds = resolveRequiredLocalModelIds(args.config)

  if (!local || modelIds.length === 0) {
    return
  }

  if (local.autoDownload === false) {
    log.warn('Local speech model auto-download is disabled. Voice may be unavailable until models are installed.')
    return
  }

  const modelList = modelIds.join(', ')
  const modelCount = modelIds.length
  const downloadSpinner = args.richUi ? spinner() : null
  let lastPlainStatus = ''

  const emitStatus = (status: string): void => {
    if (downloadSpinner) {
      downloadSpinner.message(status)
      return
    }
    if (status === lastPlainStatus) {
      return
    }
    console.log(status)
    lastPlainStatus = status
  }

  if (downloadSpinner) {
    downloadSpinner.start(`Preparing local speech models (${modelCount})...`)
  } else {
    log.message(`Preparing local speech models (${modelCount}): ${modelList}`)
  }

  try {
    for (const [index, modelId] of modelIds.entries()) {
      const modelIndex = index + 1
      emitStatus(`Checking speech model ${modelIndex}/${modelCount}: ${modelId}`)

      const perModelLogger = createLocalSpeechDownloadLogger((event) => {
        if (event.type === 'progress') {
          const progress = event.progress
          if (progress.modelId && progress.modelId !== modelId) {
            return
          }
          emitStatus(
            renderLocalModelProgress({
              modelId,
              modelIndex,
              modelCount,
              pct: progress.pct,
            })
          )
          return
        }

        if (event.phase === 'extracting') {
          emitStatus(`Extracting speech model ${modelIndex}/${modelCount}: ${modelId}`)
          return
        }
        if (event.phase === 'verifying') {
          emitStatus(`Verifying speech model ${modelIndex}/${modelCount}: ${modelId}`)
          return
        }
        if (event.phase === 'finalizing') {
          emitStatus(`Finalizing speech model ${modelIndex}/${modelCount}: ${modelId}`)
          return
        }
      })

      await ensureLocalSpeechModels({
        modelsDir: local.modelsDir,
        modelIds: [modelId],
        autoDownload: true,
        logger: perModelLogger as any,
      })

      emitStatus(`Speech model ready ${modelIndex}/${modelCount}: ${modelId}`)
    }

    if (downloadSpinner) {
      downloadSpinner.stop(`Local speech models ready (${modelCount})`)
    } else {
      log.message(`Local speech models ready (${modelCount}): ${modelList}`)
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (downloadSpinner) {
      downloadSpinner.error(`Failed to prepare local speech models: ${message}`)
    } else {
      log.error(`Failed to prepare local speech models: ${message}`)
    }
    throw error
  }
}

function parseDownloadProgress(logTail: string): DownloadProgress | null {
  const lines = logTail.split('\n').filter(Boolean)

  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index]
    if (!line || !line.includes('Downloading model artifact')) {
      continue
    }

    const pctMatch = line.match(/"pct"\s*:\s*(\d{1,3})|\bpct[=:]\s*(\d{1,3})/)
    const modelMatch = line.match(
      /"modelId"\s*:\s*"([^"]+)"|\bmodelId[=:]\s*"?([^\s",}]+)/
    )

    return {
      modelId: modelMatch?.[1] ?? modelMatch?.[2] ?? null,
      pct: pctMatch ? Number(pctMatch[1] ?? pctMatch[2]) : null,
    }
  }

  return null
}

function renderProgressLine(progress: DownloadProgress): string {
  const modelSuffix = progress.modelId ? ` (${progress.modelId})` : ''
  if (progress.pct === null) {
    return `Downloading speech model${modelSuffix}...`
  }
  return `Downloading speech model${modelSuffix}: ${progress.pct}%`
}

async function waitForDaemonReady(args: {
  home: string
  timeoutMs: number
  onStatus?: (message: string) => void
}): Promise<{ listen: string; host: string | null }> {
  const deadline = Date.now() + args.timeoutMs
  let lastStatus = ''
  let lastPrintedAt = 0

  while (Date.now() < deadline) {
    const state = resolveLocalDaemonState({ home: args.home })
    const host = resolveTcpHostFromListen(state.listen)

    if (state.running && host) {
      const client = await tryConnectToDaemon({ host, timeout: 1200 })
      if (client) {
        try {
          await client.fetchAgents()
          return { listen: state.listen, host }
        } catch {
          // Daemon process is alive but not API-ready yet.
        } finally {
          await client.close().catch(() => {})
        }
      }
    } else if (state.running && !host) {
      return { listen: state.listen, host: null }
    }

    const progress = parseDownloadProgress(tailDaemonLog(args.home, 120) ?? '')
    const progressLine = progress ? renderProgressLine(progress) : null
    const statusMessage = progressLine ?? 'Waiting for daemon to become ready...'

    if (statusMessage !== lastStatus) {
      args.onStatus?.(statusMessage)
      lastStatus = statusMessage
      lastPrintedAt = Date.now()
    } else if (!args.onStatus && Date.now() - lastPrintedAt >= 3000) {
      console.log(statusMessage)
      lastPrintedAt = Date.now()
    }

    await sleep(200)
  }

  const recentLogs = tailDaemonLog(args.home, 60)
  throw new Error(
    [
      `Timed out after ${Math.ceil(args.timeoutMs / 1000)}s waiting for daemon readiness.`,
      recentLogs ? `Recent daemon logs:\n${recentLogs}` : null,
    ]
      .filter(Boolean)
      .join('\n\n')
  )
}

function printNextSteps(pairingUrl: string | null, paseoHome: string, richUi: boolean): void {
  const daemonLogPath = path.join(paseoHome, 'daemon.log')
  const nextStepsLines = [
    pairingUrl
      ? '1. Open Paseo and scan the QR code above, or paste the pairing link.'
      : '1. Open Paseo and connect to your daemon.',
    '2. Web app: https://app.paseo.sh',
    '3. Desktop app: https://github.com/getpaseo/paseo/releases/latest',
    '4. Docs: https://paseo.sh/docs',
  ]
  const quickReferenceLines = [
    '1. paseo --help',
    '2. paseo ls',
    '3. paseo run "your prompt"',
    '4. paseo status',
    `5. Daemon logs: ${daemonLogPath}`,
  ]

  if (!richUi) {
    console.log('')
    console.log('Next steps:')
    for (const line of nextStepsLines) {
      console.log(line)
    }
    console.log('')
    console.log('CLI quick reference:')
    for (const line of quickReferenceLines) {
      console.log(line)
    }
    return
  }

  renderNote(nextStepsLines.join('\n'), 'Next steps')
  renderNote(quickReferenceLines.join('\n'), 'CLI quick reference')
}

export function onboardCommand(): Command {
  return new Command('onboard')
    .description('Run first-time setup, start daemon, and print pairing instructions')
    .option('--listen <listen>', 'Listen target (host:port, port, or unix socket path)')
    .option('--port <port>', 'Port to listen on (default: 6767)')
    .option('--home <path>', 'Paseo home directory (default: ~/.paseo)')
    .option('--no-relay', 'Disable relay connection')
    .option('--no-mcp', 'Disable the Agent MCP HTTP endpoint')
    .option(
      '--allowed-hosts <hosts>',
      'Comma-separated Host allowlist values (example: "localhost,.example.com" or "true")'
    )
    .option('--timeout <seconds>', 'Max time to wait for daemon readiness (default: 600)')
    .option('--voice <mode>', 'Voice setup mode: ask, enable, disable', 'ask')
    .action(async (options: OnboardOptions) => {
      await runOnboard(options)
    })
}

export async function runOnboard(options: OnboardOptions): Promise<void> {
  const richUi = process.stdin.isTTY && process.stdout.isTTY
  if (richUi) {
    intro('Welcome to Paseo')
  }

  if (options.listen && options.port) {
    cancel('Cannot use --listen and --port together')
    process.exit(1)
  }

  let timeoutMs = DEFAULT_READY_TIMEOUT_MS
  try {
    timeoutMs = parseTimeoutMs(options.timeout)
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    cancel(message)
    process.exit(1)
  }

  const paseoHome = resolveLocalPaseoHome(options.home)
  if (richUi) {
    renderNote(paseoHome, 'Paseo home')
  }

  let persisted = loadPersistedConfig(paseoHome) as OnboardPersistedConfig
  const persistedVoiceSelection = resolvePersistedVoiceSelection(persisted)
  const shouldPrompt = options.voice === 'ask' || options.voice === undefined
  let voiceEnabled: boolean
  try {
    voiceEnabled =
      shouldPrompt && persistedVoiceSelection !== null
        ? persistedVoiceSelection
        : await resolveVoiceSelection(options.voice)
  } catch (error) {
    if (error instanceof OnboardCancelledError) {
      cancel('Onboarding cancelled.')
      process.exit(0)
      return
    }
    throw error
  }

  if (shouldPrompt && persistedVoiceSelection !== null) {
    log.message(`Using saved voice setup from config (${voiceEnabled ? 'enabled' : 'disabled'}).`)
  }

  persisted = applyVoiceSelection(persisted, voiceEnabled)
  savePersistedConfig(paseoHome, persisted)

  const config = loadConfig(paseoHome, { cli: toCliOverrides(options) })

  const voiceStatus = voiceEnabled
    ? 'Voice features enabled. Local speech models will be downloaded if missing.'
    : 'Voice features disabled. Local speech models will not be downloaded now.'
  log.message(voiceStatus)

  try {
    await prepareLocalSpeechModelsBeforeStart({
      config,
      richUi,
    })
  } catch {
    process.exit(1)
  }

  const stateBeforeStart = resolveLocalDaemonState({ home: options.home })
  const startSpinner = richUi ? spinner() : null

  if (!stateBeforeStart.running) {
    try {
      if (startSpinner) {
        startSpinner.start('Starting daemon...')
      } else {
        log.message('Starting daemon...')
      }
      const startup = await startLocalDaemonDetached(options)
      if (startSpinner) {
        startSpinner.stop(`Daemon started (PID ${startup.pid ?? 'unknown'})`)
      } else {
        log.message(`Daemon started (PID ${startup.pid ?? 'unknown'})`)
      }
      log.message(`Logs: ${startup.logPath}`)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      if (startSpinner) {
        startSpinner.error(message)
      } else {
        log.error(message)
      }
      process.exit(1)
    }
  } else {
    log.message(`Daemon already running (PID ${stateBeforeStart.pidInfo?.pid ?? 'unknown'}).`)
  }

  let readyState: { listen: string; host: string | null }
  const readySpinner = richUi ? spinner() : null
  try {
    if (readySpinner) {
      readySpinner.start('Waiting for daemon to become ready...')
    } else {
      log.message('Waiting for daemon to become ready...')
    }
    readyState = await waitForDaemonReady({
      home: options.home ?? paseoHome,
      timeoutMs,
      onStatus: readySpinner ? (message) => readySpinner.message(message) : undefined,
    })
    if (readySpinner) {
      readySpinner.stop(`Daemon ready on ${readyState.listen}`)
    } else {
      log.message(`Daemon ready on ${readyState.listen}`)
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (readySpinner) {
      readySpinner.error(message)
    } else {
      log.error(message)
    }
    process.exit(1)
    return
  }

  if (config.relayEnabled === false) {
    log.warn('Relay is disabled; pairing offer is unavailable for this daemon.')
    printNextSteps(null, paseoHome, richUi)
    if (richUi) {
      outro('Paseo daemon is running.')
    }
    return
  }

  const pairing = await generateLocalPairingOffer({
    paseoHome,
    relayEnabled: config.relayEnabled,
    relayEndpoint: config.relayEndpoint,
    relayPublicEndpoint: config.relayPublicEndpoint,
    appBaseUrl: config.appBaseUrl,
    includeQr: true,
  })

  if (!pairing.url) {
    log.warn('Relay pairing URL is unavailable for this daemon configuration.')
    printNextSteps(null, paseoHome, richUi)
    if (richUi) {
      outro('Paseo daemon is running.')
    }
    return
  }

  renderNote(
    pairing.qr ?? 'QR is unavailable in this terminal. Use the pairing link below.',
    'Scan to pair'
  )
  renderNote(pairing.url, 'Pairing link')
  printNextSteps(pairing.url, paseoHome, richUi)
  if (richUi) {
    outro('Paseo is ready!')
  }
}
