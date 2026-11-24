#pragma once

#import "ENRMUIKit.h"
#import "RenderedMarkdownSegment.h"
#import "SegmentViewRegistry.h"
#import "StyleConfig.h"

NS_ASSUME_NONNULL_BEGIN

/**
 * Reusable host view for an AST branch node that holds a vertical stack of block
 * children (currently every blockquote; the analogue of Android's
 * ContainerNodeView). It owns the machinery shared by such hosts: reconciling a
 * list of ENRMRenderedSegment into real child views by signature via
 * ENRMSegmentReconciler + a per-kind ENRMSegmentViewRegistry the subclass
 * supplies, stacking them vertically with per-segment margins, and reporting the
 * total height (including its own content insets).
 *
 * Layout honors contentInsets so a subclass can inset its children (e.g. a
 * blockquote's border/gap/padding): children are laid out at width minus the
 * horizontal insets, starting at (insets.left, insets.top). Per-kind margins are
 * read from the config exactly as the root view's layout applies them.
 *
 * Streaming inside a container is treated as static: no fade/tail animation and
 * no pending-code-fence sync. A content change re-signs the whole subtree, so
 * the outer reconciler still reuses the container view by signature.
 */
@interface ENRMContainerNodeView : RCTUIView

@property (nonatomic, strong) StyleConfig *config;

// Set by a subclass before applySegments:reset:. The reconcile/layout loop is
// identical across hosts; only the child view construction varies per registry.
@property (nonatomic, strong) ENRMSegmentViewRegistry *segmentViewRegistry;

// Inset applied to all children. A plain container leaves this zero.
@property (nonatomic, assign) UIEdgeInsets contentInsets;

// Whether the last child contributes its trailing bottom margin.
@property (nonatomic, assign) BOOL allowTrailingMargin;

// Reconciles the current child views against renderedSegments, attaching and
// removing subviews as needed. Requests a re-layout.
- (void)applySegments:(NSArray<ENRMRenderedSegment *> *)renderedSegments reset:(BOOL)reset;

// Total laid-out height for the current children at contentWidth (inner width,
// i.e. bounds width minus horizontal insets), including the vertical insets.
- (CGFloat)computeContentHeightForWidth:(CGFloat)contentWidth;

@end

NS_ASSUME_NONNULL_END
