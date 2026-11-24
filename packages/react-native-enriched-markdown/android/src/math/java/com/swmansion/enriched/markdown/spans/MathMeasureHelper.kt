package com.swmansion.enriched.markdown.spans

import android.content.Context
import android.util.Log
import io.ratex.RaTeXEngine
import io.ratex.RaTeXFontLoader
import io.ratex.RaTeXRenderer

object MathMeasureHelper {
  @JvmStatic
  fun measure(
    context: Context,
    requests: List<MathMeasureRequest>,
  ): List<MathMetrics> {
    if (requests.isEmpty()) return emptyList()

    RaTeXFontLoader.ensureLoaded(context)

    return requests.map { request ->
      runCatching { measureSingle(context, request) }.getOrElse { estimateFallback(request) }
    }
  }

  private fun measureSingle(
    context: Context,
    request: MathMeasureRequest,
  ): MathMetrics {
    val displayList =
      RaTeXEngine.parseBlocking(
        request.latex,
        displayMode = request.mode == MathRenderMode.Display,
      )

    val renderer =
      RaTeXRenderer(displayList, request.fontSize) {
        RaTeXFontLoader.getTypeface(it)
      }

    return MathMetrics(
      renderer.widthPx.toInt(),
      renderer.heightPx,
      renderer.depthPx,
    )
  }

  private fun estimateFallback(request: MathMeasureRequest): MathMetrics {
    val h = request.fontSize * 1.4f
    return MathMetrics(
      width =
        (request.fontSize * request.latex.length * 0.5f)
          .coerceIn(request.fontSize, request.fontSize * 20f)
          .toInt(),
      ascent = h * 0.7f,
      descent = h * 0.3f,
    )
  }
}
