#import "MarkdownASTNode.h"

@implementation MarkdownASTNode

- (instancetype)initWithType:(MarkdownNodeType)type
{
  if (self = [super init]) {
    _type = type;
    _content = nil;
    _attributes = [[NSMutableDictionary alloc] init];
    _children = [[NSMutableArray alloc] init];
  }
  return self;
}

- (void)addChild:(MarkdownASTNode *)child
{
  [_children addObject:child];
}

- (void)setAttribute:(NSString *)key value:(NSString *)value
{
  _attributes[key] = value;
}

- (NSString *)description
{
  return [NSString stringWithFormat:@"MarkdownASTNode(type=%ld, content=%@, children=%lu)", (long)_type, _content,
                                    (unsigned long)_children.count];
}

@end

BOOL ENRMIsTopLevelBlockType(MarkdownNodeType type)
{
  switch (type) {
    case MarkdownNodeTypeParagraph:
    case MarkdownNodeTypeHeading:
    case MarkdownNodeTypeCodeBlock:
    case MarkdownNodeTypeBlockquote:
    case MarkdownNodeTypeAdmonition:
    case MarkdownNodeTypeTable:
    case MarkdownNodeTypeUnorderedList:
    case MarkdownNodeTypeOrderedList:
    case MarkdownNodeTypeThematicBreak:
    case MarkdownNodeTypeBlankLine:
    case MarkdownNodeTypeLatexMathDisplay:
      return YES;
    default:
      return NO;
  }
}
