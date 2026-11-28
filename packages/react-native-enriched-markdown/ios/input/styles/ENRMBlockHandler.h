#pragma once

#import "ENRMBlockRange.h"
#import "ENRMInputFormatter.h"

NS_ASSUME_NONNULL_BEGIN

/// A block handler owns how its ENRMInputBlockType styles its paragraph and how
/// it serializes to a markdown line prefix. Mirrors ENRMStyleHandler for the
/// inline pipeline. Parser recognition is NOT handler-driven: it lives in
/// ENRMInputParser's kSupportedBlocks central map, exactly as kSupportedSpans
/// does for inline styles — a new block type adds one entry there plus one
/// handler here. These signatures are designed to cover headings AND list items.
@protocol ENRMBlockHandler <NSObject>

@property (nonatomic, readonly) ENRMInputBlockType blockType;

/// Contribute paragraph-level attributes for a block of this type. Called once
/// per block range during formatting. A heading raises the font size; a list
/// item sets head/tail indents and a marker. May be a no-op.
///
/// @param paragraphStyle Mutable paragraph style to adjust (indents, spacing).
/// @param attributes     Mutable character attributes to add (e.g. font) over
///                       the block range; NSParagraphStyleAttributeName is
///                       applied by the formatter from `paragraphStyle`.
/// @param blockRange     The block being styled (carries type, range, level).
/// @param style          Resolved formatter style (base font, colors).
- (void)applyAttributesToParagraphStyle:(NSMutableParagraphStyle *)paragraphStyle
                             attributes:(NSMutableDictionary<NSAttributedStringKey, id> *)attributes
                             blockRange:(ENRMBlockRange *)blockRange
                                  style:(ENRMInputFormatterStyle *)style;

/// Markdown prefix prepended to each line of the block during serialization,
/// e.g. @"# " for an H1 or @"- " for a bullet. Returns @"" when the block needs
/// no prefix. Owning the marker here replaces a central serializer switch.
- (NSString *)markdownLinePrefixForBlockRange:(ENRMBlockRange *)blockRange;

@optional

/// Whether Return continues the block onto the next line (a list item) rather
/// than ending it (a heading). Defaults to NO when unimplemented.
@property (nonatomic, readonly) BOOL continuesOnNewline;

@end

NS_ASSUME_NONNULL_END
