package sh.paseo.watch.data

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Test
import sh.paseo.watch.model.ActivityState
import sh.paseo.watch.model.AgentSession
import sh.paseo.watch.model.Transcript
import sh.paseo.watch.model.TranscriptEntry
import sh.paseo.watch.model.TranscriptKind
import sh.paseo.watch.model.Workspace

/**
 * The transcript cache's two rules. Both exist because of a race or a leak that is
 * invisible in normal use: the startup scan overtaking the live listener, and a map
 * that only ever grows.
 */
class TranscriptCacheTest {

  private fun transcript(agentId: String, updatedAt: Long) =
    Transcript(
      agentId = agentId,
      updatedAt = updatedAt,
      entries = listOf(TranscriptEntry(TranscriptKind.Assistant, "at $updatedAt")),
    )

  private fun workspace(id: String, vararg agentIds: String) =
    Workspace(
      id = id,
      name = id,
      projectKey = "github.com/getpaseo/paseo",
      projectName = "paseo",
      serverId = "srv-1",
      agents =
        agentIds.map {
          AgentSession(
            id = it,
            workspaceId = id,
            serverId = "srv-1",
            provider = "Claude",
            state = ActivityState.Idle,
            age = "1m",
          )
        },
    )

  @Test
  fun `the first transcript for an agent always applies`() {
    assertTrue(shouldApplyTranscript(held = null, incoming = transcript("a-1", 100)))
  }

  @Test
  fun `a newer transcript replaces the one held`() {
    assertTrue(
      shouldApplyTranscript(held = transcript("a-1", 100), incoming = transcript("a-1", 200)),
    )
  }

  @Test
  fun `a stale cached transcript cannot clobber a fresher one`() {
    // The exact startup race: loadCachedDataItems reads an old DataItem while the
    // live listener has already delivered a newer one.
    assertFalse(
      shouldApplyTranscript(held = transcript("a-1", 200), incoming = transcript("a-1", 100)),
    )
  }

  @Test
  fun `an equal timestamp still applies`() {
    // Same timestamp means same content, so re-applying is free — and it keeps the
    // rule from depending on which copy happened to arrive first.
    assertTrue(
      shouldApplyTranscript(held = transcript("a-1", 100), incoming = transcript("a-1", 100)),
    )
  }

  @Test
  fun `pruning keeps only agents the snapshot still lists`() {
    val cache =
      mapOf(
        "srv-1\u0000a-1" to transcript("a-1", 100),
        "srv-1\u0000a-2" to transcript("a-2", 100),
        "srv-1\u0000gone" to transcript("gone", 100),
      )
    val kept = cache.retainingAgentsIn(listOf(workspace("ws-1", "a-1"), workspace("ws-2", "a-2")))
    assertEquals(setOf("srv-1\u0000a-1", "srv-1\u0000a-2"), kept.keys)
  }

  @Test
  fun `an empty snapshot prunes everything`() {
    val cache = mapOf("a-1" to transcript("a-1", 100))
    assertTrue(cache.retainingAgentsIn(emptyList()).isEmpty())
    // A workspace that lost all its agents is the same case.
    assertTrue(cache.retainingAgentsIn(listOf(workspace("ws-1"))).isEmpty())
  }

  @Test
  fun `pruning an unchanged agent set keeps every entry`() {
    val cache =
      mapOf(
        "srv-1\u0000a-1" to transcript("a-1", 100),
        "srv-1\u0000a-2" to transcript("a-2", 100),
      )
    val kept = cache.retainingAgentsIn(listOf(workspace("ws-1", "a-1", "a-2")))
    assertEquals(cache, kept)
  }

  @Test
  fun `pruning an empty cache is a no-op`() {
    assertTrue(emptyMap<String, Transcript>().retainingAgentsIn(listOf(workspace("ws-1", "a-1"))).isEmpty())
  }
}
