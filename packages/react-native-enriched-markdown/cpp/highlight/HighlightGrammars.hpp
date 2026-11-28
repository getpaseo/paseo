#pragma once

// Registry of the tree-sitter grammars compiled into this build. The table and
// the findGrammar definition live in generated_registry.cpp, emitted by
// vendor/gen-registry.mjs for exactly the selected language subset, so this
// header never references symbols for grammars that were not compiled.
//
// Only meaningful when ENRICHED_MARKDOWN_CODE_HIGHLIGHT is defined; without the
// flag neither this header nor generated_registry.cpp is compiled.

struct TSLanguage;

namespace Markdown {

struct GrammarEntry {
  // Canonical grammar id, matching canonicalGrammarId() in CodeBlockLanguages.
  const char *canonicalId;
  // tree-sitter language constructor (extern "C" tree_sitter_<id>).
  const TSLanguage *(*language)(void);
  // The grammar's highlights.scm, inheritance already inlined, as a C string.
  const char *highlightsQuery;
};

// Returns the entry for canonicalId, or nullptr when no grammar for it was
// compiled into this build (unselected language) or canonicalId is empty.
const GrammarEntry *findGrammar(const char *canonicalId);

} // namespace Markdown
