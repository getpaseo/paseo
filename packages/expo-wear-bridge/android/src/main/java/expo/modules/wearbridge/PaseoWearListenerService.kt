package expo.modules.wearbridge

import android.content.Context
import android.util.Log
import com.google.android.gms.wearable.MessageEvent
import com.google.android.gms.wearable.WearableListenerService
import java.io.File

private const val TAG = "ExpoWearBridge"

/**
 * Receives watch -> phone messages.
 *
 * Play Services starts this service even when the app process is dead, which is the
 * whole reason it exists. But a dead process means there is no JS runtime to hand
 * the command to, and spinning up React Native headlessly just to deliver one
 * message is slow and unreliable.
 *
 * So: if JS is listening, deliver immediately. If not, persist to [CommandQueue] and
 * let the app drain it on next start. That means a command sent while the phone app
 * is killed takes effect when the app is next opened rather than immediately —
 * a real limitation, documented in packages/watch/README.md, and the reason the
 * watch UI reports send failures rather than pretending success.
 */
class PaseoWearListenerService : WearableListenerService() {
  override fun onMessageReceived(event: MessageEvent) {
    when (event.path) {
      COMMAND_PATH -> {
        val payload = String(event.data)
        if (!WearCommandBus.deliver(payload)) {
          Log.i(TAG, "No JS listener; queueing wear command")
          CommandQueue.add(applicationContext, payload)
        }
      }
      REFRESH_PATH -> {
        // The watch is asking for a fresh snapshot. If JS is up it can answer; if
        // not, the app republishes on next start anyway, so there's nothing to queue.
        WearCommandBus.deliver(REFRESH_SENTINEL)
      }
      else -> Log.d(TAG, "Ignoring message on ${event.path}")
    }
  }

  companion object {
    const val COMMAND_PATH = "/paseo/command"
    const val REFRESH_PATH = "/paseo/refresh"

    /** Sentinel the JS side recognises as "republish now". */
    const val REFRESH_SENTINEL = "{\"kind\":\"refresh\"}"
  }
}

/**
 * Single hop between the listener service and the JS module.
 *
 * Both live in the same process when the app is alive, so a plain object reference
 * is enough; no IPC, no broadcast.
 */
object WearCommandBus {
  private var listener: ((String) -> Unit)? = null

  @Synchronized
  fun setListener(next: ((String) -> Unit)?) {
    listener = next
  }

  /** Returns false when nothing is listening, so the caller can persist instead. */
  @Synchronized
  fun deliver(payload: String): Boolean {
    val target = listener ?: return false
    target(payload)
    return true
  }
}

/**
 * Disk-backed queue for commands that arrived with no JS runtime.
 *
 * One JSON object per line. Capped, and the cap drops the OLDEST entries: if a
 * backlog builds up, the most recent instruction is the one worth keeping.
 */
object CommandQueue {
  private const val FILE_NAME = "paseo-wear-commands.jsonl"
  private const val MAX_ENTRIES = 32

  private fun file(context: Context) = File(context.filesDir, FILE_NAME)

  @Synchronized
  fun add(context: Context, payload: String) {
    runCatching {
      val target = file(context)
      val existing = if (target.exists()) target.readLines() else emptyList()
      val next = (existing + payload.replace("\n", " ")).takeLast(MAX_ENTRIES)
      target.writeText(next.joinToString("\n"))
    }.onFailure { Log.w(TAG, "Failed to queue wear command", it) }
  }

  @Synchronized
  fun drain(context: Context): List<String> {
    val target = file(context)
    if (!target.exists()) return emptyList()
    return runCatching {
      val lines = target.readLines().filter { it.isNotBlank() }
      target.delete()
      lines
    }.onFailure { Log.w(TAG, "Failed to drain wear commands", it) }.getOrDefault(emptyList())
  }
}
