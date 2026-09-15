package sh.paseo.androidintents

import android.content.Context
import android.content.Intent
import android.net.Uri
import android.provider.OpenableColumns
import androidx.core.content.IntentCompat
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.io.File
import java.util.UUID

private const val EVENT_INTENT = "onIntent"
private const val MAX_FILES = 16
private const val MAX_FILE_BYTES = 25L * 1024 * 1024
private const val MAX_TEXT_LENGTH = 100_000
private const val SHARED_DIR = "shared-intents"

/**
 * Hands share-sheet and PROCESS_TEXT intents to JavaScript. Expo's linking
 * layer only sees ACTION_VIEW data URIs, so these have to be read off the
 * activity intent here.
 */
class PaseoAndroidIntentsModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("PaseoAndroidIntents")

    Events(EVENT_INTENT)

    OnNewIntent { intent ->
      val payload = extract(intent) ?: return@OnNewIntent
      sendEvent(EVENT_INTENT, payload)
    }

    Function("consumeLaunchIntent") {
      val intent = appContext.currentActivity?.intent ?: return@Function null
      extract(intent)
    }
  }

  private fun requireContext(): Context =
    appContext.reactContext ?: throw IllegalStateException("React context is not available")

  private fun extract(intent: Intent): Map<String, Any?>? {
    val payload =
      when (intent.action) {
        Intent.ACTION_SEND, Intent.ACTION_SEND_MULTIPLE -> extractShare(intent)
        Intent.ACTION_PROCESS_TEXT -> extractProcessText(intent)
        else -> null
      } ?: return null
    // The activity keeps the intent across recreation and React Native re-reads
    // it on reload; strip it so one share never becomes two prompts.
    intent.action = Intent.ACTION_MAIN
    intent.replaceExtras(null as android.os.Bundle?)
    intent.clipData = null
    intent.type = null
    return payload
  }

  private fun extractShare(intent: Intent): Map<String, Any?> {
    val text = intent.getCharSequenceExtra(Intent.EXTRA_TEXT)?.toString()?.take(MAX_TEXT_LENGTH)
    val subject = intent.getStringExtra(Intent.EXTRA_SUBJECT)?.take(MAX_TEXT_LENGTH)
    val uris = collectStreamUris(intent)
    val files = mutableListOf<Map<String, Any?>>()
    var skipped = uris.size - minOf(uris.size, MAX_FILES)
    for (uri in uris.take(MAX_FILES)) {
      val copied = copyImage(uri)
      if (copied == null) {
        skipped += 1
      } else {
        files.add(copied)
      }
    }
    return mapOf(
      "kind" to "share",
      "text" to text,
      "subject" to subject,
      "files" to files,
      "skippedFiles" to skipped,
    )
  }

  private fun extractProcessText(intent: Intent): Map<String, Any?> =
    mapOf(
      "kind" to "process_text",
      "text" to intent.getCharSequenceExtra(Intent.EXTRA_PROCESS_TEXT)?.toString()?.take(MAX_TEXT_LENGTH),
    )

  private fun collectStreamUris(intent: Intent): List<Uri> {
    val uris = linkedSetOf<Uri>()
    if (intent.action == Intent.ACTION_SEND_MULTIPLE) {
      IntentCompat.getParcelableArrayListExtra(intent, Intent.EXTRA_STREAM, Uri::class.java)
        ?.filterNotNull()
        ?.let(uris::addAll)
    } else {
      IntentCompat.getParcelableExtra(intent, Intent.EXTRA_STREAM, Uri::class.java)?.let(uris::add)
    }
    val clip = intent.clipData
    if (clip != null) {
      for (index in 0 until clip.itemCount) {
        clip.getItemAt(index).uri?.let(uris::add)
      }
    }
    return uris.toList()
  }

  /**
   * Copies a shared content URI into the app cache. Only content URIs (the
   * grant Android attaches to the share) and image types are accepted; the
   * composer has nowhere to upload other files before a host is chosen.
   */
  private fun copyImage(uri: Uri): Map<String, Any?>? {
    if (uri.scheme != "content") return null
    val context = requireContext()
    val resolver = context.contentResolver
    val mimeType = resolver.getType(uri)?.lowercase() ?: return null
    if (!mimeType.startsWith("image/")) return null

    var displayName: String? = null
    var size: Long? = null
    resolver.query(uri, arrayOf(OpenableColumns.DISPLAY_NAME, OpenableColumns.SIZE), null, null, null)?.use { cursor ->
      if (cursor.moveToFirst()) {
        val nameIndex = cursor.getColumnIndex(OpenableColumns.DISPLAY_NAME)
        if (nameIndex >= 0 && !cursor.isNull(nameIndex)) displayName = cursor.getString(nameIndex)
        val sizeIndex = cursor.getColumnIndex(OpenableColumns.SIZE)
        if (sizeIndex >= 0 && !cursor.isNull(sizeIndex)) size = cursor.getLong(sizeIndex)
      }
    }
    if ((size ?: 0L) > MAX_FILE_BYTES) return null

    val fileName = sanitizeFileName(displayName, mimeType)
    val directory = File(File(context.cacheDir, SHARED_DIR), UUID.randomUUID().toString())
    if (!directory.mkdirs()) return null
    val target = File(directory, fileName)
    return try {
      val written =
        resolver.openInputStream(uri)?.use { input ->
          target.outputStream().use { output -> copyBounded(input, output) }
        } ?: return null
      if (written < 0) {
        target.delete()
        return null
      }
      mapOf(
        "uri" to Uri.fromFile(target).toString(),
        "mimeType" to mimeType,
        "fileName" to fileName,
        "size" to written,
      )
    } catch (error: Exception) {
      target.delete()
      null
    }
  }

  /** Returns bytes written, or -1 when the stream exceeded the size cap. */
  private fun copyBounded(input: java.io.InputStream, output: java.io.OutputStream): Long {
    val buffer = ByteArray(64 * 1024)
    var total = 0L
    while (true) {
      val read = input.read(buffer)
      if (read < 0) return total
      total += read
      if (total > MAX_FILE_BYTES) return -1
      output.write(buffer, 0, read)
    }
  }

  private fun sanitizeFileName(displayName: String?, mimeType: String): String {
    val cleaned = displayName?.substringAfterLast('/')?.replace(Regex("[^A-Za-z0-9._-]"), "_")?.trim('.', '_')
    if (!cleaned.isNullOrEmpty()) return cleaned.take(120)
    val extension =
      when (mimeType) {
        "image/png" -> "png"
        "image/gif" -> "gif"
        "image/webp" -> "webp"
        else -> "jpg"
      }
    return "shared-image.$extension"
  }
}
