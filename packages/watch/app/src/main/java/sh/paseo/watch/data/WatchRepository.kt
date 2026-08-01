package sh.paseo.watch.data

import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
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
 * Everything the watch UI needs, and nothing about how it gets there.
 *
 * The real implementation will be backed by the Wearable Data Layer with the
 * phone app holding the daemon connection. [MockWatchRepository] stands in until
 * that bridge exists, so the UI is fully exercisable on a bare emulator.
 */
interface WatchRepository {
  val workspaces: StateFlow<List<Workspace>>

  /**
   * Transcripts by agent id, for agents whose transcript has actually arrived.
   *
   * A missing key is the normal case, not an error: transcripts are fetched on
   * demand, and a phone too old to know [WireCommand.REQUEST_TRANSCRIPT] drops the
   * request silently. The agent screen falls back to the summary card.
   */
  val transcripts: StateFlow<Map<String, Transcript>>

  /**
   * Raw icon-file bytes by projectKey, for projects whose repo has an icon the
   * phone could find and this watch can decode.
   *
   * A missing key is the normal case: most projects have no icon file at all, the
   * phone may be too old to publish any, and SVG/ICO payloads are dropped on
   * arrival. [sh.paseo.watch.ui.ProjectIcon] falls back to the colored initial,
   * which is what every project looked like before this stream existed.
   */
  val icons: StateFlow<Map<String, ByteArray>>

  /**
   * The phone's Live Voice call, or [LiveVoiceState.Unknown] until an item
   * arrives.
   *
   * Unknown is also the terminal state on a phone too old to publish one, which
   * is why it is a value rather than a null: the Live Voice screen renders the
   * same "unavailable" copy either way, and has nothing to distinguish.
   */
  val liveVoice: StateFlow<LiveVoiceState>

  fun workspace(id: String): Workspace?

  fun agent(id: String): AgentSession?

  /**
   * Ask the phone to publish this agent's transcript. Fire and forget — the answer
   * arrives later through [transcripts], or never.
   */
  suspend fun requestTranscript(agentId: String)

  /** Send a prompt to an existing agent session. */
  suspend fun sendPrompt(agentId: String, text: String)

  /** Create a new agent session in a workspace with an initial prompt. */
  suspend fun createAgent(workspaceId: String, prompt: String)

  suspend fun respondToPermission(requestId: String, allow: Boolean)

  suspend fun stopAgent(agentId: String)

  /** Ask the phone to place a Live Voice call on [serverId]. */
  suspend fun startLiveVoice(serverId: String)

  /** Hang up whichever call the phone has running. */
  suspend fun stopLiveVoice()

  /** Toggle the phone's microphone for the running call. */
  suspend fun toggleLiveVoiceMute()
}

/**
 * Mock data mirroring design/watch-mock.html one-for-one, so the running app can
 * be compared against the approved mock screen by screen.
 *
 * Deliberately covers all four workspace shapes the navigation rule has to
 * handle: needs-approval, single running agent, multi-agent, and empty.
 */
class MockWatchRepository : WatchRepository {
  private val state = MutableStateFlow(seed())
  private val transcriptState = MutableStateFlow(seedTranscripts())

  override val workspaces: StateFlow<List<Workspace>> = state

  override val transcripts: StateFlow<Map<String, Transcript>> = transcriptState

  /**
   * Always empty: the mock has no phone to fetch image bytes from, so it renders the
   * colored-initial fallback — which is also what a project with no icon looks like
   * in the real app.
   */
  override val icons: StateFlow<Map<String, ByteArray>> = MutableStateFlow(emptyMap())

  private val liveVoiceState =
    MutableStateFlow(
      LiveVoiceState.Unknown.copy(
        hosts = listOf(LiveVoiceHost(serverId = MOCK_SERVER, label = "workstation")),
      ),
    )

  override val liveVoice: StateFlow<LiveVoiceState> = liveVoiceState

  override fun workspace(id: String): Workspace? = state.value.firstOrNull { it.id == id }

  override fun agent(id: String): AgentSession? =
    state.value.flatMap { it.agents }.firstOrNull { it.id == id }

  /**
   * The seeded transcripts are already present, so this is a no-op. `agent-main-copilot`
   * is deliberately left without one so the summary-card fallback — what an old phone
   * or a transcript-less agent looks like — is reachable on an emulator too.
   */
  override suspend fun requestTranscript(agentId: String) = Unit

  override suspend fun sendPrompt(agentId: String, text: String) {
    mutateAgent(agentId) {
      it.copy(state = ActivityState.Running, age = "now", summary = null, pendingPermission = null)
    }
  }

  override suspend fun createAgent(workspaceId: String, prompt: String) {
    state.value =
      state.value.map { workspace ->
        if (workspace.id != workspaceId) {
          workspace
        } else {
          workspace.copy(
            agents =
              workspace.agents +
                AgentSession(
                  id = "agent-new-${workspace.agents.size + 1}",
                  workspaceId = workspaceId,
                  serverId = workspace.serverId,
                  provider = "Claude",
                  state = ActivityState.Running,
                  age = "now",
                  intent = prompt.take(24),
                ),
          )
        }
      }
  }

  override suspend fun respondToPermission(requestId: String, allow: Boolean) {
    state.value =
      state.value.map { workspace ->
        workspace.copy(
          agents =
            workspace.agents.map { agent ->
              if (agent.pendingPermission?.id != requestId) {
                agent
              } else {
                agent.copy(
                  pendingPermission = null,
                  state = if (allow) ActivityState.Running else ActivityState.Idle,
                  age = "now",
                )
              }
            },
        )
      }
  }

  override suspend fun stopAgent(agentId: String) {
    mutateAgent(agentId) { it.copy(state = ActivityState.Idle, age = "now") }
  }

  /**
   * The mock jumps straight to [LiveVoicePhase.Active] with a seeded exchange —
   * there is no phone to negotiate with, and `starting` is a state you can only
   * usefully look at for the second it really lasts.
   */
  override suspend fun startLiveVoice(serverId: String) {
    liveVoiceState.value =
      liveVoiceState.value.copy(
        phase = LiveVoicePhase.Active,
        serverId = serverId,
        hostLabel = liveVoiceState.value.hosts.firstOrNull { it.serverId == serverId }?.label,
        isMuted = false,
        transcripts = seedCallTranscript(),
        errorCode = null,
        errorMessage = null,
        closedCause = null,
      )
  }

  override suspend fun stopLiveVoice() {
    liveVoiceState.value =
      liveVoiceState.value.copy(phase = LiveVoicePhase.Idle, closedCause = "client_stopped")
  }

  override suspend fun toggleLiveVoiceMute() {
    liveVoiceState.value = liveVoiceState.value.copy(isMuted = !liveVoiceState.value.isMuted)
  }

  private fun mutateAgent(agentId: String, transform: (AgentSession) -> AgentSession) {
    state.value =
      state.value.map { workspace ->
        workspace.copy(
          agents = workspace.agents.map { if (it.id == agentId) transform(it) else it },
        )
      }
  }

  private companion object {
    const val MOCK_SERVER = "mock-daemon"

    /** Long enough to overflow the display, so scrolling and wrapping are real. */
    fun seedCallTranscript(): List<LiveVoiceTranscriptEntry> =
      listOf(
        LiveVoiceTranscriptEntry("t1", fromUser = true, text = "What's running right now?"),
        LiveVoiceTranscriptEntry(
          "t2",
          fromUser = false,
          text =
            "Three sessions. crimson-falcon is running the relay transport tests, and " +
              "jubilant-wombat is waiting on you to approve a push.",
        ),
        LiveVoiceTranscriptEntry("t3", fromUser = true, text = "Approve the push"),
        LiveVoiceTranscriptEntry("t4", fromUser = false, text = "Approved. It's pushing now."),
      )

    /**
     * Covers every case the transcript screen has to render: all four known kinds,
     * an unknown kind from a hypothetical newer phone, a truncated backlog long
     * enough to actually scroll, and one agent with no transcript at all.
     */
    fun seedTranscripts(): Map<String, Transcript> =
      mapOf(
        "agent-jubilant" to
          Transcript(
            agentId = "agent-jubilant",
            truncated = true,
            entries =
              listOf(
                TranscriptEntry(TranscriptKind.Assistant, "Rebased onto main; no conflicts."),
                TranscriptEntry(TranscriptKind.User, "Now push it and open the change request"),
                TranscriptEntry(TranscriptKind.Tool, "Bash: git status --porcelain"),
                TranscriptEntry(
                  TranscriptKind.Assistant,
                  "Working tree is clean and the branch is 3 commits ahead. Pushing next.",
                ),
                TranscriptEntry(TranscriptKind.Tool, "Bash: git push origin jubilant-wombat"),
              ),
          ),
        "agent-crimson" to
          Transcript(
            agentId = "agent-crimson",
            entries =
              listOf(
                TranscriptEntry(TranscriptKind.User, "The relay reconnect backoff looks wrong"),
                TranscriptEntry(
                  TranscriptKind.Assistant,
                  "Agreed — it retries flat every 500ms. Rewriting it as exponential with jitter.",
                ),
                TranscriptEntry(TranscriptKind.Tool, "Edit: packages/relay/src/relay-transport.ts"),
                TranscriptEntry(TranscriptKind.Error, "Turn failed: rate limited, retrying"),
                TranscriptEntry(TranscriptKind.Tool, "Bash: npx vitest run relay-transport.test.ts"),
                TranscriptEntry(
                  TranscriptKind.Assistant,
                  "Backoff now doubles from 500ms to a 30s ceiling. Running the transport tests.",
                ),
              ),
          ),
        "agent-main-claude" to
          Transcript(
            agentId = "agent-main-claude",
            entries =
              listOf(
                TranscriptEntry(TranscriptKind.User, "Rewrite the landing page copy"),
                // A kind this build doesn't know: it must still render, just plainly.
                TranscriptEntry(TranscriptKind.Unknown, "thinking about the value proposition"),
                TranscriptEntry(
                  TranscriptKind.Assistant,
                  "Restructured around the pocket metaphor. Rebuilding the site to check it.",
                ),
              ),
          ),
      )

    fun seed(): List<Workspace> =
      listOf(
        Workspace(
          id = "ws-jubilant",
          name = "jubilant-wombat",
          projectKey = "github.com/getpaseo/paseo",
          projectName = "paseo",
          serverId = MOCK_SERVER,
          agents =
            listOf(
              AgentSession(
                id = "agent-jubilant",
                workspaceId = "ws-jubilant",
                serverId = MOCK_SERVER,
                provider = "Claude",
                state = ActivityState.NeedsInput,
                age = "1m",
                summary =
                  "Branch is ready. I need to push it before opening the change request.",
                pendingPermission =
                  PermissionRequest(
                    id = "perm-1",
                    agentId = "agent-jubilant",
                    title = "Run command?",
                    detail = "git push origin jubilant-wombat",
                  ),
              ),
            ),
        ),
        Workspace(
          id = "ws-crimson",
          name = "crimson-falcon",
          projectKey = "github.com/getpaseo/paseo",
          projectName = "paseo",
          serverId = MOCK_SERVER,
          agents =
            listOf(
              AgentSession(
                id = "agent-crimson",
                workspaceId = "ws-crimson",
                serverId = MOCK_SERVER,
                provider = "Claude",
                state = ActivityState.Running,
                age = "12m",
                summary =
                  "Rewrote the retry loop in relay-transport.ts. Now running the transport " +
                    "tests to verify backoff timing…",
              ),
            ),
        ),
        Workspace(
          id = "ws-main",
          name = "main",
          projectKey = "github.com/getpaseo/website",
          projectName = "website",
          serverId = MOCK_SERVER,
          agents =
            listOf(
              AgentSession(
                id = "agent-main-claude",
                workspaceId = "ws-main",
                serverId = MOCK_SERVER,
                provider = "Claude",
                state = ActivityState.Running,
                age = "3m",
                intent = "docs rewrite",
                summary = "Restructured the landing page copy; rebuilding the site now.",
              ),
              AgentSession(
                id = "agent-main-codex",
                workspaceId = "ws-main",
                serverId = MOCK_SERVER,
                provider = "Codex",
                state = ActivityState.Idle,
                age = "2h",
                summary = "Done — pricing table is responsive at 320px.",
              ),
              AgentSession(
                id = "agent-main-copilot",
                workspaceId = "ws-main",
                serverId = MOCK_SERVER,
                provider = "Copilot",
                state = ActivityState.Idle,
                age = "4h",
                summary = "No changes needed; the redirect config already covers it.",
              ),
            ),
        ),
        Workspace(
          id = "ws-relay",
          name = "relay-tls",
          projectKey = "github.com/getpaseo/paseo-relay",
          projectName = "relay",
          serverId = MOCK_SERVER,
          agents = emptyList(),
        ),
      )
  }
}
