package sh.paseo.watch.data

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import sh.paseo.watch.model.ActivityState
import sh.paseo.watch.model.TranscriptKind
import sh.paseo.watch.model.WorkspaceDestination
import sh.paseo.watch.model.destination
import sh.paseo.watch.model.sortedForWrist
import sh.paseo.watch.model.summaryLine
import sh.paseo.watch.model.workspaceByIdentity

/**
 * The watch/phone wire contract has no generated code keeping the two halves in
 * sync, so these tests pin the exact JSON the phone is expected to produce. If
 * packages/app/src/wear/wear-protocol.ts changes shape, this is what should fail.
 */
class WearBridgeTest {

  private val phoneJson =
    """
    {
      "v": 1,
      "updatedAt": 1750000000000,
      "workspaces": [
        {
          "id": "ws-1",
          "name": "jubilant-wombat",
          "projectKey": "github.com/getpaseo/paseo",
          "projectName": "paseo",
          "serverId": "srv-1",
          "agents": [
            {
              "id": "a-1",
              "provider": "Claude",
              "state": "needsInput",
              "age": "1m",
              "summary": "Branch is ready.",
              "permission": {
                "id": "perm-1",
                "title": "Run command?",
                "detail": "git push origin jubilant-wombat"
              }
            }
          ]
        },
        {
          "id": "ws-2",
          "name": "main",
          "projectKey": "github.com/getpaseo/website",
          "projectName": "website",
          "serverId": "srv-1",
          "agents": [
            { "id": "a-2", "provider": "Claude", "state": "running", "age": "3m", "intent": "docs" },
            { "id": "a-3", "provider": "Codex", "state": "idle", "age": "2h" }
          ]
        },
        {
          "id": "ws-3",
          "name": "relay-tls",
          "projectKey": "github.com/getpaseo/paseo-relay",
          "projectName": "relay",
          "serverId": "srv-1",
          "agents": []
        }
      ]
    }
    """.trimIndent()

  @Test
  fun `decodes a phone snapshot into workspaces`() {
    val snapshot = decodeSnapshot(phoneJson)
    requireNotNull(snapshot)
    val workspaces = snapshot.toWorkspaces()

    assertEquals(3, workspaces.size)

    val first = workspaces[0]
    assertEquals("jubilant-wombat", first.name)
    assertEquals("paseo", first.projectName)
    assertEquals("srv-1", first.serverId)
    assertEquals(ActivityState.NeedsInput, first.state)

    val agent = first.agents.single()
    // serverId must propagate from workspace to agent, or commands can't be routed.
    assertEquals("srv-1", agent.serverId)
    assertEquals("perm-1", agent.pendingPermission?.id)
    assertEquals("git push origin jubilant-wombat", agent.pendingPermission?.detail)
  }

  @Test
  fun `unknown state degrades to idle rather than inventing urgency`() {
    val json = phoneJson.replace("\"needsInput\"", "\"some_future_state\"")
    val workspaces = decodeSnapshot(json)!!.toWorkspaces()
    assertEquals(ActivityState.Idle, workspaces[0].agents.single().state)
  }

  @Test
  fun `rejects a snapshot from a protocol version we do not speak`() {
    assertNull(decodeSnapshot(phoneJson.replace("\"v\": 1", "\"v\": 2")))
  }

  @Test
  fun `rejects malformed json instead of throwing`() {
    assertNull(decodeSnapshot("{ not json"))
    assertNull(decodeSnapshot(""))
  }

  @Test
  fun `tolerates unknown fields from a newer phone build`() {
    val json = phoneJson.replace("\"id\": \"ws-1\",", "\"id\": \"ws-1\", \"somethingNew\": 42,")
    assertEquals(3, decodeSnapshot(json)!!.toWorkspaces().size)
  }

  @Test
  fun `navigation rule skips the picker for single-agent workspaces`() {
    val workspaces = decodeSnapshot(phoneJson)!!.toWorkspaces()

    // Pending permission wins over everything else.
    val permission = workspaces[0].destination()
    assertTrue(permission is WorkspaceDestination.Permission)
    assertEquals("srv-1", (permission as WorkspaceDestination.Permission).serverId)
    assertEquals("a-1", permission.agentId)

    // Two agents, nothing urgent -> the picker is the only correct destination.
    val picker = workspaces[1].destination()
    assertTrue(picker is WorkspaceDestination.Picker)
    assertEquals("srv-1", (picker as WorkspaceDestination.Picker).serverId)
    assertEquals("ws-2", picker.workspaceId)

    // Empty workspace -> straight to dictating a prompt.
    val newAgent = workspaces[2].destination()
    assertTrue(newAgent is WorkspaceDestination.NewAgent)
    assertEquals("srv-1", (newAgent as WorkspaceDestination.NewAgent).serverId)
    assertEquals("ws-3", newAgent.workspaceId)
  }

  @Test
  fun `single agent workspace routes straight to the agent`() {
    val workspaces = decodeSnapshot(phoneJson)!!.toWorkspaces()
    // Drop the permission so the single-agent path is the one under test.
    val ws =
      workspaces[0].copy(
        agents = workspaces[0].agents.map { it.copy(pendingPermission = null) },
      )
    val destination = ws.destination()
    assertTrue(destination is WorkspaceDestination.Agent)
    assertEquals("srv-1", (destination as WorkspaceDestination.Agent).serverId)
    assertEquals("a-1", destination.agentId)
  }

  @Test
  fun `workspace identity includes its server`() {
    val first = decodeSnapshot(phoneJson)!!.toWorkspaces().first()
    val sameIdOnAnotherServer = first.copy(serverId = "srv-2", name = "other daemon")

    val selected = listOf(first, sameIdOnAnotherServer).workspaceByIdentity("srv-2", first.id)

    assertEquals("srv-2", selected?.serverId)
    assertEquals("other daemon", selected?.name)
  }

  @Test
  fun `summary line reads as the single agent or an aggregate`() {
    val workspaces = decodeSnapshot(phoneJson)!!.toWorkspaces()
    assertEquals("Claude · needs approval", workspaces[0].summaryLine())
    assertEquals("2 agents · 1 running", workspaces[1].summaryLine())
    assertEquals("no agents · tap to start", workspaces[2].summaryLine())
  }

  @Test
  fun `sort puts needs-attention first and idle last`() {
    val sorted = decodeSnapshot(phoneJson)!!.toWorkspaces().sortedForWrist()
    assertEquals(listOf("jubilant-wombat", "main", "relay-tls"), sorted.map { it.name })
  }

  // -------------------------------------------------------------------------
  // Transcript
  // -------------------------------------------------------------------------

  private val transcriptJson =
    """
    {
      "v": 1,
      "agentId": "agent-1",
      "serverId": "srv-1",
      "updatedAt": 1738000000000,
      "entries": [
        {"kind": "user", "text": "Fix the tests"},
        {"kind": "tool", "text": "Bash: git push origin main"},
        {"kind": "assistant", "text": "Pushed. CI is running."},
        {"kind": "error", "text": "Turn failed: rate limited"}
      ],
      "truncated": false
    }
    """.trimIndent()

  @Test
  fun `decodes a transcript with every known entry kind`() {
    val wire = decodeTranscript(transcriptJson)
    requireNotNull(wire)
    assertEquals("agent-1", wire.agentId)
    assertEquals("srv-1", wire.serverId)
    assertEquals(1738000000000L, wire.updatedAt)

    val transcript = wire.toTranscript()
    assertEquals("agent-1", transcript.agentId)
    assertFalse(transcript.truncated)
    // Order is load-bearing: the screen renders oldest to newest and opens at the end.
    assertEquals(
      listOf(
        TranscriptKind.User,
        TranscriptKind.Tool,
        TranscriptKind.Assistant,
        TranscriptKind.Error,
      ),
      transcript.entries.map { it.kind },
    )
    assertEquals("Bash: git push origin main", transcript.entries[1].text)
  }

  @Test
  fun `an unknown entry kind degrades to Unknown rather than vanishing`() {
    val json = transcriptJson.replace("\"kind\": \"tool\"", "\"kind\": \"reasoning\"")
    val transcript = decodeTranscript(json)!!.toTranscript()
    // Still four entries: losing the text would leave a hole in the conversation.
    assertEquals(4, transcript.entries.size)
    assertEquals(TranscriptKind.Unknown, transcript.entries[1].kind)
    assertEquals("Bash: git push origin main", transcript.entries[1].text)
  }

  @Test
  fun `rejects a transcript from a protocol version we do not speak`() {
    assertNull(decodeTranscript(transcriptJson.replace("\"v\": 1", "\"v\": 2")))
  }

  @Test
  fun `rejects malformed transcript json instead of throwing`() {
    assertNull(decodeTranscript("{ not json"))
    assertNull(decodeTranscript(""))
    assertNull(decodeTranscript("[]"))
  }

  @Test
  fun `an empty transcript is valid, not an error`() {
    val json = transcriptJson.replace(Regex("\"entries\": \\[[^]]*]"), "\"entries\": []")
    val transcript = decodeTranscript(json)!!.toTranscript()
    assertTrue(transcript.entries.isEmpty())
    assertEquals("agent-1", transcript.agentId)
  }

  @Test
  fun `truncated marks that history exists before the first entry`() {
    val json = transcriptJson.replace("\"truncated\": false", "\"truncated\": true")
    assertTrue(decodeTranscript(json)!!.toTranscript().truncated)
  }

  @Test
  fun `blank entries are dropped as rendering artifacts`() {
    val json = transcriptJson.replace("\"text\": \"Pushed. CI is running.\"", "\"text\": \"   \"")
    assertEquals(3, decodeTranscript(json)!!.toTranscript().entries.size)
  }

  @Test
  fun `transcript path is per server scoped agent under the shared prefix`() {
    assertEquals("/paseo/transcript/srv-1/agent-1", WearBridge.transcriptPath("srv-1", "agent-1"))
    assertTrue(WearBridge.transcriptPath("srv-1", "agent-1").startsWith(WearBridge.TRANSCRIPT_PATH_PREFIX))
  }

  @Test
  fun `requestTranscript encodes to exactly what the phone parses`() {
    val command =
      WireCommand(
        kind = WireCommand.REQUEST_TRANSCRIPT,
        serverId = "srv-1",
        agentId = "agent-1",
      )
    // encodeDefaults = true, so the unused optionals go out as explicit nulls. That
    // is already what every other command emits, and the phone's parser reads fields
    // by name with a type check — a null is simply "absent" to it.
    assertEquals(
      """{"v":1,"kind":"requestTranscript","serverId":"srv-1","agentId":"agent-1",""" +
        """"workspaceId":null,"requestId":null,"text":null,"allow":null}""",
      WearBridge.json.encodeToString(WireCommand.serializer(), command),
    )
  }

  @Test
  fun `commands round trip`() {
    val command =
      WireCommand(
        kind = WireCommand.RESPOND_PERMISSION,
        serverId = "srv-1",
        agentId = "a-1",
        requestId = "perm-1",
        allow = true,
      )
    val encoded = WearBridge.json.encodeToString(WireCommand.serializer(), command)
    val decoded = WearBridge.json.decodeFromString(WireCommand.serializer(), encoded)
    assertEquals(command, decoded)
    // The phone reads these keys by name; keep them stable.
    assertTrue(encoded.contains("\"kind\":\"respondPermission\""))
    assertTrue(encoded.contains("\"allow\":true"))
  }
}
