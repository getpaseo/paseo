package sh.paseo.trace

import android.content.ContentUris
import android.content.ContentValues
import android.content.Context
import android.net.Uri
import android.provider.MediaStore
import java.io.OutputStream

internal class DownloadsLogStorage(private val context: Context, private val session: String) : LogStorage {
  private val resolver = context.contentResolver
  private val collection = MediaStore.Downloads.EXTERNAL_CONTENT_URI
  private val directory = "Download/Paseo diagnostics/"

  override fun create(part: Int): String {
    val values = ContentValues().apply {
      put(MediaStore.MediaColumns.DISPLAY_NAME, "paseo-diagnostics-${System.currentTimeMillis()}-${session.take(8)}-$part.jsonl")
      put(MediaStore.MediaColumns.MIME_TYPE, "application/x-ndjson")
      put(MediaStore.MediaColumns.RELATIVE_PATH, directory)
    }
    return checkNotNull(resolver.insert(collection, values)).toString()
  }

  override fun append(id: String): OutputStream =
    checkNotNull(resolver.openOutputStream(Uri.parse(id), "wa")).buffered(64 * 1024)

  override fun newest(): List<String> = buildList {
    resolver.query(collection, arrayOf(MediaStore.MediaColumns._ID),
      "${MediaStore.MediaColumns.RELATIVE_PATH} = ? AND ${MediaStore.MediaColumns.OWNER_PACKAGE_NAME} = ?",
      arrayOf(directory, context.packageName), "${MediaStore.MediaColumns._ID} DESC")?.use { cursor ->
      while (cursor.moveToNext()) add(ContentUris.withAppendedId(collection, cursor.getLong(0)).toString())
    }
  }

  override fun delete(id: String) { resolver.delete(Uri.parse(id), null, null) }
}
