#import "ENRMLatexErrorReporting.h"
#import "ENRMUIKit.h"
#import <Foundation/Foundation.h>

typedef NS_ENUM(NSInteger, BlockType) {
  BlockTypeNone,
  BlockTypeParagraph,
  BlockTypeHeading,
  BlockTypeBlockquote,
  BlockTypeUnorderedList,
  BlockTypeOrderedList,
  BlockTypeCodeBlock
};

/// YES when the enclosing block re-stamps its own line height over paragraph content and applies the
/// matching baseline offset itself, so a paragraph nested inside it must not apply its own (the outer
/// block's line height wins, and applyBaselineOffset skips ranges that already carry an offset).
/// TODO: loose list items have the same shape (ParagraphRenderer runs, then the list re-stamps its
/// line height); add BlockTypeUnorderedList/BlockTypeOrderedList here once lists own their offset too.
static inline BOOL ENRMBlockTypeReappliesBaselineOffset(BlockType type)
{
  return type == BlockTypeBlockquote;
}

typedef NS_ENUM(NSInteger, ListType) { ListTypeUnordered, ListTypeOrdered };

@interface BlockStyle : NSObject
@property (nonatomic, assign) CGFloat fontSize;
@property (nonatomic, strong) NSString *fontFamily;
@property (nonatomic, strong) NSString *fontWeight;
@property (nonatomic, strong) RCTUIColor *color;
@property (nonatomic, strong) UIFont *cachedFont;
@property (nonatomic, strong) NSDictionary *cachedTextAttributes;
@end

@interface RenderContext : NSObject
@property (nonatomic, strong) NSMutableArray<NSValue *> *linkRanges;
@property (nonatomic, strong) NSMutableArray<NSString *> *linkURLs;
@property (nonatomic, strong) NSMutableArray<NSValue *> *headingRanges;
@property (nonatomic, strong) NSMutableArray<NSNumber *> *headingLevels;
@property (nonatomic, strong) NSMutableArray<NSValue *> *imageRanges;
@property (nonatomic, strong) NSMutableArray<NSString *> *imageAltTexts;
@property (nonatomic, strong) NSMutableArray<NSString *> *imageURLs;
@property (nonatomic, strong) NSMutableArray<NSValue *> *listItemRanges;
@property (nonatomic, strong) NSMutableArray<NSNumber *> *listItemPositions; // Position in parent list (1, 2, 3...)
@property (nonatomic, strong) NSMutableArray<NSNumber *> *listItemDepths;  // Nesting depth (1 = top level, 2+ = nested)
@property (nonatomic, strong) NSMutableArray<NSNumber *> *listItemOrdered; // YES = ordered, NO = unordered (bullet)
@property (nonatomic, assign) BlockType currentBlockType;
@property (nonatomic, strong) BlockStyle *currentBlockStyle;
@property (nonatomic, assign) NSInteger currentHeadingLevel;
@property (nonatomic, assign) NSInteger blockquoteDepth;
@property (nonatomic, assign) NSInteger listDepth;
@property (nonatomic, assign) ListType listType;
@property (nonatomic, assign) NSInteger listItemNumber;
@property (nonatomic, assign) CGFloat accumulatedIndent;
@property (nonatomic, assign) BOOL allowFontScaling;
@property (nonatomic, assign) CGFloat maxFontSizeMultiplier;
@property (nonatomic, assign) NSInteger taskItemCount;
@property (nonatomic, strong) NSMutableArray<id<ENRMLatexErrorReporting>> *mathReporters;

- (instancetype)init;
- (void)reset;

- (UIFont *)cachedFontForSize:(CGFloat)fontSize family:(NSString *)fontFamily weight:(NSString *)fontWeight;
- (NSMutableParagraphStyle *)spacerStyleWithHeight:(CGFloat)height spacing:(CGFloat)spacing;
- (NSMutableParagraphStyle *)blockSpacerStyleWithMargin:(CGFloat)margin;
- (void)registerLinkRange:(NSRange)range url:(NSString *)url;

- (void)applyLinkAttributesToString:(NSMutableAttributedString *)attributedString;
- (void)applyImageAttributesToString:(NSMutableAttributedString *)attributedString;
- (void)registerHeadingRange:(NSRange)range level:(NSInteger)level text:(NSString *)text;
- (void)registerImageRange:(NSRange)range altText:(NSString *)altText url:(NSString *)url;
- (void)registerListItemRange:(NSRange)range
                     position:(NSInteger)position
                        depth:(NSInteger)depth
                    isOrdered:(BOOL)isOrdered;
- (void)setBlockStyle:(BlockType)type
             fontSize:(CGFloat)fontSize
           fontFamily:(NSString *)fontFamily
           fontWeight:(NSString *)fontWeight
                color:(RCTUIColor *)color;
- (void)setBlockStyle:(BlockType)type
             fontSize:(CGFloat)fontSize
           fontFamily:(NSString *)fontFamily
           fontWeight:(NSString *)fontWeight
                color:(RCTUIColor *)color
         headingLevel:(NSInteger)headingLevel;
- (void)setBlockStyle:(BlockType)type
                 font:(UIFont *)font
                color:(RCTUIColor *)color
         headingLevel:(NSInteger)headingLevel;
- (BlockStyle *)getBlockStyle;
- (NSDictionary *)getTextAttributes;
- (void)clearBlockStyle;

/**
 * Captures/restores the scoped context state: block style, block type, heading level,
 * blockquote/list depths, list type, list item counter and accumulated indent.
 * Accumulators (range registries, taskItemCount) are excluded on purpose — they
 * must survive restores.
 */
- (id)snapshotScope;
- (void)restoreScope:(id)snapshot;

/**
 * Checks if colors should be preserved based on existing attributes.
 * Returns YES if the text is inside a link or inline code, which means
 * we should preserve their colors instead of applying new colors.
 */
+ (BOOL)shouldPreserveColors:(NSDictionary *)existingAttributes;

/**
 * Calculates the color that strong would use based on the configured strong color and block style.
 * Uses strongColor if explicitly set (different from block color), otherwise uses block color.
 */
+ (RCTUIColor *)calculateStrongColor:(RCTUIColor *)configStrongColor blockColor:(RCTUIColor *)blockColor;

/**
 * Resolves highlight foreground color: uses block color when config matches paragraph default.
 */
+ (RCTUIColor *)calculateHighlightColor:(RCTUIColor *)configHighlightColor
                         paragraphColor:(RCTUIColor *)paragraphColor
                             blockColor:(RCTUIColor *)blockColor;

/**
 * Calculates the range for content rendered between start and current output length.
 * Returns a range with length 0 if no content was rendered.
 */
+ (NSRange)rangeForRenderedContent:(NSMutableAttributedString *)output start:(NSUInteger)start;

/**
 * Applies font and color attributes conditionally, only updating if they've changed.
 * Returns YES if any attributes were updated, NO otherwise.
 */
+ (BOOL)applyFontAndColorAttributes:(NSMutableAttributedString *)output
                              range:(NSRange)range
                               font:(UIFont *)font
                              color:(RCTUIColor *)color
                 existingAttributes:(NSDictionary *)existingAttributes
               shouldPreserveColors:(BOOL)shouldPreserveColors;
@end
