package sh.paseo.watch.model

/**
 * Watch-side view of Paseo's Project -> Workspace -> Agent session hierarchy.
 *
 * These are display models, not wire types. The phone app owns the daemon
 * connection and flattens its snapshot into these before pushing them over the
 * Wearable Data Layer, so the watch never has to know about timelines,
 * providers config, or git state.
 *
 * Terminology follows docs/glossary.md exactly: a Workspace is one cwd on one
 * daemon belonging to exactly one Project, and an Agent session is one running
 * instance of an agent inside a workspace. Worktree-backed workspaces carry the
 * mnemonic names (`jubilant-wombat`), so those are workspace labels — never
 * agent labels.
 */

/** Aggregate activity signal for a row. Ordering here is the sort priority. */
enum class ActivityState {
  NeedsInput,
  Running,
  Idle,
}

data class AgentSession(
  val id: String,
  val workspaceId: String,
  /** Daemon this session lives on. Commands must be routed back to it. */
  val serverId: String,
  /** Provider display name — "Claude", "Codex", "Copilot". The agent row's primary line. */
  val provider: String,
  val state: ActivityState,
  /** Pre-formatted by the phone ("12m", "2h"); the watch does no time math. */
  val age: String,
  /** Short intent line, e.g. "docs rewrite". Null when there's nothing useful to say. */
  val intent: String? = null,
  /**
   * One-line description of what this session is doing. The phone sends the
   * daemon's own agent title — it rides in the snapshot, so it must stay cheap for
   * every agent on every daemon. The actual conversation is a [Transcript], fetched
   * on demand for the one agent you opened; this is the placeholder until it lands.
   */
  val summary: String? = null,
  val pendingPermission: PermissionRequest? = null,
)

data class Workspace(
  val id: String,
  /** Workspace name — the mnemonic for worktree-backed workspaces. */
  val name: String,
  val projectKey: String,
  val projectName: String,
  /** Daemon this workspace lives on. */
  val serverId: String,
  val agents: List<AgentSession>,
) {
  /** Worst state across the workspace's agents, per ActivityState ordering. */
  val state: ActivityState
    get() = agents.minByOrNull { it.state.ordinal }?.state ?: ActivityState.Idle

  val pendingPermission: PermissionRequest?
    get() = agents.firstNotNullOfOrNull { it.pendingPermission }
}

fun List<Workspace>.workspaceByIdentity(serverId: String?, workspaceId: String?): Workspace? {
  if (serverId == null || workspaceId == null) return null
  return firstOrNull { it.serverId == serverId && it.id == workspaceId }
}

/**
 * How a transcript entry is rendered. [Unknown] exists so the phone can start
 * emitting a new kind before the watch learns to style it — the text still shows,
 * just plainly. Dropping it would leave a hole in the conversation.
 */
enum class TranscriptKind {
  User,
  Assistant,
  Tool,
  Error,
  Unknown,
}

data class TranscriptEntry(
  val kind: TranscriptKind,
  /** Already trimmed, collapsed and capped by the phone; rendered verbatim. */
  val text: String,
)

/**
 * One agent's conversation scrollback, fetched on demand for the agent you opened.
 *
 * Deliberately not part of the snapshot: the snapshot covers every agent on every
 * daemon and republishes on every store change, so carrying transcripts in it would
 * mean subscribing to every timeline just to populate a wrist.
 */
data class Transcript(
  val agentId: String,
  /** Oldest to newest — the list is read bottom-up on the watch. */
  val entries: List<TranscriptEntry>,
  /** True when history exists before [entries]`.first()`. */
  val truncated: Boolean = false,
  val updatedAt: Long = 0,
)

data class PermissionRequest(
  val id: String,
  val agentId: String,
  /** Human-readable action, e.g. "Run command?". */
  val title: String,
  /** The thing being approved, rendered monospace. */
  val detail: String,
)

/**
 * Where tapping a workspace goes. Encoding this as a value — rather than
 * branching at each call site — is what keeps the "one agent skips the picker"
 * rule from drifting.
 */
sealed interface WorkspaceDestination {
  data class Permission(val serverId: String, val agentId: String) : WorkspaceDestination

  data class Agent(val serverId: String, val agentId: String) : WorkspaceDestination

  /** Ambiguous: 2+ agents and nothing demanding attention. */
  data class Picker(val serverId: String, val workspaceId: String) : WorkspaceDestination

  /** Empty workspace — go straight to dictating a prompt for a new agent. */
  data class NewAgent(val serverId: String, val workspaceId: String) : WorkspaceDestination
}

fun Workspace.destination(): WorkspaceDestination {
  pendingPermission?.let { return WorkspaceDestination.Permission(serverId, it.agentId) }
  return when (agents.size) {
    0 -> WorkspaceDestination.NewAgent(serverId, id)
    1 -> WorkspaceDestination.Agent(serverId, agents.single().id)
    else -> WorkspaceDestination.Picker(serverId, id)
  }
}

/** Secondary line on a workspace row: the single agent's status, or an aggregate. */
fun Workspace.summaryLine(): String {
  val single = agents.singleOrNull()
  if (single != null) {
    val state =
      when (single.state) {
        ActivityState.NeedsInput -> "needs approval"
        ActivityState.Running -> "running ${single.age}"
        ActivityState.Idle -> "idle ${single.age}"
      }
    return "${single.provider} · $state"
  }
  if (agents.isEmpty()) return "no agents · tap to start"

  val needsInput = agents.count { it.state == ActivityState.NeedsInput }
  val running = agents.count { it.state == ActivityState.Running }
  val detail =
    when {
      needsInput > 0 -> "$needsInput needs approval"
      running > 0 -> "$running running"
      else -> "all idle"
    }
  return "${agents.size} agents · $detail"
}

/** Needs-attention first, then running, then idle. */
fun List<Workspace>.sortedForWrist(): List<Workspace> =
  sortedWith(compareBy({ it.state.ordinal }, { it.name }))
