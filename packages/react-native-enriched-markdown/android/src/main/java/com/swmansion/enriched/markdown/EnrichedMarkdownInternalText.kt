package com.swmansion.enriched.markdown

import android.content.Context
import android.graphics.Canvas
import android.os.Build
import android.text.Layout
import android.util.AttributeSet
import android.view.MotionEvent
import com.swmansion.enriched.markdown.accessibility.AccessibilityLabels
import com.swmansion.enriched.markdown.accessibility.AccessibleMarkdownTextView
import com.swmansion.enriched.markdown.segments.BlockSegmentView
import com.swmansion.enriched.markdown.spoiler.SpoilerCapable
import com.swmansion.enriched.markdown.spoiler.SpoilerOverlay
import com.swmansion.enriched.markdown.spoiler.SpoilerOverlayDrawer
import com.swmansion.enriched.markdown.utils.text.interaction.CheckboxTouchHelper
import com.swmansion.enriched.markdown.utils.text.view.LinkLongPressMovementMethod
import com.swmansion.enriched.markdown.utils.text.view.SelectionMenuConfig
import com.swmansion.enriched.markdown.utils.text.view.applySelectableState
import com.swmansion.enriched.markdown.utils.text.view.cancelJSTouchForCheckboxTap
import com.swmansion.enriched.markdown.utils.text.view.cancelJSTouchForLinkTap
import com.swmansion.enriched.markdown.utils.text.view.createSelectionActionModeCallback
import com.swmansion.enriched.markdown.utils.text.view.reallowParentInterceptIfLinkReleased
import com.swmansion.enriched.markdown.utils.text.view.setupAsMarkdownTextView

class EnrichedMarkdownInternalText
  @JvmOverloads
  constructor(
    context: Context,
    attrs: AttributeSet? = null,
    defStyleAttr: Int = 0,
  ) : AccessibleMarkdownTextView(context, attrs, defStyleAttr),
    BlockSegmentView,
    SpoilerCapable {
    var lastElementMarginBottom: Float = 0f

    private val checkboxTouchHelper = CheckboxTouchHelper(this)

    var onTaskListItemPressCallback: ((taskIndex: Int, checked: Boolean, itemText: String) -> Unit)?
      get() = checkboxTouchHelper.onCheckboxTap
      set(value) {
        checkboxTouchHelper.onCheckboxTap = value
      }

    var enableTaskListItemToggle: Boolean
      get() = checkboxTouchHelper.isEnabled
      set(value) {
        checkboxTouchHelper.isEnabled = value
      }

    override val segmentMarginBottom: Int get() = lastElementMarginBottom.toInt()

    override var spoilerOverlayDrawer: SpoilerOverlayDrawer? = null
      private set
    var spoilerOverlay: SpoilerOverlay = SpoilerOverlay.PARTICLES
    private var contextMenuItemTexts: List<String> = emptyList()
    private var onContextMenuItemPress: ((itemText: String, selectedText: String, selectionStart: Int, selectionEnd: Int) -> Unit)? = null
    var selectionMenuConfig: SelectionMenuConfig = SelectionMenuConfig()
    var accessibilityLabels: AccessibilityLabels = AccessibilityLabels()
      set(value) {
        field = value
        accessibilityHelper.labels = value
      }

    init {
      setupAsMarkdownTextView()
      customSelectionActionModeCallback =
        createSelectionActionModeCallback(
          this,
          getCustomItemTexts = { contextMenuItemTexts },
          getSelectionMenuConfig = { selectionMenuConfig },
          onCustomItemPress = { itemText, selectedText, start, end ->
            onContextMenuItemPress?.invoke(itemText, selectedText, start, end)
          },
        )
    }

    fun applyStyledText(styledText: CharSequence) {
      text = styledText

      if (movementMethod !is LinkLongPressMovementMethod) {
        movementMethod = LinkLongPressMovementMethod.createInstance()
      }

      spoilerOverlayDrawer = SpoilerOverlayDrawer.setupIfNeeded(this, styledText, spoilerOverlayDrawer, spoilerOverlay)
      accessibilityHelper.invalidateAccessibilityItems()
    }

    override fun onDraw(canvas: Canvas) {
      super.onDraw(canvas)
      spoilerOverlayDrawer?.draw(canvas)
    }

    override fun onDetachedFromWindow() {
      spoilerOverlayDrawer?.stop()
      spoilerOverlayDrawer = null
      super.onDetachedFromWindow()
    }

    fun setIsSelectable(selectable: Boolean) {
      applySelectableState(selectable)
    }

    fun setContextMenuItems(
      items: List<String>,
      onPress: (itemText: String, selectedText: String, selectionStart: Int, selectionEnd: Int) -> Unit,
    ) {
      contextMenuItemTexts = items
      onContextMenuItemPress = onPress
    }

    override fun onTouchEvent(event: MotionEvent): Boolean {
      if (checkboxTouchHelper.onTouchEvent(event)) {
        if (event.action == MotionEvent.ACTION_DOWN) {
          cancelJSTouchForCheckboxTap(event)
        }
        return true
      }
      val result = super.onTouchEvent(event)
      when (event.action) {
        MotionEvent.ACTION_DOWN -> cancelJSTouchForLinkTap(event)
        else -> reallowParentInterceptIfLinkReleased()
      }
      return result
    }

    fun setJustificationMode(needsJustify: Boolean) {
      if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
        justificationMode =
          if (needsJustify) {
            Layout.JUSTIFICATION_MODE_INTER_WORD
          } else {
            Layout.JUSTIFICATION_MODE_NONE
          }
      }
    }
  }
