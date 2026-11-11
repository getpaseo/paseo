package sh.paseo.keyboard

// A modal can forward the same physical event into the activity window. Keep
// observation outside that nested delivery, without retaining recycled KeyEvents.
internal class WindowKeyDispatcher<Event : Any> {
  private val delivering = java.util.Collections.newSetFromMap(java.util.IdentityHashMap<Event, Boolean>())
  fun dispatch(event: Event, observe: () -> Boolean, deliver: () -> Boolean): Boolean {
    if (!delivering.add(event)) return deliver()
    return try { observe() || deliver() } finally { delivering.remove(event) }
  }
}
