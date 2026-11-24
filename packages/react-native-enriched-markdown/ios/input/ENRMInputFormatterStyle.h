#pragma once

#import "ENRMUIKit.h"
#import <Foundation/Foundation.h>

NS_ASSUME_NONNULL_BEGIN

@interface ENRMInputLinkVariantStyle : NSObject

@property (nonatomic, copy) NSString *pattern;
@property (nonatomic, strong) RCTUIColor *color;
@property (nonatomic, assign) BOOL underline;
@property (nonatomic, strong, nullable) RCTUIColor *backgroundColor;
@property (nonatomic, strong, nullable) NSRegularExpression *regex;

@end

@interface ENRMInputFormatterStyle : NSObject <NSCopying>

/// Base text properties
@property (nonatomic, strong) UIFont *baseFont;
@property (nonatomic, strong) RCTUIColor *baseTextColor;
@property (nonatomic, assign) CGFloat baseLineHeight;

/// Bold — color override (nil = inherit baseTextColor)
@property (nonatomic, strong, nullable) RCTUIColor *boldColor;

/// Italic — color override (nil = inherit baseTextColor)
@property (nonatomic, strong, nullable) RCTUIColor *italicColor;

/// Link
@property (nonatomic, strong, nullable) RCTUIColor *linkColor;
@property (nonatomic, assign) BOOL linkUnderline;
@property (nonatomic, strong, nullable) RCTUIColor *linkBackgroundColor;
@property (nonatomic, copy) NSArray<ENRMInputLinkVariantStyle *> *linkVariants;

/// Spoiler
@property (nonatomic, strong, nullable) RCTUIColor *spoilerColor;
@property (nonatomic, strong, nullable) RCTUIColor *spoilerBackgroundColor;

/// Vertical spacing (points) added above each list item via the paragraph
/// style's paragraphSpacingBefore, so bullets read as separate rows. Configured
/// from the `markdownStyle.list.itemSpacing` prop; defaults to 0 (items pack tightly).
@property (nonatomic, assign) CGFloat listItemSpacing;

/// Per-level heading config, indexed by level 1-6. A nil/0 entry means the level
/// uses a built-in default derived from the base font. Configured from the
/// `markdownStyle.h1..h6` props.
- (void)setHeadingFontSize:(CGFloat)fontSize forLevel:(NSInteger)level;
- (void)setHeadingFontWeight:(nullable NSString *)fontWeight forLevel:(NSInteger)level;
- (void)setHeadingColor:(nullable RCTUIColor *)color forLevel:(NSInteger)level;

/// Resolved foreground color for a heading level, or nil to inherit baseTextColor.
- (nullable RCTUIColor *)headingColorForLevel:(NSInteger)level;

/// Font for a heading level, built over the base font at the configured per-level
/// size and weight (from markdownStyle h1..h6). Does not carry inline traits —
/// those are merged on top in the formatter's font pass.
- (UIFont *)headingFontForLevel:(NSInteger)level;

/// Line height for a heading level: headingFontSize + (baseLineHeight - baseFontSize).
- (CGFloat)derivedLineHeightForHeadingLevel:(NSInteger)level;

- (UIFont *)fontForTraits:(UIFontDescriptorSymbolicTraits)traits;
- (void)invalidateFontCache;

@end

NS_ASSUME_NONNULL_END
