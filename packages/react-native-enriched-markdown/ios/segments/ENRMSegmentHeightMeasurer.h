#pragma once

#import "ENRMUIKit.h"
#import "ParagraphStyleUtils.h"
#import "RenderedMarkdownSegment.h"
#import "StyleConfig.h"

NS_ASSUME_NONNULL_BEGIN

/**
 * View-free height summation for a vertical stack of already-rendered
 * segments at a fixed content width. This is the iOS counterpart of Android's
 * SegmentHeightMeasurer: it single-sources the per-segment height arithmetic so
 * the shadow-node measurement pass (ENRMViewFreeMeasurement) and the blockquote
 * container's own laid-out/static heights cannot drift.
 *
 * Each kind is measured with the same helper the visible view uses: text via a
 * fresh call-confined TextKit stack (ENRMMeasureAttributedTextViewFree), tables
 * via +[TableContainerView measureHeightForTableNode:...], code blocks via
 * +[ENRMCodeBlockContainerView measureHeightForCodeBlockNode:...], math via
 * +[ENRMMathContainerView measureHeightForLatex:...], and nested blockquotes via
 * +[ENRMBlockquoteContainerView measureHeightForBlockquoteNode:...] (recursion).
 * Per-kind margins come from the config exactly as computeSegmentLayout applies
 * them: marginTop before, marginBottom after unless it is the last segment and
 * trailing margins are disabled.
 */
CGFloat ENRMMeasureSegmentsHeightViewFree(NSArray<ENRMRenderedSegment *> *segments, StyleConfig *config,
                                          CGFloat contentWidth, BOOL allowTrailingMargin, CGFloat pointScaleFactor,
                                          ENRMWritingDirectionMode writingDirectionMode,
                                          NSWritingDirection resolvedLayoutDirection, BOOL allowFontScaling,
                                          NSLineBreakStrategy lineBreakStrategy);

NS_ASSUME_NONNULL_END
