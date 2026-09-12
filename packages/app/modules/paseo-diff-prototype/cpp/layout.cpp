#include "layout.h"
#include "graphemes.h"

#include <algorithm>
#include <cmath>
#include <numeric>
#include <stdexcept>
#include <unordered_map>
#include <unordered_set>

#include "include/core/SkFont.h"
#include "modules/skparagraph/include/FontCollection.h"
#include "modules/skparagraph/include/Paragraph.h"
#include "modules/skparagraph/include/ParagraphBuilder.h"
#include "modules/skunicode/include/SkUnicode.h"

namespace paseo::diff {
namespace {
namespace para = skia::textlayout;

int codePoint(const std::u16string& text, size_t pos) {
  int code = text[pos];
  if (code >= 0xd800 && code < 0xdc00 && pos + 1 < text.size()) {
    int low = text[pos + 1];
    if (low >= 0xdc00 && low < 0xe000) return ((code - 0xd800) << 10) + low - 0xdc00 + 0x10000;
  }
  return code;
}
bool extending(int code) {
  const auto found = std::upper_bound(extendingRanges.begin(), extendingRanges.end(), code,
      [](int value, const auto& range) { return value < range.first; });
  return found != extendingRanges.begin() && code < std::prev(found)->second;
}
bool regional(int code) { return code >= 0x1f1e6 && code <= 0x1f1ff; }

// Same forward-cluster rules as @marijn/find-cluster-break, including ZWJ/RI behavior.
std::vector<Grapheme> segment(const std::u16string& text) {
  std::vector<Grapheme> result;
  size_t pos = 0;
  size_t column = 0;
  while (pos < text.size()) {
    const auto start = pos;
    int previous = codePoint(text, pos);
    pos += previous < 0x10000 ? 1 : 2;
    while (pos < text.size()) {
      const int next = codePoint(text, pos);
      if (previous == 0x200d || next == 0x200d || extending(next)) {
        pos += next < 0x10000 ? 1 : 2;
        previous = next;
      } else if (regional(next)) {
        size_t count = 0;
        for (int index = static_cast<int>(pos) - 2; index >= 0 && regional(codePoint(text, index)); index -= 2) count++;
        if (count % 2 == 0) break;
        pos += 2;
      } else {
        break;
      }
    }
    auto display = text.substr(start, pos - start);
    const bool tab = display == u"\t";
    const size_t spaces = tab ? 4 - column % 4 : 0;
    if (tab) display.assign(spaces, u' ');
    result.push_back({static_cast<int>(start), static_cast<int>(pos), std::move(display)});
    column += tab ? spaces : 1;
  }
  return result;
}

bool needsShaping(const std::u16string& text) {
  for (const auto c : text) if ((c < 0x20 || c > 0x7e) && c != u'\t') return true;
  for (const auto* pair : {u"==", u"!=", u"=>", u"<=", u">=", u"->", u"::", u"++", u"--"}) {
    if (text.find(pair) != std::u16string::npos) return true;
  }
  return false;
}
bool cleanBoundary(const Grapheme& grapheme) {
  for (const auto c : grapheme.text) {
    if (c < 0x20 || c > 0x7e || std::u16string_view(u"=!<>+-:&|*/~^?.").find(c) != std::u16string_view::npos) return false;
  }
  return true;
}
size_t chunkEnd(const std::vector<Grapheme>& graphemes, size_t start, size_t end) {
  const size_t limit = start + 64;
  if (limit >= end) return end;
  const size_t floor = std::max(start + 1, limit - 16);
  for (size_t seam = limit; seam > floor; seam--) {
    if (cleanBoundary(graphemes[seam - 1]) && cleanBoundary(graphemes[seam])) return seam;
  }
  return limit;
}

class Measurer {
 public:
  Measurer(sk_sp<SkFontMgr> manager, const std::string& family, float size,
           const std::atomic<bool>& cancelled) : cancelled_(cancelled) {
    families_ = {SkString(family), SkString("Menlo"), SkString("SF Mono"), SkString("monospace"), SkString("System")};
    std::unordered_set<std::string> available;
    for (int i = 0; i < manager->countFamilies(); i++) {
      SkString name;
      manager->getFamilyName(i, &name);
      available.insert(name.c_str());
    }
    std::string primary = "System";
    for (const auto& name : families_) {
      if (available.contains(name.c_str())) { primary = name.c_str(); break; }
    }
    font_ = SkFont(manager->matchFamilyStyle(primary.c_str(), SkFontStyle()), size);
    fonts_ = sk_make_sp<para::FontCollection>();
    fonts_->setDefaultFontManager(manager);
    fonts_->enableFontFallback();
    para::StrutStyle strut;
    strut.setStrutEnabled(true);
    strut.setForceStrutHeight(true);
    strut.setFontFamilies(families_);
    strut.setFontSize(size);
    strut.setHeight(std::round(size * 1.5) / size);
    strut.setHeightOverride(true);
    strut.setHalfLeading(true);
    style_.setMaxLines(1);
    style_.setStrutStyle(strut);
    textStyle_.setFontFamilies(families_);
    textStyle_.setFontSize(size);
    textStyle_.setColor(SK_ColorBLACK);
  }

  double measure(const std::vector<Grapheme>& graphemes, size_t start, size_t end,
                 std::vector<double>* advances = nullptr) {
    double base = 0;
    for (size_t chunkStart = start; chunkStart < end;) {
      if (cancelled_.load()) throw std::runtime_error("Layout cancelled");
      const size_t chunkLimit = chunkEnd(graphemes, chunkStart, end);
      std::u16string text;
      for (size_t i = chunkStart; i < chunkLimit; i++) text += graphemes[i].text;
      double width = 0;
      if (!needsShaping(text) && hasEveryGlyph(text)) {
        for (size_t i = chunkStart; i < chunkLimit; i++) {
          width += additiveWidth(graphemes[i].text);
          if (advances) advances->push_back(base + width);
        }
      } else {
        auto paragraph = shape(text);
        if (advances) {
          size_t offset = 0;
          for (size_t i = chunkStart; i < chunkLimit; i++) {
            offset += graphemes[i].text.size();
            width = paragraphWidth(*paragraph, offset);
            advances->push_back(base + width);
          }
        } else {
          width = paragraphWidth(*paragraph, text.size());
        }
      }
      base += width;
      chunkStart = chunkLimit;
    }
    return base;
  }

 private:
  bool hasEveryGlyph(const std::u16string& text) {
    for (const auto c : text) {
      auto [it, inserted] = glyphs_.try_emplace(c, false);
      if (inserted) it->second = font_.unicharToGlyph(c) != 0;
      if (!it->second) return false;
    }
    return true;
  }
  double additiveWidth(const std::u16string& text) {
    auto [it, inserted] = widths_.try_emplace(text, 0);
    if (inserted) {
      std::vector<SkGlyphID> glyphs(font_.countText(text.data(), text.size() * 2, SkTextEncoding::kUTF16));
      font_.textToGlyphs(text.data(), text.size() * 2, SkTextEncoding::kUTF16, SkSpan(glyphs));
      std::vector<SkScalar> widths(glyphs.size());
      font_.getWidthsBounds(SkSpan(glyphs), SkSpan(widths), {}, nullptr);
      // Match RNSkia 2.2.12 getTextWidth's integer accumulator exactly.
      it->second = std::accumulate(widths.begin(), widths.end(), 0);
    }
    return it->second;
  }
  std::unique_ptr<para::Paragraph> shape(const std::u16string& text) {
    auto builder = para::ParagraphBuilder::make(style_, fonts_);
    builder->pushStyle(textStyle_);
    const auto utf8 = SkUnicode::convertUtf16ToUtf8(text);
    builder->addText(utf8.c_str(), utf8.size());
    builder->pop();
    auto paragraph = builder->Build();
    paragraph->layout(100000);
    return paragraph;
  }
  static double paragraphWidth(para::Paragraph& paragraph, size_t end) {
    double width = 0;
    for (const auto& box : paragraph.getRectsForRange(0, end, para::RectHeightStyle::kTight, para::RectWidthStyle::kTight)) {
      // JS adds the two float-valued properties in double precision.
      width = std::max(width, static_cast<double>(box.rect.x()) + box.rect.width());
    }
    return width;
  }
  SkFont font_;
  std::vector<SkString> families_;
  sk_sp<para::FontCollection> fonts_;
  para::ParagraphStyle style_;
  para::TextStyle textStyle_;
  std::unordered_map<char16_t, bool> glyphs_;
  std::unordered_map<std::u16string, double> widths_;
  const std::atomic<bool>& cancelled_;
};
}  // namespace

void prepare(Document& document, sk_sp<SkFontMgr> fonts, const std::string& family, float size,
             const std::atomic<bool>& cancelled) {
  Measurer measure(std::move(fonts), family, size, cancelled);
  for (auto& cell : document.cells) {
    if (cancelled.load()) throw std::runtime_error("Layout cancelled");
    auto graphemes = segment(cell.text);
    const bool bounded = !needsShaping(cell.text);
    size_t start = 0;
    do {
      size_t fitting = graphemes.size();
      if (!graphemes.empty()) {
        size_t low = start + 1;
        size_t high = bounded ? std::min(graphemes.size(), start + 64) : graphemes.size();
        fitting = low;
        if (bounded) {
          while (measure.measure(graphemes, start, high) <= cell.availableWidth) {
            fitting = high;
            low = high + 1;
            if (high == graphemes.size()) break;
            high = std::min(graphemes.size(), start + (high - start) * 2);
          }
        }
        while (low <= high) {
          const size_t middle = (low + high) / 2;
          const double width = measure.measure(graphemes, start, middle);
          if (width <= cell.availableWidth || middle == start + 1) {
            fitting = middle;
            low = middle + 1;
          } else {
            high = middle - 1;
          }
        }
      }
      std::vector<double> advances;
      advances.reserve(fitting - start);
      const double width = measure.measure(graphemes, start, fitting, &advances);
      Fragment fragment{start < graphemes.size() ? graphemes[start].start : 0,
                        fitting > start ? graphemes[fitting - 1].end : 0, width, {}};
      fragment.graphemes.reserve(fitting - start);
      for (size_t i = start; i < fitting; i++) {
        auto grapheme = graphemes[i];
        grapheme.width = advances[i - start] - (i > start ? advances[i - start - 1] : 0);
        fragment.graphemes.push_back(std::move(grapheme));
      }
      document.fragmentCount++;
      document.graphemeCount += fragment.graphemes.size();
      document.geometryBytes += sizeof(Fragment) + fragment.graphemes.capacity() * sizeof(Grapheme);
      cell.fragments.push_back(std::move(fragment));
      start = fitting;
    } while (start < graphemes.size());
  }
}

std::vector<double> read(const Document& document, size_t start, size_t count) {
  std::vector<double> output;
  const size_t end = start + std::min(count, document.cells.size() - start);
  for (size_t i = start; i < end; i++) {
    const auto& cell = document.cells[i];
    output.insert(output.end(), {static_cast<double>(i), static_cast<double>(cell.fragments.size())});
    for (const auto& fragment : cell.fragments) {
      output.insert(output.end(), {static_cast<double>(fragment.start), static_cast<double>(fragment.end), fragment.width, static_cast<double>(fragment.graphemes.size())});
      for (const auto& grapheme : fragment.graphemes) {
        output.insert(output.end(), {static_cast<double>(grapheme.start), static_cast<double>(grapheme.end), grapheme.width});
      }
    }
  }
  return output;
}
}  // namespace paseo::diff
