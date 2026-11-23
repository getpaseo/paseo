#pragma once

// Auto-detect RaTeX availability as a fallback for the podspec flag.
#if __has_include(<RaTeXFFI/ratex.h>) || __has_include("ReactNativeEnrichedMarkdown-Swift.h")
#if !defined(ENRICHED_MARKDOWN_MATH)
#define ENRICHED_MARKDOWN_MATH 1
#endif
#endif

#if !defined(ENRICHED_MARKDOWN_MATH)
#define ENRICHED_MARKDOWN_MATH 0
#endif

// Code-block syntax highlighting is defined purely by the podspec (no external
// framework to auto-detect, unlike RaTeX). Default off when the podspec did not
// enable it; the C++ seam then degrades to no tokens.
#if !defined(ENRICHED_MARKDOWN_CODE_HIGHLIGHT)
#define ENRICHED_MARKDOWN_CODE_HIGHLIGHT 0
#endif

// Video playback support. Uses AVKit (built into both iOS and macOS — no
// external framework), so the flag gates only the container view code itself.
#if !defined(ENRICHED_MARKDOWN_VIDEO)
#define ENRICHED_MARKDOWN_VIDEO 0
#endif
