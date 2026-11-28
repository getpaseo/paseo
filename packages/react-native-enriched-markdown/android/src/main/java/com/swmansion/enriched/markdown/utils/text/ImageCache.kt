package com.swmansion.enriched.markdown.utils.text

import android.graphics.Bitmap
import android.util.LruCache
import java.security.MessageDigest

object ImageCache {
  private const val ORIGINAL_CACHE_SIZE = 20 * 1024 * 1024
  private const val PROCESSED_CACHE_SIZE = 30 * 1024 * 1024

  private val originalCache = bitmapLruCache(ORIGINAL_CACHE_SIZE)
  private val processedCache = bitmapLruCache(PROCESSED_CACHE_SIZE)

  /** Header names lower-cased; sorted first so case aliases collapse deterministically. */
  fun normalizedHeaders(headers: Map<String, String>): Map<String, String> =
    headers.entries
      .sortedBy { it.key }
      .associate { it.key.lowercase() to it.value }

  /**
   * Cache identity for a remote image request. Returns the URL itself when no
   * headers are set; otherwise appends a SHA-256 digest of the sorted header
   * pairs, so the same URL fetched with different headers is cached and
   * deduplicated separately without embedding header values in the key.
   * Header names are compared case-insensitively.
   */
  fun requestKey(
    url: String,
    headers: Map<String, String>,
  ): String {
    if (headers.isEmpty()) return url
    val joined =
      normalizedHeaders(headers)
        .entries
        .sortedBy { it.key }
        .joinToString(separator = "\n") { "${it.key}:${it.value}" }
    val digest = MessageDigest.getInstance("SHA-256").digest(joined.toByteArray())
    return url + "|" + digest.joinToString(separator = "") { "%02x".format(it) }
  }

  fun getOriginal(url: String): Bitmap? = originalCache.get(url)

  fun putOriginal(
    url: String,
    bitmap: Bitmap,
  ) {
    originalCache.put(url, bitmap)
  }

  fun getProcessed(
    url: String,
    width: Int,
    height: Int,
    borderRadius: Int,
    resizeMode: String,
  ): Bitmap? = processedCache.get(processedKey(url, width, height, borderRadius, resizeMode))

  fun putProcessed(
    url: String,
    width: Int,
    height: Int,
    borderRadius: Int,
    resizeMode: String,
    bitmap: Bitmap,
  ) {
    processedCache.put(processedKey(url, width, height, borderRadius, resizeMode), bitmap)
  }

  private fun processedKey(
    url: String,
    width: Int,
    height: Int,
    borderRadius: Int,
    resizeMode: String,
  ): String = "${url}_w${width}_h${height}_r${borderRadius}_m$resizeMode"

  // A minimum per-entry cost bounds entry count as well as decoded bytes.
  internal fun bitmapLruCache(
    maxSize: Int,
    maxEntries: Int = Int.MAX_VALUE,
  ): LruCache<String, Bitmap> =
    object : LruCache<String, Bitmap>(maxSize) {
      override fun sizeOf(
        key: String,
        value: Bitmap,
      ): Int = value.allocationByteCount.coerceAtLeast(((maxSize.toLong() + maxEntries - 1) / maxEntries).toInt())
    }
}
