#import "MarkdownASTSerializer.h"
#import "ENRMCodeBlockContent.h"
#import "MarkdownASTNode.h"

static void serializeNode(MarkdownASTNode *node, NSMutableString *buffer);
static void serializeChildren(MarkdownASTNode *node, NSMutableString *buffer);
static void appendBlockNode(MarkdownASTNode *node, NSMutableString *buffer);
static void appendPlainText(MarkdownASTNode *node, NSMutableString *buffer);

static void serializeChildren(MarkdownASTNode *node, NSMutableString *buffer)
{
  for (MarkdownASTNode *child in node.children) {
    serializeNode(child, buffer);
  }
}

static void serializeNode(MarkdownASTNode *node, NSMutableString *buffer)
{
  if (!node)
    return;

  switch (node.type) {
    case MarkdownNodeTypeText:
      [buffer appendString:node.content ?: @""];
      break;

    case MarkdownNodeTypeLineBreak:
      [buffer appendString:@"\\\n"];
      break;

    case MarkdownNodeTypeSoftBreak:
      [buffer appendString:@"\n"];
      break;

    case MarkdownNodeTypeStrong:
      [buffer appendString:@"**"];
      serializeChildren(node, buffer);
      [buffer appendString:@"**"];
      break;

    case MarkdownNodeTypeEmphasis:
      [buffer appendString:@"*"];
      serializeChildren(node, buffer);
      [buffer appendString:@"*"];
      break;

    case MarkdownNodeTypeStrikethrough:
      [buffer appendString:@"~~"];
      serializeChildren(node, buffer);
      [buffer appendString:@"~~"];
      break;

    case MarkdownNodeTypeUnderline:
      [buffer appendString:@"__"];
      serializeChildren(node, buffer);
      [buffer appendString:@"__"];
      break;

    case MarkdownNodeTypeSuperscript:
      [buffer appendString:@"^"];
      serializeChildren(node, buffer);
      [buffer appendString:@"^"];
      break;

    case MarkdownNodeTypeSubscript:
      [buffer appendString:@"~"];
      serializeChildren(node, buffer);
      [buffer appendString:@"~"];
      break;

    case MarkdownNodeTypeHighlight:
      [buffer appendString:@"=="];
      serializeChildren(node, buffer);
      [buffer appendString:@"=="];
      break;

    case MarkdownNodeTypeCode:
      [buffer appendString:@"`"];
      serializeChildren(node, buffer);
      [buffer appendString:@"`"];
      break;

    case MarkdownNodeTypeLink: {
      if ([node.attributes[@"recognizedLink"] isEqualToString:@"true"]) {
        serializeChildren(node, buffer);
        break;
      }
      NSString *url = node.attributes[@"url"] ?: @"";
      [buffer appendString:@"["];
      serializeChildren(node, buffer);
      [buffer appendFormat:@"](%@)", url];
      break;
    }

    case MarkdownNodeTypeImage: {
      NSString *alt = node.attributes[@"alt"] ?: @"";
      NSString *url = node.attributes[@"url"] ?: @"";
      [buffer appendFormat:@"![%@](%@)", alt, url];
      break;
    }

    case MarkdownNodeTypeVideo: {
      NSString *url = node.attributes[@"url"] ?: @"";
      if ([url containsString:@"\""]) {
        [buffer appendFormat:@"<video src='%@' />", url];
      } else {
        [buffer appendFormat:@"<video src=\"%@\" />", url];
      }
      break;
    }

    case MarkdownNodeTypeParagraph:
    default:
      serializeChildren(node, buffer);
      break;
  }
}

// --- Block-level serialization ---

static void serializeBlockChildren(MarkdownASTNode *node, NSMutableString *buffer)
{
  NSArray<MarkdownASTNode *> *children = node.children;
  for (NSUInteger i = 0; i < children.count; i++) {
    MarkdownASTNode *child = children[i];
    appendBlockNode(child, buffer);
    if (i < children.count - 1 && ENRMIsTopLevelBlockType(child.type)) {
      [buffer appendString:@"\n"];
    }
  }
}

// Table markdown reconstruction from raw AST nodes. This parallels
// TableContainerView's buildMarkdownFromRows which works from processed
// TableCellData; both must produce the same pipe-table format.
static void appendTableMarkdown(MarkdownASTNode *node, NSMutableString *buffer)
{
  BOOL headerDone = NO;
  for (MarkdownASTNode *section in node.children) {
    for (MarkdownASTNode *row in section.children) {
      if (row.type != MarkdownNodeTypeTableRow)
        continue;
      NSMutableArray<NSString *> *cells = [NSMutableArray arrayWithCapacity:row.children.count];
      for (MarkdownASTNode *cell in row.children) {
        [cells addObject:markdownFromASTNodeChildren(cell)];
      }
      [buffer appendFormat:@"| %@ |\n", [cells componentsJoinedByString:@" | "]];
      if (!headerDone) {
        BOOL isHeader = NO;
        for (MarkdownASTNode *cell in row.children) {
          if (cell.type == MarkdownNodeTypeTableHeaderCell) {
            isHeader = YES;
            break;
          }
        }
        if (isHeader) {
          NSMutableArray<NSString *> *sep = [NSMutableArray arrayWithCapacity:row.children.count];
          for (MarkdownASTNode *cell in row.children) {
            NSString *align = cell.attributes[@"align"];
            if ([align isEqualToString:@"center"])
              [sep addObject:@":---:"];
            else if ([align isEqualToString:@"right"])
              [sep addObject:@"---:"];
            else
              [sep addObject:@"---"];
          }
          [buffer appendFormat:@"| %@ |\n", [sep componentsJoinedByString:@" | "]];
          headerDone = YES;
        }
      }
    }
  }
}

static void appendListMarkdown(MarkdownASTNode *node, NSMutableString *buffer, BOOL ordered)
{
  NSUInteger number = 1;
  if (ordered) {
    NSString *startAttr = node.attributes[@"start"];
    if (startAttr != nil) {
      NSInteger parsed = startAttr.integerValue;
      number = (NSUInteger)MAX(0, parsed);
    }
  }
  for (MarkdownASTNode *item in node.children) {
    if (item.type != MarkdownNodeTypeListItem)
      continue;
    NSString *prefix = ordered ? [NSString stringWithFormat:@"%lu. ", (unsigned long)number] : @"- ";
    NSMutableString *content = [NSMutableString string];
    serializeBlockChildren(item, content);
    NSString *trimmed =
        content.length > 0 ? [content stringByTrimmingCharactersInSet:[NSCharacterSet newlineCharacterSet]] : @"";
    NSArray<NSString *> *lines = [trimmed componentsSeparatedByString:@"\n"];
    NSString *indent = [@"" stringByPaddingToLength:prefix.length withString:@" " startingAtIndex:0];
    for (NSUInteger l = 0; l < lines.count; l++) {
      [buffer appendString:(l == 0) ? prefix : indent];
      [buffer appendString:lines[l]];
      [buffer appendString:@"\n"];
    }
    if (ordered)
      number++;
  }
}

static void appendBlockNode(MarkdownASTNode *node, NSMutableString *buffer)
{
  if (!node)
    return;

  switch (node.type) {
    case MarkdownNodeTypeParagraph:
      serializeChildren(node, buffer);
      [buffer appendString:@"\n"];
      break;

    case MarkdownNodeTypeHeading: {
      NSInteger level = [node.attributes[@"level"] integerValue];
      if (level < 1)
        level = 1;
      for (NSInteger i = 0; i < level; i++)
        [buffer appendString:@"#"];
      [buffer appendString:@" "];
      serializeChildren(node, buffer);
      [buffer appendString:@"\n"];
      break;
    }

    case MarkdownNodeTypeCodeBlock: {
      NSString *code = ENRMCodeBlockExtractCode(node);
      NSString *language = ENRMCodeBlockLanguage(node);
      NSString *fenceChar = ENRMCodeBlockFenceChar(node);
      [buffer appendString:ENRMCodeBlockFencedMarkdown(code, language, fenceChar)];
      [buffer appendString:@"\n"];
      break;
    }

    case MarkdownNodeTypeBlockquote:
    case MarkdownNodeTypeAdmonition:
      [buffer appendString:markdownFromBlockquoteNode(node)];
      break;

    case MarkdownNodeTypeThematicBreak:
      [buffer appendString:@"---\n"];
      break;

    case MarkdownNodeTypeBlankLine: {
      NSInteger count = [node.attributes[@"count"] integerValue];
      for (NSInteger i = 0; i < count; i++) {
        [buffer appendString:@"\n"];
      }
      break;
    }

    case MarkdownNodeTypeTable:
      appendTableMarkdown(node, buffer);
      break;

    case MarkdownNodeTypeUnorderedList:
      appendListMarkdown(node, buffer, NO);
      break;

    case MarkdownNodeTypeOrderedList:
      appendListMarkdown(node, buffer, YES);
      break;

    case MarkdownNodeTypeLatexMathDisplay:
      [buffer appendString:@"$$\n"];
      serializeChildren(node, buffer);
      [buffer appendString:@"\n$$\n"];
      break;

    default:
      serializeChildren(node, buffer);
      break;
  }
}

static void appendPlainText(MarkdownASTNode *node, NSMutableString *buffer)
{
  switch (node.type) {
    case MarkdownNodeTypeSoftBreak:
    case MarkdownNodeTypeLineBreak:
      [buffer appendString:@"\n"];
      break;
    case MarkdownNodeTypeBlankLine: {
      NSInteger count = [node.attributes[@"count"] integerValue];
      for (NSInteger i = 0; i < count; i++) {
        [buffer appendString:@"\n"];
      }
      break;
    }
    case MarkdownNodeTypeParagraph:
    case MarkdownNodeTypeHeading:
      for (MarkdownASTNode *child in node.children) {
        appendPlainText(child, buffer);
      }
      [buffer appendString:@"\n"];
      break;
    default:
      if (node.content.length > 0) {
        [buffer appendString:node.content];
      }
      for (MarkdownASTNode *child in node.children) {
        appendPlainText(child, buffer);
      }
      break;
  }
}

// --- Public API ---

NSString *markdownFromASTNode(MarkdownASTNode *node)
{
  if (!node)
    return @"";
  NSMutableString *buffer = [NSMutableString string];
  serializeNode(node, buffer);
  return [buffer copy];
}

NSString *markdownFromASTNodeChildren(MarkdownASTNode *node)
{
  if (!node)
    return @"";
  NSMutableString *buffer = [NSMutableString string];
  serializeChildren(node, buffer);
  return [buffer copy];
}

NSString *markdownFromBlockquoteNode(MarkdownASTNode *node)
{
  if (!node)
    return @"";

  NSMutableString *result = [NSMutableString string];
  BOOL isAdmonition = (node.type == MarkdownNodeTypeAdmonition);

  if (isAdmonition) {
    NSString *type = node.attributes[@"admonitionType"];
    if (!type.length)
      type = @"note";
    [result appendFormat:@"> [!%@]\n", [type uppercaseString]];
  }

  NSMutableString *body = [NSMutableString string];
  serializeBlockChildren(node, body);

  NSString *trimmed = [body stringByTrimmingCharactersInSet:[NSCharacterSet newlineCharacterSet]];
  NSArray<NSString *> *lines = [trimmed componentsSeparatedByString:@"\n"];
  for (NSString *line in lines) {
    [result appendString:@"> "];
    [result appendString:line];
    [result appendString:@"\n"];
  }
  return [result copy];
}

NSString *plainTextFromASTNode(MarkdownASTNode *node)
{
  if (!node)
    return @"";
  NSMutableString *buffer = [NSMutableString string];
  appendPlainText(node, buffer);
  return [[buffer copy] stringByTrimmingCharactersInSet:[NSCharacterSet whitespaceAndNewlineCharacterSet]];
}
