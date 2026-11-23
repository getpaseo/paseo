#pragma once

#import "ENRMFormattingRange.h"
#import "ENRMInputFormatter.h"
#import "ENRMStyleMergingConfig.h"

NS_ASSUME_NONNULL_BEGIN

@protocol ENRMStyleHandler <NSObject>

@property (nonatomic, readonly) ENRMInputStyleType styleType;
@property (nonatomic, readonly) ENRMStyleMergingConfig *mergingConfig;

/// Collect font traits that this style contributes (e.g. bold, italic).
/// Return 0 if the style does not affect the font.
- (UIFontDescriptorSymbolicTraits)fontTraits;

/// Apply non-font attributes (color, underline, etc.) to the given range.
- (void)applyNonFontAttributesToTextStorage:(NSTextStorage *)storage
                                      range:(NSRange)range
                            formattingRange:(ENRMFormattingRange *)formattingRange
                                      style:(ENRMInputFormatterStyle *)style;

@end

NS_ASSUME_NONNULL_END
