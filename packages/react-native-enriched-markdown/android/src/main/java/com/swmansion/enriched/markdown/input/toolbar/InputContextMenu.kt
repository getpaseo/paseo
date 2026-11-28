package com.swmansion.enriched.markdown.input.toolbar

import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.text.InputType
import android.view.ActionMode
import android.view.Menu
import android.view.MenuItem
import android.widget.EditText
import androidx.appcompat.app.AlertDialog
import com.swmansion.enriched.markdown.input.EnrichedMarkdownTextInputView
import com.swmansion.enriched.markdown.input.MarkdownClipboard
import com.swmansion.enriched.markdown.input.formatting.MarkdownSerializer
import com.swmansion.enriched.markdown.input.model.StyleType

data class InputSelectionMenuConfig(
  val format: Boolean = true,
  val formatLabel: String = "",
  val copyAsMarkdown: Boolean = true,
  val copyAsMarkdownLabel: String = "",
)

data class FormatMenuConfig(
  val bold: Boolean = true,
  val boldLabel: String = "",
  val italic: Boolean = true,
  val italicLabel: String = "",
  val underline: Boolean = true,
  val underlineLabel: String = "",
  val strikethrough: Boolean = true,
  val strikethroughLabel: String = "",
  val spoiler: Boolean = true,
  val spoilerLabel: String = "",
  val link: Boolean = true,
  val linkLabel: String = "",
)

class InputContextMenu(
  private val view: EnrichedMarkdownTextInputView,
) {
  private var customItemTexts: List<String> = emptyList()
  var selectionMenuConfig: InputSelectionMenuConfig = InputSelectionMenuConfig()
  var formatMenuConfig: FormatMenuConfig = FormatMenuConfig()

  fun setContextMenuItems(items: List<String>) {
    customItemTexts = items
  }

  fun install() {
    view.customSelectionActionModeCallback =
      object : ActionMode.Callback {
        override fun onCreateActionMode(
          mode: ActionMode,
          menu: Menu,
        ): Boolean = true

        override fun onPrepareActionMode(
          mode: ActionMode,
          menu: Menu,
        ): Boolean {
          menu.removeItem(MENU_FORMAT_ID)
          menu.removeItem(MENU_COPY_MARKDOWN_ID)
          menu.removeGroup(FORMAT_MENU_GROUP_ID)
          menu.removeGroup(CUSTOM_MENU_GROUP_ID)

          if (selectionMenuConfig.format) {
            val formatSubMenu =
              menu.addSubMenu(FORMAT_MENU_GROUP_ID, MENU_FORMAT_ID, 100, selectionMenuConfig.formatLabel)
            FORMAT_ITEMS.forEachIndexed { index, (styleType, labelOf) ->
              if (isFormatItemVisible(styleType)) {
                formatSubMenu.add(Menu.NONE, MENU_FORMAT_ITEM_BASE + index, index, labelOf(formatMenuConfig))
              }
            }
          }

          if (view.selectionStart < view.selectionEnd) {
            if (selectionMenuConfig.copyAsMarkdown) {
              menu.add(FORMAT_MENU_GROUP_ID, MENU_COPY_MARKDOWN_ID, 101, selectionMenuConfig.copyAsMarkdownLabel)
            }

            customItemTexts.forEachIndexed { index, text ->
              menu
                .add(CUSTOM_MENU_GROUP_ID, MENU_CUSTOM_BASE + index, index, text)
                .setShowAsAction(MenuItem.SHOW_AS_ACTION_ALWAYS)
            }
          }

          return true
        }

        override fun onActionItemClicked(
          mode: ActionMode,
          item: MenuItem,
        ): Boolean {
          val itemId = item.itemId

          if (itemId == MENU_COPY_MARKDOWN_ID) {
            copyAsMarkdown()
            mode.finish()
            return true
          }

          val formatIndex = itemId - MENU_FORMAT_ITEM_BASE
          if (formatIndex in FORMAT_ITEMS.indices) {
            applyFormat(FORMAT_ITEMS[formatIndex].first)
            mode.finish()
            return true
          }

          val customIndex = itemId - MENU_CUSTOM_BASE
          if (customIndex in customItemTexts.indices) {
            val start = view.selectionStart
            val end = view.selectionEnd
            // Strip the internal ZWSP anchor so it never reaches JS (a selection can
            // span an empty anchored list line).
            val selectedText = if (start < end) MarkdownSerializer.stripZwsp(view.text?.substring(start, end) ?: "") else ""
            view.eventEmitter.emitContextMenuItemPress(customItemTexts[customIndex], selectedText, start, end)
            mode.finish()
            return true
          }

          return false
        }

        override fun onDestroyActionMode(mode: ActionMode) {}
      }
  }

  private fun isFormatItemVisible(styleType: StyleType): Boolean =
    when (styleType) {
      StyleType.BOLD -> formatMenuConfig.bold
      StyleType.ITALIC -> formatMenuConfig.italic
      StyleType.UNDERLINE -> formatMenuConfig.underline
      StyleType.STRIKETHROUGH -> formatMenuConfig.strikethrough
      StyleType.SPOILER -> formatMenuConfig.spoiler
      StyleType.LINK -> formatMenuConfig.link
    }

  private fun applyFormat(styleType: StyleType) {
    val start = view.selectionStart
    val end = view.selectionEnd
    if (styleType == StyleType.LINK) {
      showLinkDialog(start, end)
      return
    }
    if (start < end) view.applyStyleToRange(styleType, start, end) else view.toggleInlineStyle(styleType)
  }

  private fun showLinkDialog(
    start: Int,
    end: Int,
  ) {
    val existingLink = view.linkForSelection(start, end)
    val isEdit = existingLink != null

    val urlInput =
      EditText(view.context).apply {
        hint = "https://example.com"
        inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_URI
        setSingleLine(true)
        existingLink?.url?.let { setText(it) }
      }

    AlertDialog
      .Builder(view.context)
      .setTitle(if (isEdit) "Edit Link" else "Add Link")
      .setView(urlInput)
      .setPositiveButton(if (isEdit) "Update" else "Add") { _, _ ->
        val url = urlInput.text.toString().trim()
        if (url.isNotEmpty()) view.setLinkForRange(url, start, end)
      }.setNegativeButton("Cancel", null)
      .show()
  }

  // Explicit "Copy as Markdown": the user asked for markdown syntax, so it is
  // also the plain-text representation external targets receive.
  fun copyAsMarkdown() {
    val markdown = view.markdownForSelectedRange() ?: return
    val clipboard = view.context.getSystemService(Context.CLIPBOARD_SERVICE) as? ClipboardManager ?: return
    clipboard.setPrimaryClip(MarkdownClipboard.newMarkdownClip(markdown, markdown))
  }

  companion object {
    private const val FORMAT_MENU_GROUP_ID = 1000
    private const val MENU_FORMAT_ID = 1001
    private const val MENU_COPY_MARKDOWN_ID = 1002
    private const val MENU_FORMAT_ITEM_BASE = 1100
    private const val CUSTOM_MENU_GROUP_ID = 2000
    private const val MENU_CUSTOM_BASE = 2001

    // Order here defines submenu order and the index used by
    // `MENU_FORMAT_ITEM_BASE + index` when handling clicks.
    private val FORMAT_ITEMS: List<Pair<StyleType, (FormatMenuConfig) -> String>> =
      listOf(
        StyleType.BOLD to { it.boldLabel },
        StyleType.ITALIC to { it.italicLabel },
        StyleType.UNDERLINE to { it.underlineLabel },
        StyleType.STRIKETHROUGH to { it.strikethroughLabel },
        StyleType.SPOILER to { it.spoilerLabel },
        StyleType.LINK to { it.linkLabel },
      )
  }
}
