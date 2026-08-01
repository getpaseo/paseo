package sh.paseo.watch.data

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import sh.paseo.watch.model.LiveVoiceHost
import sh.paseo.watch.model.LiveVoicePhase
import sh.paseo.watch.model.LiveVoiceState
import sh.paseo.watch.model.liveVoiceErrorMessage
import sh.paseo.watch.model.liveVoiceUnavailableMessage

/**
 * Pins the Live Voice half of the watch/phone contract, the same way
 * [WearBridgeTest] pins the snapshot half. The phone's producer is
 * packages/app/src/wear/wear-live-voice.ts; nothing generated keeps the two in
 * sync, so this is what should fail when that file changes shape.
 */
class LiveVoiceWireTest {

  private val phoneJson =
    """
    {
      "v": 1,
      "updatedAt": 1750000000000,
      "phase": "active",
      "serverId": "srv-1",
      "hostLabel": "workstation",
      "isMuted": false,
      "hosts": [
        { "serverId": "srv-1", "label": "workstation" },
        { "serverId": "srv-2", "label": "laptop" }
      ],
      "unavailableReason": null,
      "transcripts": [
        { "id": "t1", "role": "user", "text": "What's running?" },
        { "id": "t2", "role": "assistant", "text": "Three sessions." }
      ],
      "errorCode": null,
      "errorMessage": null,
      "closedCause": null
    }
    """
      .trimIndent()

  @Test
  fun `decodes a phone live voice item`() {
    val state = decodeLiveVoice(phoneJson)!!.toLiveVoiceState()

    assertEquals(LiveVoicePhase.Active, state.phase)
    assertEquals("srv-1", state.serverId)
    assertEquals("workstation", state.hostLabel)
    assertFalse(state.isMuted)
    assertTrue(state.isLive)
    assertEquals(listOf("workstation", "laptop"), state.hosts.map { it.label })
    // Two callable hosts is exactly the case where the screen must show a picker
    // rather than a single start button.
    assertNull(state.soleHost)

    assertEquals(2, state.transcripts.size)
    assertTrue(state.transcripts[0].fromUser)
    assertFalse(state.transcripts[1].fromUser)
    assertEquals("Three sessions.", state.transcripts[1].text)
  }

  @Test
  fun `an unknown phase degrades to idle rather than claiming a call`() {
    // Idle is the safe default: it offers to start a call rather than showing a
    // hang-up button for a call this build cannot reason about.
    val state = decodeLiveVoice(phoneJson.replace("\"active\"", "\"reconnecting\""))!!
      .toLiveVoiceState()
    assertEquals(LiveVoicePhase.Idle, state.phase)
    assertFalse(state.isLive)
  }

  @Test
  fun `rejects a live voice item from a protocol version we do not speak`() {
    assertNull(decodeLiveVoice(phoneJson.replace("\"v\": 1", "\"v\": 99")))
  }

  @Test
  fun `rejects malformed json instead of throwing`() {
    assertNull(decodeLiveVoice("{ not json"))
  }

  @Test
  fun `tolerates unknown fields from a newer phone build`() {
    val state = decodeLiveVoice(phoneJson.replace("\"isMuted\": false", "\"isMuted\": false, \"volume\": 3"))
    assertEquals(LiveVoicePhase.Active, state!!.toLiveVoiceState().phase)
  }

  @Test
  fun `an idle item with no hosts is the unavailable state, not an error`() {
    val json =
      """
      { "v": 1, "phase": "idle", "hosts": [], "unavailableReason": "hosts_offline" }
      """
        .trimIndent()
    val state = decodeLiveVoice(json)!!.toLiveVoiceState()

    assertEquals(LiveVoicePhase.Idle, state.phase)
    assertTrue(state.hosts.isEmpty())
    assertNull(state.errorCode)
    assertEquals("No host is online", liveVoiceUnavailableMessage(state.unavailableReason))
  }

  @Test
  fun `blank transcript entries are dropped as rendering artifacts`() {
    val json =
      """
      {
        "v": 1, "phase": "active",
        "transcripts": [
          { "id": "t1", "role": "assistant", "text": "  " },
          { "id": "t2", "role": "assistant", "text": "Done." }
        ]
      }
      """
        .trimIndent()
    val state = decodeLiveVoice(json)!!.toLiveVoiceState()
    assertEquals(listOf("t2"), state.transcripts.map { it.id })
  }

  @Test
  fun `a single callable host needs no picker`() {
    val state = LiveVoiceState.Unknown.copy(hosts = listOf(LiveVoiceHost("srv-1", "workstation")))
    assertEquals("srv-1", state.soleHost?.serverId)
  }

  @Test
  fun `unknown reasons and codes fall back rather than showing a raw string`() {
    // The daemon's code sets stay open on the wire, so a watch that predates a
    // code must still say something true.
    assertEquals("Live Voice is unavailable", liveVoiceUnavailableMessage("quota_exhausted"))
    assertEquals("the phone said so", liveVoiceErrorMessage("brand_new_code", "the phone said so"))
    assertEquals("Call failed", liveVoiceErrorMessage("brand_new_code", null))
    assertEquals("The phone's mic is in use", liveVoiceErrorMessage("mic_busy", null))
  }

  @Test
  fun `startLiveVoice names a host and the other two deliberately do not`() {
    val start = WireCommand(kind = WireCommand.START_LIVE_VOICE, serverId = "srv-1")
    assertEquals(
      """{"v":1,"kind":"startLiveVoice","serverId":"srv-1","agentId":null,""" +
        """"workspaceId":null,"requestId":null,"text":null,"allow":null}""",
      WearBridge.json.encodeToString(WireCommand.serializer(), start),
    )

    // No serverId: the phone's runtime owns the single active call and already
    // knows which host it is on, so a stale item here can't address the wrong one.
    val stop = WireCommand(kind = WireCommand.STOP_LIVE_VOICE)
    assertTrue(
      WearBridge.json
        .encodeToString(WireCommand.serializer(), stop)
        .contains("\"serverId\":null"),
    )
  }

  @Test
  fun `live voice commands round trip`() {
    for (kind in
      listOf(
        WireCommand.START_LIVE_VOICE,
        WireCommand.STOP_LIVE_VOICE,
        WireCommand.TOGGLE_LIVE_VOICE_MUTE,
      )) {
      val command = WireCommand(kind = kind, serverId = "srv-1")
      val encoded = WearBridge.json.encodeToString(WireCommand.serializer(), command)
      assertEquals(command, WearBridge.json.decodeFromString(WireCommand.serializer(), encoded))
      assertTrue(encoded.contains("\"kind\":\"$kind\""))
    }
  }

  @Test
  fun `the live voice path is a single item, not a prefix`() {
    assertEquals("/paseo/livevoice", WearBridge.LIVE_VOICE_PATH)
    // Must not collide with the snapshot's suffix match, which is how both are
    // dispatched in DataLayerRepository.
    assertFalse(WearBridge.LIVE_VOICE_PATH.endsWith(WearBridge.SNAPSHOT_PATH))
    assertFalse(WearBridge.SNAPSHOT_PATH.endsWith(WearBridge.LIVE_VOICE_PATH))
  }
}
