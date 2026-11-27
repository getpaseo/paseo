#import "ENRMInputStyleStateBuilder.h"

@implementation ENRMInputStyleStateBuilder

+ (void)setLinkStateOnSnapshot:(ENRMInputStyleSnapshot *)snapshot
                  forSelection:(NSRange)selection
                    dataSource:(id<ENRMInputStyleStateDataSource>)dataSource
{
  ENRMFormattingRange *link = [dataSource linkForSelection:selection];
  snapshot->link = link != nil;
  snapshot->linkDestination = link.url.UTF8String ?: "";
}

+ (ENRMInputStyleSnapshot)snapshotAtCurrentCursor:(id<ENRMInputStyleStateDataSource>)dataSource
{
  NSUInteger cursor = [dataSource selectedRange].location;
  ENRMInputStyleSnapshot snapshot = {};
  if (cursor == NSNotFound) {
    return snapshot;
  }
  snapshot.bold = [dataSource isEffectiveStyleActive:ENRMInputStyleTypeStrong atPosition:cursor];
  snapshot.italic = [dataSource isEffectiveStyleActive:ENRMInputStyleTypeEmphasis atPosition:cursor];
  snapshot.underline = [dataSource isEffectiveStyleActive:ENRMInputStyleTypeUnderline atPosition:cursor];
  snapshot.strikethrough = [dataSource isEffectiveStyleActive:ENRMInputStyleTypeStrikethrough atPosition:cursor];
  snapshot.spoiler = [dataSource isEffectiveStyleActive:ENRMInputStyleTypeSpoiler atPosition:cursor];
  [self setLinkStateOnSnapshot:&snapshot forSelection:[dataSource selectedRange] dataSource:dataSource];
  snapshot.headingLevel = [dataSource headingLevelForCursorParagraph];

  ENRMBlockRange *listBlock = [dataSource listBlockForCursorParagraph];
  snapshot.unorderedList = listBlock != nil && listBlock.type == ENRMInputBlockTypeUnorderedListItem;
  snapshot.orderedList = listBlock != nil && listBlock.type == ENRMInputBlockTypeOrderedListItem;
  snapshot.listDepth = listBlock != nil ? listBlock.level : 0;

  return snapshot;
}

+ (ENRMInputStyleSnapshot)snapshotForRange:(NSRange)range dataSource:(id<ENRMInputStyleStateDataSource>)dataSource
{
  ENRMInputStyleSnapshot snapshot = {};
  if (range.location == NSNotFound) {
    return snapshot;
  }
  if (range.length > 0) {
    snapshot.bold = [dataSource isStyleActive:ENRMInputStyleTypeStrong inRange:range];
    snapshot.italic = [dataSource isStyleActive:ENRMInputStyleTypeEmphasis inRange:range];
    snapshot.underline = [dataSource isStyleActive:ENRMInputStyleTypeUnderline inRange:range];
    snapshot.strikethrough = [dataSource isStyleActive:ENRMInputStyleTypeStrikethrough inRange:range];
    snapshot.spoiler = [dataSource isStyleActive:ENRMInputStyleTypeSpoiler inRange:range];
  } else {
    snapshot.bold = [dataSource isEffectiveStyleActive:ENRMInputStyleTypeStrong atPosition:range.location];
    snapshot.italic = [dataSource isEffectiveStyleActive:ENRMInputStyleTypeEmphasis atPosition:range.location];
    snapshot.underline = [dataSource isEffectiveStyleActive:ENRMInputStyleTypeUnderline atPosition:range.location];
    snapshot.strikethrough = [dataSource isEffectiveStyleActive:ENRMInputStyleTypeStrikethrough
                                                     atPosition:range.location];
    snapshot.spoiler = [dataSource isEffectiveStyleActive:ENRMInputStyleTypeSpoiler atPosition:range.location];
  }
  [self setLinkStateOnSnapshot:&snapshot forSelection:range dataSource:dataSource];
  snapshot.headingLevel = [dataSource headingLevelForCursorParagraph];

  ENRMBlockRange *listBlock = [dataSource listBlockForCursorParagraph];
  snapshot.unorderedList = listBlock != nil && listBlock.type == ENRMInputBlockTypeUnorderedListItem;
  snapshot.orderedList = listBlock != nil && listBlock.type == ENRMInputBlockTypeOrderedListItem;
  snapshot.listDepth = listBlock != nil ? listBlock.level : 0;

  return snapshot;
}

@end
