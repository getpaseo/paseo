#pragma once

#import <Foundation/Foundation.h>

@class StyleConfig;

NS_ASSUME_NONNULL_BEGIN

#ifdef __cplusplus
extern "C" {
#endif

/// Platform adapter over the shared C++ syntax highlighting seam
/// (cpp/highlight/CodeBlockHighlighter.hpp).
///
/// Applies token colors as foreground-color attributes onto a mutable copy of
/// the plain styled code, so highlighting can never change text metrics and
/// the block height measured from the plain string stays valid. Token colors
/// come from the config's resolved per-token palette. Returns nil when
/// highlighting is unavailable (module compiled out, unknown language, parse
/// failure); callers keep the plain attributed code.
NSAttributedString *_Nullable ENRMHighlightedAttributedCode(NSAttributedString *plainCode, NSString *code,
                                                            NSString *_Nullable language, StyleConfig *config);

/// Applies token foreground colors from the config's palette onto `output`
/// within `range` (range.location is where the code begins in output). Used by
/// the commonmark flavor, which renders code inline instead of as a container.
/// Returns whether any color was applied. No-op when highlighting is
/// unavailable, so callers keep the plain rendering.
BOOL ENRMApplyHighlightTokens(NSMutableAttributedString *output, NSRange range, NSString *code,
                              NSString *_Nullable language, StyleConfig *config);

#ifdef __cplusplus
}
#endif

NS_ASSUME_NONNULL_END
