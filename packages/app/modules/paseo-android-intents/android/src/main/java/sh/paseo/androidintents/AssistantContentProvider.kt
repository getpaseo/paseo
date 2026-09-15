package sh.paseo.androidintents

import android.content.ContentProvider
import android.content.ContentValues
import android.content.Context
import android.content.pm.ProviderInfo
import android.database.Cursor
import android.database.MatrixCursor
import android.net.Uri
import android.os.CancellationSignal
import org.json.JSONArray
import org.json.JSONException
import org.json.JSONObject

private const val DEFAULT_LIMIT = 25
private const val MAX_LIMIT = 100
private const val CALLER_PACKAGE_PREFIX = "com.colonelpanic.eva"

private val WORKSPACE_COLUMNS =
  listOf("id", "serverId", "name", "project", "branch", "status", "agentCount", "lastActivityAt")
private val AGENT_COLUMNS =
  listOf("id", "serverId", "workspaceId", "name", "provider", "status", "lastActivityAt")
private val INT_COLUMNS = setOf("agentCount")

/**
 * Read-only view of the catalog [AssistantCatalogStore] holds, for on-device
 * assistants that can query a content provider but not run code here.
 * `content://<authority>/workspaces?q=&limit=` and
 * `/agents?workspaceId=&q=&limit=`; the authority is declared by the app's
 * config plugin so a debug build can install beside a release build. Only
 * query parameters filter: a SQL selection is refused rather than ignored.
 */
class AssistantContentProvider : ContentProvider() {
  private var authority: String = ""

  override fun attachInfo(context: Context, info: ProviderInfo) {
    super.attachInfo(context, info)
    authority = info.authority
  }

  override fun onCreate(): Boolean = true

  override fun getType(uri: Uri): String? =
    when (uri.pathSegments.singleOrNull()) {
      "workspaces" -> "vnd.android.cursor.dir/vnd.$authority.workspace"
      "agents" -> "vnd.android.cursor.dir/vnd.$authority.agent"
      else -> null
    }

  override fun query(
    uri: Uri,
    projection: Array<String>?,
    selection: String?,
    selectionArgs: Array<String>?,
    sortOrder: String?,
    cancellationSignal: CancellationSignal?,
  ): Cursor = query(uri, projection, selection, selectionArgs, sortOrder)

  override fun query(
    uri: Uri,
    projection: Array<String>?,
    selection: String?,
    selectionArgs: Array<String>?,
    sortOrder: String?,
  ): Cursor {
    val caller = callingPackage
    if (caller == null || !(caller == CALLER_PACKAGE_PREFIX || caller.startsWith("$CALLER_PACKAGE_PREFIX."))) {
      throw SecurityException("Caller is not an allowed assistant")
    }
    require(uri.authority == authority) { "Unknown authority ${uri.authority}" }
    require(selection.isNullOrEmpty() && selectionArgs.isNullOrEmpty()) {
      "Filter with query parameters; selections are not supported"
    }
    require(sortOrder.isNullOrEmpty()) { "Sorting is fixed to most recent activity" }
    val table = uri.pathSegments.singleOrNull()
    val columns =
      when (table) {
        "workspaces" -> WORKSPACE_COLUMNS
        "agents" -> AGENT_COLUMNS
        else -> throw IllegalArgumentException("Unknown table ${uri.path}")
      }
    val requested = projection?.toList() ?: columns
    val unknown = requested.filterNot { it in columns }
    require(unknown.isEmpty()) { "Unknown columns ${unknown.joinToString()}" }

    val limit = parseLimit(uri.getQueryParameter("limit"))
    val query = uri.getQueryParameter("q")?.trim()?.lowercase()?.ifEmpty { null }
    val workspaceId = uri.getQueryParameter("workspaceId")?.trim()?.ifEmpty { null }
    require(table == "agents" || workspaceId == null) { "workspaceId only filters agents" }

    val catalog = readCatalog()
    val rows =
      catalog?.optJSONArray(table).toList().filter { row ->
        (workspaceId == null || row.optString("workspaceId") == workspaceId) &&
          (query == null || columns.any { column -> row.optString(column).lowercase().contains(query) })
      }
    val cursor = MatrixCursor(requested.toTypedArray(), minOf(rows.size, limit))
    for (row in rows.take(limit)) {
      cursor.addRow(
        requested.map { column ->
          when {
            column in INT_COLUMNS -> row.optInt(column)
            row.isNull(column) -> null
            else -> row.optString(column)
          }
        },
      )
    }
    return cursor
  }

  private fun parseLimit(raw: String?): Int {
    if (raw == null) return DEFAULT_LIMIT
    val limit = raw.toIntOrNull()
    require(limit != null && limit in 1..MAX_LIMIT) { "limit must be 1..$MAX_LIMIT" }
    return limit
  }

  private fun readCatalog(): JSONObject? {
    val context = context ?: return null
    val json = AssistantCatalogStore.read(context) ?: return null
    return try {
      JSONObject(json)
    } catch (_: JSONException) {
      null
    }
  }

  private fun JSONArray?.toList(): List<JSONObject> {
    if (this == null) return emptyList()
    return (0 until length()).mapNotNull { optJSONObject(it) }
  }

  override fun insert(uri: Uri, values: ContentValues?): Uri? = throw UnsupportedOperationException("read-only")

  override fun update(uri: Uri, values: ContentValues?, selection: String?, selectionArgs: Array<String>?): Int =
    throw UnsupportedOperationException("read-only")

  override fun delete(uri: Uri, selection: String?, selectionArgs: Array<String>?): Int =
    throw UnsupportedOperationException("read-only")
}
