package com.swmansion.enriched.markdown.segments

import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.net.Uri
import android.widget.FrameLayout
import androidx.media3.common.MediaItem
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.ui.PlayerView
import com.swmansion.enriched.markdown.parser.MarkdownASTNode
import com.swmansion.enriched.markdown.styles.StyleConfig
import com.swmansion.enriched.markdown.views.ContextMenuPopup
import kotlin.math.roundToInt

class VideoContainerView(
  context: Context,
  private val styleConfig: StyleConfig,
) : FrameLayout(context),
  BlockSegmentView {
  private val playerView = PlayerView(context)
  private var player: ExoPlayer? = null
  private var currentUrl: String? = null
  var dynamicProps: DynamicBlockProps = DynamicBlockProps()

  override val segmentMarginTop: Int get() = styleConfig.videoStyle.marginTop.toInt()
  override val segmentMarginBottom: Int get() = styleConfig.videoStyle.marginBottom.toInt()

  init {
    val videoStyle = styleConfig.videoStyle
    setBackgroundColor(videoStyle.backgroundColor)
    clipToOutline = true
    outlineProvider = RoundedOutlineProvider(videoStyle.borderRadius)

    playerView.apply {
      clipToOutline = true
      outlineProvider = RoundedOutlineProvider(videoStyle.borderRadius)
    }

    addView(playerView, LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.MATCH_PARENT))

    isLongClickable = true
    setOnLongClickListener { view -> showContextMenu(view) }

    playerView.isLongClickable = true
    playerView.setOnLongClickListener { showContextMenu(it) }
  }

  fun applyVideoNode(node: MarkdownASTNode) {
    val url = node.getAttribute("url") ?: return
    if (url == currentUrl) return

    releasePlayer()
    currentUrl = url

    val exoPlayer = ExoPlayer.Builder(context).build()
    exoPlayer.playWhenReady = false
    exoPlayer.setMediaItem(MediaItem.fromUri(Uri.parse(url)))
    exoPlayer.prepare()
    player = exoPlayer
    playerView.player = exoPlayer
  }

  override fun onMeasure(
    widthMeasureSpec: Int,
    heightMeasureSpec: Int,
  ) {
    val width = MeasureSpec.getSize(widthMeasureSpec)
    val height = (width / styleConfig.videoStyle.resolvedAspectRatio).roundToInt()
    super.onMeasure(
      MeasureSpec.makeMeasureSpec(width, MeasureSpec.EXACTLY),
      MeasureSpec.makeMeasureSpec(height, MeasureSpec.EXACTLY),
    )
  }

  override fun onDetachedFromWindow() {
    super.onDetachedFromWindow()
    releasePlayer()
  }

  private fun showContextMenu(anchor: android.view.View): Boolean {
    val url = currentUrl ?: return false
    if (!dynamicProps.enableBlockContextMenu || url.isEmpty()) return false
    ContextMenuPopup.show(anchor, this) {
      item(ContextMenuPopup.Icon.COPY, dynamicProps.copyLabel) { copyToClipboard(url) }
      item(ContextMenuPopup.Icon.DOCUMENT, dynamicProps.copyAsMarkdownLabel) { copyToClipboard(videoMarkdown(url)) }
    }
    return true
  }

  private fun videoMarkdown(url: String): String = if (url.contains('"')) "<video src='$url' />" else "<video src=\"$url\" />"

  private fun copyToClipboard(text: String) {
    val clipboard = context.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
    clipboard.setPrimaryClip(ClipData.newPlainText("Video", text))
  }

  private fun releasePlayer() {
    player?.release()
    player = null
    playerView.player = null
    currentUrl = null
  }
}

private class RoundedOutlineProvider(
  private val radius: Float,
) : android.view.ViewOutlineProvider() {
  override fun getOutline(
    view: android.view.View,
    outline: android.graphics.Outline,
  ) {
    outline.setRoundRect(0, 0, view.width, view.height, radius)
  }
}
