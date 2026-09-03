package sh.paseo.watch.data

import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test
import sh.paseo.watch.model.ActivityState
import sh.paseo.watch.model.AgentSession
import sh.paseo.watch.model.Workspace

/**
 * The icon cache's three rules: which paths are icon paths, which payloads are worth
 * decoding, and when an icon stops being worth keeping.
 *
 * All three are the parts of the icon stream that fail silently — a path that misses
 * gives a project no icon forever, and an SVG that gets stored costs a decode attempt
 * for every frame it is drawn.
 */
class IconCacheTest {

  private fun workspace(id: String, projectKey: String) =
    Workspace(
      id = id,
      name = id,
      projectKey = projectKey,
      projectName = projectKey.substringAfterLast('/'),
      serverId = "srv-1",
      agents =
        listOf(
          AgentSession(
            id = "$id-agent",
            workspaceId = id,
            serverId = "srv-1",
            provider = "Claude",
            state = ActivityState.Idle,
            age = "1m",
          ),
        ),
    )

  private fun png(vararg tail: Int): ByteArray =
    byteArrayOf(0x89.toByte(), 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A) +
      tail.map { it.toByte() }.toByteArray()

  @Test
  fun `an icon path yields the still-encoded project key`() {
    // The real shape: wear://<nodeId>/paseo/icon/<Uri.encode(projectKey)>. The node
    // id is why this cannot be a prefix strip.
    assertEquals(
      "github.com%2Fgetpaseo%2Fpaseo",
      encodedProjectKeyFromIconPath("/paseo/icon/github.com%2Fgetpaseo%2Fpaseo"),
    )
  }

  @Test
  fun `the encoded key is returned verbatim, not decoded here`() {
    // Decoding is Uri.decode's job in the repository; doing it here would be a
    // second, subtly different codec from the phone's Uri.encode.
    assertEquals("a%20b", encodedProjectKeyFromIconPath("/paseo/icon/a%20b"))
  }

  @Test
  fun `the other data layer paths are not icon paths`() {
    assertNull(encodedProjectKeyFromIconPath("/paseo/snapshot"))
    assertNull(encodedProjectKeyFromIconPath("/paseo/transcript/agent-1"))
  }

  @Test
  fun `an icon path with no key is not an icon path`() {
    // A bare directory item carries nothing to key a cache entry on.
    assertNull(encodedProjectKeyFromIconPath("/paseo/icon/"))
    assertNull(encodedProjectKeyFromIconPath("/paseo/icon"))
  }

  @Test
  fun `bitmap formats BitmapFactory can decode are accepted`() {
    assertTrue(isRenderableIconPayload(png(1, 2, 3, 4)))
    assertTrue(isRenderableIconPayload(byteArrayOf(0xFF.toByte(), 0xD8.toByte(), 0xFF.toByte()) + ByteArray(20)))
    assertTrue(isRenderableIconPayload("GIF89a".toByteArray() + ByteArray(20)))
    assertTrue(isRenderableIconPayload("RIFF????WEBPVP8 ".toByteArray()))
  }

  @Test
  fun `SVG is rejected — BitmapFactory cannot decode it`() {
    // The daemon accepts image/svg+xml as a project icon, so this arrives in
    // practice. Rejecting it here means the UI sees "no icon", which has a fallback.
    assertFalse(isRenderableIconPayload("<svg xmlns=\"http://www.w3.org/2000/svg\"/>".toByteArray()))
    assertFalse(isRenderableIconPayload("<?xml version=\"1.0\"?><svg/>".toByteArray()))
  }

  @Test
  fun `ICO is rejected`() {
    assertFalse(isRenderableIconPayload(byteArrayOf(0x00, 0x00, 0x01, 0x00) + ByteArray(20)))
  }

  @Test
  fun `empty, absent, and too-short payloads are rejected`() {
    assertFalse(isRenderableIconPayload(null))
    assertFalse(isRenderableIconPayload(ByteArray(0)))
    // A truncated PNG header can't even be classified, let alone decoded.
    assertFalse(isRenderableIconPayload(byteArrayOf(0x89.toByte(), 0x50, 0x4E)))
  }

  @Test
  fun `a RIFF container that is not WEBP is rejected`() {
    assertFalse(isRenderableIconPayload("RIFF????WAVEfmt ".toByteArray()))
  }

  @Test
  fun `pruning keeps only projects the snapshot still lists`() {
    val cache =
      mapOf(
        "github.com/getpaseo/paseo" to png(),
        "github.com/getpaseo/website" to png(),
        "github.com/getpaseo/gone" to png(),
      )
    val kept =
      cache.retainingProjectsIn(
        listOf(
          workspace("ws-1", "github.com/getpaseo/paseo"),
          workspace("ws-2", "github.com/getpaseo/website"),
        ),
      )
    assertEquals(setOf("github.com/getpaseo/paseo", "github.com/getpaseo/website"), kept.keys)
  }

  @Test
  fun `two workspaces sharing a project keep the one icon`() {
    // Icons are per project, workspaces are per branch: the common case is several
    // workspaces mapping to a single cache entry.
    val cache = mapOf("github.com/getpaseo/paseo" to png())
    val kept =
      cache.retainingProjectsIn(
        listOf(
          workspace("ws-1", "github.com/getpaseo/paseo"),
          workspace("ws-2", "github.com/getpaseo/paseo"),
        ),
      )
    assertEquals(cache, kept)
  }

  @Test
  fun `an empty snapshot prunes everything`() {
    assertTrue(mapOf("github.com/getpaseo/paseo" to png()).retainingProjectsIn(emptyList()).isEmpty())
  }

  @Test
  fun `pruning an empty cache is a no-op`() {
    assertTrue(
      emptyMap<String, ByteArray>()
        .retainingProjectsIn(listOf(workspace("ws-1", "github.com/getpaseo/paseo")))
        .isEmpty(),
    )
  }
}
