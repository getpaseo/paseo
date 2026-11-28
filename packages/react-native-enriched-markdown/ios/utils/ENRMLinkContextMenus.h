#pragma once
#import "ENRMUIKit.h"

NS_ASSUME_NONNULL_BEGIN

/// One item of a link's long-press menu.
@interface ENRMLinkContextMenuItem : NSObject
@property (nonatomic, copy) NSString *text;
/// SF Symbol name; empty for no icon.
@property (nonatomic, copy) NSString *icon;
@property (nonatomic, assign) BOOL disabled;
@property (nonatomic, assign) BOOL destructive;
@end

/// The menu items for links whose URL matches `pattern`.
@interface ENRMLinkContextMenuEntry : NSObject
@property (nonatomic, copy) NSString *pattern;
@property (nonatomic, copy) NSArray<ENRMLinkContextMenuItem *> *items;
@end

typedef void (^ENRMLinkContextMenuPressHandler)(NSString *url, NSString *pattern, NSString *itemText);

/**
 * The `linkContextMenuItems` prop: long-press menus for links, by URL pattern.
 * Entries are tried in order, like link variants, and the first whose pattern
 * matches a URL supplies its menu. Menus need iOS 17; below that no URL has one.
 */
@interface ENRMLinkContextMenus : NSObject
@property (nonatomic, copy) NSArray<ENRMLinkContextMenuEntry *> *entries;
@property (nonatomic, copy, nullable) ENRMLinkContextMenuPressHandler onPress;
- (BOOL)hasMenuForURL:(nullable NSString *)url;
#if !TARGET_OS_OSX
/// `title` is what the user sees the link as: its text, or its pill label.
- (nullable UIMenu *)menuForURL:(nullable NSString *)url title:(nullable NSString *)title;
#endif
@end

#if !TARGET_OS_OSX
/// Adopted by a text view's delegate to supply the long-press menus of its links.
@protocol ENRMLinkContextMenuSource <NSObject>
- (nullable ENRMLinkContextMenus *)linkContextMenusForTextView:(UITextView *)textView;
@end

/// Adopted by a text view that presents the menus of some of its links itself.
@protocol ENRMLinkMenuPresenting <NSObject>
/// UIKit must be given no menu for such a link, or it lifts the link as a text item as well.
- (BOOL)presentsLinkMenuAtIndex:(NSUInteger)index;
@end

/**
 * The copy of a link that its long-press menu lifts.
 *
 * UIKit draws a menu's preview only from a view that is on screen, and hides that view for as
 * long as the menu is open. Lifting part of a larger view through a visible path would hide
 * all of it, and a detached view stays blank until the menu appears. So the link is lifted as
 * an image of itself, laid over the view it belongs to and taken down when the menu ends.
 */
@interface ENRMLinkMenuLift : NSObject
/// Called when the image is taken down, for the owner to restore what the image stood in for.
@property (nonatomic, copy, nullable) void (^onEnd)(void);
/// Whether an image is laid over `view`.
- (BOOL)isOverView:(UIView *)view;
/// Takes down the image laid before, if any.
- (void)layImage:(UIImage *)image atFrame:(CGRect)frame overView:(UIView *)view;
/// The preview that lifts the laid image, nil when there is none. A nil `backgroundColor`
/// leaves UIKit's own behind the image.
- (nullable UITargetedPreview *)previewWithCornerRadius:(CGFloat)cornerRadius
                                        backgroundColor:(nullable UIColor *)backgroundColor;
- (void)end;
/// Ends once the menu has animated away, unless another image was laid in the meantime.
- (void)endWithAnimator:(nullable id<UIContextMenuInteractionAnimating>)animator;
@end

#ifdef __cplusplus
extern "C" {
#endif

/**
 * What a long press on a text item shows: the link's configured menu, or what links did before
 * menus existed (the system menu with a preview, or `onLinkLongPress` when previews are off).
 * Every text view delegate answers `textView:menuConfigurationForTextItem:defaultMenu:` with this.
 * A link whose menu the text view presents itself (`ENRMLinkMenuPresenting`) gets none here.
 */
UITextItemMenuConfiguration *_Nullable ENRMLinkMenuConfigurationForTextItem(
    UITextView *textView, UITextItem *textItem, UIMenu *defaultMenu, ENRMLinkContextMenus *_Nullable menus,
    BOOL linkPreviewEnabled, void (^_Nullable onLinkLongPress)(NSString *url)) API_AVAILABLE(ios(17.0));

#ifdef __cplusplus
}
#endif
#endif

NS_ASSUME_NONNULL_END
