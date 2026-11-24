package com.swmansion.enriched.markdown.spoiler

import android.graphics.Color
import android.graphics.Paint
import android.text.Layout
import android.text.Spanned
import android.view.View
import android.widget.TextView
import com.facebook.react.uimanager.BackgroundStyleApplicator
import com.swmansion.enriched.markdown.spans.SpoilerSpan

class SpoilerDrawContext(
  val textView: TextView,
  val layout: Layout,
  val text: Spanned,
  val spans: Array<SpoilerSpan>,
  val paddingLeft: Float,
  val paddingTop: Float,
  val fontMetrics: Paint.FontMetrics,
  val backgroundColor: Int,
) {
  companion object {
    fun resolveBackgroundColor(textView: TextView): Int {
      var view: View? = textView
      while (view != null) {
        val color = BackgroundStyleApplicator.getBackgroundColor(view)
        if (color != null && Color.alpha(color) > 0) return color
        view = view.parent as? View
      }
      return Color.WHITE
    }
  }
}
