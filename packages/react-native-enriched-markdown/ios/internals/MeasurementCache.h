#pragma once

#include <CoreGraphics/CGBase.h>
#include <React/RCTUtils.h>
#include <list>
#include <mutex>
#include <react/renderer/graphics/Float.h>
#include <string>
#include <tuple>
#include <unordered_map>

namespace facebook::react {

struct HashUtils {

  static inline size_t combine(size_t h, size_t v)
  {
    return h ^ (v + 0x9e3779b97f4a7c15ULL + (h << 6) + (h >> 2));
  }

  template <typename T> static inline void hash_one(size_t &seed, const T &v)
  {
    seed = combine(seed, std::hash<T>{}(v));
  }
};

enum class MarkdownFlavor : uint8_t {
  CommonMark = 0,
  GitHub = 1,
};

struct MeasurementCacheKey {
  std::string markdown;
  CGFloat maxWidth;
  bool allowTrailingMargin;
  bool allowFontScaling;
  double maxFontSizeMultiplier;
  bool md4cFlagsUnderline;
  bool md4cFlagsSuperscript;
  bool md4cFlagsSubscript;
  bool md4cFlagsHighlight;
  bool md4cFlagsLatexMath;
  bool md4cFlagsHardSoftBreaks;
  bool md4cFlagsPreserveBlankLines;
  bool md4cFlagsAdmonitions;
  size_t styleFingerprint;
  size_t linkPillContentFingerprint;
  CGFloat fontScale;
  MarkdownFlavor flavor;
  std::string lineBreakStrategyIOS;
  std::string writingDirection;
  int numberOfLines;
  std::string ellipsizeMode;
  std::string linkRegexKey;
  std::string inlineCodeLinkRegexKey;

  bool operator==(const MeasurementCacheKey &other) const
  {
    return std::tie(markdown, maxWidth, allowTrailingMargin, allowFontScaling, maxFontSizeMultiplier,
                    md4cFlagsUnderline, md4cFlagsSuperscript, md4cFlagsSubscript, md4cFlagsHighlight,
                    md4cFlagsLatexMath, md4cFlagsHardSoftBreaks, md4cFlagsPreserveBlankLines, md4cFlagsAdmonitions,
                    styleFingerprint, linkPillContentFingerprint, fontScale, flavor, lineBreakStrategyIOS,
                    writingDirection, numberOfLines, ellipsizeMode, linkRegexKey, inlineCodeLinkRegexKey) ==
           std::tie(other.markdown, other.maxWidth, other.allowTrailingMargin, other.allowFontScaling,
                    other.maxFontSizeMultiplier, other.md4cFlagsUnderline, other.md4cFlagsSuperscript,
                    other.md4cFlagsSubscript, other.md4cFlagsHighlight, other.md4cFlagsLatexMath,
                    other.md4cFlagsHardSoftBreaks, other.md4cFlagsPreserveBlankLines, other.md4cFlagsAdmonitions,
                    other.styleFingerprint, other.linkPillContentFingerprint, other.fontScale, other.flavor,
                    other.lineBreakStrategyIOS, other.writingDirection, other.numberOfLines, other.ellipsizeMode,
                    other.linkRegexKey, other.inlineCodeLinkRegexKey);
  }
};

struct MeasurementCacheKeyHash {
  size_t operator()(const MeasurementCacheKey &key) const
  {
    size_t h = 0;
    HashUtils::hash_one(h, key.markdown);
    HashUtils::hash_one(h, key.maxWidth);
    HashUtils::hash_one(h, key.allowTrailingMargin);
    HashUtils::hash_one(h, key.allowFontScaling);
    HashUtils::hash_one(h, key.maxFontSizeMultiplier);
    HashUtils::hash_one(h, key.md4cFlagsUnderline);
    HashUtils::hash_one(h, key.md4cFlagsSuperscript);
    HashUtils::hash_one(h, key.md4cFlagsSubscript);
    HashUtils::hash_one(h, key.md4cFlagsHighlight);
    HashUtils::hash_one(h, key.md4cFlagsLatexMath);
    HashUtils::hash_one(h, key.md4cFlagsHardSoftBreaks);
    HashUtils::hash_one(h, key.md4cFlagsPreserveBlankLines);
    HashUtils::hash_one(h, key.md4cFlagsAdmonitions);
    HashUtils::hash_one(h, key.styleFingerprint);
    HashUtils::hash_one(h, key.linkPillContentFingerprint);
    HashUtils::hash_one(h, key.fontScale);
    HashUtils::hash_one(h, static_cast<uint8_t>(key.flavor));
    HashUtils::hash_one(h, key.lineBreakStrategyIOS);
    HashUtils::hash_one(h, key.writingDirection);
    HashUtils::hash_one(h, key.numberOfLines);
    HashUtils::hash_one(h, key.ellipsizeMode);
    HashUtils::hash_one(h, key.linkRegexKey);
    HashUtils::hash_one(h, key.inlineCodeLinkRegexKey);
    return h;
  }
};

struct CachedSize {
  CGFloat width;
  CGFloat height;
};

template <typename StyleStruct> inline size_t computeStyleFingerprint(const StyleStruct &s)
{
  size_t h = 0;
  auto hashFields = [&](auto... args) { (HashUtils::hash_one(h, args), ...); };

  auto hashTextLayout = [&](const auto &item) {
    hashFields(item.fontFamily, item.fontSize, item.fontWeight, item.marginTop, item.marginBottom, item.lineHeight);
  };

  // Block Elements
  hashTextLayout(s.paragraph);
  hashFields(s.paragraph.textAlign);
  hashTextLayout(s.h1);
  hashFields(s.h1.textAlign);
  hashTextLayout(s.h2);
  hashFields(s.h2.textAlign);
  hashTextLayout(s.h3);
  hashFields(s.h3.textAlign);
  hashTextLayout(s.h4);
  hashFields(s.h4.textAlign);
  hashTextLayout(s.h5);
  hashFields(s.h5.textAlign);
  hashTextLayout(s.h6);
  hashFields(s.h6.textAlign);

  hashTextLayout(s.blockquote);
  hashFields(s.blockquote.borderWidth, s.blockquote.gapWidth, s.blockquote.padding, s.blockquote.borderRadius);

  hashTextLayout(s.list);
  hashFields(s.list.bulletSize, s.list.markerMinWidth, s.list.markerFontWeight, s.list.gapWidth, s.list.marginLeft,
             s.list.itemSpacing);

  // Code & Inlines
  hashFields(s.codeBlock.fontFamily, s.codeBlock.fontSize, s.codeBlock.fontWeight, s.codeBlock.marginTop,
             s.codeBlock.marginBottom, s.codeBlock.lineHeight, s.codeBlock.padding, s.codeBlock.borderRadius,
             s.codeBlock.borderWidth);
  hashFields(s.code.fontFamily, s.code.fontSize, s.code.fontScale);
  hashFields(s.link.fontFamily, s.strong.fontFamily, s.strong.fontWeight, s.em.fontFamily, s.em.fontStyle);
  // Variants change link metrics: a font family, or a pill box around the label.
  for (const auto &variant : s.linkVariants) {
    hashFields(variant.pattern, variant.fontFamily, variant.pill.enabled, variant.pill.label, variant.pill.iconUri,
               variant.pill.paddingHorizontal, variant.pill.paddingVertical, variant.pill.lineHeight,
               variant.pill.borderWidth, variant.pill.maxWidth);
  }
  hashFields(s.highlight.backgroundColor, s.highlight.color);

  // Visual/Spacing Elements
  hashFields(s.image.height, s.image.maxHeight, s.image.aspectRatio, s.image.marginTop, s.image.marginBottom);
  hashFields(s.video.marginTop, s.video.marginBottom, s.video.borderRadius, s.video.aspectRatio,
             s.video.backgroundColor);
  hashFields(s.inlineImage.size);
  hashFields(s.thematicBreak.height, s.thematicBreak.marginTop, s.thematicBreak.marginBottom);

  // Complex Components
  hashTextLayout(s.table);
  hashFields(s.table.headerFontFamily, s.table.cellPaddingHorizontal, s.table.cellPaddingVertical, s.table.borderWidth,
             s.table.borderRadius, s.table.horizontalOverflow);
  hashFields(s.math.fontSize, s.math.padding, s.math.marginTop, s.math.marginBottom, s.math.textAlign);
  hashFields(s.taskList.checkboxSize, s.taskList.checkboxBorderRadius);

  return h;
}

// Pill labels and icons (the `linkPillContent` prop) change link widths.
template <typename ContentVector> inline size_t computeLinkPillContentFingerprint(const ContentVector &content)
{
  size_t h = 0;
  for (const auto &entry : content) {
    HashUtils::hash_one(h, entry.url);
    HashUtils::hash_one(h, entry.label);
    HashUtils::hash_one(h, entry.iconUri);
  }
  return h;
}

template <typename RegexProps> inline std::string buildLinkRecognitionCacheKey(const RegexProps &props)
{
  std::string key;
  key += props.caseInsensitive ? '1' : '0';
  key += props.dotAll ? '1' : '0';
  key += props.isDisabled ? '1' : '0';
  key += props.isDefault ? '1' : '0';
  return key + props.pattern;
}

template <typename PropsType>
inline MeasurementCacheKey buildMeasurementCacheKey(const PropsType &props, CGFloat maxWidth, CGFloat fontScale,
                                                    MarkdownFlavor flavor)
{
  return MeasurementCacheKey{
      .markdown = props.markdown,
      .maxWidth = maxWidth,
      .allowTrailingMargin = props.allowTrailingMargin,
      .allowFontScaling = props.allowFontScaling,
      .maxFontSizeMultiplier = props.maxFontSizeMultiplier,
      .md4cFlagsUnderline = props.md4cFlags.underline,
      .md4cFlagsSuperscript = props.md4cFlags.superscript,
      .md4cFlagsSubscript = props.md4cFlags.subscript,
      .md4cFlagsHighlight = props.md4cFlags.highlight,
      .md4cFlagsLatexMath = props.md4cFlags.latexMath,
      .md4cFlagsHardSoftBreaks = props.md4cFlags.hardSoftBreaks,
      .md4cFlagsPreserveBlankLines = props.md4cFlags.preserveBlankLines,
      .md4cFlagsAdmonitions = props.md4cFlags.admonitions,
      .styleFingerprint = computeStyleFingerprint(props.markdownStyle),
      .linkPillContentFingerprint = computeLinkPillContentFingerprint(props.linkPillContent),
      .fontScale = fontScale,
      .flavor = flavor,
      .lineBreakStrategyIOS = props.lineBreakStrategyIOS,
      .writingDirection = props.writingDirection,
      .numberOfLines = props.numberOfLines,
      .ellipsizeMode = props.ellipsizeMode,
      .linkRegexKey = buildLinkRecognitionCacheKey(props.linkRecognition.text),
      .inlineCodeLinkRegexKey = buildLinkRecognitionCacheKey(props.linkRecognition.inlineCode),
  };
}

/**
 * Thread-safe global measurement cache using an LRU (Least Recently Used) strategy.
 * This ensures O(1) lookups while automatically discarding the oldest entries.
 */
class MeasurementCache {
public:
  struct CacheEntry {
    MeasurementCacheKey key;
    CachedSize size;
  };

  static MeasurementCache &shared()
  {
    static MeasurementCache instance;
    return instance;
  }

  bool get(const MeasurementCacheKey &key, CachedSize &outSize)
  {
    std::lock_guard<std::mutex> lock(mutex_);

    auto it = map_.find(key);
    if (it == map_.end()) {
      return false;
    }

    list_.splice(list_.begin(), list_, it->second);

    outSize = it->second->size;
    return true;
  }

  void set(const MeasurementCacheKey &key, CachedSize size)
  {
    std::lock_guard<std::mutex> lock(mutex_);

    auto it = map_.find(key);
    if (it != map_.end()) {
      it->second->size = size;
      list_.splice(list_.begin(), list_, it->second);
      return;
    }

    list_.push_front({key, size});
    map_[key] = list_.begin();

    if (map_.size() > kMaxEntries) {
      auto &lastEntry = list_.back();
      map_.erase(lastEntry.key);
      list_.pop_back();
    }
  }

  void removeMatchingMarkdown(const std::string &markdown)
  {
    std::lock_guard<std::mutex> lock(mutex_);

    for (auto it = list_.begin(); it != list_.end();) {
      if (it->key.markdown == markdown) {
        map_.erase(it->key);
        it = list_.erase(it);
      } else {
        ++it;
      }
    }
  }

private:
  MeasurementCache() = default;

  static constexpr size_t kMaxEntries = 512;
  mutable std::mutex mutex_;

  std::list<CacheEntry> list_;
  std::unordered_map<MeasurementCacheKey, std::list<CacheEntry>::iterator, MeasurementCacheKeyHash> map_;
};

} // namespace facebook::react
