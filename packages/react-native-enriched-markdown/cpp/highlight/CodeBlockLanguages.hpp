#pragma once

#include <string>

// Display names for code block fence languages, shared by every platform and
// both markdown flavors so a fence like ```python is labeled identically
// everywhere. Unlike the highlighting seam this is always compiled; it does
// not depend on ENRICHED_MARKDOWN_CODE_HIGHLIGHT.

namespace Markdown {

// Maps a fence info string (for example "python", "js") to a human readable
// display name ("Python", "JavaScript"). Unknown languages fall back to the
// lowercased input with the first ASCII letter capitalized. Empty input
// returns an empty string.
std::string displayNameForLanguage(const std::string& language);

// Maps a fence info string to the canonical tree-sitter grammar id that can
// highlight it (for example "js" and "jsx" both map to "javascript"), or an
// empty string when no grammar covers the language. The id is the vendored
// grammar directory name; whether that grammar is actually compiled into the
// build is answered separately by findGrammar.
std::string canonicalGrammarId(const std::string& language);

} // namespace Markdown
