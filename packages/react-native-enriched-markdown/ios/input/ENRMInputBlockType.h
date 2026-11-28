#pragma once

#import <Foundation/Foundation.h>

NS_ASSUME_NONNULL_BEGIN

/// Block-level (paragraph-scoped) element types. A block covers whole lines,
/// unlike inline styles (ENRMInputStyleType) which cover character ranges.
///
/// Paragraph is the default: every line is a paragraph until a block handler
/// claims it. Concrete block types (headings, list items, etc.) are appended
/// here as their handlers are added — each new case must have a matching
/// id<ENRMBlockHandler> registered in ENRMInputFormatter.
typedef NS_ENUM(NSInteger, ENRMInputBlockType) {
  ENRMInputBlockTypeParagraph = 0,
  ENRMInputBlockTypeHeading1 = 1,
  ENRMInputBlockTypeHeading2 = 2,
  ENRMInputBlockTypeHeading3 = 3,
  ENRMInputBlockTypeHeading4 = 4,
  ENRMInputBlockTypeHeading5 = 5,
  ENRMInputBlockTypeHeading6 = 6,
  ENRMInputBlockTypeUnorderedListItem = 7,
  ENRMInputBlockTypeOrderedListItem = 8,
};

/// Whether the type is a list item (nesting depth rides in the range's level).
static inline BOOL ENRMBlockTypeIsListItem(ENRMInputBlockType type)
{
  return type == ENRMInputBlockTypeUnorderedListItem || type == ENRMInputBlockTypeOrderedListItem;
}

/// Maximum bullet-list nesting depth (0-based). Depth is carried as the block's
/// level payload (ENRMBlockRange.level), clamped into [0, kENRMMaxListDepth].
static const NSInteger kENRMMaxListDepth = 5;

/// Bullet-list layout metrics (points). Shared by the list block handler (which
/// reserves the head-indent column via the paragraph style) and the layout
/// manager (which draws the marker glyph into that column). Text for a list item
/// at depth d starts at (d + 1) * kENRMListIndentPerDepth from the leading edge;
/// the marker is centered kENRMListBulletGap before the text.
static const CGFloat kENRMListIndentPerDepth = 18.0;
static const CGFloat kENRMListBulletGap = 9.0;

/// Maps a heading level (1-6) to its ENRMInputBlockType. Levels outside 1-6 are
/// clamped into range. The contiguous Heading1..Heading6 enum values make this a
/// simple offset from the Heading1 base.
static inline ENRMInputBlockType ENRMBlockTypeForHeadingLevel(NSInteger level)
{
  if (level < 1) {
    level = 1;
  } else if (level > 6) {
    level = 6;
  }
  return (ENRMInputBlockType)(ENRMInputBlockTypeHeading1 + (level - 1));
}

/// The heading level (1-6) for a heading block type, or 0 if the type is not a
/// heading. Inverse of ENRMBlockTypeForHeadingLevel.
static inline NSInteger ENRMHeadingLevelForBlockType(ENRMInputBlockType type)
{
  if (type >= ENRMInputBlockTypeHeading1 && type <= ENRMInputBlockTypeHeading6) {
    return (NSInteger)(type - ENRMInputBlockTypeHeading1) + 1;
  }
  return 0;
}

/// Whether an emptied line of this type keeps a zero-length anchor (an emptied
/// heading stays a heading, an emptied bullet keeps its marker) instead of
/// reverting to a plain paragraph.
static inline BOOL ENRMBlockTypePersistsWhenEmpty(ENRMInputBlockType type)
{
  return (type >= ENRMInputBlockTypeHeading1 && type <= ENRMInputBlockTypeHeading6) || ENRMBlockTypeIsListItem(type);
}

/// NSAttributedString attribute carrying the ENRMInputBlockType (boxed NSNumber)
/// of the paragraph a character belongs to. Set by ENRMInputFormatter on the
/// paragraphs a block claims; the next block pass uses it to find and strip the
/// previous pass's styling before re-applying.
extern NSAttributedStringKey const ENRMBlockTypeAttributeName;

/// NSAttributedString attribute carrying the block's integer payload (boxed
/// NSNumber) — e.g. heading level or list depth. See ENRMBlockRange.level.
/// Applied and stripped alongside ENRMBlockTypeAttributeName.
extern NSAttributedStringKey const ENRMBlockLevelAttributeName;

/// NSAttributedString attribute carrying an ordered item's 1-based ordinal
/// (boxed NSNumber) so the layout manager can draw its number. Applied and
/// stripped alongside ENRMBlockTypeAttributeName.
extern NSAttributedStringKey const ENRMBlockOrdinalAttributeName;

NS_ASSUME_NONNULL_END
