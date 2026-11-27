package com.swmansion.enriched.markdown.segments

import android.content.ClipData
import android.content.ClipboardManager
import android.content.Context
import android.graphics.Canvas
import android.graphics.Paint
import android.graphics.Path
import android.graphics.RectF
import android.graphics.Typeface
import android.text.Layout
import android.text.Spannable
import android.text.Spanned
import android.text.StaticLayout
import android.text.TextPaint
import android.text.style.AlignmentSpan
import android.text.style.MetricAffectingSpan
import android.view.Gravity
import android.view.MotionEvent
import android.view.View
import android.widget.FrameLayout
import androidx.core.view.ViewCompat
import com.swmansion.enriched.markdown.accessibility.AccessibilityLabels
import com.swmansion.enriched.markdown.parser.MarkdownASTNode
import com.swmansion.enriched.markdown.parser.MarkdownASTNode.NodeType
import com.swmansion.enriched.markdown.renderer.Renderer
import com.swmansion.enriched.markdown.spans.ImageSpan
import com.swmansion.enriched.markdown.spans.LinkPillSpan
import com.swmansion.enriched.markdown.styles.StyleConfig
import com.swmansion.enriched.markdown.styles.TableStyle
import com.swmansion.enriched.markdown.utils.common.findEnrichedMarkdownAncestor
import com.swmansion.enriched.markdown.utils.common.layout.isLayoutRTL
import com.swmansion.enriched.markdown.utils.common.serialization.MarkdownASTSerializer
import com.swmansion.enriched.markdown.utils.text.conversion.HTMLGenerator
import com.swmansion.enriched.markdown.utils.text.extensions.replaceMathSpansWithPlaceholders
import com.swmansion.enriched.markdown.utils.text.span.prepareWidthAwareSpans
import com.swmansion.enriched.markdown.utils.text.view.LinkLongPressMovementMethod
import com.swmansion.enriched.markdown.utils.text.view.cancelJSTouchForLinkTap
import com.swmansion.enriched.markdown.views.ClaimingHorizontalScrollView
import com.swmansion.enriched.markdown.views.ContextMenuPopup
import kotlin.math.ceil
import kotlin.math.max
import kotlin.math.min

class TableContainerView(
  context: Context,
  private val styleConfig: StyleConfig,
) : FrameLayout(context),
  BlockSegmentView {
  internal val tableStyle: TableStyle = styleConfig.tableStyle

  override val segmentMarginTop: Int get() = tableStyle.marginTop.toInt()
  override val segmentMarginBottom: Int get() = tableStyle.marginBottom.toInt()
  private val density = resources.displayMetrics.density
  private val isRtl = resources.isLayoutRTL()

  var allowFontScaling = true
  var maxFontSizeMultiplier = 0f
  var onLinkPress: ((String, String) -> Unit)? = null
  var onLinkLongPress: ((String) -> Unit)? = null
  var accessibilityLabels: AccessibilityLabels = AccessibilityLabels()
    set(value) {
      if (field == value) return
      field = value
      if (rowCount > 0) renderGrid()
    }

  // Runtime-mutable block props read live at menu-open. See DynamicBlockProps.
  var dynamicProps: DynamicBlockProps = DynamicBlockProps()

  private val scrollView =
    ClaimingHorizontalScrollView(context).apply {
      isHorizontalScrollBarEnabled = true
      overScrollMode = View.OVER_SCROLL_NEVER
      importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_NO
      addView(
        GridContainerView(context).apply {
          importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_NO
        },
      )
    }
  private val gridContainer get() = scrollView.getChildAt(0) as GridContainerView

  val rowCount: Int get() = rows.size

  fun animateNewRows(
    previousRowCount: Int,
    durationMs: Long,
  ) {
    if (rowCount <= previousRowCount) return
    val grid = gridContainer
    val childCount = grid.childCount
    if (childCount == 0 || rowCount == 0) return

    val colCount = childCount / rowCount
    if (colCount == 0) return

    val firstNewCellIndex = previousRowCount * colCount
    for (i in firstNewCellIndex until childCount) {
      val cell = grid.getChildAt(i) ?: continue
      cell.alpha = 0f
      cell
        .animate()
        .alpha(1f)
        .setDuration(durationMs)
        .start()
    }
  }

  private var rows: List<List<TableCellData>> = emptyList()
  private var columnCount = 0
  private var columnWidths = emptyList<Float>()
  private var rowHeights = emptyList<Float>()
  private var totalTableWidth = 0f
  private var totalTableHeight = 0f
  private var tableMarkdown = ""

  init {
    importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_NO
    addView(scrollView, LayoutParams(LayoutParams.MATCH_PARENT, LayoutParams.WRAP_CONTENT))
  }

  fun applyTableNode(tableNode: MarkdownASTNode) {
    rows =
      tableNode.children.flatMap { section ->
        val isSectionHead = section.type == NodeType.TableHead
        section.children.filter { it.type == NodeType.TableRow }.map { row ->
          row.children.map { cell ->
            val isHeader = isSectionHead || cell.type == NodeType.TableHeaderCell
            val align = textAlignmentFromString(cell.getAttribute("align"))
            TableCellData(
              attributedText = renderCellNode(cell, isHeader, align),
              plainText = extractPlainText(cell),
              markdownText = MarkdownASTSerializer.serializeChildren(cell),
              isHeader = isHeader,
              alignment = align,
            )
          }
        }
      }

    columnCount = rows.maxOfOrNull { it.size } ?: 0
    tableMarkdown = buildMarkdownFromRows()

    val (widths, heights) = computeTableDimensions(rows.map { row -> row.map { it.attributedText } }, styleConfig, context)
    columnWidths = widths
    rowHeights = heights
    totalTableWidth = columnWidths.sum() + tableStyle.borderWidth
    totalTableHeight = rowHeights.sum() + tableStyle.borderWidth

    renderGrid()
  }

  private fun renderCellNode(
    node: MarkdownASTNode,
    isHeader: Boolean,
    alignment: Layout.Alignment,
  ): Spannable {
    val paragraph = MarkdownASTNode(NodeType.Paragraph, children = node.children)
    val cellParagraphStyle = styleConfig.tableCellParagraphStyle(tableStyle, isHeader)
    return styleConfig
      .withParagraphOverride(cellParagraphStyle) {
        Renderer().apply { configure(styleConfig, context) }.renderContent(listOf(paragraph), onLinkPress, onLinkLongPress)
      }.apply {
        if (isNotEmpty()) {
          if (isHeader) setSpan(HeaderTypefaceSpan(styleConfig.tableHeaderTypeface ?: Typeface.DEFAULT_BOLD), 0, length, 33)
          if (alignment != Layout.Alignment.ALIGN_NORMAL) setSpan(AlignmentSpan.Standard(alignment), 0, length, 33)
        }
      }
  }

  private fun extractPlainText(node: MarkdownASTNode): String = node.content + node.children.joinToString("") { extractPlainText(it) }

  private fun textAlignmentFromString(align: String?): Layout.Alignment =
    when (align) {
      "center" -> Layout.Alignment.ALIGN_CENTER
      "right" -> if (isRtl) Layout.Alignment.ALIGN_NORMAL else Layout.Alignment.ALIGN_OPPOSITE
      "left" -> if (isRtl) Layout.Alignment.ALIGN_OPPOSITE else Layout.Alignment.ALIGN_NORMAL
      else -> Layout.Alignment.ALIGN_NORMAL
    }

  private fun renderGrid() {
    gridContainer.removeAllViews()
    gridContainer.configure(totalTableWidth, totalTableHeight, tableStyle)

    var yOffset = 0f
    var bodyRowIndex = 0

    rows.forEachIndexed { rowIndex, row ->
      val rowHeight = rowHeights[rowIndex]
      val isHeaderRow = row.firstOrNull()?.isHeader == true
      val rowBg =
        when {
          isHeaderRow -> tableStyle.headerBackgroundColor
          bodyRowIndex % 2 == 0 -> tableStyle.rowEvenBackgroundColor
          else -> tableStyle.rowOddBackgroundColor
        }

      var xOffset = if (isRtl) totalTableWidth - tableStyle.borderWidth else 0f
      for (col in 0 until columnCount) {
        val columnWidth = columnWidths[col]

        val cellX =
          if (isRtl) {
            xOffset -= columnWidth
            xOffset
          } else {
            xOffset
          }

        val cellBg =
          CellBackgroundView(context).apply {
            configure(rowBg, tableStyle.borderColor, tableStyle.borderWidth)
            setOnLongClickListener { view -> showContextMenu(view) }
            importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_NO_HIDE_DESCENDANTS
          }

        gridContainer.addView(
          cellBg,
          LayoutParams(ceil(columnWidth + tableStyle.borderWidth).toInt(), ceil(rowHeight + tableStyle.borderWidth).toInt()).apply {
            leftMargin = ceil(cellX).toInt()
            topMargin = ceil(yOffset).toInt()
          },
        )

        if (col < row.size) addTextToCell(cellBg, row[col], columnWidth, rowHeight)
        if (!isRtl) xOffset += columnWidth
      }

      addRowAccessibilityOverlay(row, rowIndex, isHeaderRow, yOffset, rowHeight)

      if (!isHeaderRow) bodyRowIndex++
      yOffset += rowHeight
    }
    gridContainer.layoutParams = LayoutParams(ceil(totalTableWidth).toInt(), ceil(totalTableHeight).toInt())
  }

  private fun addRowAccessibilityOverlay(
    row: List<TableCellData>,
    rowIndex: Int,
    isHeaderRow: Boolean,
    yOffset: Float,
    rowHeight: Float,
  ) {
    val joinedContent = row.joinToString(", ") { it.plainText }
    val description =
      accessibilityLabels.tableRow
        .replace("{n}", (rowIndex + 1).toString())
        .replace("{content}", joinedContent)

    val overlay =
      View(context).apply {
        isClickable = false
        isLongClickable = false
        isFocusable = true
        ViewCompat.setScreenReaderFocusable(this, true)
        importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_YES
        contentDescription = description
        if (isHeaderRow) ViewCompat.setAccessibilityHeading(this, true)
      }
    gridContainer.addView(
      overlay,
      0,
      LayoutParams(
        ceil(totalTableWidth).toInt(),
        ceil(rowHeight + tableStyle.borderWidth).toInt(),
      ).apply {
        leftMargin = 0
        topMargin = ceil(yOffset).toInt()
      },
    )
  }

  private fun addTextToCell(
    container: CellBackgroundView,
    data: TableCellData,
    width: Float,
    height: Float,
  ) {
    val cellTextView =
      CellTextView(context).apply {
        text = data.attributedText
        textSize = tableStyle.fontSize / resources.displayMetrics.scaledDensity
        typeface = if (data.isHeader) styleConfig.tableHeaderTypeface else styleConfig.tableTypeface
        setTextColor(if (data.isHeader) tableStyle.headerTextColor else tableStyle.color)
        gravity =
          when (data.alignment) {
            Layout.Alignment.ALIGN_CENTER -> Gravity.CENTER_HORIZONTAL
            Layout.Alignment.ALIGN_OPPOSITE -> Gravity.END
            else -> Gravity.START
          }
        setOnLongClickListener { view -> showContextMenu(view) }
      }
    val horizontalPadding = tableStyle.cellPaddingHorizontal
    val verticalPadding = tableStyle.cellPaddingVertical
    container.addView(
      cellTextView,
      LayoutParams(
        (width - horizontalPadding * 2).toInt().coerceAtLeast(1),
        (height - verticalPadding * 2).toInt().coerceAtLeast(1),
      ).apply {
        leftMargin = ceil(horizontalPadding).toInt()
        topMargin = ceil(verticalPadding).toInt()
      },
    )

    data.attributedText
      .getSpans(0, data.attributedText.length, ImageSpan::class.java)
      .forEach { span -> span.registerTextView(cellTextView) { scheduleImageRemeasure() } }
    LinkPillSpan.registerView(data.attributedText, cellTextView) { scheduleImageRemeasure() }
  }

  private var imageRemeasurePending = false

  private fun scheduleImageRemeasure() {
    if (imageRemeasurePending) return
    imageRemeasurePending = true
    post {
      imageRemeasurePending = false
      remeasureForImageLoad()
    }
  }

  private fun remeasureForImageLoad() {
    if (rows.isEmpty()) return
    val (widths, heights) =
      computeTableDimensions(rows.map { row -> row.map { it.attributedText } }, styleConfig, context)
    if (widths == columnWidths && heights == rowHeights) return

    columnWidths = widths
    rowHeights = heights
    totalTableWidth = columnWidths.sum() + tableStyle.borderWidth
    totalTableHeight = rowHeights.sum() + tableStyle.borderWidth
    renderGrid()
    requestLayout()

    findEnrichedMarkdownAncestor()?.onImageLayoutChanged()
  }

  override fun onMeasure(
    widthSpec: Int,
    heightSpec: Int,
  ) {
    val measuredWidth = MeasureSpec.getSize(widthSpec)
    val measuredHeight = ceil(totalTableHeight).toInt()
    scrollView.measure(
      MeasureSpec.makeMeasureSpec(measuredWidth, MeasureSpec.EXACTLY),
      MeasureSpec.makeMeasureSpec(measuredHeight, MeasureSpec.EXACTLY),
    )
    setMeasuredDimension(measuredWidth, measuredHeight)
  }

  override fun onLayout(
    changed: Boolean,
    left: Int,
    top: Int,
    right: Int,
    bottom: Int,
  ) {
    val viewWidth = right - left
    val overhang = max(ceil(tableStyle.horizontalOverflow.toDouble()).toInt(), 0)
    val contentWidth = viewWidth - overhang * 2
    val tableOverflows = totalTableWidth > contentWidth

    scrollView.setPadding(overhang, 0, overhang, 0)
    scrollView.clipToPadding = !tableOverflows
    scrollView.isHorizontalScrollBarEnabled = tableOverflows

    scrollView.layout(0, 0, viewWidth, bottom - top)

    gridContainer.translationX =
      if (tableStyle.align.isNotEmpty() && !tableOverflows) {
        val freeSpace = max(contentWidth - totalTableWidth, 0f)
        val desiredLeft =
          overhang +
            when (tableStyle.align) {
              "center" -> freeSpace / 2f
              "right" -> freeSpace
              else -> 0f
            }
        desiredLeft - gridContainer.left
      } else {
        0f
      }

    if (isRtl) {
      val effectiveWidth = if (tableOverflows) contentWidth.toFloat() else viewWidth.toFloat()
      if (totalTableWidth > effectiveWidth) {
        scrollView.scrollTo((totalTableWidth - effectiveWidth).toInt(), 0)
      }
    }
  }

  private fun showContextMenu(anchor: View): Boolean {
    if (!dynamicProps.enableBlockContextMenu) return false
    val clipboard = context.getSystemService(Context.CLIPBOARD_SERVICE) as ClipboardManager
    ContextMenuPopup.show(anchor, this) {
      item(ContextMenuPopup.Icon.COPY, dynamicProps.copyLabel) {
        val plainText = rows.joinToString("\n") { row -> row.joinToString("\t") { it.plainText } }
        if (plainText.isNotEmpty()) {
          val displayMetrics = context.resources.displayMetrics
          val tableRows =
            rows.map { row ->
              row.map { cell -> Triple(cell.attributedText as CharSequence, cell.isHeader, cell.alignment) }
            }
          val html = HTMLGenerator.generateTableHTML(tableRows, styleConfig, displayMetrics.scaledDensity, displayMetrics.density)
          clipboard.setPrimaryClip(ClipData.newHtmlText("Table", plainText, html))
        }
      }
      item(ContextMenuPopup.Icon.DOCUMENT, dynamicProps.copyAsMarkdownLabel) {
        if (tableMarkdown.isNotEmpty()) clipboard.setPrimaryClip(ClipData.newPlainText("Table", tableMarkdown))
      }
    }
    return true
  }

  private fun buildMarkdownFromRows(): String =
    rows.joinToString("") { row ->
      val line = "| ${row.joinToString(" | ") { it.markdownText }} |\n"
      if (row.firstOrNull()?.isHeader == true) {
        val sep = "| ${row.joinToString(" | ") {
          when (it.alignment) {
            Layout.Alignment.ALIGN_CENTER -> ":---:"
            Layout.Alignment.ALIGN_OPPOSITE -> "---:"
            else -> "---"
          }
        }} |\n"
        line + sep
      } else {
        line
      }
    }

  companion object {
    private class HeaderTypefaceSpan(
      private val typeface: Typeface,
    ) : MetricAffectingSpan() {
      override fun updateDrawState(paint: TextPaint) {
        paint.typeface = typeface
      }

      override fun updateMeasureState(paint: TextPaint) {
        paint.typeface = typeface
      }
    }

    private fun cellHasBlockImage(text: CharSequence): Boolean {
      val spanned = text as? Spanned ?: return false
      return spanned.getSpans(0, spanned.length, ImageSpan::class.java).any { !it.isInline }
    }

    private fun computeTableDimensions(
      texts: List<List<CharSequence>>,
      config: StyleConfig,
      context: Context,
    ): Pair<List<Float>, List<Float>> {
      val style = config.tableStyle
      val density = context.resources.displayMetrics.density
      val (minColumnWidth, maxColumnWidth) = 60f * density to 300f * density
      val (horizontalPadding, verticalPadding) = style.cellPaddingHorizontal * 2 to style.cellPaddingVertical * 2
      val paint =
        TextPaint(Paint.ANTI_ALIAS_FLAG).apply {
          textSize = style.fontSize
          typeface = config.tableTypeface
        }

      val columnWidths = FloatArray(texts.maxOfOrNull { it.size } ?: 0)
      texts.forEach { row ->
        row.forEachIndexed { colIndex, cellText ->
          // Images are sized in the row pass below, once the column width is known.
          prepareWidthAwareSpans(cellText, maxColumnWidth.toInt(), includeImages = false)
          val layout =
            StaticLayout.Builder
              .obtain(cellText, 0, cellText.length, paint, maxColumnWidth.toInt())
              .setIncludePad(false)
              .build()
          val textWidth: Float = (0 until layout.lineCount).maxOfOrNull { line -> layout.getLineWidth(line) } ?: 0f
          val effectiveWidth = if (cellHasBlockImage(cellText)) maxColumnWidth else ceil(textWidth)
          columnWidths[colIndex] =
            max(columnWidths[colIndex], min(max(effectiveWidth + horizontalPadding, minColumnWidth), maxColumnWidth + horizontalPadding))
        }
      }

      val rowHeights =
        texts.map { row ->
          row
            .mapIndexed { colIndex, cellText ->
              val contentWidth = (columnWidths[colIndex] - horizontalPadding).toInt().coerceAtLeast(1)
              prepareWidthAwareSpans(cellText, contentWidth)
              val layout =
                StaticLayout.Builder
                  .obtain(
                    cellText,
                    0,
                    cellText.length,
                    paint,
                    contentWidth,
                  ).setIncludePad(false)
                  .build()
              ceil(layout.height.toFloat()) + verticalPadding
            }.maxOfOrNull { it } ?: 0f
        }
      return columnWidths.toList() to rowHeights
    }

    fun measureTableNodeHeight(
      node: MarkdownASTNode,
      config: StyleConfig,
      context: Context,
    ): Float {
      val tableStyle = config.tableStyle
      val headerTypeface = config.tableHeaderTypeface ?: Typeface.DEFAULT_BOLD
      val texts =
        node.children.flatMap { section ->
          section.children.filter { it.type == NodeType.TableRow }.map { row ->
            row.children.map { cell ->
              val isHeader = section.type == NodeType.TableHead || cell.type == NodeType.TableHeaderCell
              val paragraph = MarkdownASTNode(NodeType.Paragraph, children = cell.children)
              val cellParagraphStyle = config.tableCellParagraphStyle(tableStyle, isHeader)
              val styledText =
                config.withParagraphOverride(cellParagraphStyle) {
                  Renderer()
                    .apply { configure(config, context) }
                    .renderContent(listOf(paragraph), null, null)
                }
              styledText.replaceMathSpansWithPlaceholders(context)
              if (isHeader && styledText.isNotEmpty()) {
                styledText.setSpan(HeaderTypefaceSpan(headerTypeface), 0, styledText.length, 33)
              }
              styledText
            }
          }
        }
      if (texts.isEmpty()) return 0f
      val (_, heights) = computeTableDimensions(texts, config, context)
      return heights.sum() + tableStyle.borderWidth
    }
  }

  private class GridContainerView(
    context: Context,
  ) : FrameLayout(context) {
    private var radius = 0f
    private val paint = Paint(Paint.ANTI_ALIAS_FLAG).apply { style = Paint.Style.STROKE }
    private val path = Path()
    private val rect = RectF()

    init {
      layoutDirection = View.LAYOUT_DIRECTION_LTR
    }

    fun configure(
      tableWidth: Float,
      tableHeight: Float,
      style: TableStyle,
    ) {
      radius = style.borderRadius
      paint.color = style.borderColor
      paint.strokeWidth = style.borderWidth
    }

    override fun dispatchDraw(canvas: Canvas) {
      rect.set(0f, 0f, width.toFloat(), height.toFloat())
      if (radius > 0f) {
        path.apply {
          reset()
          addRoundRect(rect, radius, radius, Path.Direction.CW)
        }
        canvas.save()
        canvas.clipPath(path)
        super.dispatchDraw(canvas)
        canvas.restore()
        val halfStroke = paint.strokeWidth / 2
        rect.inset(halfStroke, halfStroke)
        canvas.drawRoundRect(rect, radius, radius, paint)
      } else {
        super.dispatchDraw(canvas)
        canvas.drawRect(rect, paint)
      }
    }
  }

  private class CellBackgroundView(
    context: Context,
  ) : FrameLayout(context) {
    private val backgroundPaint = Paint(Paint.ANTI_ALIAS_FLAG)
    private val borderPaint = Paint(Paint.ANTI_ALIAS_FLAG).apply { style = Paint.Style.STROKE }

    fun configure(
      backgroundColor: Int,
      borderColor: Int,
      borderWidth: Float,
    ) {
      backgroundPaint.color = backgroundColor
      borderPaint.color = borderColor
      borderPaint.strokeWidth = borderWidth
    }

    override fun dispatchDraw(canvas: Canvas) {
      canvas.drawRect(0f, 0f, width.toFloat(), height.toFloat(), backgroundPaint)
      if (borderPaint.strokeWidth > 0f) {
        val halfStroke = borderPaint.strokeWidth / 2
        canvas.drawRect(halfStroke, halfStroke, width.toFloat() - halfStroke, height.toFloat() - halfStroke, borderPaint)
      }
      super.dispatchDraw(canvas)
    }
  }

  private class CellTextView(
    context: Context,
  ) : androidx.appcompat.widget.AppCompatTextView(context) {
    init {
      setPadding(0, 0, 0, 0)
      includeFontPadding = false
      movementMethod = LinkLongPressMovementMethod.createInstance()
      layoutDirection = View.LAYOUT_DIRECTION_LOCALE
      textDirection = View.TEXT_DIRECTION_LOCALE
      importantForAccessibility = View.IMPORTANT_FOR_ACCESSIBILITY_NO
    }

    override fun onTouchEvent(event: MotionEvent): Boolean {
      val result = super.onTouchEvent(event)
      if (event.action == MotionEvent.ACTION_DOWN) cancelJSTouchForLinkTap(event)
      return result
    }
  }

  private data class TableCellData(
    val attributedText: Spannable,
    val plainText: String,
    val markdownText: String,
    val isHeader: Boolean,
    val alignment: Layout.Alignment,
  )
}
