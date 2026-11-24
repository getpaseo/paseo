package com.swmansion.enriched.markdown.spans

import android.content.Context
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import android.graphics.Path
import android.graphics.drawable.Drawable
import android.net.Uri
import android.os.Build
import android.text.Spannable
import android.text.Spanned
import android.text.style.LeadingMarginSpan
import android.util.Log
import android.widget.TextView
import androidx.core.graphics.createBitmap
import androidx.core.graphics.drawable.toDrawable
import androidx.core.graphics.withClip
import androidx.core.graphics.withSave
import com.swmansion.enriched.markdown.EnrichedMarkdownText
import com.swmansion.enriched.markdown.styles.StyleConfig
import com.swmansion.enriched.markdown.utils.common.findEnrichedMarkdownAncestor
import com.swmansion.enriched.markdown.utils.text.ImageCache
import com.swmansion.enriched.markdown.utils.text.ImageDownloader
import com.swmansion.enriched.markdown.utils.text.LocalImageLoader
import java.lang.ref.WeakReference
import java.util.concurrent.Executors
import android.text.style.ImageSpan as AndroidImageSpan
import android.text.style.LineHeightSpan as AndroidLineHeightSpan

class ImageSpan(
  private val context: Context,
  val imageUrl: String,
  styleConfig: StyleConfig,
  val isInline: Boolean = false,
  val altText: String = "",
) : AndroidImageSpan(
    Color.TRANSPARENT.toDrawable(),
    imageUrl,
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) ALIGN_CENTER else ALIGN_BASELINE,
  ),
  AndroidLineHeightSpan {
  private var loadedDrawable: Drawable? = null
  private val height: Int = if (isInline) styleConfig.inlineImageStyle.size.toInt() else styleConfig.imageStyle.height.toInt()

  private val borderRadiusPx: Int = styleConfig.imageStyle.borderRadius.toInt()
  private val maxHeightPx: Int = if (isInline) 0 else styleConfig.imageStyle.maxHeight.toInt()
  private val aspectRatio: Float = if (isInline) 0f else styleConfig.imageStyle.aspectRatio
  private val resizeMode: String = if (isInline) "" else styleConfig.imageStyle.resizeMode

  // so legacy always implies a fixed height box.
  private val legacySizing: Boolean = resizeMode.isEmpty()

  private val dynamicBoxHeight: Boolean = !isInline && (maxHeightPx > 0 || aspectRatio > 0f)

  private var boxHeight: Int =
    when {
      isInline -> height
      maxHeightPx > 0 -> maxHeightPx
      else -> height
    }

  private val requestHeaders: Map<String, String> = styleConfig.imageRequestHeaders
  private val requestKey: String = ImageCache.requestKey(imageUrl, requestHeaders)

  private var cachedWidth: Int = 0
  private var viewRef: WeakReference<TextView>? = null
  private var sourceDrawable: Drawable? = null
  private var onBoxHeightChanged: (() -> Unit)? = null

  private fun intrinsicImageSize(): Pair<Int, Int> {
    sourceDrawable?.let { return it.intrinsicWidth to it.intrinsicHeight }
    val cached = ImageCache.getOriginal(imageUrl) ?: return 0 to 0
    return cached.width to cached.height
  }

  // Sizing precedence: aspectRatio > maxHeight > height. Returns the legacy fixed
  // height when no new knob is set.
  private fun resolveBoxHeight(targetWidth: Int): Int {
    if (isInline) return height
    if (aspectRatio > 0f && targetWidth > 0) {
      return (targetWidth / aspectRatio).toInt().coerceAtLeast(1)
    }
    if (maxHeightPx > 0) {
      val (intrinsicWidth, intrinsicHeight) = intrinsicImageSize()
      if (targetWidth > 0 && intrinsicWidth > 0 && intrinsicHeight > 0) {
        val fitted = targetWidth.toFloat() * intrinsicHeight / intrinsicWidth
        return minOf(maxHeightPx.toFloat(), fitted).toInt().coerceAtLeast(1)
      }
      return maxHeightPx
    }
    return height
  }

  fun prepareForMeasurement(
    text: Spanned,
    widthPx: Int,
  ) {
    if (!dynamicBoxHeight || widthPx <= 0) return
    val available = availableWidthIn(text, widthPx)
    if (available > 0) boxHeight = resolveBoxHeight(available)
  }

  init {
    loadImage()
  }

  private fun loadImage() {
    val scheme = Uri.parse(imageUrl).scheme?.lowercase()
    if (scheme == "http" || scheme == "https") {
      ImageDownloader.download(context, imageUrl, requestHeaders) { bitmap ->
        if (bitmap != null) {
          sourceDrawable = bitmap.toDrawable(context.resources)
          wrapAndAssignDrawable()
        }
      }
    } else {
      val cached = ImageCache.getOriginal(imageUrl)
      val bitmap = cached ?: LocalImageLoader.load(context, imageUrl)
      if (bitmap != null) {
        if (cached == null) ImageCache.putOriginal(imageUrl, bitmap)
        sourceDrawable = bitmap.toDrawable(context.resources)
        wrapAndAssignDrawable()
      }
    }
  }

  private fun wrapAndAssignDrawable() {
    val base = sourceDrawable ?: return
    val targetWidth =
      if (isInline) {
        height
      } else {
        val available = viewRef?.get()?.let { getAvailableWidth(it) } ?: cachedWidth
        available.coerceAtLeast(0)
      }

    boxHeight = resolveBoxHeight(targetWidth)

    val cachedBitmap = ImageCache.getProcessed(requestKey, targetWidth, boxHeight, borderRadiusPx, resizeMode)

    if (cachedBitmap != null) {
      loadedDrawable =
        cachedBitmap.toDrawable(context.resources).apply {
          setBounds(0, 0, targetWidth, boxHeight)
        }
    } else {
      loadedDrawable =
        ScaledImageDrawable(
          imageDrawable = base,
          targetWidth = targetWidth,
          targetHeight = boxHeight,
          borderRadius = borderRadiusPx,
          isBlockImage = !isInline,
          resizeMode = resizeMode,
          legacySizing = legacySizing,
          cacheKey = CacheKey(requestKey, targetWidth, boxHeight, borderRadiusPx, resizeMode),
        )
    }
    requestReflow()
  }

  private fun requestReflow() {
    val view = viewRef?.get() ?: return
    val text = view.text
    if (text is Spannable) {
      val start = text.getSpanStart(this)
      val end = text.getSpanEnd(this)
      if (start != -1 && end != -1) {
        text.setSpan(this, start, end, Spannable.SPAN_EXCLUSIVE_EXCLUSIVE)
      }
    } else {
      view.invalidate()
      view.requestLayout()
    }
    notifyBoxHeightMayHaveChanged(view)
  }

  // With maxHeight/aspectRatio the box height can change after the image loads
  // (maxHeight fitted, aspectRatio at a late width). The React container height
  // was measured with the pre-load value, so ask the owning component to
  // re-measure; it only propagates when the stored height actually changed.
  private fun notifyBoxHeightMayHaveChanged(view: TextView) {
    if (!dynamicBoxHeight) return
    // A self-measuring host (e.g. a table cell) sizes the image box itself and drives
    // its own re-layout, so bubbling up to the component would churn it and orphan this
    // freshly registered view. Let the host re-measure locally instead.
    onBoxHeightChanged?.let {
      it()
      return
    }
    if (view is EnrichedMarkdownText) {
      view.layoutManager.invalidateLayout()
      return
    }
    view.findEnrichedMarkdownAncestor()?.onImageLayoutChanged()
  }

  fun registerTextView(
    view: TextView,
    onBoxHeightChanged: (() -> Unit)? = null,
  ) {
    this.onBoxHeightChanged = onBoxHeightChanged
    viewRef = WeakReference(view)
    if (!isInline) {
      val availableWidth = getAvailableWidth(view)
      if (availableWidth > 0) {
        updateWidthAndRecreate(availableWidth)
      }
      view.post {
        val postWidth = getAvailableWidth(view)
        if (postWidth != cachedWidth) updateWidthAndRecreate(postWidth)
      }
    }
  }

  private fun updateWidthAndRecreate(newWidth: Int) {
    if (newWidth <= 0 || cachedWidth == newWidth) return
    cachedWidth = newWidth
    if (sourceDrawable != null) {
      wrapAndAssignDrawable()
      return
    }
    if (dynamicBoxHeight) {
      val newBoxHeight = resolveBoxHeight(newWidth)
      if (newBoxHeight != boxHeight) {
        boxHeight = newBoxHeight
        requestReflow()
      }
    }
  }

  private fun getAvailableWidth(view: TextView): Int {
    val baseWidth = (view.layout?.width ?: view.width).coerceAtLeast(0)
    val text = view.text as? Spanned ?: return baseWidth
    return availableWidthIn(text, baseWidth)
  }

  private fun availableWidthIn(
    text: Spanned,
    baseWidth: Int,
  ): Int {
    val start = text.getSpanStart(this).takeIf { it >= 0 } ?: return baseWidth
    val end = text.getSpanEnd(this).coerceAtLeast(start)
    // Subtract leading margins (list bullet/indent, blockquote bar) that consume
    // horizontal space on the image's line. first=true is correct because a block
    // image sits on its own line — the "first line" from the layout's perspective.
    val totalMargin =
      text
        .getSpans(start, end, LeadingMarginSpan::class.java)
        .sumOf { it.getLeadingMargin(true) }
    return (baseWidth - totalMargin).coerceAtLeast(0)
  }

  override fun getDrawable(): Drawable {
    val drawable = loadedDrawable ?: transparentDrawable
    if (drawable !is ScaledImageDrawable) {
      val drawableWidth = if (isInline) height else cachedWidth.takeIf { it > 0 } ?: drawable.intrinsicWidth
      drawable.setBounds(0, 0, drawableWidth.coerceAtLeast(0), boxHeight.coerceAtLeast(0))
    }
    return drawable
  }

  override fun getSize(
    paint: Paint,
    text: CharSequence?,
    start: Int,
    end: Int,
    fm: Paint.FontMetricsInt?,
  ): Int = getDrawable().bounds.right

  override fun chooseHeight(
    text: CharSequence?,
    start: Int,
    end: Int,
    spanstartv: Int,
    lineHeight: Int,
    fm: Paint.FontMetricsInt?,
  ) {
    if (fm == null || isInline) return
    val currentLineHeight = fm.descent - fm.ascent
    if (boxHeight > currentLineHeight) {
      val extraHeight = boxHeight - currentLineHeight
      fm.descent += extraHeight
      fm.bottom += extraHeight
    }
  }

  override fun draw(
    canvas: Canvas,
    text: CharSequence?,
    start: Int,
    end: Int,
    x: Float,
    top: Int,
    y: Int,
    bottom: Int,
    paint: Paint,
  ) {
    val drawable = getDrawable()
    canvas.withSave {
      if (isInline) {
        val imageHeight = drawable.bounds.height()
        translate(x, (y - imageHeight + (imageHeight * 0.1f)))
      } else {
        translate(x, top.toFloat())
      }
      drawable.draw(this)
    }
  }

  private data class CacheKey(
    val url: String,
    val width: Int,
    val height: Int,
    val borderRadius: Int,
    val resizeMode: String,
  )

  private class ScaledImageDrawable(
    private val imageDrawable: Drawable,
    private val targetWidth: Int,
    private val targetHeight: Int,
    private val borderRadius: Int,
    isBlockImage: Boolean,
    private val resizeMode: String = "",
    private val legacySizing: Boolean = true,
    private val cacheKey: CacheKey? = null,
  ) : Drawable() {
    private val clipPath: Path?
    private var hasCached = false

    init {
      setBounds(0, 0, targetWidth, targetHeight)
      val intrinsicWidth = imageDrawable.intrinsicWidth
      val intrinsicHeight = imageDrawable.intrinsicHeight

      // New sizing needs a clip to the box so cropping
      // modes don't spill over neighbouring lines.
      val clipToBox = isBlockImage && !legacySizing

      val (scaledWidth, scaledHeight) =
        if (intrinsicWidth > 0 && intrinsicHeight > 0) {
          when {
            !isBlockImage -> {
              val scale = minOf(targetWidth.toFloat() / intrinsicWidth, targetHeight.toFloat() / intrinsicHeight)
              (intrinsicWidth * scale).toInt() to (intrinsicHeight * scale).toInt()
            }

            legacySizing -> {
              val scale = targetWidth.toFloat() / intrinsicWidth
              targetWidth to (intrinsicHeight * scale).toInt()
            }

            else -> {
              resizeModeSize(intrinsicWidth, intrinsicHeight)
            }
          }
        } else {
          targetWidth to targetHeight
        }

      val left = (targetWidth - scaledWidth) / 2
      val top = (targetHeight - scaledHeight) / 2
      imageDrawable.setBounds(left, top, left + scaledWidth, top + scaledHeight)

      val clipLeft = maxOf(0, left).toFloat()
      val clipTop = maxOf(0, top).toFloat()
      val clipRight = minOf(targetWidth, left + scaledWidth).toFloat()
      val clipBottom = minOf(targetHeight, top + scaledHeight).toFloat()
      clipPath =
        when {
          borderRadius > 0 -> {
            Path().apply {
              addRoundRect(
                clipLeft,
                clipTop,
                clipRight,
                clipBottom,
                borderRadius.toFloat(),
                borderRadius.toFloat(),
                Path.Direction.CW,
              )
            }
          }

          clipToBox -> {
            Path().apply {
              addRect(clipLeft, clipTop, clipRight, clipBottom, Path.Direction.CW)
            }
          }

          else -> {
            null
          }
        }
    }

    private fun resizeModeSize(
      intrinsicWidth: Int,
      intrinsicHeight: Int,
    ): Pair<Int, Int> {
      if (resizeMode == "stretch") return targetWidth to targetHeight
      val widthScale = targetWidth.toFloat() / intrinsicWidth
      val heightScale = targetHeight.toFloat() / intrinsicHeight
      val scale =
        when (resizeMode) {
          "contain" -> minOf(widthScale, heightScale)
          "center" -> minOf(1f, minOf(widthScale, heightScale))
          "none" -> 1f
          else -> maxOf(widthScale, heightScale) // cover (default)
        }
      return (intrinsicWidth * scale).toInt() to (intrinsicHeight * scale).toInt()
    }

    override fun draw(canvas: Canvas) {
      if (clipPath != null) {
        canvas.withSave {
          clipPath(clipPath)
          imageDrawable.draw(canvas)
        }
      } else {
        imageDrawable.draw(canvas)
      }
      scheduleCacheBitmap()
    }

    private fun scheduleCacheBitmap() {
      if (hasCached || cacheKey == null || targetWidth <= 0 || targetHeight <= 0) return
      hasCached = true
      val cachedKey = cacheKey
      val width = targetWidth
      val height = targetHeight
      val path = clipPath
      val source = imageDrawable
      cacheExecutor.execute {
        try {
          val bitmap = createBitmap(width, height)
          val offscreen = Canvas(bitmap)
          if (path != null) {
            offscreen.withClip(path) { source.draw(this) }
          } else {
            source.draw(offscreen)
          }
          ImageCache.putProcessed(
            cachedKey.url,
            cachedKey.width,
            cachedKey.height,
            cachedKey.borderRadius,
            cachedKey.resizeMode,
            bitmap,
          )
        } catch (_: OutOfMemoryError) {
          Log.e("ScaledImageDrawable", "OOM caching bitmap ${width}x$height")
        }
      }
    }

    override fun setAlpha(alpha: Int) {
      imageDrawable.alpha = alpha
    }

    override fun setColorFilter(colorFilter: android.graphics.ColorFilter?) {
      imageDrawable.colorFilter = colorFilter
    }

    @Suppress("DEPRECATION")
    @Deprecated("Deprecated in Java")
    override fun getOpacity(): Int = imageDrawable.opacity

    override fun getIntrinsicWidth(): Int = targetWidth

    override fun getIntrinsicHeight(): Int = targetHeight
  }

  companion object {
    private val transparentDrawable by lazy { Color.TRANSPARENT.toDrawable() }
    private val cacheExecutor = Executors.newSingleThreadExecutor()
  }
}
