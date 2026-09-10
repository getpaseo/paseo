#pragma once

#include <atomic>
#include <cstddef>
#include <string>
#include <vector>
#include "include/core/SkFontMgr.h"

namespace paseo::diff {
struct Grapheme {
  int start;
  int end;
  std::u16string text;
  double width = 0;
};
struct Fragment {
  int start;
  int end;
  double width;
  std::vector<Grapheme> graphemes;
};
struct Cell {
  std::u16string text;
  double availableWidth;
  std::vector<Fragment> fragments;
};
struct Document {
  std::vector<Cell> cells;
  size_t fragmentCount = 0;
  size_t graphemeCount = 0;
  size_t geometryBytes = 0;
};

void prepare(Document& document, sk_sp<SkFontMgr> fonts, const std::string& family, float fontSize,
             const std::atomic<bool>& cancelled);
std::vector<double> read(const Document& document, size_t start, size_t count);
}  // namespace paseo::diff
