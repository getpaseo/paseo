#pragma once
#import "ENRMDynamicBlockProps.h"
#import "ENRMUIKit.h"
#import "ParagraphStyleUtils.h"
#import "StyleConfig.h"

@class MarkdownASTNode;
@class ENRMAccessibilityLabels;

NS_ASSUME_NONNULL_BEGIN

typedef void (^TableLinkPressBlock)(NSString *url);

@interface TableContainerView : RCTUIView

- (instancetype)initWithConfig:(StyleConfig *)config;

- (void)applyTableNode:(MarkdownASTNode *)tableNode;

- (CGFloat)measureHeight:(CGFloat)maxWidth;

/// View-free table height for shadow-node measurement (issue #550): renders
/// the cells' attributed strings and runs the same column/row layout the view
/// runs in `applyTableNode:`/`computeLayout` — shared statics, so measured and
/// rendered heights cannot drift — without creating any view. Safe on any
/// thread; the iOS counterpart of Android's
/// `TableContainerView.measureTableNodeHeight`. Table height is intrinsic
/// (content-sized columns, horizontal scroll), so no maxWidth parameter.
+ (CGFloat)measureHeightForTableNode:(MarkdownASTNode *)tableNode
                              config:(StyleConfig *)config
                    allowFontScaling:(BOOL)allowFontScaling
               maxFontSizeMultiplier:(CGFloat)maxFontSizeMultiplier
                writingDirectionMode:(ENRMWritingDirectionMode)writingDirectionMode
             resolvedLayoutDirection:(NSWritingDirection)resolvedLayoutDirection;

@property (nonatomic, strong) StyleConfig *config;

@property (nonatomic, assign) BOOL allowFontScaling;
@property (nonatomic, assign) CGFloat maxFontSizeMultiplier;

@property (nonatomic, copy, nullable) void (^onLinkPress)(NSString *url, NSString *sourceType);
@property (nonatomic, copy, nullable) TableLinkPressBlock onLinkLongPress;
@property (nonatomic, copy, nullable) void (^onImagePress)(NSString *url, NSString *altText);

@property (nonatomic, assign) BOOL enableLinkPreview;

@property (nonatomic, assign) ENRMWritingDirectionMode writingDirectionMode;
@property (nonatomic, assign) NSWritingDirection resolvedLayoutDirection;

@property (nonatomic, strong, nullable) ENRMAccessibilityLabels *accessibilityLabels;

// Shared, runtime-mutable block props (context-menu gate + copy labels) read live
// at menu-open. Set to the root's shared instance at creation. See
// ENRMDynamicBlockProps.
@property (nonatomic, strong) ENRMDynamicBlockProps *dynamicProps;

@property (nonatomic, readonly) NSUInteger rowCount;

- (void)animateNewRowsFromPreviousCount:(NSUInteger)previousRowCount duration:(NSTimeInterval)duration;

@end

NS_ASSUME_NONNULL_END
