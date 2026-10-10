package sh.paseo.ssh

/** Fences bridge mutations and session startup against teardown, including late background work. */
internal class SshModuleLifecycle<T>(private val close: (T) -> Unit) {
  private val lock = Any()
  private val sessions = mutableMapOf<String, T>()
  private var destroyed = false

  /** Runs credential mutations atomically with teardown. Do not close sessions inside this block. */
  fun <R> withActive(block: () -> R): R = synchronized(lock) {
    check(!destroyed) { "SSH module is closed." }
    block()
  }

  /** Registers and starts together; late or duplicate resources are closed before rejection. */
  fun registerAndStart(id: String, session: T, start: () -> Unit) {
    try {
      withActive {
        check(!sessions.containsKey(id)) { "SSH session already exists." }
        sessions[id] = session
        try {
          start()
        } catch (error: Throwable) {
          sessions.remove(id)
          throw error
        }
      }
    } catch (error: Throwable) {
      close(session)
      throw error
    }
  }

  fun get(id: String): T? = synchronized(lock) { sessions[id] }
  fun remove(id: String): T? = synchronized(lock) { sessions.remove(id) }

  /** A stale close callback must not remove a replacement or an existing duplicate session. */
  fun remove(id: String, expected: T) = synchronized(lock) {
    if (sessions[id] === expected) sessions.remove(id)
    Unit
  }

  /** Invalidates pending work before clearing secrets. Close outside the lock to avoid callback deadlocks. */
  fun destroy(clearCredentials: () -> Unit) {
    val remaining = synchronized(lock) {
      if (destroyed) return
      destroyed = true
      clearCredentials()
      sessions.values.toList().also { sessions.clear() }
    }
    remaining.forEach { close(it) }
  }
}
