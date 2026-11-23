#import "ENRMInputParser.h"
#import "ENRMFormattingRange.h"
#import "ENRMInputRemend.h"
#include "md4c.h"
#include <algorithm>
#include <string>
#include <vector>

@interface ENRMParseResult ()
@property (nonatomic, strong, readwrite) NSString *plainText;
@property (nonatomic, strong, readwrite) NSArray<ENRMFormattingRange *> *formattingRanges;
@property (nonatomic, strong, readwrite) NSArray<ENRMBlockRange *> *blockRanges;
@end

@implementation ENRMParseResult
@end

namespace {

static const size_t kByteOffsetUnset = SIZE_MAX;

struct SpanTypeMapping {
  MD_SPANTYPE md4cType;
  ENRMInputStyleType styleType;
};

static const SpanTypeMapping kSupportedSpans[] = {
    {MD_SPAN_STRONG, ENRMInputStyleTypeStrong}, {MD_SPAN_EM, ENRMInputStyleTypeEmphasis},
    {MD_SPAN_U, ENRMInputStyleTypeUnderline},   {MD_SPAN_DEL, ENRMInputStyleTypeStrikethrough},
    {MD_SPAN_A, ENRMInputStyleTypeLink},        {MD_SPAN_SPOILER, ENRMInputStyleTypeSpoiler},
};
static const size_t kSupportedSpanCount = sizeof(kSupportedSpans) / sizeof(kSupportedSpans[0]);

static bool isSupportedSpan(MD_SPANTYPE md4cType, ENRMInputStyleType &outStyleType)
{
  for (size_t index = 0; index < kSupportedSpanCount; index++) {
    if (kSupportedSpans[index].md4cType == md4cType) {
      outStyleType = kSupportedSpans[index].styleType;
      return true;
    }
  }
  return false;
}

// Block-type mapping mirrors kSupportedSpans for the inline pipeline. A block
// handler extends recognition by adding its md4c block here and, if leveled,
// reading its detail in resolveBlockLevel below. MD_BLOCK_P maps to the
// implicit Paragraph default and produces no stored block range.
struct BlockTypeMapping {
  MD_BLOCKTYPE md4cType;
  ENRMInputBlockType blockType;
};

static const BlockTypeMapping kSupportedBlocks[] = {
    {MD_BLOCK_P, ENRMInputBlockTypeParagraph},
    // MD_BLOCK_H maps to a representative heading type; onEnterBlock resolves the
    // level (via resolveBlockLevel) and rewrites the type to the level-specific
    // ENRMInputBlockTypeHeadingN.
    {MD_BLOCK_H, ENRMInputBlockTypeHeading1},
};
static const size_t kSupportedBlockCount = sizeof(kSupportedBlocks) / sizeof(kSupportedBlocks[0]);

static bool isSupportedBlock(MD_BLOCKTYPE md4cType, ENRMInputBlockType &outBlockType)
{
  for (size_t index = 0; index < kSupportedBlockCount; index++) {
    if (kSupportedBlocks[index].md4cType == md4cType) {
      outBlockType = kSupportedBlocks[index].blockType;
      return true;
    }
  }
  return false;
}

// Per-block integer payload (heading level, list depth). md4c exposes this in
// the block's MD_BLOCK_*_DETAIL struct. Headings read MD_BLOCK_H_DETAIL.level
// (1-6); other blocks have no level and return 0.
static NSInteger resolveBlockLevel(MD_BLOCKTYPE blockType, void *detail)
{
  if (blockType == MD_BLOCK_H && detail) {
    return (NSInteger)(static_cast<MD_BLOCK_H_DETAIL *>(detail)->level);
  }
  return 0;
}

struct InlineSpanInfo {
  ENRMInputStyleType type;
  size_t openingDelimiterByteOffset;
  size_t contentStartByteOffset = kByteOffsetUnset;
  size_t contentEndByteOffset = kByteOffsetUnset;
  std::string linkURL;
};

struct BlockInfo {
  ENRMInputBlockType type;
  NSInteger level;
  size_t contentStartByteOffset = kByteOffsetUnset;
  size_t contentEndByteOffset = kByteOffsetUnset;
};

struct ParseContext {
  const char *buffer;
  size_t bufferLength;
  size_t originalLength;
  std::vector<InlineSpanInfo> openStack;
  std::vector<InlineSpanInfo> resolved;
  std::vector<BlockInfo> openBlockStack;
  std::vector<BlockInfo> resolvedBlocks;
  std::vector<size_t> textStartOffsets;
  // Byte offsets of backslashes md4c resolved as escape sequences (the '\' of "\*"),
  // stripped from the plain text alongside inline/block delimiters.
  std::vector<size_t> escapeByteOffsets;
  size_t lastTextEnd = 0;
  // Open list containers, innermost last (true = ordered). An item's depth is
  // the stack size - 1 and its type the innermost container's; md4c carries no
  // per-item depth, so both derive from the open UL/OL ancestors.
  std::vector<bool> listContainerStack;
};

static std::vector<NSUInteger> buildByteToUTF16Map(const char *utf8, size_t byteLength)
{
  std::vector<NSUInteger> map(byteLength + 1, 0);
  NSUInteger utf16Index = 0;
  size_t byteIndex = 0;

  while (byteIndex < byteLength) {
    unsigned char leadByte = (unsigned char)utf8[byteIndex];
    size_t sequenceLength;

    if (leadByte < 0x80) {
      sequenceLength = 1;
    } else if ((leadByte & 0xE0) == 0xC0) {
      sequenceLength = 2;
    } else if ((leadByte & 0xF0) == 0xE0) {
      sequenceLength = 3;
    } else {
      sequenceLength = 4;
    }

    for (size_t offset = 0; offset < sequenceLength && (byteIndex + offset) <= byteLength; offset++) {
      map[byteIndex + offset] = utf16Index;
    }

    // 4-byte UTF-8 sequences encode codepoints above U+FFFF, which need a surrogate pair in UTF-16
    utf16Index += (sequenceLength == 4) ? 2 : 1;
    byteIndex += sequenceLength;
  }

  map[byteLength] = utf16Index;
  return map;
}

static inline NSUInteger mapByteOffset(const std::vector<NSUInteger> &map, size_t offset, size_t maxOffset)
{
  return map[std::min(offset, maxOffset)];
}

static size_t closingDelimiterEndByte(const ParseContext &context, const InlineSpanInfo &span)
{
  size_t position = span.contentEndByteOffset;

  if (span.type == ENRMInputStyleTypeLink) {
    while (position < context.bufferLength && context.buffer[position] != ')') {
      position++;
    }
    return (position < context.bufferLength) ? position + 1 : position;
  }

  // Markdown delimiter bytes occupy the gap between content end and the next emitted text run
  // (md4c never emits syntax bytes as text). Anchoring here — rather than adding a
  // fixed per-type length — keeps stacked closers of co-terminating spans (e.g.
  // "***", "**~~x~~**") from overlapping and leaking a trailing marker.
  auto next = std::lower_bound(context.textStartOffsets.begin(), context.textStartOffsets.end(), position);
  return (next != context.textStartOffsets.end()) ? *next : context.bufferLength;
}

// Block tracking. md4c's enter_block gives no byte offset, so a block's content
// range is bounded by the text spans it encloses: onText records the first/last
// text offset into the currently open block(s). On leave_block the block is
// resolved with whatever text range it accumulated; empty blocks (no text) are
// discarded later when building results.
static int onEnterBlock(MD_BLOCKTYPE blockType, void *detail, void *userdata)
{
  auto *context = static_cast<ParseContext *>(userdata);

  // List nesting is tracked by the container stack, not stored as its own
  // block: the UL/OL container only frames the items that read it.
  if (blockType == MD_BLOCK_UL || blockType == MD_BLOCK_OL) {
    context->listContainerStack.push_back(blockType == MD_BLOCK_OL);
    return 0;
  }

  // Tag the item itself, not its inner paragraph: md4c emits MD_BLOCK_P inside
  // items only for *loose* lists, so a tight list has no paragraph to tag. The
  // item's range is clipped back to its own first line when building results.
  if (blockType == MD_BLOCK_LI) {
    BlockInfo blockInfo;
    BOOL ordered = !context->listContainerStack.empty() && context->listContainerStack.back();
    blockInfo.type = ordered ? ENRMInputBlockTypeOrderedListItem : ENRMInputBlockTypeUnorderedListItem;
    // Clamp to the shared max depth (matches Android's parser): markdown can
    // nest deeper than the editor represents, and downstream metadata passes
    // size their counters by kENRMMaxListDepth.
    blockInfo.level = context->listContainerStack.empty()
                          ? 0
                          : MIN((NSInteger)context->listContainerStack.size() - 1, kENRMMaxListDepth);
    context->openBlockStack.push_back(blockInfo);
    return 0;
  }

  ENRMInputBlockType mappedType;
  if (!isSupportedBlock(blockType, mappedType)) {
    return 0;
  }

  BlockInfo blockInfo;
  blockInfo.level = resolveBlockLevel(blockType, detail);
  // Headings share one md4c block type but split into six ENRMInputBlockTypes by
  // level; map the resolved level onto the concrete heading type.
  blockInfo.type = (blockType == MD_BLOCK_H) ? ENRMBlockTypeForHeadingLevel(blockInfo.level) : mappedType;
  context->openBlockStack.push_back(blockInfo);
  return 0;
}

static int onLeaveBlock(MD_BLOCKTYPE blockType, void *, void *userdata)
{
  auto *context = static_cast<ParseContext *>(userdata);

  if (blockType == MD_BLOCK_UL || blockType == MD_BLOCK_OL) {
    if (!context->listContainerStack.empty()) {
      context->listContainerStack.pop_back();
    }
    return 0;
  }

  // List items are tagged in onEnterBlock (not via isSupportedBlock); resolve
  // them here the same way as supported blocks.
  if (blockType == MD_BLOCK_LI) {
    if (!context->openBlockStack.empty()) {
      context->resolvedBlocks.push_back(context->openBlockStack.back());
      context->openBlockStack.pop_back();
    }
    return 0;
  }

  ENRMInputBlockType mappedType;
  if (!isSupportedBlock(blockType, mappedType)) {
    return 0;
  }

  if (context->openBlockStack.empty()) {
    return 0;
  }

  context->resolvedBlocks.push_back(context->openBlockStack.back());
  context->openBlockStack.pop_back();
  return 0;
}

static int onEnterSpan(MD_SPANTYPE spanType, void *detail, void *userdata)
{
  ENRMInputStyleType styleType;
  if (!isSupportedSpan(spanType, styleType)) {
    return 0;
  }

  auto *context = static_cast<ParseContext *>(userdata);
  InlineSpanInfo spanInfo;
  spanInfo.type = styleType;
  spanInfo.openingDelimiterByteOffset = context->lastTextEnd;

  if (spanType == MD_SPAN_A && detail) {
    auto *linkDetail = static_cast<MD_SPAN_A_DETAIL *>(detail);
    if (linkDetail->href.text && linkDetail->href.size > 0) {
      spanInfo.linkURL = std::string(linkDetail->href.text, linkDetail->href.size);
    }
  }

  context->openStack.push_back(spanInfo);
  return 0;
}

static int onLeaveSpan(MD_SPANTYPE spanType, void *, void *userdata)
{
  ENRMInputStyleType styleType;
  if (!isSupportedSpan(spanType, styleType)) {
    return 0;
  }

  auto *context = static_cast<ParseContext *>(userdata);
  if (context->openStack.empty()) {
    return 0;
  }

  context->resolved.push_back(context->openStack.back());
  context->openStack.pop_back();
  return 0;
}

static int onText(MD_TEXTTYPE, const MD_CHAR *text, MD_SIZE size, void *userdata)
{
  if (!text || size == 0) {
    return 0;
  }
  auto *context = static_cast<ParseContext *>(userdata);

  // md4c passes pointers outside the input buffer for synthetic tokens
  // (e.g. MD_TEXT_SOFTBR, MD_TEXT_BR use a string literal "\n").
  // Pointer arithmetic against context->buffer would underflow, corrupting offsets.
  //
  // Skipping out-of-buffer tokens means lastTextEnd doesn't advance past
  // synthetic newlines. Inline-span offsets stay correct because spans never
  // straddle a synthetic break; block offsets are derived from real text below.
  bool insideBuffer = (text >= context->buffer && text < context->buffer + context->bufferLength);
  if (!insideBuffer) {
    return 0;
  }

  size_t textStart = text - context->buffer;
  size_t textEnd = textStart + size;
  context->textStartOffsets.push_back(textStart);

  if (textStart > 0 && context->buffer[textStart - 1] == '\\' && (textStart - 1) >= context->lastTextEnd) {
    context->escapeByteOffsets.push_back(textStart - 1);
  }

  for (auto &openSpan : context->openStack) {
    if (openSpan.contentStartByteOffset == kByteOffsetUnset) {
      openSpan.contentStartByteOffset = textStart;
    }
    openSpan.contentEndByteOffset = textEnd;
  }
  for (auto &openBlock : context->openBlockStack) {
    if (openBlock.contentStartByteOffset == kByteOffsetUnset) {
      openBlock.contentStartByteOffset = textStart;
    }
    openBlock.contentEndByteOffset = textEnd;
  }
  context->lastTextEnd = textEnd;
  return 0;
}

static bool runMd4cParse(NSString *markdown, ParseContext &context)
{
  NSString *completed = ENRMInputRemendComplete(markdown);
  const char *completedUTF8 = [completed UTF8String];
  size_t completedLength = strlen(completedUTF8);
  size_t originalLength = [markdown lengthOfBytesUsingEncoding:NSUTF8StringEncoding];

  context.buffer = completedUTF8;
  context.bufferLength = completedLength;
  context.originalLength = originalLength;

  MD_PARSER parser = {
      .abi_version = 0,
      .flags = MD_FLAG_NOHTML | MD_FLAG_UNDERLINE | MD_FLAG_STRIKETHROUGH | MD_FLAG_SPOILERS,
      .enter_block = onEnterBlock,
      .leave_block = onLeaveBlock,
      .enter_span = onEnterSpan,
      .leave_span = onLeaveSpan,
      .text = onText,
      .debug_log = nullptr,
      .syntax = nullptr,
  };

  return md_parse(completedUTF8, (MD_SIZE)completedLength, &parser, &context) == 0;
}

// Builds inline styled ranges (raw-markdown UTF-16 coords) from a completed
// parse. Split out so parseToPlainTextAndRanges: can derive inline and block
// ranges from ONE md4c run instead of parsing twice.
static NSArray<ENRMInputStyledRange *> *styledRangesFromContext(const ParseContext &context,
                                                                const std::vector<NSUInteger> &byteMap)
{
  NSMutableArray<ENRMInputStyledRange *> *results = [NSMutableArray arrayWithCapacity:context.resolved.size()];

  for (const auto &spanInfo : context.resolved) {
    if (spanInfo.contentStartByteOffset == kByteOffsetUnset || spanInfo.contentEndByteOffset == kByteOffsetUnset ||
        spanInfo.contentStartByteOffset > context.originalLength) {
      continue;
    }

    ENRMInputStyledRange *styledRange = [[ENRMInputStyledRange alloc] init];
    styledRange.type = spanInfo.type;

    if (spanInfo.type == ENRMInputStyleTypeLink && !spanInfo.linkURL.empty()) {
      styledRange.url = [NSString stringWithUTF8String:spanInfo.linkURL.c_str()];
    }

    NSUInteger contentStart = mapByteOffset(byteMap, spanInfo.contentStartByteOffset, context.bufferLength);
    NSUInteger contentEnd = mapByteOffset(byteMap, spanInfo.contentEndByteOffset, context.bufferLength);
    styledRange.contentRange = NSMakeRange(contentStart, contentEnd - contentStart);

    NSUInteger openStart = mapByteOffset(byteMap, spanInfo.openingDelimiterByteOffset, context.bufferLength);
    NSRange openingRange = NSMakeRange(openStart, contentStart - openStart);

    size_t closingEndByte = std::min(closingDelimiterEndByte(context, spanInfo), context.bufferLength);
    NSUInteger closingStart = mapByteOffset(byteMap, spanInfo.contentEndByteOffset, context.bufferLength);
    NSUInteger closingEnd = mapByteOffset(byteMap, closingEndByte, context.bufferLength);
    NSRange closingRange = NSMakeRange(closingStart, closingEnd - closingStart);

    styledRange.syntaxRanges = @[ [NSValue valueWithRange:openingRange], [NSValue valueWithRange:closingRange] ];

    NSUInteger fullStart = openingRange.location;
    NSUInteger fullEnd = NSMaxRange(closingRange);
    styledRange.fullRange = NSMakeRange(fullStart, fullEnd - fullStart);

    styledRange.isComplete = (closingEndByte <= context.originalLength);

    [results addObject:styledRange];
  }

  [results sortUsingComparator:^NSComparisonResult(ENRMInputStyledRange *first, ENRMInputStyledRange *second) {
    NSUInteger a = first.fullRange.location, b = second.fullRange.location;
    return (a < b) ? NSOrderedAscending : (a > b) ? NSOrderedDescending : NSOrderedSame;
  }];

  return results;
}

// Builds block-level ranges (raw-markdown UTF-16 coords) from the same
// completed parse, mirroring styledRangesFromContext for inline spans.
// Paragraph blocks (the implicit default) are omitted — only blocks a handler
// claims are returned.
static NSArray<ENRMBlockRange *> *blockRangesFromContext(const ParseContext &context,
                                                         const std::vector<NSUInteger> &byteMap, NSString *markdown)
{
  NSMutableArray<ENRMBlockRange *> *results = [NSMutableArray arrayWithCapacity:context.resolvedBlocks.size()];

  for (const auto &blockInfo : context.resolvedBlocks) {
    if (blockInfo.type == ENRMInputBlockTypeParagraph) {
      continue;
    }
    if (blockInfo.contentStartByteOffset == kByteOffsetUnset || blockInfo.contentEndByteOffset == kByteOffsetUnset ||
        blockInfo.contentStartByteOffset > context.originalLength) {
      continue;
    }

    NSUInteger contentStart = mapByteOffset(byteMap, blockInfo.contentStartByteOffset, context.bufferLength);
    NSUInteger contentEnd = mapByteOffset(byteMap, blockInfo.contentEndByteOffset, context.bufferLength);
    if (contentEnd <= contentStart) {
      continue;
    }

    // A list item accumulates all text in its subtree, so a parent item's range
    // runs through its nested sublist. Clip each item to its own first line so
    // nested items keep their own (deeper) depth rather than being overwritten
    // by the parent's range. Input list items are single-line.
    if (ENRMBlockTypeIsListItem(blockInfo.type) && contentEnd <= markdown.length) {
      NSRange newline = [markdown rangeOfString:@"\n"
                                        options:0
                                          range:NSMakeRange(contentStart, contentEnd - contentStart)];
      if (newline.location != NSNotFound) {
        contentEnd = newline.location;
      }
      if (contentEnd <= contentStart) {
        continue;
      }
    }

    [results addObject:[ENRMBlockRange rangeWithType:blockInfo.type
                                               range:NSMakeRange(contentStart, contentEnd - contentStart)
                                               level:blockInfo.level]];
  }

  return results;
}

} // namespace

@implementation ENRMInputParser

- (NSArray<ENRMInputStyledRange *> *)parse:(NSString *)markdown
{
  if (markdown.length == 0) {
    return @[];
  }

  ParseContext context;
  if (!runMd4cParse(markdown, context)) {
    return @[];
  }

  auto byteMap = buildByteToUTF16Map(context.buffer, context.bufferLength);
  return styledRangesFromContext(context, byteMap);
}

- (ENRMParseResult *)parseToPlainTextAndRanges:(NSString *)markdown
{
  ENRMParseResult *parseResult = [[ENRMParseResult alloc] init];

  if (markdown.length == 0) {
    parseResult.plainText = @"";
    parseResult.formattingRanges = @[];
    parseResult.blockRanges = @[];
    return parseResult;
  }

  // One md4c run feeds both pipelines: inline styled ranges and block ranges
  // are derived from the same ParseContext.
  ParseContext context;
  NSArray<ENRMInputStyledRange *> *styledRanges = @[];
  NSArray<ENRMBlockRange *> *rawBlockRanges = @[];
  NSMutableIndexSet *escapeIndexes = [NSMutableIndexSet indexSet];
  if (runMd4cParse(markdown, context)) {
    auto byteMap = buildByteToUTF16Map(context.buffer, context.bufferLength);
    styledRanges = styledRangesFromContext(context, byteMap);
    rawBlockRanges = blockRangesFromContext(context, byteMap, markdown);
    for (size_t escapeByte : context.escapeByteOffsets) {
      NSUInteger escapeIndex = mapByteOffset(byteMap, escapeByte, context.bufferLength);
      if (escapeIndex < markdown.length) {
        [escapeIndexes addIndex:escapeIndex];
      }
    }
  }

  NSUInteger rawLength = markdown.length;

  NSMutableIndexSet *syntaxIndexes = [NSMutableIndexSet indexSet];
  for (ENRMInputStyledRange *styledRange in styledRanges) {
    if (!styledRange.isComplete)
      continue;
    for (NSValue *syntaxValue in styledRange.syntaxRanges) {
      NSRange syntaxRange = [syntaxValue rangeValue];
      if (NSMaxRange(syntaxRange) > rawLength) {
        syntaxRange.length = (syntaxRange.location < rawLength) ? rawLength - syntaxRange.location : 0;
      }
      if (syntaxRange.length > 0) {
        [syntaxIndexes addIndexesInRange:syntaxRange];
      }
    }
  }

  // Strip block markers (e.g. "# ") from plain text — same as inline delimiters.
  // Without this the marker survives and the serializer doubles it ("# # ").
  for (ENRMBlockRange *rawBlock in rawBlockRanges) {
    NSUInteger contentStart = rawBlock.range.location;
    if (contentStart == 0 || contentStart > rawLength) {
      continue;
    }
    NSUInteger lineStart = contentStart;
    while (lineStart > 0) {
      unichar previous = [markdown characterAtIndex:lineStart - 1];
      if (previous == '\n' || previous == '\r') {
        break;
      }
      lineStart--;
    }
    if (contentStart > lineStart) {
      [syntaxIndexes addIndexesInRange:NSMakeRange(lineStart, contentStart - lineStart)];
    }
  }

  [syntaxIndexes addIndexes:escapeIndexes];

  // Strip \n/\r from syntax ranges — newlines are structural content, not
  // markdown syntax, and must survive into the plain text.
  NSMutableIndexSet *newlineIndexes = [NSMutableIndexSet indexSet];
  [syntaxIndexes enumerateIndexesUsingBlock:^(NSUInteger index, BOOL *stop) {
    if (index < rawLength) {
      unichar character = [markdown characterAtIndex:index];
      if (character == '\n' || character == '\r') {
        [newlineIndexes addIndex:index];
      }
    }
  }];
  [syntaxIndexes removeIndexes:newlineIndexes];

  NSMutableString *plainText = [NSMutableString stringWithCapacity:rawLength];
  __block std::vector<NSUInteger> rawToPlainMap(rawLength + 1, 0);

  __block NSUInteger plainPosition = 0;
  __block NSUInteger previousEnd = 0;

  [syntaxIndexes enumerateRangesUsingBlock:^(NSRange syntaxRange, BOOL *stop) {
    if (syntaxRange.location > previousEnd) {
      NSRange visibleRange = NSMakeRange(previousEnd, syntaxRange.location - previousEnd);
      [plainText appendString:[markdown substringWithRange:visibleRange]];
      for (NSUInteger rawIndex = previousEnd; rawIndex < syntaxRange.location; rawIndex++) {
        rawToPlainMap[rawIndex] = plainPosition++;
      }
    }
    for (NSUInteger rawIndex = syntaxRange.location; rawIndex < NSMaxRange(syntaxRange); rawIndex++) {
      rawToPlainMap[rawIndex] = plainPosition;
    }
    previousEnd = NSMaxRange(syntaxRange);
  }];

  if (previousEnd < rawLength) {
    [plainText appendString:[markdown substringFromIndex:previousEnd]];
    for (NSUInteger rawIndex = previousEnd; rawIndex < rawLength; rawIndex++) {
      rawToPlainMap[rawIndex] = plainPosition++;
    }
  }
  rawToPlainMap[rawLength] = plainPosition;

  NSMutableArray<ENRMFormattingRange *> *formattingRanges = [NSMutableArray arrayWithCapacity:styledRanges.count];

  for (ENRMInputStyledRange *styledRange in styledRanges) {
    if (!styledRange.isComplete)
      continue;

    NSUInteger contentStart = styledRange.contentRange.location;
    NSUInteger contentEnd = NSMaxRange(styledRange.contentRange);

    if (contentStart > rawLength || contentEnd > rawLength)
      continue;

    NSUInteger plainStart = rawToPlainMap[contentStart];
    NSUInteger plainEnd = rawToPlainMap[contentEnd];

    if (plainEnd <= plainStart)
      continue;

    ENRMFormattingRange *formattingRange =
        [ENRMFormattingRange rangeWithType:styledRange.type
                                     range:NSMakeRange(plainStart, plainEnd - plainStart)
                                       url:styledRange.url];
    [formattingRanges addObject:formattingRange];
  }

  // Map block content ranges (raw-markdown coords) onto plain-text coords. The
  // block's marker syntax was stripped above, so the content range maps cleanly
  // onto the post-strip text and the block no longer covers the marker.
  NSMutableArray<ENRMBlockRange *> *blockRanges = [NSMutableArray arrayWithCapacity:rawBlockRanges.count];
  for (ENRMBlockRange *rawBlock in rawBlockRanges) {
    NSUInteger contentStart = rawBlock.range.location;
    NSUInteger contentEnd = NSMaxRange(rawBlock.range);
    if (contentStart > rawLength || contentEnd > rawLength)
      continue;

    NSUInteger plainStart = rawToPlainMap[contentStart];
    NSUInteger plainEnd = rawToPlainMap[contentEnd];
    if (plainEnd <= plainStart)
      continue;

    [blockRanges addObject:[ENRMBlockRange rangeWithType:rawBlock.type
                                                   range:NSMakeRange(plainStart, plainEnd - plainStart)
                                                   level:rawBlock.level]];
  }

  parseResult.plainText = plainText;
  parseResult.formattingRanges = formattingRanges;
  parseResult.blockRanges = blockRanges;
  return parseResult;
}

@end
