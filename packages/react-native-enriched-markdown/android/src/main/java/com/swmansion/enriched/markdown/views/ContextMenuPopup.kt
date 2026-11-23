package com.swmansion.enriched.markdown.views

import android.content.Context
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.ColorFilter
import android.graphics.Paint
import android.graphics.PixelFormat
import android.graphics.RectF
import android.graphics.Typeface
import android.graphics.drawable.ColorDrawable
import android.graphics.drawable.Drawable
import android.graphics.drawable.GradientDrawable
import android.util.TypedValue
import android.view.Gravity
import android.view.View
import android.view.View.MeasureSpec
import android.view.ViewGroup
import android.widget.ImageView
import android.widget.LinearLayout
import android.widget.PopupWindow
import android.widget.TextView
import kotlin.math.roundToInt

object ContextMenuPopup {
  private var activePopup: PopupWindow? = null

  fun dismiss() {
    activePopup?.dismiss()
  }

  enum class Icon { COPY, DOCUMENT }

  class Builder internal constructor() {
    internal val items = mutableListOf<MenuItem>()

    fun item(
      icon: Icon,
      label: String,
      onClick: () -> Unit,
    ) {
      items.add(MenuItem(icon, label, onClick))
    }
  }

  internal data class MenuItem(
    val icon: Icon,
    val label: String,
    val onClick: () -> Unit,
  )

  private var density = 1f
  private val Float.dp get() = (this * density).roundToInt()

  fun show(
    anchor: View,
    parent: View,
    block: Builder.() -> Unit,
  ) {
    activePopup?.dismiss()

    val context = anchor.context
    density = context.resources.displayMetrics.density
    val builder = Builder().apply(block)
    if (builder.items.isEmpty()) return

    val container =
      LinearLayout(context).apply {
        orientation = LinearLayout.VERTICAL
        elevation = 12f.dp.toFloat()
        setPadding(4f.dp, 12f.dp, 4f.dp, 12f.dp)
        background =
          GradientDrawable().apply {
            setColor(Color.WHITE)
            cornerRadius = 14f.dp.toFloat()
          }
      }

    builder.items.forEachIndexed { index, item ->
      if (index > 0) container.addView(createDivider(context))
      container.addView(createMenuItemView(context, item))
    }

    val popup =
      PopupWindow(
        container,
        ViewGroup.LayoutParams.WRAP_CONTENT,
        ViewGroup.LayoutParams.WRAP_CONTENT,
        true,
      ).apply {
        elevation = 24f.dp.toFloat()
        isOutsideTouchable = true
        setBackgroundDrawable(ColorDrawable(Color.TRANSPARENT))
        setOnDismissListener {
          activePopup = null
        }
      }

    container.measure(MeasureSpec.UNSPECIFIED, MeasureSpec.UNSPECIFIED)

    val location = IntArray(2).also { anchor.getLocationOnScreen(it) }
    val centerX = location[0] + anchor.width / 2
    val topY = location[1]

    val screenW = context.resources.displayMetrics.widthPixels
    val margin = 8f.dp

    val x =
      (centerX - container.measuredWidth / 2)
        .coerceIn(margin, screenW - container.measuredWidth - margin)
    val y =
      (topY - container.measuredHeight - margin)
        .coerceAtLeast(margin)

    activePopup = popup
    popup.showAtLocation(parent, Gravity.NO_GRAVITY, x, y)
  }

  private fun createMenuItemView(
    context: Context,
    item: MenuItem,
  ) = LinearLayout(context).apply {
    orientation = LinearLayout.HORIZONTAL
    gravity = Gravity.CENTER_VERTICAL
    setPadding(16f.dp, 0, 16f.dp, 0)
    minimumHeight = 48f.dp
    isClickable = true
    isFocusable = true

    val outValue = TypedValue()
    context.theme.resolveAttribute(android.R.attr.selectableItemBackground, outValue, true)
    foreground = context.getDrawable(outValue.resourceId)

    addView(
      ImageView(context).apply {
        setImageDrawable(createIconDrawable(item.icon))
        setColorFilter(Color.parseColor("#333333"))
      },
      LinearLayout.LayoutParams(20f.dp, 20f.dp),
    )

    addView(
      TextView(context).apply {
        text = item.label
        textSize = 16f
        setTextColor(Color.parseColor("#1C1C1E"))
        typeface = Typeface.create("sans-serif-medium", Typeface.NORMAL)
      },
      LinearLayout
        .LayoutParams(
          ViewGroup.LayoutParams.WRAP_CONTENT,
          ViewGroup.LayoutParams.WRAP_CONTENT,
        ).apply { marginStart = 12f.dp },
    )

    setOnClickListener {
      item.onClick()
      dismiss()
    }
  }

  private fun createDivider(context: Context) =
    View(context).apply {
      setBackgroundColor(Color.parseColor("#E5E5EA"))
      layoutParams =
        LinearLayout
          .LayoutParams(
            ViewGroup.LayoutParams.MATCH_PARENT,
            1f.dp.coerceAtLeast(1),
          ).apply {
            setMargins(16f.dp, 0, 16f.dp, 0)
          }
    }

  private fun createIconDrawable(icon: Icon): Drawable =
    object : Drawable() {
      private val paint =
        Paint(Paint.ANTI_ALIAS_FLAG).apply {
          style = Paint.Style.STROKE
          strokeWidth = 1.5f * density
          strokeJoin = Paint.Join.ROUND
          strokeCap = Paint.Cap.ROUND
          color = Color.parseColor("#333333")
        }

      private val copyGlyph = CopyGlyph()

      // COPY mirrors SF Symbol doc.on.doc, DOCUMENT mirrors doc.text; the copy
      // glyph is shared with the header button in CodeBlockContainerView.
      override fun draw(canvas: Canvas) {
        val u = bounds.width() / 24f
        if (icon == Icon.COPY) {
          copyGlyph.draw(canvas, bounds.width().toFloat(), paint)
        } else {
          canvas.drawRoundRect(RectF(5 * u, 3 * u, 19 * u, 21 * u), 2.5f * u, 2.5f * u, paint)
          canvas.drawLine(8.5f * u, 9 * u, 15.5f * u, 9 * u, paint)
          canvas.drawLine(8.5f * u, 12.5f * u, 15.5f * u, 12.5f * u, paint)
          canvas.drawLine(8.5f * u, 16 * u, 13 * u, 16 * u, paint)
        }
      }

      override fun getIntrinsicWidth() = 24f.dp

      override fun getIntrinsicHeight() = 24f.dp

      override fun setAlpha(alpha: Int) {
        paint.alpha = alpha
      }

      override fun setColorFilter(colorFilter: ColorFilter?) {
        paint.colorFilter = colorFilter
      }

      @Deprecated("Deprecated in Java")
      override fun getOpacity() = PixelFormat.TRANSLUCENT
    }
}
