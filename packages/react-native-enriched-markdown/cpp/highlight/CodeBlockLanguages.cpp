#include "CodeBlockLanguages.hpp"

#include <algorithm>
#include <array>
#include <cctype>
#include <cstring>

namespace Markdown {

namespace {

struct LanguageName {
  const char *key;
  const char *name;
  // Canonical tree-sitter grammar id (vendored directory name), or "" when no
  // grammar covers this fence language.
  const char *grammar;
};

// Sorted by key; both lookups below binary-search this table.
constexpr std::array<LanguageName, 42> kLanguageNames{{
    {"bash", "Bash", "bash"},
    {"c", "C", "c"},
    {"cc", "C++", "cpp"},
    {"cpp", "C++", "cpp"},
    {"cs", "C#", "c-sharp"},
    {"csharp", "C#", "c-sharp"},
    {"css", "CSS", "css"},
    {"cxx", "C++", "cpp"},
    {"dockerfile", "Dockerfile", ""},
    {"go", "Go", "go"},
    {"golang", "Go", "go"},
    {"graphql", "GraphQL", ""},
    {"html", "HTML", "html"},
    {"java", "Java", "java"},
    {"javascript", "JavaScript", "javascript"},
    {"js", "JavaScript", "javascript"},
    {"json", "JSON", "json"},
    {"jsx", "JSX", "javascript"},
    {"markdown", "Markdown", "markdown"},
    {"md", "Markdown", "markdown"},
    {"objc", "Objective-C", ""},
    {"objectivec", "Objective-C", ""},
    {"php", "PHP", "php"},
    {"py", "Python", "python"},
    {"python", "Python", "python"},
    {"rb", "Ruby", "ruby"},
    {"rs", "Rust", "rust"},
    {"ruby", "Ruby", "ruby"},
    {"rust", "Rust", "rust"},
    {"scss", "SCSS", ""},
    {"sh", "Shell", "bash"},
    {"shell", "Shell", "bash"},
    {"sql", "SQL", ""},
    {"swift", "Swift", "swift"},
    {"toml", "TOML", ""},
    {"ts", "TypeScript", "typescript"},
    {"tsx", "TSX", "tsx"},
    {"typescript", "TypeScript", "typescript"},
    {"xml", "XML", ""},
    {"yaml", "YAML", "yaml"},
    {"yml", "YAML", "yaml"},
    {"zsh", "Zsh", "bash"},
}};

// findLanguage binary-searches kLanguageNames, so the table must be strictly
// ascending by key under C strcmp order. Enforce it at compile time: a
// misordered entry (e.g. "ruby" before "rs") would otherwise silently fail the
// lookup and leave that language unhighlighted.
constexpr bool keyLess(const char *a, const char *b) {
  for (std::size_t i = 0;; ++i) {
    unsigned char ca = static_cast<unsigned char>(a[i]);
    unsigned char cb = static_cast<unsigned char>(b[i]);
    if (ca != cb) {
      return ca < cb;
    }
    if (ca == '\0') {
      return false;
    }
  }
}

constexpr bool languageTableIsSorted() {
  for (std::size_t i = 1; i < kLanguageNames.size(); ++i) {
    if (!keyLess(kLanguageNames[i - 1].key, kLanguageNames[i].key)) {
      return false;
    }
  }
  return true;
}

static_assert(languageTableIsSorted(), "kLanguageNames must be sorted by key for binary search");

// Lowercases language and binary-searches the table. Returns nullptr on miss.
const LanguageName *findLanguage(const std::string &language, std::string &lowerOut) {
  lowerOut = language;
  for (char &c : lowerOut) {
    c = static_cast<char>(std::tolower(static_cast<unsigned char>(c)));
  }

  auto it =
      std::lower_bound(kLanguageNames.begin(), kLanguageNames.end(), lowerOut.c_str(),
                       [](const LanguageName &entry, const char *key) { return std::strcmp(entry.key, key) < 0; });
  if (it != kLanguageNames.end() && lowerOut == it->key) {
    return &(*it);
  }
  return nullptr;
}

} // namespace

std::string displayNameForLanguage(const std::string &language) {
  if (language.empty()) {
    return "";
  }

  std::string lower;
  if (const LanguageName *entry = findLanguage(language, lower)) {
    return entry->name;
  }

  lower[0] = static_cast<char>(std::toupper(static_cast<unsigned char>(lower[0])));
  return lower;
}

std::string canonicalGrammarId(const std::string &language) {
  if (language.empty()) {
    return "";
  }

  std::string lower;
  if (const LanguageName *entry = findLanguage(language, lower)) {
    return entry->grammar;
  }
  return "";
}

} // namespace Markdown
