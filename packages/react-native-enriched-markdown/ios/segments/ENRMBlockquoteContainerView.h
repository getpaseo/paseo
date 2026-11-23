#pragma once

#import "ENRMCodeBlockContainerView.h"
#import "ENRMContainerNodeView.h"
#import "StyleConfig.h"

@class MarkdownASTNode;
@class ENRMAccessibilityLabels;

NS_ASSUME_NONNULL_BEGIN

typedef void (^ENRMBlockquoteLinkBlock)(NSString *url);

/**
 * A GFM blockquote rendered as a recursive container (issue #608): it splits its
 * own AST children into segments and lays them out through the shared
 * ENRMContainerNodeView machinery, so a nested quote becomes another
 * ENRMBlockquoteContainerView, a fenced code block becomes an
 * ENRMCodeBlockContainerView, and prose collapses into a single inner text view.
 * Nesting depth is automatic: each level is its own view, inset further by its
 * padding, so drawRect: only ever renders one accent bar plus the background for
 * this single level. This mirrors Android's BlockquoteContainerView.
 *
 * The content inset is applied via contentInsets (left = borderWidth + gapWidth
 * + padding, other edges = padding), reusing the geometry the commonmark
 * BlockquoteBorder draws for the in-text (list-nested) path, which stays
 * untouched. The base measure/layout already honor contentInsets.
 *
 * Streaming is static inside a quote (no pending fence, no animation); a content
 * change re-signs the whole subtree so the outer reconciler still reuses the
 * quote view.
 */
@interface ENRMBlockquoteContainerView : ENRMContainerNodeView

- (instancetype)initWithConfig:(StyleConfig *)config;

// Splits the node's children into segments and applies them to this container.
- (void)applyBlockquoteNode:(MarkdownASTNode *)node;

// Laid-out height of this quote at the given outer width (the width the parent
// lays it out at, before this view's own inset).
- (CGFloat)measureHeight:(CGFloat)maxWidth;

// View-free height for the shadow-node measurement pass: the same height an
// instance's measureHeight: reports for the node, without building a view. It
// sums the child segments at the reduced inner width and adds the vertical
// inset, recursing into itself for nested quotes. pointScaleFactor is the layout
// context's scale (the visible instance path uses RCTScreenScale), threaded so
// the per-text-segment pixel rounding matches the laid-out height.
+ (CGFloat)measureHeightForBlockquoteNode:(MarkdownASTNode *)node
                                   config:(StyleConfig *)config
                                 maxWidth:(CGFloat)maxWidth
                         pointScaleFactor:(CGFloat)pointScaleFactor
                         allowFontScaling:(BOOL)allowFontScaling
                        lineBreakStrategy:(NSLineBreakStrategy)lineBreakStrategy;

// Consumer text props threaded into the quote's inner content so it honors them
// the same way the root document path does, instead of assuming defaults. Set by
// the host (root view or parent quote) at creation; propagated to nested quotes.
@property (nonatomic, assign) BOOL allowFontScaling;
@property (nonatomic, assign) NSLineBreakStrategy lineBreakStrategy;

// YES when this quote is nested directly inside another quote. A nested quote
// carries no vertical margin (only the outermost quote does, applied by the root
// host), matching the commonmark path which applies blockquote margins only at
// depth 0. Set by the parent quote's child registry.
@property (nonatomic, assign) BOOL nested;

// Bridged up to the JS onLinkPress/onLinkLongPress events; propagated to nested
// quotes so links at any depth fire.
@property (nonatomic, copy, nullable) void (^onLinkPress)(NSString *url, NSString *sourceType);
@property (nonatomic, copy, nullable) ENRMBlockquoteLinkBlock onLinkLongPress;
@property (nonatomic, copy, nullable) void (^onImagePress)(NSString *url, NSString *altText);

@property (nonatomic, copy, nullable) ENRMCodeBlockCopyBlock onCopyPress;
@property (nonatomic, copy, nullable) ENRMCodeBlockPressBlock onCodeBlockPress;

// Shared, runtime-mutable block props (context-menu gate, code-block tap gate,
// copy labels) read live at use-time. Set to the root's shared instance at
// creation and handed unchanged to this quote's children, so a child added after
// a toggle is born current with no per-toggle push. See ENRMDynamicBlockProps.
@property (nonatomic, strong) ENRMDynamicBlockProps *dynamicProps;

// Resolved VoiceOver strings (list, quote, table and math announcements). Set by
// the host at creation and pushed to this quote's children, recursing into
// nested quotes, so they are labelled the same way top-level segments are.
@property (nonatomic, strong, nullable) ENRMAccessibilityLabels *accessibilityLabels;

@end

NS_ASSUME_NONNULL_END
