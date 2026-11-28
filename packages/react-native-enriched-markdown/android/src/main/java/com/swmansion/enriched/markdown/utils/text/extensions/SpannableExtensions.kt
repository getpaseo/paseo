package com.swmansion.enriched.markdown.utils.text.extensions

import android.content.Context
import android.text.Spannable
import android.text.SpannableStringBuilder
import android.util.Log
import com.swmansion.enriched.markdown.spans.MathMeasureRequest
import com.swmansion.enriched.markdown.spans.MathMetrics
import com.swmansion.enriched.markdown.utils.common.FeatureFlags

fun SpannableStringBuilder.isInlineImage(): Boolean {
  if (isEmpty()) return false
  val lastChar = last()
  return lastChar != '\n' && lastChar != '\u200B'
}

/** Swaps MathInlineSpans for MathInlinePlaceholderSpans safe for background-thread measurement. */
fun Spannable.replaceMathSpansWithPlaceholders(context: Context) {
  if (!FeatureFlags.IS_MATH_ENABLED) return

  try {
    val spanClass = Class.forName("com.swmansion.enriched.markdown.spans.MathInlineSpan")
    val placeholderClass = Class.forName("com.swmansion.enriched.markdown.spans.MathInlinePlaceholderSpan")

    val mathSpans = getSpans(0, length, spanClass)
    if (mathSpans.isNullOrEmpty()) return

    val fontSizeField = spanClass.getDeclaredField("fontSize").apply { isAccessible = true }
    val latexField = spanClass.getDeclaredField("latex").apply { isAccessible = true }

    val requests =
      mathSpans.map { span ->
        MathMeasureRequest(
          fontSize = fontSizeField.getFloat(span),
          latex = latexField.get(span) as String,
        )
      }

    val mathMeasureHelperClass = Class.forName("com.swmansion.enriched.markdown.spans.MathMeasureHelper")
    val measureMethod = mathMeasureHelperClass.getMethod("measure", Context::class.java, List::class.java)

    @Suppress("UNCHECKED_CAST")
    val results = measureMethod.invoke(null, context, requests) as? List<MathMetrics> ?: return

    val placeholderCtor = placeholderClass.getConstructor(MathMetrics::class.java)

    mathSpans.forEachIndexed { i, oldSpan ->
      val metrics = results.getOrNull(i) ?: return@forEachIndexed

      val start = getSpanStart(oldSpan)
      val end = getSpanEnd(oldSpan)
      val flags = getSpanFlags(oldSpan)

      if (start != -1 && end != -1) {
        removeSpan(oldSpan)
        val newSpan = placeholderCtor.newInstance(metrics)
        setSpan(newSpan, start, end, flags)
      }
    }
  } catch (_: ClassNotFoundException) {
    // Expected if the module isn't linked; silent return
  } catch (e: Exception) {
    Log.e("MathSpan", "Failed to replace math spans", e)
  }
}
