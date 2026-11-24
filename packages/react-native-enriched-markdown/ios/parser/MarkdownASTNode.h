#import <Foundation/Foundation.h>

typedef NS_ENUM(NSInteger, MarkdownNodeType) {
  MarkdownNodeTypeDocument,
  MarkdownNodeTypeParagraph,
  MarkdownNodeTypeText,
  MarkdownNodeTypeLink,
  MarkdownNodeTypeHeading,
  MarkdownNodeTypeLineBreak,
  MarkdownNodeTypeStrong,
  MarkdownNodeTypeEmphasis,
  MarkdownNodeTypeStrikethrough,
  MarkdownNodeTypeUnderline,
  MarkdownNodeTypeCode,
  MarkdownNodeTypeImage,
  MarkdownNodeTypeBlockquote,
  MarkdownNodeTypeUnorderedList,
  MarkdownNodeTypeOrderedList,
  MarkdownNodeTypeListItem,
  MarkdownNodeTypeCodeBlock,
  MarkdownNodeTypeThematicBreak,
  MarkdownNodeTypeTable,
  MarkdownNodeTypeTableHead,
  MarkdownNodeTypeTableBody,
  MarkdownNodeTypeTableRow,
  MarkdownNodeTypeTableHeaderCell,
  MarkdownNodeTypeTableCell,
  MarkdownNodeTypeLatexMathInline,
  MarkdownNodeTypeLatexMathDisplay,
  MarkdownNodeTypeSpoiler,
  MarkdownNodeTypeSuperscript,
  MarkdownNodeTypeSubscript,
  MarkdownNodeTypeHighlight,
  MarkdownNodeTypeSoftBreak,
  MarkdownNodeTypeBlankLine,
  MarkdownNodeTypeAdmonition,
  MarkdownNodeTypeVideo
};

@interface MarkdownASTNode : NSObject

@property (nonatomic, assign) MarkdownNodeType type;
@property (nonatomic, strong) NSString *content;
@property (nonatomic, strong) NSMutableDictionary *attributes;
@property (nonatomic, strong) NSMutableArray<MarkdownASTNode *> *children;

- (instancetype)initWithType:(MarkdownNodeType)type;
- (void)addChild:(MarkdownASTNode *)child;
- (void)setAttribute:(NSString *)key value:(NSString *)value;

@end

/// A node type that md4c emits as a standalone block stacked vertically,
/// as opposed to an inline span.
BOOL ENRMIsTopLevelBlockType(MarkdownNodeType type);
