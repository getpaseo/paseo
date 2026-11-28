package com.swmansion.enriched.markdown.input

import android.content.ClipData
import android.content.ClipDescription
import android.content.ClipboardManager
import android.content.Context
import android.os.PersistableBundle

/**
 * Clipboard round-trip for markdown content, mirroring iOS's dual pasteboard
 * representation: the clip's item text stays clean plain text for external
 * paste targets, while the markdown source travels in the description extras
 * under a vendor MIME type so our paste can restore formatting and block
 * ranges. External clips (no vendor MIME) keep pasting as plain text.
 */
object MarkdownClipboard {
  const val MIME_TYPE = "text/vnd.com.swmansion.enriched-markdown"
  private const val EXTRA_MARKDOWN = "com.swmansion.enriched-markdown.markdown"

  fun newMarkdownClip(
    markdown: String,
    plainText: String,
  ): ClipData {
    val clip =
      ClipData(
        ClipDescription("Markdown", arrayOf(MIME_TYPE, ClipDescription.MIMETYPE_TEXT_PLAIN)),
        ClipData.Item(plainText),
      )
    clip.description.extras = PersistableBundle().apply { putString(EXTRA_MARKDOWN, markdown) }
    return clip
  }

  /** Returns the clipboard's markdown, or null if the clip wasn't created by [newMarkdownClip]. */
  fun markdownFromClipboard(context: Context): String? {
    val clipboard = context.getSystemService(Context.CLIPBOARD_SERVICE) as? ClipboardManager ?: return null
    val clip = clipboard.primaryClip ?: return null
    if (!clip.description.hasMimeType(MIME_TYPE)) return null
    return clip.description.extras
      ?.getString(EXTRA_MARKDOWN)
      ?.takeIf { it.isNotEmpty() }
  }
}
