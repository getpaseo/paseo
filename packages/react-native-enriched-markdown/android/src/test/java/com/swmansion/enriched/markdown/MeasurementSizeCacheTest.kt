package com.swmansion.enriched.markdown

import org.junit.Assert.*
import org.junit.Test

class MeasurementSizeCacheTest {
  private fun key(markdown: String = "hello", propsHash: Int = 1, width: Float = 320f) =
    MeasurementSizeCache.Key(markdown, propsHash, width, true)

  @Test fun reusesSizeAcrossIndependentEqualKeys() {
    val cache = MeasurementSizeCache(2)
    cache.put(key(), 42L)
    assertEquals(42L, cache.get(key()))
    assertNull(cache.get(key(propsHash = 2)))
    assertNull(cache.get(key(width = 321f)))
    assertNull(cache.get(key().copy(splitTableSegments = false)))
  }

  @Test fun comparesMarkdownEvenWhenItsHashCollides() {
    val cache = MeasurementSizeCache(2)
    assertEquals("Aa".hashCode(), "BB".hashCode())
    cache.put(key("Aa"), 42L)
    assertNull(cache.get(key("BB")))
  }

  @Test fun evictsLeastRecentlyUsedSize() {
    val cache = MeasurementSizeCache(2)
    cache.put(key("one"), 1L)
    cache.put(key("two"), 2L)
    assertEquals(1L, cache.get(key("one")))
    cache.put(key("three"), 3L)
    assertNull(cache.get(key("two")))
    assertEquals(1L, cache.get(key("one")))
    assertEquals(3L, cache.get(key("three")))
  }

  @Test fun invalidatesAllWidthsAndPropsForChangedContent() {
    val cache = MeasurementSizeCache(4)
    cache.put(key(), 1L)
    cache.put(key(width = 640f), 2L)
    cache.put(key(propsHash = 2), 3L)
    cache.put(key("other"), 4L)
    cache.removeMatchingMarkdown("hello")
    assertNull(cache.get(key()))
    assertNull(cache.get(key(width = 640f)))
    assertNull(cache.get(key(propsHash = 2)))
    assertEquals(4L, cache.get(key("other")))
    cache.clear()
    assertNull(cache.get(key("other")))
  }
}
