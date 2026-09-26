package sh.paseo.androidintents

import android.content.Context
import java.io.File

private const val CATALOG_FILE = "assistant-catalog.json"
private const val MAX_CATALOG_BYTES = 512 * 1024

/**
 * The catalog JavaScript publishes for [AssistantContentProvider]. A plain
 * file so the provider can answer without starting React Native.
 */
object AssistantCatalogStore {
  fun write(context: Context, json: String) {
    val bytes = json.toByteArray(Charsets.UTF_8)
    require(bytes.size <= MAX_CATALOG_BYTES) { "Assistant catalog exceeds $MAX_CATALOG_BYTES bytes" }
    val target = File(context.filesDir, CATALOG_FILE)
    val temp = File(context.filesDir, "$CATALOG_FILE.tmp")
    temp.writeBytes(bytes)
    if (!temp.renameTo(target)) {
      target.writeBytes(bytes)
      temp.delete()
    }
  }

  fun read(context: Context): String? {
    val target = File(context.filesDir, CATALOG_FILE)
    if (!target.isFile) return null
    return target.readText(Charsets.UTF_8)
  }
}
