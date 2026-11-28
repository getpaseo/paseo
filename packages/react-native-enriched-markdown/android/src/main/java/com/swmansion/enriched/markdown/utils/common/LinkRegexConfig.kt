package com.swmansion.enriched.markdown.utils.common

import java.util.regex.Pattern
import java.util.regex.PatternSyntaxException

/** A regex sent from JS. Equal configs share compiled patterns. */
data class LinkRegexConfig(
  val pattern: String,
  val caseInsensitive: Boolean,
  val dotAll: Boolean,
  val isDisabled: Boolean,
  val isDefault: Boolean,
) {
  private val isActive: Boolean
    get() = !isDisabled && !isDefault && pattern.isNotEmpty()

  /** Null when inactive or invalid. */
  val compiled: Pattern?
    get() = if (isActive) compiledPattern(pattern, flags) else null

  /** Anchored to the whole string, for inline-code spans. */
  val compiledWholeSpan: Pattern?
    get() = if (isActive) compiledPattern("\\A(?:$pattern)\\z", flags) else null

  private val flags: Int
    get() = (if (caseInsensitive) Pattern.CASE_INSENSITIVE else 0) or (if (dotAll) Pattern.DOTALL else 0)

  private companion object {
    private const val MAX_CACHED_PATTERNS = 64
    private val invalid = Pattern.compile("(?!)")

    // Bounded LRU keyed by flags and source.
    private val cache =
      object : LinkedHashMap<String, Pattern>(MAX_CACHED_PATTERNS, 0.75f, true) {
        override fun removeEldestEntry(eldest: MutableMap.MutableEntry<String, Pattern>): Boolean = size > MAX_CACHED_PATTERNS
      }

    @Synchronized
    fun compiledPattern(
      source: String,
      flags: Int,
    ): Pattern? {
      val key = "$flags\u0000$source"
      val cached = cache[key]
      if (cached != null) return cached.takeUnless { it === invalid }
      val compiled =
        try {
          Pattern.compile(source, flags)
        } catch (_: PatternSyntaxException) {
          invalid
        }
      cache[key] = compiled
      return compiled.takeUnless { it === invalid }
    }
  }
}
