package sh.paseo.watch.data

import sh.paseo.watch.model.Workspace

/**
 * Policy for the watch's per-project icon cache.
 *
 * Same shape and same reason as [TranscriptCache][shouldApplyTranscript]: these are
 * the parts with edge cases worth pinning, and [DataLayerRepository] cannot be
 * instantiated without Play Services, so anything living inside it is only reachable
 * from an on-device test.
 *
 * Icons are raw image file bytes straight off the project repo, so nothing here can
 * assume the payload is even an image — see [isRenderableIconPayload].
 */

/**
 * The still-encoded projectKey from an icon DataItem path, or null if this is not
 * an icon path.
 *
 * DataItem URIs are `wear://<nodeId>/paseo/icon/<encoded>`, so the node id has to be
 * skipped by searching for the marker rather than by stripping a fixed prefix. The
 * decode itself stays with the caller: `Uri.decode` is the exact inverse of the
 * phone's `Uri.encode`, and re-implementing percent-decoding here to make it pure
 * would be a second, subtly different codec.
 */
fun encodedProjectKeyFromIconPath(path: String): String? {
  val marker = "${WearBridge.ICON_PATH_PREFIX}/"
  val start = path.indexOf(marker)
  if (start < 0) return null
  return path.substring(start + marker.length).ifEmpty { null }
}

/**
 * Whether these bytes are worth handing to `BitmapFactory`.
 *
 * The daemon accepts `image/png`, `image/jpeg`, `image/svg+xml` and `image/x-icon`
 * as project icons, and Android's `BitmapFactory` decodes neither SVG nor most ICOs.
 * Rejecting those here rather than at draw time keeps the cache holding only bytes
 * that can actually become a bitmap, so "no icon" and "an icon we can't draw" are
 * the same state by the time the UI sees them — one colored-initial fallback, no
 * second code path.
 *
 * Magic numbers, not the declared mime type: the mime comes from the phone's guess
 * at a file extension, and a `.png` that is really an SVG is a real thing to find in
 * a repo. Truncated or corrupt files still get through this and fail in
 * `BitmapFactory`, which returns null — that fallback stays.
 */
fun isRenderableIconPayload(bytes: ByteArray?): Boolean {
  if (bytes == null || bytes.size < MIN_IMAGE_HEADER) return false
  return bytes.startsWith(PNG_MAGIC) ||
    bytes.startsWith(JPEG_MAGIC) ||
    bytes.startsWith(GIF_MAGIC) ||
    bytes.startsWith(BMP_MAGIC) ||
    (bytes.startsWith(RIFF_MAGIC) && bytes.startsWith(WEBP_MAGIC, offset = 8))
}

/**
 * Keep only the icons whose project still appears in [workspaces].
 *
 * Same rationale as transcript pruning: without it the map holds an image for every
 * project ever seen for as long as the app lives. Icons are capped at 32 KB by the
 * phone, so this is a bounded leak rather than a dangerous one — but the snapshot is
 * authoritative about which projects exist, so there is no reason to keep the rest.
 */
fun Map<String, ByteArray>.retainingProjectsIn(
  workspaces: List<Workspace>,
): Map<String, ByteArray> {
  if (isEmpty()) return this
  val live = workspaces.mapTo(mutableSetOf()) { it.projectKey }
  return filterKeys { it in live }
}

private val PNG_MAGIC = byteArrayOf(0x89.toByte(), 0x50, 0x4E, 0x47, 0x0D, 0x0A, 0x1A, 0x0A)
private val JPEG_MAGIC = byteArrayOf(0xFF.toByte(), 0xD8.toByte(), 0xFF.toByte())
private val GIF_MAGIC = "GIF8".toByteArray(Charsets.US_ASCII)
private val BMP_MAGIC = "BM".toByteArray(Charsets.US_ASCII)
private val RIFF_MAGIC = "RIFF".toByteArray(Charsets.US_ASCII)
private val WEBP_MAGIC = "WEBP".toByteArray(Charsets.US_ASCII)

/** Enough bytes for the longest header checked above (`RIFF????WEBP`). */
private const val MIN_IMAGE_HEADER = 12

private fun ByteArray.startsWith(magic: ByteArray, offset: Int = 0): Boolean {
  if (size < offset + magic.size) return false
  return magic.indices.all { this[offset + it] == magic[it] }
}
