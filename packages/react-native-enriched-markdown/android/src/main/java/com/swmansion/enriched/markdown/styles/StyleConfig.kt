package com.swmansion.enriched.markdown.styles

import android.content.Context
import android.content.res.AssetManager
import android.graphics.Typeface
import com.facebook.react.bridge.ReadableMap
import com.facebook.react.common.ReactConstants
import com.facebook.react.views.text.ReactTypefaceUtils.applyStyles
import com.facebook.react.views.text.ReactTypefaceUtils.parseFontWeight

/**
 * Main style configuration class that parses and caches all markdown element styles.
 * Uses lazy initialization to defer parsing until styles are actually needed,
 * improving startup time for documents that don't use all markdown features.
 */
class StyleConfig(
  private val style: ReadableMap,
  context: Context,
  allowFontScaling: Boolean,
  maxFontSizeMultiplier: Float,
) {
  private val styleParser = StyleParser(context, allowFontScaling, maxFontSizeMultiplier)
  internal val assetManager: AssetManager = context.assets
  private val assets: AssetManager get() = assetManager

  private var paragraphStyleOverride: ParagraphStyle? = null

  val paragraphStyle: ParagraphStyle
    get() = paragraphStyleOverride ?: paragraphStyleDefault

  private val paragraphStyleDefault: ParagraphStyle by lazy {
    val map =
      requireNotNull(style.getMap("paragraph")) {
        "Paragraph style not found. JS should always provide defaults."
      }
    ParagraphStyle.fromReadableMap(map, styleParser)
  }

  /** Runs block with a temporary paragraph style override for table cell rendering. */
  fun <T> withParagraphOverride(
    override: ParagraphStyle,
    block: () -> T,
  ): T {
    paragraphStyleOverride = override
    try {
      return block()
    } finally {
      paragraphStyleOverride = null
    }
  }

  fun tableCellParagraphStyle(
    tableStyle: TableStyle,
    isHeader: Boolean,
  ): ParagraphStyle =
    paragraphStyleDefault.copy(
      fontSize = tableStyle.fontSize,
      fontFamily = if (isHeader && tableStyle.headerFontFamily.isNotEmpty()) tableStyle.headerFontFamily else tableStyle.fontFamily,
      fontWeight = if (isHeader) "bold" else tableStyle.fontWeight,
      color = if (isHeader) tableStyle.headerTextColor else tableStyle.color,
      lineHeight = tableStyle.lineHeight,
      marginTop = 0f,
      marginBottom = 0f,
    )

  val headingStyles: Array<HeadingStyle?> by lazy {
    Array(7) { index ->
      if (index == 0) {
        null
      } else {
        val levelKey = "h$index"
        val map =
          requireNotNull(style.getMap(levelKey)) {
            "Style for $levelKey not found. JS should always provide defaults."
          }
        HeadingStyle.fromReadableMap(map, styleParser)
      }
    }
  }

  // Cache typefaces for heading levels (1-6) - lazily initialized after headingStyles
  // Uses React Native's applyStyles to properly load custom fonts from assets
  val headingTypefaces: Array<Typeface?> by lazy {
    Array(7) { level ->
      if (level == 0) {
        null
      } else {
        val headingStyle = headingStyles[level]
        val fontFamily = headingStyle?.fontFamily?.takeIf { it.isNotEmpty() }
        val fontWeight = parseFontWeight(headingStyle?.fontWeight)

        if (fontFamily != null) {
          // Load the base font at NORMAL so the assets/fonts file resolves, then apply the
          // weight on the real typeface. Requesting the weight up front makes ReactFontManager
          // look for a `_bold` asset variant that single-file custom fonts lack and silently
          // fall back to a default system face. See SpanStyleCache.getTypeface.
          val base = applyStyles(null, ReactConstants.UNSET, ReactConstants.UNSET, fontFamily, assets)
          applyStyles(base, ReactConstants.UNSET, fontWeight, null, assets)
        } else {
          null
        }
      }
    }
  }

  val linkStyle: LinkStyle by lazy {
    val map =
      requireNotNull(style.getMap("link")) {
        "Link style not found. JS should always provide defaults."
      }
    LinkStyle.fromReadableMap(map, styleParser)
  }

  val linkVariants: List<LinkVariantEntry> by lazy {
    val array = style.getArray("linkVariants") ?: return@lazy emptyList()
    (0 until array.size()).mapNotNull { i ->
      array.getMap(i)?.let { LinkVariantEntry.fromReadableMap(it, styleParser) }
    }
  }

  /** Whether any variant can produce a pill; lets per-draw code skip pill lookups. */
  val hasLinkPills: Boolean by lazy { linkVariants.any { it.pill != null } }

  val strongStyle: StrongStyle by lazy {
    val map =
      requireNotNull(style.getMap("strong")) {
        "Strong style not found. JS should always provide defaults."
      }
    StrongStyle.fromReadableMap(map, styleParser)
  }

  val emphasisStyle: EmphasisStyle by lazy {
    val map =
      requireNotNull(style.getMap("em")) {
        "Emphasis style not found. JS should always provide defaults."
      }
    EmphasisStyle.fromReadableMap(map, styleParser)
  }

  val strikethroughStyle: StrikethroughStyle by lazy {
    val map =
      requireNotNull(style.getMap("strikethrough")) {
        "Strikethrough style not found. JS should always provide defaults."
      }
    StrikethroughStyle.fromReadableMap(map, styleParser)
  }

  val underlineStyle: UnderlineStyle by lazy {
    val map =
      requireNotNull(style.getMap("underline")) {
        "Underline style not found. JS should always provide defaults."
      }
    UnderlineStyle.fromReadableMap(map, styleParser)
  }

  val codeStyle: CodeStyle by lazy {
    val map =
      requireNotNull(style.getMap("code")) {
        "Code style not found. JS should always provide defaults."
      }
    CodeStyle.fromReadableMap(map, styleParser)
  }

  val imageStyle: ImageStyle by lazy {
    val map =
      requireNotNull(style.getMap("image")) {
        "Image style not found. JS should always provide defaults."
      }
    ImageStyle.fromReadableMap(map, styleParser)
  }

  var imageRequestHeaders: Map<String, String> = emptyMap()

  /** Per-link pill content keyed by exact URL; content, so it lives outside the style map. */
  var linkPillContent: Map<String, LinkPillContent> = emptyMap()

  val videoStyle: VideoStyle by lazy {
    val map =
      requireNotNull(style.getMap("video")) {
        "Video style not found. JS should always provide defaults."
      }
    VideoStyle.fromReadableMap(map, styleParser)
  }

  val inlineImageStyle: InlineImageStyle by lazy {
    val map =
      requireNotNull(style.getMap("inlineImage")) {
        "InlineImage style not found. JS should always provide defaults."
      }
    InlineImageStyle.fromReadableMap(map, styleParser)
  }

  val blockquoteStyle: BlockquoteStyle by lazy {
    val map =
      requireNotNull(style.getMap("blockquote")) {
        "Blockquote style not found. JS should always provide defaults."
      }
    BlockquoteStyle.fromReadableMap(map, styleParser)
  }

  val listStyle: ListStyle by lazy {
    val map =
      requireNotNull(style.getMap("list")) {
        "List style not found. JS should always provide defaults."
      }
    ListStyle.fromReadableMap(map, styleParser)
  }

  val codeBlockStyle: CodeBlockStyle by lazy {
    val map =
      requireNotNull(style.getMap("codeBlock")) {
        "CodeBlock style not found. JS should always provide defaults."
      }
    CodeBlockStyle.fromReadableMap(map, styleParser)
  }

  val thematicBreakStyle: ThematicBreakStyle by lazy {
    val map =
      requireNotNull(style.getMap("thematicBreak")) {
        "ThematicBreak style not found. JS should always provide defaults."
      }
    ThematicBreakStyle.fromReadableMap(map, styleParser)
  }

  val tableStyle: TableStyle by lazy {
    val map =
      requireNotNull(style.getMap("table")) {
        "Table style not found. JS should always provide defaults."
      }
    TableStyle.fromReadableMap(map, styleParser)
  }

  val taskListStyle: TaskListStyle by lazy {
    val map =
      requireNotNull(style.getMap("taskList")) {
        "TaskList style not found. JS should always provide defaults."
      }
    TaskListStyle.fromReadableMap(map, styleParser)
  }

  val mathStyle: MathStyle by lazy {
    val map =
      requireNotNull(style.getMap("math")) {
        "Math style not found. JS should always provide defaults."
      }
    MathStyle.fromReadableMap(map, styleParser)
  }

  val inlineMathStyle: InlineMathStyle by lazy {
    val map =
      requireNotNull(style.getMap("inlineMath")) {
        "InlineMath style not found. JS should always provide defaults."
      }
    InlineMathStyle.fromReadableMap(map, styleParser)
  }

  val spoilerStyle: SpoilerStyle by lazy {
    val map =
      requireNotNull(style.getMap("spoiler")) {
        "Spoiler style not found. JS should always provide defaults."
      }
    SpoilerStyle.fromReadableMap(map, styleParser)
  }

  val superscriptStyle: SuperscriptStyle by lazy {
    val map =
      requireNotNull(style.getMap("superscript")) {
        "Superscript style not found. JS should always provide defaults."
      }
    SuperscriptStyle.fromReadableMap(map)
  }

  val subscriptStyle: SubscriptStyle by lazy {
    val map =
      requireNotNull(style.getMap("subscript")) {
        "Subscript style not found. JS should always provide defaults."
      }
    SubscriptStyle.fromReadableMap(map)
  }

  val highlightStyle: HighlightStyle by lazy {
    val map =
      requireNotNull(style.getMap("highlight")) {
        "Highlight style not found. JS should always provide defaults."
      }
    HighlightStyle.fromReadableMap(map, styleParser)
  }

  val tableTypeface: Typeface? by lazy {
    val fontFamily = tableStyle.fontFamily.takeIf { it.isNotEmpty() }
    val fontWeight = parseFontWeight(tableStyle.fontWeight)
    if (fontFamily != null) {
      applyStyles(null, ReactConstants.UNSET, fontWeight, fontFamily, assets)
    } else {
      null
    }
  }

  val tableHeaderTypeface: Typeface? by lazy {
    val headerFamily = tableStyle.headerFontFamily.takeIf { it.isNotEmpty() }
    val baseFamily = tableStyle.fontFamily.takeIf { it.isNotEmpty() }

    when {
      // 1. Try Header font (specific variant)
      headerFamily != null -> {
        applyStyles(null, ReactConstants.UNSET, parseFontWeight("normal"), headerFamily, assets)
      }

      // 2. Try Table font (forced to bold)
      baseFamily != null -> {
        applyStyles(null, ReactConstants.UNSET, parseFontWeight("bold"), baseFamily, assets)
      }

      // 3. System Fallback
      else -> {
        Typeface.DEFAULT_BOLD
      }
    }
  }

  /**
   * Returns true if any paragraph or heading style uses justify alignment.
   * Used to enable justification mode on the TextView (API 26+).
   */
  val needsJustify: Boolean by lazy {
    paragraphStyle.textAlign.needsJustify ||
      headingStyles.filterNotNull().any { it.textAlign.needsJustify }
  }

  override fun equals(other: Any?): Boolean {
    if (this === other) return true
    if (other !is StyleConfig) return false

    return paragraphStyle == other.paragraphStyle &&
      headingStyles.contentEquals(other.headingStyles) &&
      linkStyle == other.linkStyle &&
      linkVariants == other.linkVariants &&
      strongStyle == other.strongStyle &&
      emphasisStyle == other.emphasisStyle &&
      strikethroughStyle == other.strikethroughStyle &&
      underlineStyle == other.underlineStyle &&
      codeStyle == other.codeStyle &&
      imageStyle == other.imageStyle &&
      videoStyle == other.videoStyle &&
      inlineImageStyle == other.inlineImageStyle &&
      blockquoteStyle == other.blockquoteStyle &&
      listStyle == other.listStyle &&
      codeBlockStyle == other.codeBlockStyle &&
      thematicBreakStyle == other.thematicBreakStyle &&
      tableStyle == other.tableStyle &&
      taskListStyle == other.taskListStyle &&
      mathStyle == other.mathStyle &&
      inlineMathStyle == other.inlineMathStyle &&
      spoilerStyle == other.spoilerStyle &&
      superscriptStyle == other.superscriptStyle &&
      subscriptStyle == other.subscriptStyle &&
      highlightStyle == other.highlightStyle &&
      imageRequestHeaders == other.imageRequestHeaders &&
      linkPillContent == other.linkPillContent
  }

  override fun hashCode(): Int {
    var result = paragraphStyle.hashCode()
    result = 31 * result + headingStyles.contentHashCode()
    result = 31 * result + linkStyle.hashCode()
    result = 31 * result + linkVariants.hashCode()
    result = 31 * result + strongStyle.hashCode()
    result = 31 * result + emphasisStyle.hashCode()
    result = 31 * result + strikethroughStyle.hashCode()
    result = 31 * result + underlineStyle.hashCode()
    result = 31 * result + codeStyle.hashCode()
    result = 31 * result + imageStyle.hashCode()
    result = 31 * result + videoStyle.hashCode()
    result = 31 * result + inlineImageStyle.hashCode()
    result = 31 * result + blockquoteStyle.hashCode()
    result = 31 * result + listStyle.hashCode()
    result = 31 * result + codeBlockStyle.hashCode()
    result = 31 * result + thematicBreakStyle.hashCode()
    result = 31 * result + tableStyle.hashCode()
    result = 31 * result + taskListStyle.hashCode()
    result = 31 * result + mathStyle.hashCode()
    result = 31 * result + inlineMathStyle.hashCode()
    result = 31 * result + spoilerStyle.hashCode()
    result = 31 * result + superscriptStyle.hashCode()
    result = 31 * result + subscriptStyle.hashCode()
    result = 31 * result + highlightStyle.hashCode()
    result = 31 * result + imageRequestHeaders.hashCode()
    result = 31 * result + linkPillContent.hashCode()
    return result
  }
}
