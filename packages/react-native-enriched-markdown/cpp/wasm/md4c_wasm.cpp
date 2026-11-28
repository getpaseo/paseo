#include "../parser/MD4CParser.hpp"
#include "ASTSerializer.hpp"
#include <string>

// Static buffer for the JSON result.
// Safe for single-threaded WASM execution — the caller must consume (copy)
// the returned string before calling parseMarkdown again.
static std::string g_resultBuffer;

extern "C" {

/**
 * Parse a markdown string and return its AST as a JSON string.
 *
 * @param markdown   Null-terminated UTF-8 markdown input.
 * @param underline  1 → enable __ underline extension; 0 → __ means emphasis.
 * @param latexMath  1 → enable $…$ / $$…$$ LaTeX math spans; 0 → disable.
 * @param superscript 1 → enable ^superscript^ spans; 0 → disable.
 * @param subscript  1 → enable ~subscript~ spans; 0 → disable.
 * @param highlight  1 → enable ==highlight== spans; 0 → disable.
 * @param hardSoftBreaks 1 → treat soft breaks as hard breaks; 0 → collapse to space.
 * @param preserveBlankLines 1 → report runs of blank lines as BlankLine nodes; 0 → collapse them.
 * @param admonitions 1 → enable GitHub-style admonitions/alerts; 0 → disable.
 * @return           Null-terminated UTF-8 JSON string, valid until the next call.
 */
const char *parseMarkdown(const char *markdown, int underline, int latexMath, int superscript, int subscript,
                          int highlight, int hardSoftBreaks, int preserveBlankLines, int admonitions) {
  if (!markdown) {
    g_resultBuffer = "{\"type\":\"Document\"}";
    return g_resultBuffer.c_str();
  }

  Markdown::Md4cFlags flags;
  flags.underline = (underline != 0);
  flags.latexMath = (latexMath != 0);
  flags.superscript = (superscript != 0);
  flags.subscript = (subscript != 0);
  flags.highlight = (highlight != 0);
  flags.hardSoftBreaks = (hardSoftBreaks != 0);
  flags.preserveBlankLines = (preserveBlankLines != 0);
  flags.admonitions = (admonitions != 0);

  Markdown::MD4CParser parser;
  auto root = parser.parse(std::string(markdown), flags);
  g_resultBuffer = Markdown::ASTSerializer::serialize(*root);
  return g_resultBuffer.c_str();
}

} // extern "C"
