package com.swmansion.enriched.markdown

/** Size-only cache: no views, spans, Contexts or callbacks survive unmount. */
internal class MeasurementSizeCache(private val capacity: Int = 512) {
  data class Key(val markdown: String, val propsHash: Int, val width: Float, val splitTableSegments: Boolean)

  private val sizes = LinkedHashMap<Key, Long>(16, 0.75f, true)

  @Synchronized
  fun get(key: Key): Long? = sizes[key]

  @Synchronized
  fun put(key: Key, size: Long) {
    sizes[key] = size
    if (sizes.size > capacity) {
      val oldest = sizes.entries.iterator()
      oldest.next()
      oldest.remove()
    }
  }

  @Synchronized
  fun removeMatchingMarkdown(markdown: String) {
    sizes.keys.removeAll { it.markdown == markdown }
  }

  @Synchronized
  fun clear() {
    sizes.clear()
  }
}
