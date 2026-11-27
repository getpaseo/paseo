#import "RendererFactory.h"
#import "BlankLineRenderer.h"
#import "BlockquoteRenderer.h"
#import "CodeBlockRenderer.h"
#import "CodeRenderer.h"
#import "ENRMImageRenderer.h"
#import "EmphasisRenderer.h"

#import "ENRMFeatureFlags.h"

#if ENRICHED_MARKDOWN_MATH
#import "ENRMMathInlineRenderer.h"
#endif
#import "ENRMSpoilerRenderer.h"
#import "HeadingRenderer.h"
#import "HighlightRenderer.h"
#import "LinkRenderer.h"
#import "ListItemRenderer.h"
#import "ListRenderer.h"
#import "MarkdownASTNode.h"
#import "ParagraphRenderer.h"
#import "RenderContext.h"
#import "StrikethroughRenderer.h"
#import "StrongRenderer.h"
#import "StyleConfig.h"
#import "SubscriptRenderer.h"
#import "SuperscriptRenderer.h"
#import "TextRenderer.h"
#import "ThematicBreakRenderer.h"
#import "UnderlineRenderer.h"

@implementation RendererFactory {
  StyleConfig *_config;
  NSMutableDictionary<NSNumber *, id<NodeRenderer>> *_cache;
}

/**
 * Initializes the factory with a shared style configuration.
 * Uses a mutable dictionary to cache renderer instances as they are needed.
 */
- (instancetype)initWithConfig:(StyleConfig *)config
{
  self = [super init];
  if (self) {
    _config = config;
    _cache = [NSMutableDictionary new];
  }
  return self;
}

/**
 * Returns a shared renderer instance for a specific node type.
 * Implements lazy initialization to avoid allocating unused renderers.
 */
- (id<NodeRenderer>)rendererForNodeType:(MarkdownNodeType)type
{
  id<NodeRenderer> cached = _cache[@(type)];
  if (cached) {
    return cached;
  }

  id<NodeRenderer> renderer = [self createRendererForType:type];
  if (renderer) {
    _cache[@(type)] = renderer;
  }
  return renderer;
}

/**
 * Internal factory method to instantiate specialized renderers.
 */
- (id<NodeRenderer>)createRendererForType:(MarkdownNodeType)type
{
  switch (type) {
    case MarkdownNodeTypeText:
      return [TextRenderer new];
    case MarkdownNodeTypeStrong:
      return [[StrongRenderer alloc] initWithRendererFactory:self config:_config];
    case MarkdownNodeTypeEmphasis:
      return [[EmphasisRenderer alloc] initWithRendererFactory:self config:_config];
    case MarkdownNodeTypeStrikethrough:
      return [[StrikethroughRenderer alloc] initWithRendererFactory:self config:_config];
    case MarkdownNodeTypeUnderline:
      return [[UnderlineRenderer alloc] initWithRendererFactory:self config:_config];
    case MarkdownNodeTypeSuperscript:
      return [[SuperscriptRenderer alloc] initWithRendererFactory:self config:_config];
    case MarkdownNodeTypeSubscript:
      return [[SubscriptRenderer alloc] initWithRendererFactory:self config:_config];
    case MarkdownNodeTypeHighlight:
      return [[HighlightRenderer alloc] initWithRendererFactory:self config:_config];
    case MarkdownNodeTypeParagraph:
      return [[ParagraphRenderer alloc] initWithRendererFactory:self config:_config];
    case MarkdownNodeTypeLink:
      return [[LinkRenderer alloc] initWithRendererFactory:self config:_config];
    case MarkdownNodeTypeHeading:
      return [[HeadingRenderer alloc] initWithRendererFactory:self config:_config];
    case MarkdownNodeTypeCode:
      return [[CodeRenderer alloc] initWithRendererFactory:self config:_config];
    case MarkdownNodeTypeImage:
      return [[ENRMImageRenderer alloc] initWithRendererFactory:self config:_config];
    case MarkdownNodeTypeBlockquote:
    // A list-nested admonition falls back to the inline blockquote renderer
    // (no themed header); top-level admonitions use the segment container path.
    case MarkdownNodeTypeAdmonition:
      return [[BlockquoteRenderer alloc] initWithRendererFactory:self config:_config];
    case MarkdownNodeTypeListItem:
      return [[ListItemRenderer alloc] initWithRendererFactory:self config:_config];
    case MarkdownNodeTypeUnorderedList:
      return [[ListRenderer alloc] initWithRendererFactory:self config:_config isOrdered:NO];
    case MarkdownNodeTypeOrderedList:
      return [[ListRenderer alloc] initWithRendererFactory:self config:_config isOrdered:YES];
    case MarkdownNodeTypeCodeBlock:
      return [[CodeBlockRenderer alloc] initWithRendererFactory:self config:_config];
    case MarkdownNodeTypeThematicBreak:
      return [[ThematicBreakRenderer alloc] initWithRendererFactory:self config:_config];
    case MarkdownNodeTypeBlankLine:
      return [[BlankLineRenderer alloc] initWithRendererFactory:self config:_config];
#if ENRICHED_MARKDOWN_MATH
    case MarkdownNodeTypeLatexMathInline:
      return [[ENRMMathInlineRenderer alloc] initWithRendererFactory:self config:_config];
    case MarkdownNodeTypeLatexMathDisplay:
      // Display math INSIDE a paragraph (mid-paragraph / softbreak-adjacent
      // `$$…$$`) previously fell through to the nil-renderer child dump —
      // the body leaked as plain text with its delimiters silently dropped.
      // Typeset it as an inline attachment instead; block-level display math
      // is unaffected (SegmentRenderer intercepts root-level display nodes
      // before this factory is consulted).
      return [[ENRMMathInlineRenderer alloc] initWithRendererFactory:self config:_config];
#endif
    case MarkdownNodeTypeSpoiler:
      return [[ENRMSpoilerRenderer alloc] initWithRendererFactory:self config:_config];
    default:
      return nil;
  }
}

/**
 * Helper method for container renderers to process their children.
 * Leverages the factory to find the appropriate renderer for each child node.
 */
- (void)renderChildrenOfNode:(MarkdownASTNode *)node
                        into:(NSMutableAttributedString *)output
                     context:(RenderContext *)context
{
  for (MarkdownASTNode *child in node.children) {
    if (child.type == MarkdownNodeTypeLineBreak) {
      NSAttributedString *lineBreak = [[NSAttributedString alloc] initWithString:@"\u2028"
                                                                      attributes:[context getTextAttributes]];
      [output appendAttributedString:lineBreak];
      continue;
    }
    if (child.type == MarkdownNodeTypeSoftBreak) {
      NSAttributedString *softBreak = [[NSAttributedString alloc] initWithString:@" "
                                                                      attributes:[context getTextAttributes]];
      [output appendAttributedString:softBreak];
      continue;
    }
    id<NodeRenderer> renderer = [self rendererForNodeType:child.type];
    if (renderer) {
      [renderer renderNode:child into:output context:context];
    } else if (child.children.count > 0) {
      [self renderChildrenOfNode:child into:output context:context];
    }
  }
}

@end