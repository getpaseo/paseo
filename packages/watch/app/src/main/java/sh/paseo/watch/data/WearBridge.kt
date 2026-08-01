package sh.paseo.watch.data

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.Json
import sh.paseo.watch.model.ActivityState
import sh.paseo.watch.model.AgentSession
import sh.paseo.watch.model.LiveVoiceHost
import sh.paseo.watch.model.LiveVoicePhase
import sh.paseo.watch.model.LiveVoiceState
import sh.paseo.watch.model.LiveVoiceTranscriptEntry
import sh.paseo.watch.model.PermissionRequest
import sh.paseo.watch.model.Transcript
import sh.paseo.watch.model.TranscriptEntry
import sh.paseo.watch.model.TranscriptKind
import sh.paseo.watch.model.Workspace

/**
 * The watch <-> phone wire contract.
 *
 * This is a private protocol between two halves of the same product that ship
 * together, so it is NOT subject to Paseo's daemon protocol back-compat rules. It
 * does still carry [PROTOCOL_VERSION]: a watch and a phone app can be updated
 * independently by the user, and the mismatch has to be detectable rather than
 * silently mis-parsed.
 *
 * The mirror of this file is packages/app/src/wear/wear-protocol.ts. Change both or
 * neither — there is no generated code keeping them honest.
 *
 * Design notes:
 * - The phone sends display-ready values. `age` arrives as "12m", already
 *   formatted, so the watch does no clock math and needs no timezone handling.
 * - Snapshots go over DataClient (persisted, auto-synced, survives the watch being
 *   out of range and resyncs on reconnect). Commands go over MessageClient
 *   (fire-and-forget, low latency, no persistence — a command that can't be
 *   delivered should fail loudly rather than arrive an hour later).
 */
object WearBridge {
  const val PROTOCOL_VERSION = 1

  /** DataClient path carrying the full snapshot. */
  const val SNAPSHOT_PATH = "/paseo/snapshot"

  /**
   * DataClient path prefix for per-agent transcripts: `/paseo/transcript/<agentId>`.
   *
   * One item per agent rather than one blob, because a transcript is fetched on
   * demand for the agent you opened. Folding them into the snapshot would mean the
   * phone republishing every transcript on every store change, and the snapshot
   * covers every agent on every daemon.
   */
  const val TRANSCRIPT_PATH_PREFIX = "/paseo/transcript"

  /** DataClient path for one agent's transcript. */
  fun transcriptPath(agentId: String): String = "$TRANSCRIPT_PATH_PREFIX/$agentId"

  /**
   * DataClient path prefix for per-project icons: `/paseo/icon/<Uri.encode(projectKey)>`.
   *
   * The phone publishes one item per project whose repo actually has an icon file
   * (favicon/icon/logo, <= 32 KB), carrying the raw file bytes as an [Asset] under
   * [ICON_PAYLOAD_KEY] and its mime type under [ICON_MIME_KEY]. The key is encoded
   * because a projectKey is a repo-ish string (`github.com/getpaseo/paseo`) and a
   * DataItem path is a URI path — the slashes would otherwise invent directories.
   *
   * The watch never publishes these, so there is no `iconPath()` here: encoding
   * lives on the phone (`packages/app/src/wear/`), decoding in
   * [encodedProjectKeyFromIconPath] plus `Uri.decode`.
   *
   * A missing item is the normal case, not an error — the project simply has no
   * icon, and [sh.paseo.watch.ui.ProjectIcon] falls back to the colored initial.
   */
  const val ICON_PATH_PREFIX = "/paseo/icon"

  /** DataMap key holding the icon's raw bytes as a Wearable `Asset`. */
  const val ICON_PAYLOAD_KEY = "payload"

  /** DataMap key holding the icon's mime type, for diagnostics only. */
  const val ICON_MIME_KEY = "mimeType"

  /**
   * DataClient path carrying Live Voice call state.
   *
   * A single item, not a prefix: a Live Voice call is app-global on the phone —
   * one call, one owning socket — so the watch observes exactly one item and
   * never reconciles several.
   *
   * The item being absent entirely is meaningful and normal: it is what a phone
   * without Live Voice looks like, and what a signed-out phone leaves behind.
   * The watch shows its unavailable state for that rather than treating it as an
   * error, the same way a missing transcript falls back to the summary card.
   */
  const val LIVE_VOICE_PATH = "/paseo/livevoice"

  /** MessageClient path for watch -> phone commands. */
  const val COMMAND_PATH = "/paseo/command"

  /** MessageClient path asking the phone to republish immediately. */
  const val REFRESH_PATH = "/paseo/refresh"

  /** DataItem key holding the JSON payload — same key for snapshots and transcripts. */
  const val SNAPSHOT_KEY = "payload"

  val json: Json = Json {
    ignoreUnknownKeys = true
    encodeDefaults = true
  }
}

// ---------------------------------------------------------------------------
// Snapshot: phone -> watch
// ---------------------------------------------------------------------------

@Serializable
data class WireSnapshot(
  @SerialName("v") val version: Int = WearBridge.PROTOCOL_VERSION,
  @SerialName("updatedAt") val updatedAt: Long = 0,
  @SerialName("workspaces") val workspaces: List<WireWorkspace> = emptyList(),
)

@Serializable
data class WireWorkspace(
  val id: String,
  val name: String,
  val projectKey: String,
  val projectName: String,
  /** Which daemon this workspace lives on; commands must be routed back to it. */
  val serverId: String,
  val agents: List<WireAgent> = emptyList(),
)

@Serializable
data class WireAgent(
  val id: String,
  val provider: String,
  /** "needsInput" | "running" | "idle" — unknown values degrade to idle. */
  val state: String,
  val age: String = "",
  val intent: String? = null,
  val summary: String? = null,
  val permission: WirePermission? = null,
)

@Serializable
data class WirePermission(
  val id: String,
  val title: String,
  val detail: String,
)

// ---------------------------------------------------------------------------
// Transcript: phone -> watch, on demand, one DataItem per agent
// ---------------------------------------------------------------------------

@Serializable
data class WireTranscript(
  @SerialName("v") val version: Int = WearBridge.PROTOCOL_VERSION,
  val agentId: String = "",
  val serverId: String = "",
  val updatedAt: Long = 0,
  /** Oldest to newest, capped at 100 by the phone. */
  val entries: List<WireTranscriptEntry> = emptyList(),
  /** True when history exists before the first entry. */
  val truncated: Boolean = false,
)

@Serializable
data class WireTranscriptEntry(
  /**
   * "user" | "assistant" | "tool" | "error". Unknown kinds are NOT dropped — the
   * phone may learn to emit a new one before the watch learns to render it, and
   * losing the text entirely is worse than rendering it plainly. See
   * [String.toTranscriptKind].
   */
  val kind: String = "",
  /** Already trimmed, collapsed and capped by the phone; rendered verbatim. */
  val text: String = "",
)

// ---------------------------------------------------------------------------
// Commands: watch -> phone
// ---------------------------------------------------------------------------

@Serializable
data class WireCommand(
  @SerialName("v") val version: Int = WearBridge.PROTOCOL_VERSION,
  val kind: String,
  /**
   * Null only for the Live Voice commands that act on the single app-global
   * call; every agent-scoped command must name the daemon to route back to.
   */
  val serverId: String? = null,
  val agentId: String? = null,
  val workspaceId: String? = null,
  val requestId: String? = null,
  val text: String? = null,
  val allow: Boolean? = null,
) {
  companion object {
    const val SEND_PROMPT = "sendPrompt"
    const val CREATE_AGENT = "createAgent"
    const val RESPOND_PERMISSION = "respondPermission"
    const val STOP_AGENT = "stopAgent"

    /**
     * Ask the phone to publish this agent's transcript to
     * [WearBridge.transcriptPath]. A phone too old to know this kind drops it
     * silently, so the watch must treat "no transcript ever arrives" as normal —
     * it keeps showing the summary card — rather than as an error.
     */
    const val REQUEST_TRANSCRIPT = "requestTranscript"

    /**
     * Place a Live Voice call on [WireCommand.serverId].
     *
     * The only Live Voice command that names a host, because choosing which
     * daemon answers is exactly what the watch is deciding. The other two act on
     * the one call the phone already knows about.
     */
    const val START_LIVE_VOICE = "startLiveVoice"

    /** Hang up the active call. Carries no serverId — see [START_LIVE_VOICE]. */
    const val STOP_LIVE_VOICE = "stopLiveVoice"

    /** Toggle the phone's microphone. Carries no serverId. */
    const val TOGGLE_LIVE_VOICE_MUTE = "toggleLiveVoiceMute"
  }
}

// ---------------------------------------------------------------------------
// Live Voice: phone -> watch, one item for the single app-global call
// ---------------------------------------------------------------------------

@Serializable
data class WireLiveVoice(
  @SerialName("v") val version: Int = WearBridge.PROTOCOL_VERSION,
  val updatedAt: Long = 0,
  /** "idle" | "starting" | "active" | "stopping" | "error"; unknown reads as idle. */
  val phase: String = "idle",
  val serverId: String? = null,
  val hostLabel: String? = null,
  val isMuted: Boolean = false,
  /** Hosts that can take a call right now. Empty means see [unavailableReason]. */
  val hosts: List<WireLiveVoiceHost> = emptyList(),
  val unavailableReason: String? = null,
  /** Newest last, capped by the phone. */
  val transcripts: List<WireLiveVoiceTranscript> = emptyList(),
  val errorCode: String? = null,
  val errorMessage: String? = null,
  val closedCause: String? = null,
)

@Serializable data class WireLiveVoiceHost(val serverId: String = "", val label: String = "")

@Serializable
data class WireLiveVoiceTranscript(
  val id: String = "",
  /** "user" | "assistant". */
  val role: String = "",
  val text: String = "",
)

// ---------------------------------------------------------------------------
// Mapping to the UI model
// ---------------------------------------------------------------------------

private fun String.toActivityState(): ActivityState =
  when (this) {
    "needsInput" -> ActivityState.NeedsInput
    "running" -> ActivityState.Running
    // Anything unrecognised — including a state added by a newer phone build —
    // reads as idle. Idle is the safe default: it never fabricates urgency.
    else -> ActivityState.Idle
  }

fun WireSnapshot.toWorkspaces(): List<Workspace> =
  workspaces.map { wire ->
    Workspace(
      id = wire.id,
      name = wire.name,
      projectKey = wire.projectKey,
      projectName = wire.projectName,
      serverId = wire.serverId,
      agents =
        wire.agents.map { agent ->
          AgentSession(
            id = agent.id,
            workspaceId = wire.id,
            serverId = wire.serverId,
            provider = agent.provider,
            state = agent.state.toActivityState(),
            age = agent.age,
            intent = agent.intent,
            summary = agent.summary,
            pendingPermission =
              agent.permission?.let {
                PermissionRequest(
                  id = it.id,
                  agentId = agent.id,
                  title = it.title,
                  detail = it.detail,
                )
              },
          )
        },
    )
  }

/**
 * Unrecognised kinds degrade to [TranscriptKind.Unknown], which renders as muted
 * plain text. Deliberately not dropped: the kind list is allowed to grow without a
 * protocol bump, and an old watch showing the words without the styling is a much
 * better failure than an old watch showing a hole in the conversation.
 */
private fun String.toTranscriptKind(): TranscriptKind =
  when (this) {
    "user" -> TranscriptKind.User
    "assistant" -> TranscriptKind.Assistant
    "tool" -> TranscriptKind.Tool
    "error" -> TranscriptKind.Error
    else -> TranscriptKind.Unknown
  }

fun WireTranscript.toTranscript(): Transcript =
  Transcript(
    agentId = agentId,
    updatedAt = updatedAt,
    truncated = truncated,
    entries =
      entries
        // An entry with no text is a rendering artifact, not content.
        .filter { it.text.isNotBlank() }
        .map { TranscriptEntry(kind = it.kind.toTranscriptKind(), text = it.text) },
  )

fun decodeSnapshot(raw: String): WireSnapshot? =
  runCatching { WearBridge.json.decodeFromString<WireSnapshot>(raw) }
    .getOrNull()
    // A snapshot from a future protocol version is dropped rather than
    // partially rendered; the UI shows its "waiting for phone" state instead.
    ?.takeIf { it.version == WearBridge.PROTOCOL_VERSION }

/** Same version-gate discipline as [decodeSnapshot]: parse or drop, never guess. */
fun decodeTranscript(raw: String): WireTranscript? =
  runCatching { WearBridge.json.decodeFromString<WireTranscript>(raw) }
    .getOrNull()
    ?.takeIf { it.version == WearBridge.PROTOCOL_VERSION }

/** Same version-gate discipline as [decodeSnapshot]. */
fun decodeLiveVoice(raw: String): WireLiveVoice? =
  runCatching { WearBridge.json.decodeFromString<WireLiveVoice>(raw) }
    .getOrNull()
    ?.takeIf { it.version == WearBridge.PROTOCOL_VERSION }

private fun String.toLiveVoicePhase(): LiveVoicePhase =
  when (this) {
    "starting" -> LiveVoicePhase.Starting
    "active" -> LiveVoicePhase.Active
    "stopping" -> LiveVoicePhase.Stopping
    "error" -> LiveVoicePhase.Error
    // Idle is the safe default for a phase this build doesn't know: it offers to
    // start a call rather than claiming one is running that the watch can't end.
    else -> LiveVoicePhase.Idle
  }

fun WireLiveVoice.toLiveVoiceState(): LiveVoiceState =
  LiveVoiceState(
    phase = phase.toLiveVoicePhase(),
    serverId = serverId,
    hostLabel = hostLabel,
    isMuted = isMuted,
    hosts = hosts.filter { it.serverId.isNotEmpty() }.map { LiveVoiceHost(it.serverId, it.label) },
    unavailableReason = unavailableReason,
    transcripts =
      transcripts
        // An entry with no text is a turn the model is still filling in; it would
        // render as an empty bubble.
        .filter { it.text.isNotBlank() }
        .map {
          LiveVoiceTranscriptEntry(id = it.id, fromUser = it.role == "user", text = it.text)
        },
    errorCode = errorCode,
    errorMessage = errorMessage,
    closedCause = closedCause,
  )
