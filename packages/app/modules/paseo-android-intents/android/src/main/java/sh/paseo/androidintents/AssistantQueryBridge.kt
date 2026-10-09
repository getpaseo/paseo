package sh.paseo.androidintents

import java.util.UUID
import java.util.concurrent.ArrayBlockingQueue
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.TimeUnit

/**
 * Carries one assistant query from a binder thread to JavaScript and back.
 * The message table has to be live, and only the running app can reach the
 * daemon, so [AssistantContentProvider] parks its binder thread here until
 * JavaScript answers or the wait runs out.
 */
object AssistantQueryBridge {
  private val pending = ConcurrentHashMap<String, ArrayBlockingQueue<String>>()

  @Volatile
  private var dispatch: ((String, Map<String, Any?>) -> Unit)? = null

  fun setDispatch(handler: ((String, Map<String, Any?>) -> Unit)?) {
    dispatch = handler
  }

  /** Null when JavaScript is not listening, cannot be reached, or runs out of time. */
  fun request(params: Map<String, Any?>, timeoutMs: Long): String? {
    val handler = dispatch ?: return null
    val requestId = UUID.randomUUID().toString()
    val answers = ArrayBlockingQueue<String>(1)
    pending[requestId] = answers
    return try {
      handler(requestId, params)
      answers.poll(timeoutMs, TimeUnit.MILLISECONDS)
    } catch (_: InterruptedException) {
      Thread.currentThread().interrupt()
      null
    } catch (_: Exception) {
      null
    } finally {
      pending.remove(requestId)
    }
  }

  fun resolve(requestId: String, json: String) {
    pending[requestId]?.offer(json)
  }
}
