#import "AttributedRenderer.h"
#import "BlockquoteBorder.h"
#import "CodeBlockBackground.h"
#import "ENRMBlockquoteTextRenderer.h"
#import "ENRMLinkPillText.h"
#import "LastElementUtils.h"
#import "MarkdownASTNode.h"
#import "NodeRenderer.h"
#import "ParagraphStyleUtils.h"
#import "RenderContext.h"
#import "RendererFactory.h"
#import "StyleConfig.h"

@implementation AttributedRenderer {
  StyleConfig *_config;
  RendererFactory *_rendererFactory;
  CGFloat _lastElementMarginBottom;
  BOOL _allowTrailingMargin;
}

- (instancetype)initWithConfig:(StyleConfig *)config
{
  self = [super init];
  if (self) {
    _config = config;
    _rendererFactory = [[RendererFactory alloc] initWithConfig:config];
    _lastElementMarginBottom = 0.0;
    _allowTrailingMargin = NO;
  }
  return self;
}

/**
 * Entry point for rendering a flat list of sibling nodes (e.g. a document's or a block segment's
 * children). Sets the baseline block style, runs the recursive traversal, and trims the trailing
 * block margin. An optional [block] decorates the pass - it enters a block baseline before the nodes
 * render and post-processes the finished string - letting a caller render content as e.g. blockquote
 * text without this class knowing anything block-specific. See ENRMBlockquoteTextRenderer.
 */
- (NSMutableAttributedString *)renderNodes:(NSArray<MarkdownASTNode *> *)nodes
                                   context:(RenderContext *)context
                                     block:(ENRMBlockquoteTextRenderer *)block
{
  // 1. Establish the baseline block style. This ensures leaf nodes (like Text) have valid
  // attributes if they appear at the top level. A decorator overrides the default paragraph
  // baseline (e.g. the blockquote baseline so paragraphs render tight and pick up the quote's
  // font/color).
  if (block) {
    [block pushOnContext:context];
  } else {
    [context setBlockStyle:BlockTypeParagraph font:_config.paragraphFont color:_config.paragraphColor headingLevel:0];
  }

  NSMutableAttributedString *output = [[NSMutableAttributedString alloc] init];

  // 2. Iterate through the sibling nodes.
  for (MarkdownASTNode *node in nodes) {
    [self renderNodeRecursive:node into:output context:context];
  }

  // 3. Remove trailing paragraph spacing from last block element
  // Reset lastElementMarginBottom before processing
  _lastElementMarginBottom = 0.0;
  [self removeTrailingSpacing:output];

  // 4. Let the decorator post-process the finished string (e.g. stamp the quote's line height).
  [block postProcess:output];
  ENRMLinkPillsAdoptPlaceholderFonts(output);

  // 5. Cleanup global state to prevent side effects in subsequent renders.
  [context clearBlockStyle];

  return output;
}

/**
 * Trims trailing newlines after the last rendered block, with special handling for code blocks.
 *
 * For non-code-block tail elements: deletes all trailing newlines after the last non-newline
 * character and zeroes the last element's paragraph spacing so it doesn't render a margin past
 * the content.
 *
 * For code blocks (`isLastBlockACodeBlock` == YES): keeps the bottom padding spacer in place
 * AND preserves a single trailing newline immediately after it (typically the
 * codeBlockMarginBottom spacer that CodeBlockRenderer already appended; if none exists, one is
 * synthesized here). That extra newline matters because of an iOS layout quirk:
 *
 *   - iOS treats the trailing `\n` of the storage as a paragraph terminator and reports the
 *     line fragment for the paragraph after it via `extraLineFragmentRect`.
 *   - `boundingRectForGlyphRange:` excludes that extra line, and the graphics-context clip
 *     passed to `drawBackgroundForGlyphRange:` is tiled to the laid-out content area (rounded
 *     up to 128pt boundaries) which also excludes it.
 *   - If the bottom padding spacer were the trailing `\n`, its 16/19pt line fragment would
 *     fall into that excluded zone — the background rect would have to be manually extended
 *     past the clip and the bottom rounded corner would get sliced off at the tile boundary
 *     (the original visual bug in #354).
 *
 * By keeping a 1pt-tall tail newline beyond the bottom padding spacer, iOS lays the spacer
 * out as a normal interior line fragment included in usedRect/boundingRect and inside the
 * drawing tiles, so the corner renders intact and no rect extension is needed.
 */
- (void)removeTrailingSpacing:(NSMutableAttributedString *)output
{
  if (output.length == 0)
    return;

  // Find the last non-newline character
  NSRange lastContent = [output.string rangeOfCharacterFromSet:[NSCharacterSet.newlineCharacterSet invertedSet]
                                                       options:NSBackwardsSearch];
  if (lastContent.location == NSNotFound)
    return;

  // 1. Capture the Margin Bottom (Scanning from last content to end)
  _lastElementMarginBottom = 0.0;
  for (NSUInteger i = lastContent.location; i < output.length;) {
    NSRange attrRange;
    NSParagraphStyle *style = [output attribute:NSParagraphStyleAttributeName atIndex:i effectiveRange:&attrRange];
    if (style) {
      _lastElementMarginBottom = MAX(_lastElementMarginBottom, style.paragraphSpacing);
    }
    i = NSMaxRange(attrRange);
  }

  // 2. Trim trailing characters
  NSUInteger logicalEnd = NSMaxRange(lastContent);
  BOOL isCodeBlock = isLastBlockACodeBlock(output);
  BOOL isPaddedBlockquote = !isCodeBlock && [_config blockquotePadding] > 0 &&
                            [output attribute:BlockquoteDepthAttributeName
                                       atIndex:lastContent.location
                                effectiveRange:NULL] != nil;
  NSRange codeRange = NSMakeRange(0, 0);
  if (isCodeBlock) {
    [output attribute:CodeBlockAttributeName
                      atIndex:lastContent.location
        longestEffectiveRange:&codeRange
                      inRange:NSMakeRange(0, output.length)];
    NSUInteger codeEnd = NSMaxRange(codeRange);
    if (codeEnd >= output.length) {
      [output appendAttributedString:kNewlineAttributedString];
    }
    logicalEnd = codeEnd + 1;
  } else if (isPaddedBlockquote) {
    NSUInteger blockquoteEnd = NSMaxRange(lastContent);
    while (blockquoteEnd < output.length && [output attribute:BlockquoteDepthAttributeName
                                                       atIndex:blockquoteEnd
                                                effectiveRange:NULL] != nil) {
      blockquoteEnd++;
    }
    if (blockquoteEnd >= output.length) {
      [output appendAttributedString:kNewlineAttributedString];
    }
    logicalEnd = blockquoteEnd + 1;
  }

  if (logicalEnd < output.length) {
    [output deleteCharactersInRange:NSMakeRange(logicalEnd, output.length - logicalEnd)];
  }

  if ((isCodeBlock && NSMaxRange(codeRange) < output.length) || isPaddedBlockquote) {
    NSUInteger tailIdx = isCodeBlock ? NSMaxRange(codeRange) : logicalEnd - 1;
    [output removeAttribute:CodeBlockAttributeName range:NSMakeRange(tailIdx, 1)];
    [output removeAttribute:BlockquoteDepthAttributeName range:NSMakeRange(tailIdx, 1)];
    [output removeAttribute:BlockquoteBackgroundColorAttributeName range:NSMakeRange(tailIdx, 1)];
    NSParagraphStyle *style = [output attribute:NSParagraphStyleAttributeName atIndex:tailIdx effectiveRange:NULL];
    NSMutableParagraphStyle *mutableStyle = style ? [style mutableCopy] : [[NSMutableParagraphStyle alloc] init];
    mutableStyle.paragraphSpacing = 0;
    mutableStyle.paragraphSpacingBefore = 0;
    mutableStyle.minimumLineHeight = 1;
    mutableStyle.maximumLineHeight = 1;
    [output addAttribute:NSParagraphStyleAttributeName value:mutableStyle range:NSMakeRange(tailIdx, 1)];
  }

  // 3. Zero out internal spacing for the last element (if not a code block)
  if (!isCodeBlock) {
    NSRange styleRange;
    NSParagraphStyle *style = [output attribute:NSParagraphStyleAttributeName
                                        atIndex:lastContent.location
                                 effectiveRange:&styleRange];

    if (style) {
      NSMutableParagraphStyle *mutableStyle = [style mutableCopy];
      mutableStyle.paragraphSpacing = 0;
      mutableStyle.paragraphSpacingBefore = 0;

      if (isLastElementImage(output)) {
        mutableStyle.lineSpacing = 0;
      }

      NSRange safeRange = NSIntersectionRange(styleRange, NSMakeRange(0, output.length));
      [output addAttribute:NSParagraphStyleAttributeName value:mutableStyle range:safeRange];
    }
  }
}

- (void)setAllowTrailingMargin:(BOOL)allow
{
  _allowTrailingMargin = allow;
}

- (CGFloat)getLastElementMarginBottom
{
  return _lastElementMarginBottom;
}

/**
 * Orchestrates the recursive traversal of the AST.
 * If a specialized renderer exists for a node type, it takes full control.
 */
- (void)renderNodeRecursive:(MarkdownASTNode *)node
                       into:(NSMutableAttributedString *)out
                    context:(RenderContext *)context
{
  if (!node)
    return;

  id<NodeRenderer> renderer = [_rendererFactory rendererForNodeType:node.type];

  if (renderer) {
    // Specialized renderers (e.g., Strong, Link, Heading) handle their own sub-trees.
    [renderer renderNode:node into:out context:context];
  } else {
    // Fallback: Default to deep-first traversal for unhandled container nodes.
    for (MarkdownASTNode *child in node.children) {
      [self renderNodeRecursive:child into:out context:context];
    }
  }
}

@end
