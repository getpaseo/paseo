#pragma once
#import "ENRMFeatureFlags.h"

#if ENRICHED_MARKDOWN_VIDEO

#import "ENRMDynamicBlockProps.h"
#import "ENRMUIKit.h"
#import "StyleConfig.h"

@class MarkdownASTNode;

NS_ASSUME_NONNULL_BEGIN

@interface ENRMVideoContainerView : RCTUIView
#if !TARGET_OS_OSX
                                    <UIContextMenuInteractionDelegate>
#endif

- (instancetype)initWithConfig:(StyleConfig *)config;

- (void)applyVideoNode:(MarkdownASTNode *)node;

- (void)reapplyStyle;

- (CGFloat)measureHeight:(CGFloat)maxWidth;

+ (CGFloat)measureHeightForVideoNode:(MarkdownASTNode *)node config:(StyleConfig *)config maxWidth:(CGFloat)maxWidth;

@property (nonatomic, strong) StyleConfig *config;

// Shared, runtime-mutable block props (context-menu gate + copy labels) read live
// at menu-open. Set to the root's shared instance at creation. See
// ENRMDynamicBlockProps.
@property (nonatomic, strong) ENRMDynamicBlockProps *dynamicProps;

@end

NS_ASSUME_NONNULL_END

#endif
