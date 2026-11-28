#pragma once

#import <Foundation/Foundation.h>

NS_ASSUME_NONNULL_BEGIN

typedef struct {
  NSRange range;
  BOOL shouldRemove;
} ENRMAdjustedRange;

/// Shared shift/clip logic applied to a stored range after a text edit that
/// replaced `deletedLength` characters at `editLocation` with `insertedLength`
/// characters. Both ENRMFormattingStore and ENRMBlockStore delegate here so the
/// overlap classification lives in exactly one place. `shouldRemove` is set
/// when the range was deleted outright or clipped to zero length.
///
/// Insert-only edits at exactly the range end do NOT grow the range — the typed
/// characters stay outside it. An insert at exactly the range start grows the
/// range only when `growsAtStartOnInsert` is YES; otherwise the range shifts and
/// the typed characters stay outside it. Whether boundary text joins the range is
/// otherwise decided elsewhere: pending styles for inline ranges, line
/// re-normalization for block ranges.
///
/// `inheritsReplacementAtStart`: when YES, a replacement whose deletion starts
/// at the range start lets the inserted text join the range (UIKit attribute
/// inheritance); when NO, the old clip/remove behavior applies.
///
/// `growsAtStartOnInsert`: when YES, a pure insert at the range start grows the
/// range to cover the inserted text instead of shifting the range past it. Block
/// ranges own their whole line, so a character typed at the line start must keep
/// the line's block; inline styles must NOT set this (a character typed before a
/// bold run must not become bold).
ENRMAdjustedRange ENRMAdjustRangeForEdit(NSRange range, NSUInteger editLocation, NSUInteger deletedLength,
                                         NSUInteger insertedLength, BOOL inheritsReplacementAtStart,
                                         BOOL growsAtStartOnInsert);

NS_ASSUME_NONNULL_END
