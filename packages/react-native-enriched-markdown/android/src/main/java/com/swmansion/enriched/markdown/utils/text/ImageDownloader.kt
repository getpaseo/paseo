package com.swmansion.enriched.markdown.utils.text

import android.content.Context
import android.graphics.Bitmap
import android.graphics.BitmapFactory
import android.os.Handler
import android.os.Looper
import android.util.Log
import okhttp3.Cache
import okhttp3.Call
import okhttp3.Callback
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import java.io.File
import java.io.IOException
import java.util.concurrent.TimeUnit

object ImageDownloader {
  private const val TAG = "ImageDownloader"
  private const val DISK_CACHE_SIZE = 100L * 1024 * 1024
  private const val TIMEOUT = 15L

  private val mainHandler = Handler(Looper.getMainLooper())

  @Volatile
  private var client: OkHttpClient? = null

  // No disk cache: it keys by URL alone and would mix header sets.
  @Volatile
  private var headerClient: OkHttpClient? = null
  private var maxTargetWidth: Int = 0

  private val inFlight = HashMap<String, MutableList<(Bitmap?) -> Unit>>()

  private fun getClient(context: Context): OkHttpClient =
    client ?: synchronized(this) {
      client ?: buildClient(context).also {
        client = it
        maxTargetWidth = context.applicationContext.resources.displayMetrics.widthPixels
      }
    }

  private fun getHeaderClient(context: Context): OkHttpClient =
    headerClient ?: synchronized(this) {
      headerClient ?: getClient(context)
        .newBuilder()
        .cache(null)
        .build()
        .also { headerClient = it }
    }

  private fun buildClient(context: Context): OkHttpClient {
    val cacheDir = File(context.applicationContext.cacheDir, "enrm_image_cache")
    return OkHttpClient
      .Builder()
      .cache(Cache(cacheDir, DISK_CACHE_SIZE))
      .connectTimeout(TIMEOUT, TimeUnit.SECONDS)
      .readTimeout(TIMEOUT, TimeUnit.SECONDS)
      .build()
  }

  fun download(
    context: Context,
    url: String,
    headers: Map<String, String> = emptyMap(),
    callback: (Bitmap?) -> Unit,
  ) {
    val headers = ImageCache.normalizedHeaders(headers)
    val requestKey = ImageCache.requestKey(url, headers)

    ImageCache.getOriginal(requestKey)?.let {
      callback(it)
      return
    }

    synchronized(inFlight) {
      val existing = inFlight[requestKey]
      if (existing != null) {
        existing.add(callback)
        return
      }
      inFlight[requestKey] = mutableListOf(callback)
    }

    // OkHttp throws on a URL or header it cannot use; report that like any failed download.
    val request =
      try {
        Request
          .Builder()
          .url(url)
          .apply { headers.forEach { (name, value) -> addHeader(name, value) } }
          .build()
      } catch (e: IllegalArgumentException) {
        Log.e(TAG, "Invalid image request: $url", e)
        dispatchCallbacks(requestKey, null)
        return
      }
    val client = if (headers.isEmpty()) getClient(context) else getHeaderClient(context)
    client.newCall(request).enqueue(
      object : Callback {
        override fun onResponse(
          call: Call,
          response: Response,
        ) {
          val bitmap =
            response.use {
              try {
                val bytes = it.body?.bytes() ?: return@use null
                decodeDownsampled(bytes, maxTargetWidth)
              } catch (_: OutOfMemoryError) {
                Log.e(TAG, "OOM decoding image: $url")
                null
              } catch (e: Exception) {
                Log.e(TAG, "Failed to decode image: $url", e)
                null
              }
            }

          bitmap?.let { ImageCache.putOriginal(requestKey, it) }
          dispatchCallbacks(requestKey, bitmap)
        }

        override fun onFailure(
          call: Call,
          e: IOException,
        ) {
          Log.e(TAG, "Failed to download image: $url", e)
          dispatchCallbacks(requestKey, null)
        }
      },
    )
  }

  private fun decodeDownsampled(
    bytes: ByteArray,
    targetWidth: Int,
    maxDimension: Int? = null,
  ): Bitmap? {
    val opts = BitmapFactory.Options().apply { inJustDecodeBounds = true }
    BitmapFactory.decodeByteArray(bytes, 0, bytes.size, opts)
    return decodeWithSampleSize(opts, targetWidth, maxDimension) {
      BitmapFactory.decodeByteArray(bytes, 0, bytes.size, it)
    }
  }

  fun decodeBytesDownsampled(
    context: Context,
    bytes: ByteArray,
    maxDimension: Int? = null,
  ): Bitmap? = decodeDownsampled(bytes, context.resources.displayMetrics.widthPixels, maxDimension)

  fun decodeFileDownsampled(
    context: Context,
    path: String,
    maxDimension: Int? = null,
  ): Bitmap? {
    val targetWidth = context.resources.displayMetrics.widthPixels
    val opts = BitmapFactory.Options().apply { inJustDecodeBounds = true }
    BitmapFactory.decodeFile(path, opts)
    return decodeWithSampleSize(opts, targetWidth, maxDimension) {
      BitmapFactory.decodeFile(path, it)
    }
  }

  private inline fun decodeWithSampleSize(
    opts: BitmapFactory.Options,
    targetWidth: Int,
    maxDimension: Int?,
    decode: (BitmapFactory.Options) -> Bitmap?,
  ): Bitmap? {
    if (opts.outWidth <= 0 || opts.outHeight <= 0) return null
    opts.inSampleSize =
      if (maxDimension == null) {
        calculateInSampleSize(opts.outWidth, targetWidth)
      } else {
        var sample = 1
        val limit = maxDimension.coerceAtLeast(1).toLong()
        while (maxOf(opts.outWidth, opts.outHeight).toLong() > limit * sample) sample *= 2
        sample
      }
    opts.inJustDecodeBounds = false
    return decode(opts)
  }

  private fun calculateInSampleSize(
    srcWidth: Int,
    reqWidth: Int,
  ): Int {
    if (srcWidth in 0..reqWidth) return 1
    return Integer.highestOneBit(srcWidth / reqWidth)
  }

  private fun dispatchCallbacks(
    requestKey: String,
    bitmap: Bitmap?,
  ) {
    val callbacks = synchronized(inFlight) { inFlight.remove(requestKey) } ?: return
    mainHandler.post {
      callbacks.forEach { it(bitmap) }
    }
  }
}
