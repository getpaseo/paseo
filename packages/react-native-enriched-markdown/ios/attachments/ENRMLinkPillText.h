#pragma once
#import "ENRMUIKit.h"

NS_ASSUME_NONNULL_BEGIN

/**
 * In text storage a link pill is one placeholder character. Wherever text leaves the
 * view it must carry the link text again: the Markdown, HTML and RTF exporters expand
 * pills themselves, and code that reads plain text out of storage calls these functions.
 * On macOS, where pills are not rendered, they return their input unchanged.
 */

/**
 * Returns `text` with every pill placeholder replaced by the link content it stands for,
 * or `text` itself when it holds no pills. `ioRange`, when given, is a range in `text` on
 * input and the matching range in the result on output.
 */
FOUNDATION_EXPORT NSAttributedString *ENRMAttributedStringByExpandingLinkPills(NSAttributedString *text,
                                                                               NSRange *_Nullable ioRange);

FOUNDATION_EXPORT NSString *ENRMStringByExpandingLinkPills(NSAttributedString *text);

/// Enclosing strong/emphasis restyle the placeholder after the pill was created. Run once
/// rendering is finished so each label uses the font ordinary link text would have.
FOUNDATION_EXPORT void ENRMLinkPillsAdoptPlaceholderFonts(NSAttributedString *text);

NS_ASSUME_NONNULL_END
