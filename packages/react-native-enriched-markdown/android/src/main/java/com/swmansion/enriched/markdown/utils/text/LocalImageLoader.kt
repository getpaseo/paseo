package com.swmansion.enriched.markdown.utils.text

import android.content.Context
import android.graphics.Bitmap
import android.net.Uri
import android.util.Base64
import android.util.Log
import java.io.FileNotFoundException
import java.io.InputStream

/**
 * Loads markdown images from non-network sources (issue #377).
 *
 * React Native's asset system produces different URI shapes for the same
 * `require('./img.png')` depending on environment, and none of them are plain
 * file paths in a bundled app:
 * - Metro dev server: `http://host:8081/assets/...` (handled by [ImageDownloader])
 * - Release APK: a bare drawable resource name, e.g. `src_assets_logo`
 *   (RN's `AssetSourceResolver.resourceIdentifierWithoutScale`)
 * - Sideloaded JS bundle: `file:///.../drawable-xhdpi/src_assets_logo.png`
 * - expo-updates embedded assets: `file:///android_res/drawable/<name>.png`
 * - expo-asset downloads: percent-encoded `file://` paths in the cache dir
 *
 * Resolution mirrors RN core: `ImageSource.computeUri` treats a scheme-less
 * source as a resource name, and `ResourceDrawableIdHelper` normalizes names
 * by lowercasing, replacing `-` with `_`, and accepting numeric resource ids. The
 * `android_res`/`android_asset` and drawable/raw lookups follow expo-asset's
 * `ResourceAsset.kt`. `content://`, `asset://`, `res://` and `data:` URIs are
 * supported for parity with RN's Fresco pipeline. All decodes are downsampled
 * to screen width like the network path.
 */
object LocalImageLoader {
  private const val TAG = "LocalImageLoader"
  private const val ASSET_PATH_PREFIX = "/android_asset/"
  private const val RES_PATH_PREFIX = "/android_res/"
  private const val BASE64_MARKER = "base64,"

  fun load(
    context: Context,
    source: String,
    maxDimension: Int? = null,
  ): Bitmap? =
    try {
      val uri = Uri.parse(source)
      when (uri.scheme?.lowercase()) {
        null -> {
          if (source.startsWith('/')) {
            ImageDownloader.decodeFileDownsampled(context, source, maxDimension)
          } else {
            decodeResourceByName(context, source, maxDimension)
          }
        }

        "file" -> {
          loadFileUri(context, uri, maxDimension)
        }

        "asset" -> {
          decodeStream(context, maxDimension) { context.assets.open(schemelessPath(uri)) }
        }

        "content" -> {
          decodeStream(context, maxDimension) {
            context.contentResolver.openInputStream(uri) ?: throw FileNotFoundException(source)
          }
        }

        "res" -> {
          decodeResourceByName(context, schemelessPath(uri), maxDimension)
        }

        "data" -> {
          decodeDataUri(context, source, maxDimension)
        }

        else -> {
          Log.w(TAG, "Unsupported image URI scheme: $source")
          null
        }
      }
    } catch (_: OutOfMemoryError) {
      Log.e(TAG, "OOM loading local image: $source")
      null
    } catch (e: Exception) {
      Log.w(TAG, "Failed to load local image: $source", e)
      null
    }

  private fun loadFileUri(
    context: Context,
    uri: Uri,
    maxDimension: Int?,
  ): Bitmap? {
    val path = uri.path ?: return null
    return when {
      path.startsWith(ASSET_PATH_PREFIX) -> {
        decodeStream(context, maxDimension) { context.assets.open(path.removePrefix(ASSET_PATH_PREFIX)) }
      }

      path.startsWith(RES_PATH_PREFIX) -> {
        decodeAndroidRes(context, uri, maxDimension)
      }

      else -> {
        ImageDownloader.decodeFileDownsampled(context, path, maxDimension)
      }
    }
  }

  /**
   * Resolves `file:///android_res/<dir>[-qualifier]/<file>[.<ext>]` by stripping
   * density qualifiers and the file extension, then looking the resource up by name.
   */
  private fun decodeAndroidRes(
    context: Context,
    uri: Uri,
    maxDimension: Int?,
  ): Bitmap? {
    val segments = uri.pathSegments
    if (segments.size < 3) return null
    val directory = segments[1].substringBefore('-')
    val name = segments[2].substringBeforeLast('.')
    val resId = context.resources.getIdentifier(name, directory, context.packageName)
    if (resId == 0) {
      Log.w(TAG, "No $directory resource named: $name")
      return null
    }
    return decodeStream(context, maxDimension) { context.resources.openRawResource(resId) }
  }

  private fun decodeResourceByName(
    context: Context,
    name: String,
    maxDimension: Int?,
  ): Bitmap? {
    if (name.isEmpty()) return null
    val normalized = name.lowercase().replace('-', '_')
    val resId =
      normalized.toIntOrNull()
        ?: context.resources.getIdentifier(normalized, "drawable", context.packageName).takeIf { it != 0 }
        ?: context.resources.getIdentifier(normalized, "raw", context.packageName)
    if (resId == 0) {
      Log.w(TAG, "No drawable or raw resource named: $normalized")
      return null
    }
    return decodeStream(context, maxDimension) { context.resources.openRawResource(resId) }
  }

  private fun decodeDataUri(
    context: Context,
    source: String,
    maxDimension: Int?,
  ): Bitmap? {
    val marker = source.indexOf(BASE64_MARKER)
    if (marker == -1) return null
    val bytes = Base64.decode(source.substring(marker + BASE64_MARKER.length), Base64.DEFAULT)
    return ImageDownloader.decodeBytesDownsampled(context, bytes, maxDimension)
  }

  private inline fun decodeStream(
    context: Context,
    maxDimension: Int?,
    open: () -> InputStream,
  ): Bitmap? = open().use { ImageDownloader.decodeBytesDownsampled(context, it.readBytes(), maxDimension) }

  private fun schemelessPath(uri: Uri): String = (uri.host.orEmpty() + uri.path.orEmpty()).trimStart('/')
}
