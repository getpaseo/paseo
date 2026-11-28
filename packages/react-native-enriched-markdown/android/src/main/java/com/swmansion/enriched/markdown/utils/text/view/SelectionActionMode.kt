package com.swmansion.enriched.markdown.utils.text.view

import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.text.Spannable
import android.view.ActionMode
import android.view.Menu
import android.view.MenuItem
import android.view.ViewParent
import android.widget.TextView
import com.swmansion.enriched.markdown.EnrichedMarkdown
import com.swmansion.enriched.markdown.EnrichedMarkdownText
import com.swmansion.enriched.markdown.spans.ImageSpan
import com.swmansion.enriched.markdown.styles.StyleConfig
import com.swmansion.enriched.markdown.utils.common.layout.isLayoutRTL
import com.swmansion.enriched.markdown.utils.text.conversion.HTMLGenerator
import com.swmansion.enriched.markdown.utils.text.conversion.MarkdownExtractor

private const val MENU_ITEM_COPY_MARKDOWN = 1000
private const val MENU_ITEM_COPY_IMAGE_URL = 1001
private const val MENU_ITEM_CUSTOM_BASE = 2000
private const val MENU_ITEM_CUSTOM_GROUP = 2001

data class SelectionMenuConfig(
  val copyAsMarkdown: Boolean = true,
  val copyImageUrl: Boolean = true,
  val copyLabel: String = "",
  val copyAsMarkdownLabel: String = "",
  val copyImageUrlLabel: String = "",
  val copyImageUrlsLabel: String = "",
  // Plural templates indexed by image count (0..100). Empty when no pluralLabels
  // are set; counts > 100 use copyImageUrlsLabel (the "other" form).
  val copyImageUrlPluralTemplates: List<String> = emptyList(),
)

/**
 * Resolves the "Copy Image URL(s)" menu title for the given image count. Uses the
 * precomputed plural templates when present (counts > 100 use the "other" form),
 * otherwise the singular/`{count}` templates. All labels are resolved JS-side.
 */
private fun SelectionMenuConfig.imageUrlsTitle(count: Int): String {
  val template =
    when {
      copyImageUrlPluralTemplates.isNotEmpty() && count in 0..100 -> copyImageUrlPluralTemplates[count]
      count == 1 -> copyImageUrlLabel
      else -> copyImageUrlsLabel
    }
  return template.replace("{count}", count.toString())
}

/**
 * Creates an ActionMode.Callback that adds custom copy options and
 * overrides the default "Copy" action to include HTML for rich text support.
 */
fun createSelectionActionModeCallback(
  textView: TextView,
  getCustomItemTexts: () -> List<String> = { emptyList() },
  getSelectionMenuConfig: () -> SelectionMenuConfig = { SelectionMenuConfig() },
  onCustomItemPress: (itemText: String, selectedText: String, selectionStart: Int, selectionEnd: Int) -> Unit =
    { _, _, _, _ -> },
): ActionMode.Callback =
  object : ActionMode.Callback {
    override fun onCreateActionMode(
      mode: ActionMode?,
      menu: Menu?,
    ): Boolean = true

    override fun onPrepareActionMode(
      mode: ActionMode?,
      menu: Menu?,
    ): Boolean {
      if (menu == null) return false

      menu.removeItem(MENU_ITEM_COPY_MARKDOWN)
      menu.removeItem(MENU_ITEM_COPY_IMAGE_URL)
      menu.removeGroup(MENU_ITEM_CUSTOM_GROUP)

      val selectionMenuConfig = getSelectionMenuConfig()

      // The system Copy item is added by the platform; relabel it so it
      // matches the rest of the localized menu (iOS rebuilds the menu so
      // gets this for free; Android only intercepts the click).
      if (selectionMenuConfig.copyLabel.isNotEmpty()) {
        menu.findItem(android.R.id.copy)?.title = selectionMenuConfig.copyLabel
      }

      if (
        selectionMenuConfig.copyAsMarkdown &&
        textView.selectionStart >= 0 &&
        textView.selectionEnd > textView.selectionStart
      ) {
        menu.add(
          Menu.NONE,
          MENU_ITEM_COPY_MARKDOWN,
          Menu.NONE,
          selectionMenuConfig.copyAsMarkdownLabel,
        )
      }

      if (textView.selectionStart >= 0 && textView.selectionEnd > textView.selectionStart) {
        val customItems = getCustomItemTexts()
        customItems.forEachIndexed { index, text ->
          menu
            .add(MENU_ITEM_CUSTOM_GROUP, MENU_ITEM_CUSTOM_BASE + index, index, text)
            .setShowAsAction(MenuItem.SHOW_AS_ACTION_ALWAYS)
        }
      }

      val imageUrls =
        if (selectionMenuConfig.copyImageUrl) {
          textView.getImageUrlsInSelection()
        } else {
          emptyList()
        }
      if (imageUrls.isNotEmpty()) {
        val title = selectionMenuConfig.imageUrlsTitle(imageUrls.size)
        menu.add(Menu.NONE, MENU_ITEM_COPY_IMAGE_URL, Menu.NONE, title)
      }

      return true
    }

    override fun onActionItemClicked(
      mode: ActionMode?,
      item: MenuItem?,
    ): Boolean {
      val itemId = item?.itemId ?: return false

      when (itemId) {
        android.R.id.copy -> {
          textView.copyWithHTML()
          mode?.finish()
          return true
        }

        MENU_ITEM_COPY_MARKDOWN -> {
          textView.copyMarkdownToClipboard()
          mode?.finish()
          return true
        }

        MENU_ITEM_COPY_IMAGE_URL -> {
          textView.copyImageUrlsToClipboard()
          mode?.finish()
          return true
        }
      }

      val customItems = getCustomItemTexts()
      val customIndex = itemId - MENU_ITEM_CUSTOM_BASE
      if (customIndex in customItems.indices) {
        val start = textView.selectionStart
        val end = textView.selectionEnd
        val selectedText = if (start >= 0 && end > start) textView.text.substring(start, end) else ""
        onCustomItemPress(customItems[customIndex], selectedText, start, end)
        mode?.finish()
        return true
      }

      return false
    }

    override fun onDestroyActionMode(mode: ActionMode?) {}
  }

/** Copies selection as both plain text and HTML with inline styles. */
private fun TextView.copyWithHTML() {
  val start = selectionStart
  val end = selectionEnd
  if (start < 0 || end < 0 || start >= end) return

  val spannable = text as? Spannable ?: return
  val selectedText = spannable.subSequence(start, end)
  val plainText = selectedText.toString()

  val styleConfig =
    (this as? EnrichedMarkdownText)?.markdownStyle
      ?: findParentMarkdownStyle()
  val clipboard = context.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager

  if (styleConfig != null && selectedText is Spannable) {
    // Density values convert device pixels back to CSS pixels
    val displayMetrics = context.resources.displayMetrics
    val isRTL = context.resources.isLayoutRTL()
    val html =
      HTMLGenerator.generateHTML(
        selectedText,
        styleConfig,
        displayMetrics.scaledDensity,
        displayMetrics.density,
        isRTL,
      )
    clipboard.setPrimaryClip(ClipData.newHtmlText("EnrichedMarkdown", plainText, html))
  } else {
    clipboard.setPrimaryClip(ClipData.newPlainText("Text", plainText))
  }
}

private fun TextView.copyMarkdownToClipboard() {
  val markdown = MarkdownExtractor.getMarkdownForSelection(this) ?: return
  val clipboard = context.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
  clipboard.setPrimaryClip(ClipData.newPlainText("Markdown", markdown))
}

/** Returns remote image URLs (http/https only) from the current selection. */
private fun TextView.getImageUrlsInSelection(): List<String> {
  val start = selectionStart
  val end = selectionEnd
  if (start < 0 || end < 0 || start >= end) return emptyList()

  val spannable = text as? Spannable ?: return emptyList()
  return spannable
    .getSpans(start, end, ImageSpan::class.java)
    .mapNotNull { it.imageUrl }
    .filter { it.startsWith("http://") || it.startsWith("https://") }
}

private fun TextView.copyImageUrlsToClipboard() {
  val urls = getImageUrlsInSelection()
  if (urls.isEmpty()) return

  val clipboard = context.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
  clipboard.setPrimaryClip(ClipData.newPlainText("Image URLs", urls.joinToString("\n")))
}

private fun TextView.findParentMarkdownStyle(): StyleConfig? {
  var current: ViewParent? = parent
  while (current != null) {
    if (current is EnrichedMarkdown) return current.markdownStyle
    current = current.parent
  }
  return null
}
