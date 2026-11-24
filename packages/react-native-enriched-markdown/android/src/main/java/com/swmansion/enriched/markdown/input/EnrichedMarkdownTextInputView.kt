package com.swmansion.enriched.markdown.input

import android.content.ClipboardManager
import android.content.Context
import android.graphics.BlendMode
import android.graphics.BlendModeColorFilter
import android.graphics.Color
import android.os.Build
import android.text.Editable
import android.text.InputType
import android.text.SpannableString
import android.text.TextPaint
import android.util.Log
import android.util.TypedValue
import android.view.Gravity
import android.view.KeyEvent
import android.view.MotionEvent
import android.view.View.OnFocusChangeListener
import android.view.inputmethod.EditorInfo
import android.view.inputmethod.InputConnection
import android.view.inputmethod.InputMethodManager
import androidx.appcompat.widget.AppCompatEditText
import com.facebook.react.common.ReactConstants
import com.facebook.react.uimanager.BackgroundStyleApplicator
import com.facebook.react.uimanager.PixelUtil
import com.facebook.react.uimanager.StateWrapper
import com.facebook.react.views.text.ReactTypefaceUtils
import com.facebook.react.views.text.TextAttributes
import com.swmansion.enriched.markdown.input.autolink.AutoLinkDetector
import com.swmansion.enriched.markdown.input.detection.DetectorPipeline
import com.swmansion.enriched.markdown.input.editing.BlockEditCoordinator
import com.swmansion.enriched.markdown.input.editing.ClipboardCoordinator
import com.swmansion.enriched.markdown.input.editing.EditContext
import com.swmansion.enriched.markdown.input.editing.EditPhase
import com.swmansion.enriched.markdown.input.editing.EditPipeline
import com.swmansion.enriched.markdown.input.editing.EditPipelineHost
import com.swmansion.enriched.markdown.input.editing.EditSession
import com.swmansion.enriched.markdown.input.editing.InputConnectionWrapper
import com.swmansion.enriched.markdown.input.editing.LinkCoordinator
import com.swmansion.enriched.markdown.input.editing.MarkdownEditableFactory
import com.swmansion.enriched.markdown.input.editing.MarkdownShortcutsConfig
import com.swmansion.enriched.markdown.input.editing.MarkdownTextWatcher
import com.swmansion.enriched.markdown.input.editing.MentionCoordinator
import com.swmansion.enriched.markdown.input.editing.MentionEvent
import com.swmansion.enriched.markdown.input.editing.ZWSP
import com.swmansion.enriched.markdown.input.formatting.BlockStore
import com.swmansion.enriched.markdown.input.formatting.FormattingStore
import com.swmansion.enriched.markdown.input.formatting.InputFormatter
import com.swmansion.enriched.markdown.input.formatting.InputParser
import com.swmansion.enriched.markdown.input.layout.InputEventEmitter
import com.swmansion.enriched.markdown.input.layout.InputLayoutManager
import com.swmansion.enriched.markdown.input.model.BlockRange
import com.swmansion.enriched.markdown.input.model.BlockType
import com.swmansion.enriched.markdown.input.model.FormattingRange
import com.swmansion.enriched.markdown.input.model.InputFormatterStyle
import com.swmansion.enriched.markdown.input.model.StyleType
import com.swmansion.enriched.markdown.input.spans.applyBodyLineHeightSpan
import com.swmansion.enriched.markdown.input.spans.bodyLineMinimumFontMetrics
import com.swmansion.enriched.markdown.input.toolbar.InputContextMenu
import com.swmansion.enriched.markdown.utils.common.LinkRegexConfig
import com.swmansion.enriched.markdown.utils.input.AutoCapitalizeUtils
import kotlin.math.ceil

class EnrichedMarkdownTextInputView(
  context: Context,
) : AppCompatEditText(context) {
  private var isComponentReady = false
  private var lastEmittedSelectionStart = -1
  private var lastEmittedSelectionEnd = -1

  val formattingStore = FormattingStore()
  val blockStore = BlockStore()
  val formatter = InputFormatter(resources.displayMetrics.density)
  val pendingStyles = mutableSetOf<StyleType>()
  val pendingStyleRemovals = mutableSetOf<StyleType>()

  val editSession = EditSession()
  val blockCoordinator = BlockEditCoordinator(blockStore)

  private var lastProcessedText: String = ""
  private var preEditSelectionStart = 0
  private var preEditSelectionEnd = 0

  var emitMarkdown = false
  var autoFocusRequested = false
  var stateWrapper: StateWrapper? = null
  val layoutManager = InputLayoutManager(this)
  private var pendingAutoFocusKeyboard = false

  private var typefaceDirty = false

  /**
   * Whenever formatting has changed, set this to true to ensure `onAfterUpdateTransaction` calls
   * `applyFormatting` after all new props have been processed. We use this instead of directly
   * calling `applyFormatting` to avoid duplicate calls when setting multiple props.
   */
  private var formattingDirty = false
  private var fontFamilyValue: String? = null
  private var fontWeightValue: Int = ReactConstants.UNSET
  internal val textAttributes = TextAttributes()

  val contextMenu = InputContextMenu(this)
  val eventEmitter = InputEventEmitter(this)
  private val autoLinkDetector = AutoLinkDetector(formattingStore)
  private val detectorPipeline = DetectorPipeline()
  private val mentionCoordinator = MentionCoordinator(formattingStore)
  private val linkCoordinator = LinkCoordinator(formattingStore, autoLinkDetector)

  private val editPipelineHost =
    object : EditPipelineHost {
      override val editable: Editable? get() = text
      override val emitMarkdown: Boolean get() = this@EnrichedMarkdownTextInputView.emitMarkdown

      override fun syncEmptyListAnchor(restamp: Boolean) = this@EnrichedMarkdownTextInputView.syncEmptyListAnchor(restamp)

      override fun forceScrollToSelection() = this@EnrichedMarkdownTextInputView.forceScrollToSelection()

      override fun syncCursorSizeWithBlock() = this@EnrichedMarkdownTextInputView.syncCursorSizeWithBlock()

      override fun updateActiveMention() = this@EnrichedMarkdownTextInputView.dispatchMentionUpdate()

      override fun runAsATransaction(block: () -> Unit) = this@EnrichedMarkdownTextInputView.runAsATransaction(block)

      override fun setViewSelection(position: Int) = setSelection(position)

      override val markdownShortcuts: MarkdownShortcutsConfig
        get() = this@EnrichedMarkdownTextInputView.markdownShortcuts
    }

  val editPipeline =
    EditPipeline(
      formattingStore = formattingStore,
      blockStore = blockStore,
      formatter = formatter,
      detectorPipeline = detectorPipeline,
      eventEmitter = eventEmitter,
      host = editPipelineHost,
    )

  private var textWatcher: MarkdownTextWatcher? = null
  private var inputMethodManager: InputMethodManager? = null
  private var detectScrollMovement = false
  var scrollEnabled: Boolean = true

  /** Typed `# `, `- `, `1. ` become blocks (opt-in per family from JS). */
  var markdownShortcuts: MarkdownShortcutsConfig = MarkdownShortcutsConfig()

  private val clipboardCoordinator = ClipboardCoordinator(formattingStore, blockStore, detectorPipeline, formatter)

  private var bodySizeBeforeHeadingOverridePx: Float? = null
  private var baseHintColor: Int? = null

  // Number of ZWSP empty-list anchors believed live in the buffer. Bumped on insert,
  // made exact on every strip scan (which recounts what it keeps), and reset when the
  // buffer is replaced. Incoming markdown is scrubbed of U+200B at parse time, so in
  // practice only syncEmptyListAnchor's own inserts raise it. When it is 0 there is
  // nothing to strip, letting syncEmptyListAnchor skip its O(document) backward scan
  // on every caret move.
  private var zwspAnchorCount = 0

  // The consumer-set placeholder, hidden while a bullet is drawn on an empty editor.
  private var userHint: CharSequence? = null

  // userHint with the body line-height span, so the hint lays out at the same
  // line height that InputMeasurementStore measures it with.
  private var styledHint: CharSequence? = null
  private var styledHintLineHeight = Float.NaN

  init {
    setupDetectorPipeline()
    prepareComponent()
    isComponentReady = true
  }

  private fun setupDetectorPipeline() {
    autoLinkDetector.onLinkDetected = { text, url, start, end ->
      eventEmitter.emitLinkDetected(text, url, start, end)
    }
    detectorPipeline.addDetector(autoLinkDetector)
  }

  private fun prepareComponent() {
    isSingleLine = false
    isHorizontalScrollBarEnabled = false
    isVerticalScrollBarEnabled = true
    inputType = InputType.TYPE_CLASS_TEXT or
      InputType.TYPE_TEXT_FLAG_MULTI_LINE or
      InputType.TYPE_TEXT_FLAG_CAP_SENTENCES or
      InputType.TYPE_TEXT_FLAG_AUTO_CORRECT
    gravity = Gravity.TOP or Gravity.START

    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
      breakStrategy = android.graphics.text.LineBreaker.BREAK_STRATEGY_HIGH_QUALITY
    }

    setEditableFactory(MarkdownEditableFactory(this))
    setPadding(0, 0, 0, 0)
    // Line height comes from InputLineHeightSpan, so there is no extra line
    // spacing, as in React Native's text layout:
    // https://github.com/react/react-native/blob/v0.86.2/packages/react-native/ReactAndroid/src/main/java/com/facebook/react/views/text/TextLayoutManager.kt#L676
    setLineSpacing(0f, 1f)
    // Start from EditText's default size so heading line heights can be
    // derived even when no fontSize prop is set.
    textAttributes.fontSize = textSize / (resources.displayMetrics.density * resources.configuration.fontScale)
    background = null
    BackgroundStyleApplicator.setBackgroundColor(this, Color.TRANSPARENT)
    contextMenu.install()

    inputMethodManager = context.getSystemService(Context.INPUT_METHOD_SERVICE) as? InputMethodManager

    onFocusChangeListener =
      OnFocusChangeListener { _, hasFocus ->
        if (hasFocus) {
          eventEmitter.emitFocus()
        } else {
          eventEmitter.emitBlur()
        }
      }
  }

  override fun onAttachedToWindow() {
    super.onAttachedToWindow()
    runAsATransaction { super.setTextIsSelectable(true) }
  }

  override fun onWindowFocusChanged(hasWindowFocus: Boolean) {
    super.onWindowFocusChanged(hasWindowFocus)
    // The autofocus keyboard request may run before the window has IME focus (e.g. while a modal is
    // still presenting), where showSoftInput() is dropped.
    showAutoFocusKeyboardIfPending()
  }

  override fun clearFocus() {
    super.clearFocus()
    inputMethodManager?.hideSoftInputFromWindow(windowToken, 0)
  }

  override fun onCreateInputConnection(outAttrs: EditorInfo): InputConnection? {
    val base = super.onCreateInputConnection(outAttrs) ?: return null
    return InputConnectionWrapper(base, this)
  }

  // Plain Tab is consumed before the platform's focus navigation so it inserts
  // a tab character and emits onKeyPress, matching iOS. Shift/Ctrl+Tab still
  // navigate focus.
  override fun onKeyDown(
    keyCode: Int,
    event: KeyEvent?,
  ): Boolean {
    if (keyCode == KeyEvent.KEYCODE_TAB && event?.hasNoModifiers() != false) {
      eventEmitter.emitKeyPress("Tab")
      val start = minOf(selectionStart, selectionEnd).coerceAtLeast(0)
      val end = maxOf(selectionStart, selectionEnd).coerceAtLeast(0)
      text?.replace(start, end, "\t")
      return true
    }
    if (keyCode == KeyEvent.KEYCODE_DEL && deleteLinkBeforeCursor()) {
      return true
    }
    if (handleListKey(keyCode, event)) {
      return true
    }
    return super.onKeyDown(keyCode, event)
  }

  /**
   * Hardware-keyboard list editing: Tab indents the current item, Shift+Tab outdents,
   * and Backspace at the start of an item (or on an empty/ZWSP-anchored item) outdents,
   * then un-lists at depth 0. Only fires on a list line; returns true when handled.
   */
  private fun handleListKey(
    keyCode: Int,
    event: KeyEvent?,
  ): Boolean {
    val listBlock = listBlockAtCursor() ?: return false
    val depth = listBlock.level
    when (keyCode) {
      KeyEvent.KEYCODE_TAB -> {
        if (event?.isShiftPressed == true) outdentList() else indentList()
        return true
      }

      KeyEvent.KEYCODE_DEL -> {
        if (selectionStart == selectionEnd) {
          val editable = text ?: return false
          val ls = blockCoordinator.lineStartOf(editable, selectionStart)
          val le = blockCoordinator.lineEndOf(editable, selectionStart)
          val content = editable.subSequence(ls, le).toString()
          if (selectionStart == ls || content.isEmpty() || content == ZWSP.toString()) {
            if (depth > 0) outdentList() else toggleListType(listBlock.type)
            return true
          }
        }
      }
    }
    return false
  }

  // Prevents TextView from deferring its internal layout when a Fabric
  // state-update (height change) triggers requestLayout(). Without this
  // override the deferred relayout causes a visible flicker of styled spans.
  // See: ReactEditText in React Native core.
  override fun isLayoutRequested(): Boolean = false

  override fun onTouchEvent(ev: MotionEvent): Boolean {
    when (ev.action) {
      MotionEvent.ACTION_DOWN -> {
        detectScrollMovement = true
        parent?.requestDisallowInterceptTouchEvent(true)
      }

      MotionEvent.ACTION_MOVE -> {
        if (detectScrollMovement) {
          if (!canScrollVertically(-1) && !canScrollVertically(1) &&
            !canScrollHorizontally(-1) && !canScrollHorizontally(1)
          ) {
            parent?.requestDisallowInterceptTouchEvent(false)
          }
          detectScrollMovement = false
        }
      }
    }
    return super.onTouchEvent(ev)
  }

  override fun performClick(): Boolean = super.performClick()

  // Framework bug (issue #728): inside Editor.performLongClick, the guarded branch calls
  // Selection.setSelection, whose SpanWatcher callback runs our onSelectionChanged override
  // synchronously; that can re-run prepareCursorControllers and flip mInsertionControllerEnabled
  // to false before the immediately following getInsertionController().show(), which then
  // dereferences null. Absorb only that specific NPE (thrown from Editor.performLongClick) and
  // rethrow anything else so unrelated regressions in our own callbacks aren't masked. We log it
  // rather than swallowing silently (RN's ReactSoftExceptionLogger is internal to RN, so we use a
  // plain warning under our own tag), and return true so the long press counts as handled (else
  // View.CheckForLongPress leaves mHasPerformedLongPress unset and a spurious click fires on
  // ACTION_UP); the long press just skips the insertion UI on that frame instead of crashing.
  override fun performLongClick(): Boolean =
    try {
      super.performLongClick()
    } catch (e: NullPointerException) {
      val top = e.stackTrace.firstOrNull()
      if (top == null || !top.className.startsWith("android.widget.Editor") || top.methodName != "performLongClick") {
        throw e
      }
      Log.w(TAG, "Absorbed framework NPE in performLongClick (issue #728)", e)
      true
    }

  // In auto-grow mode (scrollEnabled=false) TextView's internal bringPointIntoView
  // scrolls content before Fabric has resized the view, causing a visible flicker.
  override fun scrollTo(
    x: Int,
    y: Int,
  ) {
    if (!scrollEnabled) return
    super.scrollTo(x, y)
  }

  override fun canScrollVertically(direction: Int): Boolean = scrollEnabled && super.canScrollVertically(direction)

  override fun canScrollHorizontally(direction: Int): Boolean = scrollEnabled && super.canScrollHorizontally(direction)

  fun attachTextWatcher(editable: Editable) {
    if (textWatcher != null) {
      editable.removeSpan(textWatcher)
    }
    textWatcher = MarkdownTextWatcher(this)
    addTextChangedListener(textWatcher)
  }

  fun runAsATransaction(block: () -> Unit) {
    if (editSession.phase != EditPhase.Idle) {
      block()
    } else {
      editSession.scoped(EditPhase.Processing) { block() }
    }
  }

  fun onBeforeTextChanged() {
    if (editSession.phase != EditPhase.Idle) return
    editSession.isTextChanging = true
    preEditSelectionStart = selectionStart
    preEditSelectionEnd = selectionEnd
  }

  fun onAfterTextChanged(
    editStart: Int,
    deletedLength: Int,
    insertedLength: Int,
  ) {
    if (editSession.phase != EditPhase.Idle) return

    val currentText = text?.toString() ?: ""
    if (currentText == lastProcessedText) return

    editSession.scoped(EditPhase.Processing) {
      val context =
        EditContext(
          editStart = editStart,
          deletedLength = deletedLength,
          insertedLength = insertedLength,
          preEditText = currentText,
          preEditSelectionStart = preEditSelectionStart,
          preEditSelectionEnd = preEditSelectionEnd,
          pendingStyles = pendingStyles.toSet(),
          pendingStyleRemovals = pendingStyleRemovals.toSet(),
        )
      editPipeline.processTextChange(context)
      // Measure only once the pipeline has settled the text and its formatting
      // (list continuation, shortcuts, the ZWSP anchor), never mid-edit.
      layoutManager.invalidateLayout()
      editSession.isTextChanging = false
      editSession.didTextChangeRecently = true
      lastProcessedText = text?.toString() ?: currentText
    }
    emitSelectionIfChanged()
  }

  override fun onSelectionChanged(
    selStart: Int,
    selEnd: Int,
  ) {
    super.onSelectionChanged(selStart, selEnd)
    if (!isComponentReady || editSession.shouldSuppressTextWatcher) return

    if (!editSession.isTextChanging) {
      formattingStore.selectionAdjustedForAtomicLinks(selStart, selEnd)?.let { (newStart, newEnd) ->
        setSelection(newStart, newEnd)
        return
      }
      if (editSession.didTextChangeRecently) {
        editSession.didTextChangeRecently = false
      } else {
        pendingStyles.clear()
        pendingStyleRemovals.clear()
        seedPendingStylesFromSelection(selStart, selEnd)
      }
    }

    if (!editSession.isTextChanging && editSession.phase == EditPhase.Idle) {
      // The caret moving on/off an empty bullet line toggles the ZWSP anchor and the
      // placeholder visibility; skip during a text-change pass (handled there).
      syncEmptyListAnchor()
    }

    emitSelectionIfChanged()
    dispatchMentionUpdate()
    eventEmitter.emitState()
    eventEmitter.emitCaretRectChangeIfNeeded()
  }

  /**
   * Sends the caret range to JS when it differs from the last range JS received.
   *
   * [onSelectionChanged] returns immediately while an edit phase is active, so
   * a caret move from setValue, a programmatic insert, or anchor management is
   * not reported there. Those callers invoke this once the edit phase has ended.
   *
   * This function then rereads the latest range at that point before emitting
   * the selection.
   */
  private fun emitSelectionIfChanged() {
    if (!isComponentReady) return
    val start = selectionStart
    val end = selectionEnd
    if (start == lastEmittedSelectionStart && end == lastEmittedSelectionEnd) return
    if (eventEmitter.emitSelection(start, end)) {
      lastEmittedSelectionStart = start
      lastEmittedSelectionEnd = end
    }
  }

  /**
   * Text typed over a non-empty selection inherits the inline styles of the first
   * selected character (mirrors iOS rebuildFromContext and the range-inheritance
   * rule in [com.swmansion.enriched.markdown.input.formatting.RangeEditAdjustment]).
   * Seeding here is the only chance to carry the style through the whole typed
   * run: the post-edit grace period above skips reseeding between keystrokes.
   * LINK is excluded — typing over a selected link replaces it, not extends it.
   */
  private fun seedPendingStylesFromSelection(
    selStart: Int,
    selEnd: Int,
  ) {
    if (selStart == selEnd) return
    for (style in StyleType.entries) {
      if (style == StyleType.LINK) continue
      if (formattingStore.isStyleActive(style, selStart)) {
        pendingStyles.add(style)
      }
    }
  }

  /**
   * Adjusts both [formattingStore] and [blockStore] for a text edit, then prunes
   * orphaned anchors and normalizes block ranges to line bounds. Every code path
   * that mutates the text buffer must call this so block ranges stay in sync —
   * mirrors iOS's `replaceTextInRange:withText:formattingRanges:blockRanges:`.
   */
  private fun adjustStoresForEdit(
    editStart: Int,
    deletedLength: Int,
    insertedLength: Int,
  ) {
    formattingStore.adjustForEdit(editStart, deletedLength, insertedLength)
    blockStore.adjustForEdit(editStart, deletedLength, insertedLength)
    editPipeline.pruneOrphanedAnchors()
    text?.let { blockStore.normalizeToLineBounds(it) }
  }

  private inline fun replaceTextInRange(
    start: Int,
    end: Int,
    newText: String,
    crossinline postAdjust: (Editable) -> Unit = {},
  ) {
    val editable = text ?: return
    editSession.scoped(EditPhase.Processing) {
      editable.replace(start, end, newText)
      adjustStoresForEdit(start, end - start, newText.length)
      postAdjust(editable)
      lastProcessedText = editable.toString()
      applyFormattingAndEmit()
      eventEmitter.emitChangeText()
    }
    emitSelectionIfChanged()
  }

  fun applyFormatting() {
    val editable = text ?: return
    formattingDirty = false
    // textAttributes is mutated in place by the prop setters, while
    // InputFormatter.copy() (used for measurement snapshots) shares
    // bodyTextAttributes on the assumption that it is never mutated.
    formatter.bodyTextAttributes = textAttributes.copy()
    formatter.applyFormatting(editable, formattingStore.allRanges)
    formatter.applyBlockFormatting(editable, blockStore.allRanges)
    applyBodyLineHeightSpan(editable, textAttributes)
    updateMinimumFontMetrics()
    updateStyledHint()
    // Formatting can change the height without changing the text (toggling a
    // heading or list, or a new font size or line height), so Yoga has to
    // re-measure here, not only on text changes.
    layoutManager.invalidateLayout()
  }

  /** Ensures empty lines also apply the lineHeight. See [bodyLineMinimumFontMetrics]. */
  private fun updateMinimumFontMetrics() {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.VANILLA_ICE_CREAM) return

    // The minimum is for body lines, so compute it at the body font size.
    //
    // On an empty heading line, syncCursorSizeWithBlock has enlarged the paint to
    // the heading size and saved the body size in bodySizeBeforeHeadingOverridePx,
    // so use a copy of the paint at that saved size.
    val bodyPaint = TextPaint(paint).apply { bodySizeBeforeHeadingOverridePx?.let { textSize = it } }
    val metrics = bodyLineMinimumFontMetrics(bodyPaint, textAttributes)
    val current = minimumFontMetrics
    val unchanged =
      metrics == current ||
        (
          metrics != null &&
            current != null &&
            metrics.top == current.top &&
            metrics.ascent == current.ascent &&
            metrics.descent == current.descent &&
            metrics.bottom == current.bottom
        )
    if (unchanged) return

    minimumFontMetrics = metrics
    // setMinimumFontMetrics doesn't rebuild the layout and DynamicLayout keeps
    // the metrics it was built with; re-setting the break strategy does both.
    breakStrategy = breakStrategy
  }

  private fun applyFormattingAndEmit() {
    applyFormatting()
    forceScrollToSelection()
    if (emitMarkdown) eventEmitter.emitChangeMarkdown()
    eventEmitter.emitState()
  }

  private fun forceScrollToSelection() {
    val textLayout = layout ?: return
    val cursorOffset = selectionStart
    if (cursorOffset <= 0) return

    val selectedLineIndex = textLayout.getLineForOffset(cursorOffset)
    val selectedLineTop = textLayout.getLineTop(selectedLineIndex)
    val selectedLineBottom = textLayout.getLineBottom(selectedLineIndex)
    val visibleTextHeight = height - paddingTop - paddingBottom
    if (visibleTextHeight <= 0) return

    val visibleTop = scrollY
    val visibleBottom = scrollY + visibleTextHeight
    var targetScrollY = scrollY

    if (selectedLineTop < visibleTop) {
      targetScrollY = selectedLineTop
    } else if (selectedLineBottom > visibleBottom) {
      targetScrollY = selectedLineBottom - visibleTextHeight
    }

    val maxScrollY = (textLayout.height - visibleTextHeight).coerceAtLeast(0)
    targetScrollY = targetScrollY.coerceIn(0, maxScrollY)
    scrollTo(scrollX, targetScrollY)
  }

  fun toggleInlineStyle(styleType: StyleType) {
    val handler = formatter.handlers[styleType] ?: return
    val mergingConfig = handler.mergingConfig
    val selStart = selectionStart
    val selEnd = selectionEnd

    if (formattingStore.isToggleBlocked(styleType, selStart, mergingConfig.blockingStyles)) return

    val result = formattingStore.toggleStyle(styleType, selStart, selEnd, mergingConfig.conflictingStyles)

    if (selStart == selEnd) {
      if (pendingStyleRemovals.contains(styleType)) {
        pendingStyleRemovals.remove(styleType)
        pendingStyles.add(styleType)
      } else if (pendingStyles.contains(styleType)) {
        pendingStyles.remove(styleType)
        pendingStyleRemovals.add(styleType)
      } else if (result == FormattingStore.ToggleResult.WAS_ACTIVE) {
        pendingStyleRemovals.add(styleType)
      } else {
        pendingStyles.add(styleType)
      }
      eventEmitter.emitState()
    } else {
      applyFormattingAndEmit()
      pendingStyles.clear()
      pendingStyleRemovals.clear()
      seedPendingStylesFromSelection(selStart, selEnd)
    }
  }

  private fun listBlockAtCursor(): BlockRange? {
    val editable = text ?: return null
    return blockCoordinator.listBlockAtPosition(editable, selectionStart)
  }

  fun listStateAtCursor(type: BlockType): Pair<Boolean, Int> {
    val editable = text ?: return false to 0
    return blockCoordinator.listStateAtPosition(editable, selectionStart, type)
  }

  fun toggleUnorderedList() = toggleListType(BlockType.UNORDERED_LIST_ITEM)

  fun toggleOrderedList() = toggleListType(BlockType.ORDERED_LIST_ITEM)

  private fun toggleListType(type: BlockType) {
    val editable = text ?: return
    blockCoordinator.toggleList(editable, type, selectionStart, selectionStart, selectionEnd)
    syncEmptyListAnchor(restamp = false)
    applyFormattingAndEmit()
  }

  /** Increases the nesting depth of the selected list item(s). QoL: indenting a plain paragraph starts a list. */
  fun indentList() = changeListDepthBy(1)

  /** Decreases the nesting depth; outdenting at depth 0 removes the list marker. */
  fun outdentList() = changeListDepthBy(-1)

  private fun changeListDepthBy(delta: Int) {
    val editable = text ?: return
    val result = blockCoordinator.changeDepth(editable, selectionStart, selectionStart, selectionEnd, delta)
    if (result == BlockEditCoordinator.DepthChangeResult.NO_OP) return
    syncEmptyListAnchor(restamp = false)
    applyFormattingAndEmit()
  }

  /**
   * Keeps an empty bullet line anchored by a ZWSP so its marker draws and the caret
   * indents (a [android.text.style.LeadingMarginSpan] doesn't indent an empty
   * paragraph). Inserts the ZWSP on the caret's empty list line, strips stale ones.
   *
   * @param restamp re-apply block formatting here (selection path); the text-change
   *   pass and list commands pass false and stamp once afterwards.
   * @return true if an anchor was inserted or stripped (text/ranges mutated).
   *
   * When called from `onAfterTextChanged` this mutates the [Editable] from inside
   * the text-change callback — normally an Android hazard around IME composition,
   * undo/redo, and accessibility. It is safe here, and deliberately synchronous,
   * because: every buffer mutation is wrapped in [runAsATransaction] (which keeps
   * [EditSession.phase] non-idle, so [MarkdownTextWatcher] early-returns and the edit
   * does not re-enter this pass), the whole `onAfterTextChanged` body holds
   * [EditPhase.Processing], and [EditPhase.ManagingAnchors] blocks re-entry via the
   * selection-change path. The mutation must stay synchronous: the single-stamp
   * ordering above, the caret placement past the anchor, and `lastProcessedText`
   * all depend on the buffer reaching its final state within this same callback —
   * deferring the insert/delete (e.g. via `post`) would run it outside every guard
   * and reintroduce the double-bullet and stale-caret bugs.
   */
  private fun syncEmptyListAnchor(restamp: Boolean = true): Boolean {
    if (editSession.shouldSuppressAnchorSync) return false
    val editable = text ?: return false
    return editSession.scoped(EditPhase.ManagingAnchors) {
      var anchorChanged = false
      // Strip every stale ZWSP first (a line that gained content or stopped being a
      // list). Skip the full-document scan when we've inserted no anchors — there is
      // nothing to strip, so a caret move in a document with no empty list lines is
      // O(1) instead of O(document length). When the scan does run it recounts the
      // anchors it keeps, so the count is exact afterwards — a prior overcount (an
      // anchor the user deleted directly) or an undercount (a foreign ZWSP that stole
      // a decrement) self-heals rather than disabling the fast path or leaking a
      // stale anchor.
      if (zwspAnchorCount > 0) {
        var keptAnchors = 0
        var i = editable.length - 1
        while (i >= 0) {
          if (editable[i] == ZWSP) {
            val ls = blockCoordinator.lineStartOf(editable, i)
            val le = blockCoordinator.lineEndOf(editable, i)
            val onlyZwsp = le - ls == 1 && editable[ls] == ZWSP
            val isEmptyListLine = onlyZwsp && blockCoordinator.listBlockAtLineStart(ls) != null
            if (!isEmptyListLine) {
              runAsATransaction { editable.delete(i, i + 1) }
              formattingStore.adjustForEdit(i, 1, 0)
              blockStore.adjustForEdit(i, 1, 0)
              anchorChanged = true
            } else {
              keptAnchors++
            }
          }
          i--
        }
        zwspAnchorCount = keptAnchors
      }

      val caret = selectionStart
      if (selectionStart == selectionEnd) {
        val ls = blockCoordinator.lineStartOf(editable, caret)
        val le = blockCoordinator.lineEndOf(editable, caret)
        val block = blockCoordinator.listBlockAtLineStart(ls)
        if (block != null && le == ls) {
          runAsATransaction { editable.insert(ls, ZWSP.toString()) }
          formattingStore.adjustForEdit(ls, 0, 1)
          blockStore.adjustForEdit(ls, 0, 1)
          blockStore.normalizeToLineBounds(editable)
          setSelection(ls + 1)
          zwspAnchorCount++
          anchorChanged = true
        }
      }

      if (anchorChanged) {
        // Re-snap any range left zero-length by a strip so the next stamp is exact.
        blockStore.normalizeToLineBounds(editable)
        if (restamp) applyFormatting()
        lastProcessedText = editable.toString()
        if (emitMarkdown) eventEmitter.emitChangeMarkdown()
      }
      syncHintVisibility()
      anchorChanged
    }
  }

  /**
   * The hint shows only on a truly empty editor with no block range — a bullet's
   * ZWSP anchor counts as content, so the hint never overlaps a marker. Mirrors iOS.
   */
  private fun syncHintVisibility(force: Boolean = false) {
    val content = text
    val hasRealText = content != null && content.any { it != ZWSP }
    val hasBlock = blockStore.allRanges.isNotEmpty()
    val target: CharSequence? = if (hasRealText || hasBlock) "" else styledHint
    // Compare as strings: setHint copies the hint, so the spanned copy is never
    // identical to target. A line-height change passes force instead.
    if (force || hint?.toString() != target?.toString()) super.setHint(target)
  }

  fun setUserHint(value: CharSequence?) {
    userHint = value
    updateStyledHint(force = true)
  }

  /** Rebuilds [styledHint] when the hint text or the body line height changes. */
  private fun updateStyledHint(force: Boolean = false) {
    val lineHeight = textAttributes.effectiveLineHeight
    // compareTo treats NaN (no line height) as equal to itself, unlike !=.
    if (!force && lineHeight.compareTo(styledHintLineHeight) == 0) return

    styledHintLineHeight = lineHeight
    styledHint = userHint?.let { SpannableString(it).apply { applyBodyLineHeightSpan(this, textAttributes) } }
    syncHintVisibility(force = true)
  }

  // Copies the whole input as markdown without disturbing the current selection,
  // tagged so paste restores formatting and block ranges — mirrors iOS, which
  // stores markdown under its custom pasteboard type.
  fun copyToClipboard() {
    val content = text
    if (content.isNullOrEmpty()) return
    val clipboard = context.getSystemService(Context.CLIPBOARD_SERVICE) as? ClipboardManager ?: return
    val markdown = clipboardCoordinator.serializeFullDocument(content.toString(), content)
    clipboard.setPrimaryClip(MarkdownClipboard.newMarkdownClip(markdown, content.toString()))
  }

  // Copy/cut re-tag the clip with markdown and paste restores it, so formatting
  // and block ranges survive the round trip — mirrors iOS's copy:/cut:/paste:
  // overrides. External clips keep default handling.
  override fun onTextContextMenuItem(id: Int): Boolean {
    if (id == android.R.id.paste) {
      MarkdownClipboard.markdownFromClipboard(context)?.let { markdown ->
        pasteMarkdown(markdown)
        return true
      }
      // External plain text is treated as markdown so pasted syntax ("- ", "#",
      // "**") formats instead of landing literal; syntax-free text is unchanged.
      // "Paste as plain text" (pasteAsPlainText) keeps the literal default.
      plainTextFromClipboard()?.let { plainText ->
        pasteMarkdown(plainText)
        return true
      }
    }
    if (id == android.R.id.copy || id == android.R.id.cut) {
      val selStart = selectionStart
      val selEnd = selectionEnd
      val plainText = if (selStart < selEnd) text?.substring(selStart, selEnd) else null
      val markdown = markdownForSelectedRange()
      val handled = super.onTextContextMenuItem(id)
      if (handled && markdown != null && plainText != null) {
        val clipboard = context.getSystemService(Context.CLIPBOARD_SERVICE) as? ClipboardManager
        clipboard?.setPrimaryClip(MarkdownClipboard.newMarkdownClip(markdown, plainText))
      }
      return handled
    }
    return super.onTextContextMenuItem(id)
  }

  fun markdownForSelectedRange(): String? {
    val fullText = text?.toString() ?: return null
    return clipboardCoordinator.serializeSelectedRange(fullText, selectionStart, selectionEnd, text)
  }

  private fun plainTextFromClipboard(): String? {
    val clipboard = context.getSystemService(Context.CLIPBOARD_SERVICE) as? ClipboardManager ?: return null
    val item = clipboard.primaryClip?.takeIf { it.itemCount > 0 }?.getItemAt(0) ?: return null
    return item.coerceToText(context)?.toString()?.takeIf { it.isNotEmpty() }
  }

  /**
   * Replaces the selection with parsed markdown, importing its inline formatting
   * and block ranges (headings etc.) into the stores — mirrors iOS pasteMarkdown.
   *
   * Insertion is literal: the string's characters land at the cursor exactly as
   * given. Markdown parsing consumes leading and trailing newlines as block
   * structure, so they are split off before the parse and re-attached verbatim;
   * without this, insertText("\n- item\n") mid-paragraph would merge the list
   * line with the surrounding text. Callers decide separation by including (or
   * omitting) newlines in the string.
   */
  fun pasteMarkdown(markdown: String) {
    val editable = text ?: return
    val prefix = markdown.takeWhile { it == '\n' }
    val suffix = if (markdown.length > prefix.length) markdown.takeLastWhile { it == '\n' } else ""
    val core = markdown.substring(prefix.length, markdown.length - suffix.length)
    val parsed = InputParser.parseToPlainTextAndRanges(core)
    val selStart = selectionStart.coerceIn(0, editable.length)
    val selEnd = selectionEnd.coerceIn(selStart, editable.length)

    val plainText = prefix + parsed.plainText + suffix
    val contentStart = selStart + prefix.length

    replaceTextInRange(selStart, selEnd, plainText) { editable ->
      for (range in parsed.formattingRanges) {
        formattingStore.addRange(
          FormattingRange(range.type, range.start + contentStart, range.end + contentStart, range.url),
        )
      }
      for (block in parsed.blockRanges) {
        blockStore.setBlock(block.type, block.level, block.start + contentStart, block.end + contentStart, editable)
      }
      setSelection(selStart + plainText.length)
      detectorPipeline.processTextChange(editable, editable.toString(), selStart, plainText.length)
    }
  }

  /** Toggles a heading (H1-H6) on the cursor's paragraph(s); the active level toggles back to a paragraph. */
  fun toggleHeading(level: Int) {
    val blockType = BlockType.forHeadingLevel(level) ?: return
    toggleBlockType(blockType, level)
  }

  private fun toggleBlockType(
    type: BlockType,
    level: Int,
  ) {
    val editable = text ?: return
    val selStart = selectionStart.coerceIn(0, editable.length)
    val selEnd = selectionEnd.coerceIn(selStart, editable.length)
    blockCoordinator.toggleBlock(editable, type, level, selStart, selEnd)
    // Resize the caret first: on an empty heading line the measured height comes
    // from the paint's text size.
    syncCursorSizeWithBlock()
    applyFormattingAndEmit()
  }

  private fun blockOnParagraphAt(pos: Int): BlockRange? {
    val editable = text ?: return null
    return blockCoordinator.blockAtPosition(editable, pos)
  }

  private fun listBlockStartingAt(lineStart: Int): BlockRange? = blockCoordinator.listBlockAtLineStart(lineStart)

  fun headingLevelAtCursor(): Int {
    val editable = text ?: return 0
    return blockCoordinator.headingLevelAtPosition(editable, selectionStart)
  }

  fun linkForSelection(
    start: Int,
    end: Int,
  ): FormattingRange? = linkCoordinator.linkForSelection(start, end)

  /**
   * On empty text with a heading block, overrides text size to the heading's
   * font size so the cursor matches heading height. Hides the hint while
   * active. Cleared automatically when text is typed or heading is toggled off.
   */
  private fun syncCursorSizeWithBlock() {
    val editable = text ?: return
    val block = blockOnParagraphAt(selectionStart)

    if (block != null && block.type in BlockType.HEADINGS && editable.isEmpty()) {
      val headingSizePx = formatter.resolveHeadingFontSizePx(block.level) ?: return
      if (bodySizeBeforeHeadingOverridePx == null) {
        bodySizeBeforeHeadingOverridePx = paint.textSize
        baseHintColor = currentHintTextColor
        setHintTextColor(Color.TRANSPARENT)
      }
      if (paint.textSize != headingSizePx) {
        setTextSize(TypedValue.COMPLEX_UNIT_PX, headingSizePx)
      }
    } else {
      bodySizeBeforeHeadingOverridePx?.let { bodySizePx ->
        setTextSize(TypedValue.COMPLEX_UNIT_PX, bodySizePx)
        bodySizeBeforeHeadingOverridePx = null
        baseHintColor?.let { setHintTextColor(it) }
        baseHintColor = null
      }
    }
  }

  fun setLinkForSelection(url: String) {
    setLinkForRange(url, selectionStart, selectionEnd)
  }

  fun setLinkForRange(
    url: String,
    start: Int,
    end: Int,
  ) {
    if (!linkCoordinator.setLinkUrl(url, start, end, text)) return
    applyFormattingAndEmit()
  }

  /** Parses the given markdown and inserts it at the cursor, replacing any selection. */
  fun insertTextAtCursor(markdown: String) {
    if (markdown.isEmpty()) return
    pasteMarkdown(markdown)
  }

  fun insertLinkAtCursor(
    displayText: String,
    url: String,
  ) {
    val selStart = selectionStart
    val selEnd = selectionEnd
    val linkEnd = selStart + displayText.length

    replaceTextInRange(selStart, selEnd, displayText) { editable ->
      linkCoordinator.addLink(url, selStart, linkEnd, editable)
      setSelection(linkEnd)
    }
  }

  fun insertMention(
    displayText: String,
    url: String,
  ) {
    if (displayText.isEmpty()) return
    val indicator = mentionCoordinator.currentIndicator ?: return
    val start = mentionCoordinator.currentStart
    val end = mentionCoordinator.currentEnd
    val editable = text ?: return
    if (start < 0 || end < start || end > editable.length) return

    val shouldAppendSpace = end >= editable.length || !editable[end].isWhitespace()
    val replacement = if (shouldAppendSpace) "$displayText " else displayText
    val linkEnd = start + displayText.length

    replaceTextInRange(start, end, replacement) { ed ->
      linkCoordinator.addLink(url, start, linkEnd, ed)
      dispatchMentionEvents(mentionCoordinator.clear(indicatorOverride = indicator))
      setSelection(start + replacement.length)
    }
  }

  fun startMention(indicator: String) {
    if (indicator.isEmpty() || !mentionCoordinator.containsIndicator(indicator)) return
    val selStart = selectionStart
    val selEnd = selectionEnd

    replaceTextInRange(selStart, selEnd, indicator) {
      setSelection(selStart + indicator.length)
    }
    dispatchMentionUpdate()
  }

  fun removeLinkAtCursor() {
    if (!linkCoordinator.removeLink(selectionStart, selectionEnd)) return
    applyFormattingAndEmit()
  }

  fun deleteLinkBeforeCursor(): Boolean {
    val cursorStart = selectionStart
    val cursorEnd = selectionEnd
    if (cursorStart != cursorEnd || cursorStart <= 0) return false
    if (text == null) return false

    val linkRange = linkCoordinator.linkRangeForDeletion(cursorStart) ?: return false

    replaceTextInRange(linkRange.start, linkRange.end, "") { editable ->
      setSelection(linkRange.start.coerceAtMost(editable.length))
    }
    dispatchMentionEvents(mentionCoordinator.clear())
    return true
  }

  fun setMentionIndicators(indicators: List<String>) {
    dispatchMentionEvents(mentionCoordinator.setIndicators(indicators))
    dispatchMentionUpdate()
  }

  fun dismissActiveMention() {
    mentionCoordinator.clear(emit = false)
  }

  fun setContextMenuItems(items: List<String>) {
    contextMenu.setContextMenuItems(items)
  }

  fun setLinkRegex(config: LinkRegexConfig) {
    autoLinkDetector.setRegexConfig(config)
  }

  fun setAutoLinkStyle(style: InputFormatterStyle) {
    autoLinkDetector.style = style
  }

  /**
   * Applies the parsed `markdownStyle` (which now carries `list.itemSpacing`).
   * Display density is folded in at [InputFormatter] construction, so the style is
   * handed to the formatter as-is. Formatting is re-applied in [afterUpdateTransaction]
   * if the effective style changed.
   */
  fun setMarkdownStyleFromProps(style: InputFormatterStyle) {
    setAutoLinkStyle(style)
    if (formatter.updateStyle(style)) formattingDirty = true
  }

  fun allFormattingRangesForSerialization(): List<FormattingRange> = clipboardCoordinator.allRangesForSerialization(text)

  fun setValueFromJS(markdown: String) {
    val parsed = InputParser.parseToPlainTextAndRanges(markdown)
    editSession.scoped(EditPhase.Importing) {
      formattingStore.clearAll()
      formattingStore.setRanges(parsed.formattingRanges)
      blockStore.setRanges(parsed.blockRanges)
      setText(parsed.plainText)
      setSelection(text?.length ?: 0)
      zwspAnchorCount = 0
      applyFormatting()
      forceScrollToSelection()
      // No invalidateLayout() needed: applyFormatting() already re-measures.
      lastProcessedText = text?.toString() ?: ""
    }
    emitSelectionIfChanged()
  }

  override fun setBackgroundColor(color: Int) {
    BackgroundStyleApplicator.setBackgroundColor(this, color)
  }

  fun setFontSizeFromProps(size: Float) {
    if (size <= 0f) return
    textAttributes.fontSize = size
    val sizePx = ceil(PixelUtil.toPixelFromSP(size))
    setTextSize(TypedValue.COMPLEX_UNIT_PX, sizePx)
    // Heading line heights are derived from the body font size.
    formattingDirty = true
  }

  fun setLineHeightFromProps(lineHeight: Float) {
    // Mirrors React Native TextInput: lineHeight stays in SP on TextAttributes
    // and is applied as a span on the text rather than through setLineSpacing:
    // https://github.com/react/react-native/blob/v0.86.2/packages/react-native/ReactAndroid/src/main/java/com/facebook/react/views/textinput/ReactEditText.kt#L332-L334
    // https://github.com/react/react-native/blob/v0.86.2/packages/react-native/ReactAndroid/src/main/java/com/facebook/react/views/textinput/ReactEditText.kt#L856-L858
    textAttributes.lineHeight = if (lineHeight > 0f) lineHeight else Float.NaN
    formattingDirty = true
  }

  fun setColorFromProps(colorInt: Int?) {
    setTextColor(colorInt ?: Color.BLACK)
  }

  fun setCursorColorFromProps(colorInt: Int?) {
    if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
      val cursorDrawable = textCursorDrawable ?: return
      if (colorInt != null) {
        cursorDrawable.colorFilter = BlendModeColorFilter(colorInt, BlendMode.SRC_IN)
      } else {
        cursorDrawable.clearColorFilter()
      }
      textCursorDrawable = cursorDrawable
    }
  }

  fun setFontFamily(family: String?) {
    if (family != fontFamilyValue) {
      fontFamilyValue = family
      typefaceDirty = true
    }
  }

  fun setFontWeight(weight: String?) {
    val parsed = ReactTypefaceUtils.parseFontWeight(weight)
    if (parsed != fontWeightValue) {
      fontWeightValue = parsed
      typefaceDirty = true
    }
  }

  /** Returns true if the typeface changed. */
  private fun updateTypeface(): Boolean {
    if (!typefaceDirty) return false
    typefaceDirty = false

    val newTypeface =
      ReactTypefaceUtils.applyStyles(
        typeface,
        ReactConstants.UNSET,
        fontWeightValue,
        fontFamilyValue,
        context.assets,
      )
    typeface = newTypeface
    paint.typeface = newTypeface
    return true
  }

  fun setAutoCapitalize(flagName: String?) {
    AutoCapitalizeUtils.apply(this, flagName)
  }

  /**
   * Programmatic focus for ref.focus() and for the focus command that the JS
   * pressability onPress sends on finger-up (including after a long-press word
   * select).
   *
   * Matches ReactEditText.requestFocusProgrammatically: request focus and show
   * the keyboard without touching the selection, so a long-press word selection
   * isn't collapsed:
   * https://github.com/react/react-native/blob/v0.86.2/packages/react-native/ReactAndroid/src/main/java/com/facebook/react/views/textinput/ReactEditText.kt#L396-L402
   */
  fun requestFocusProgrammatically(): Boolean {
    val focused = super.requestFocus(FOCUS_DOWN, null)
    if (isInTouchMode && showSoftInputOnFocus) {
      inputMethodManager?.showSoftInput(this, 0)
    }
    return focused
  }

  private fun showAutoFocusKeyboardIfPending() {
    if (!pendingAutoFocusKeyboard || !hasWindowFocus()) return
    pendingAutoFocusKeyboard = false
    inputMethodManager?.showSoftInput(this, 0)
  }

  /** Called after props updates */
  fun afterUpdateTransaction() {
    val typefaceChanged = updateTypeface()
    // Props that affect formatting only mark it dirty, so a transaction that
    // changes several of them restamps spans and re-measures once.
    if (formattingDirty) {
      applyFormatting()
    } else if (typefaceChanged) {
      layoutManager.invalidateLayout()
    }
    if (autoFocusRequested) {
      autoFocusRequested = false
      pendingAutoFocusKeyboard = true
      post {
        // afterUpdateTransaction runs before onAttachedToWindow, where requestFocus()/showSoftInput()
        // are dropped and setTextIsSelectable(true) would reset the caret to 0. Defer to the next loop
        // so focus sticks and the caret lands at end (matching iOS).
        requestFocus()
        setSelection(text?.length ?: 0)
        showAutoFocusKeyboardIfPending()
      }
    }
  }

  fun applyStyleToRange(
    styleType: StyleType,
    start: Int,
    end: Int,
  ) {
    if (start >= end) return
    val handler = formatter.handlers[styleType] ?: return
    formattingStore.toggleStyle(styleType, start, end, handler.mergingConfig.conflictingStyles)
    applyFormattingAndEmit()
  }

  private fun dispatchMentionUpdate() {
    dispatchMentionEvents(mentionCoordinator.update(text?.toString(), selectionStart, selectionEnd))
  }

  private fun dispatchMentionEvents(events: List<MentionEvent>) {
    for (event in events) {
      when (event) {
        is MentionEvent.Start -> eventEmitter.emitStartMention(event.indicator)
        is MentionEvent.Change -> eventEmitter.emitChangeMention(event.indicator, event.text)
        is MentionEvent.End -> eventEmitter.emitEndMention(event.indicator)
      }
    }
  }

  companion object {
    private val TAG: String = EnrichedMarkdownTextInputView::class.java.simpleName
  }
}

/** Copy of the body text attributes the input uses, safe to keep after the original changes. */
internal fun TextAttributes.copy(): TextAttributes {
  val source = this
  return TextAttributes().apply {
    allowFontScaling = source.allowFontScaling
    fontSize = source.fontSize
    lineHeight = source.lineHeight
  }
}
