package com.swmansion.enriched.markdown.spans

import android.content.Context
import android.graphics.Bitmap
import android.net.Uri
import android.os.SystemClock
import android.util.LruCache
import androidx.annotation.VisibleForTesting
import androidx.core.graphics.scale
import com.swmansion.enriched.markdown.utils.text.ImageCache
import com.swmansion.enriched.markdown.utils.text.ImageDownloader
import com.swmansion.enriched.markdown.utils.text.LocalImageLoader
import java.io.File
import kotlin.math.max

/**
 * Original-color pill icon thumbnails, bounded by count and decoded bytes. Local
 * sources decode synchronously through the library's local resolver; remote ones go
 * through the shared image downloader and arrive later.
 */
internal object LinkPillIconCache {
  // Icons are drawn at the label's font size, so they need few pixels. Local sources
  // are sampled down by the decoder in powers of two; downloads are scaled once.
  private const val LOCAL_MAX_DIMENSION = 512
  private const val REMOTE_MAX_DIMENSION = 256

  // Every render asks for the same icons again. A local source is trusted for this
  // long before its file is stat'ed (or a failed decode retried); a failed download
  // is not retried sooner than the remote window.
  private const val LOCAL_REVALIDATE_MS = 1_000L
  private const val REMOTE_RETRY_MS = 30_000L

  private val images = ImageCache.bitmapLruCache(8 * 1024 * 1024, 64)
  private val sources = LruCache<String, Source>(256)

  private class Source(
    val imageKey: String,
    val checkedAt: Long,
    val failed: Boolean,
    val isFile: Boolean = false,
  )

  /** Replaceable so unit tests never touch the network. */
  @VisibleForTesting
  internal var remoteLoader: (Context, String, Map<String, String>, (Bitmap?) -> Unit) -> Unit = ImageDownloader::download

  @VisibleForTesting
  internal var clock: () -> Long = SystemClock::uptimeMillis

  fun isRemote(iconUri: String): Boolean =
    iconUri.startsWith("http://", ignoreCase = true) || iconUri.startsWith("https://", ignoreCase = true)

  /** Synchronously resolves a local icon; null for remote, empty and unreadable sources. */
  @Synchronized
  fun load(
    context: Context,
    iconUri: String,
  ): Bitmap? {
    if (iconUri.isEmpty() || isRemote(iconUri)) return null
    val key = localKey(context, iconUri)
    val now = clock()
    val known = sources.get(key)
    // File-backed and failed sources are re-checked once the window passes.
    if (known != null && ((!known.isFile && !known.failed) || now - known.checkedAt < LOCAL_REVALIDATE_MS)) {
      if (known.failed) return null
      images.get(known.imageKey)?.let { return it }
    }

    // Only a real file can change underneath its URI; asset, resource, content and
    // data sources keep one entry.
    val file = localFile(iconUri)?.takeIf { it.isFile }
    val imageKey = if (file != null) "$key|${file.lastModified()}|${file.length()}" else key
    val bitmap =
      images.get(imageKey)
        ?: runCatching { LocalImageLoader.load(context, iconUri, maxDimension = LOCAL_MAX_DIMENSION) }
          .getOrNull()
          ?.also { images.put(imageKey, it) }
    sources.put(key, Source(imageKey, now, failed = bitmap == null, isFile = file != null))
    return bitmap
  }

  fun hasFailedRecently(
    iconUri: String,
    headers: Map<String, String>,
  ): Boolean =
    synchronized(this) {
      val known = sources.get(remoteKey(iconUri, headers))
      known != null && known.failed && clock() - known.checkedAt < REMOTE_RETRY_MS
    }

  private fun remoteKey(
    iconUri: String,
    headers: Map<String, String>,
  ) = "remote|" + ImageCache.requestKey(iconUri, headers)

  /**
   * Returns the cached remote icon, or null after starting a download that reports
   * through [onLoaded] on the main thread, with null when the download fails. [onLoaded]
   * can also run before this returns when the downloader already holds the image.
   */
  fun loadRemote(
    context: Context,
    iconUri: String,
    headers: Map<String, String>,
    onLoaded: (Bitmap?) -> Unit,
  ): Bitmap? {
    val key = remoteKey(iconUri, headers)
    synchronized(this) {
      images.get(key)?.let { return it }
      val known = sources.get(key)
      if (known != null && known.failed && clock() - known.checkedAt < REMOTE_RETRY_MS) return null
    }
    remoteLoader(context, iconUri, headers) { downloaded ->
      val icon =
        synchronized(this) {
          // Every pill waiting for this download gets the same thumbnail.
          val shared = images.get(key) ?: downloaded?.let { thumbnail(it) }?.also { images.put(key, it) }
          sources.put(key, Source(key, clock(), failed = shared == null))
          shared
        }
      onLoaded(icon)
    }
    return null
  }

  private fun thumbnail(bitmap: Bitmap): Bitmap {
    val longest = max(bitmap.width, bitmap.height)
    if (longest <= REMOTE_MAX_DIMENSION) return bitmap
    val ratio = REMOTE_MAX_DIMENSION.toFloat() / longest
    return bitmap.scale((bitmap.width * ratio).toInt().coerceAtLeast(1), (bitmap.height * ratio).toInt().coerceAtLeast(1))
  }

  // Data URIs can be large: key them by a cheap fingerprint instead of retaining
  // (or digesting) the whole payload on every render.
  private fun localKey(
    context: Context,
    iconUri: String,
  ): String {
    val source =
      if (iconUri.startsWith("data:", ignoreCase = true)) {
        "data|${iconUri.length}|${iconUri.hashCode()}|${iconUri.takeLast(32)}"
      } else {
        iconUri
      }
    return "${context.packageName}|$source"
  }

  private fun localFile(iconUri: String): File? =
    when {
      iconUri.startsWith('/') -> File(iconUri)
      iconUri.startsWith("file:", ignoreCase = true) -> Uri.parse(iconUri).path?.let { File(it) }
      else -> null
    }
}
