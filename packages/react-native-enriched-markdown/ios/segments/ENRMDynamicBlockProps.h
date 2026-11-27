#pragma once
#import "ENRMLinkContextMenus.h"
#import <Foundation/Foundation.h>

NS_ASSUME_NONNULL_BEGIN

/**
 * Runtime-mutable block props that a prop update can flip WITHOUT recreating the
 * segment tree: the block context-menu gate, the code-block tap gate, and the
 * copy menu labels. The root owns one instance and mutates it in place; every
 * block view down the tree holds the same reference (never a copy) and reads a
 * field at use-time (menu-open, tap). So a view created after a toggle - e.g. a
 * code block added to a blockquote once onCodeBlockPress is on - is born current
 * instead of from a stale snapshot, and no per-toggle push into existing views is
 * needed. Mirrors Android's DynamicBlockProps. See issues #768 and #822.
 *
 * The copy/tap callbacks stay per-view: on iOS they are stable event bridges set
 * once at creation, so they never go stale. Only props that actually change at
 * runtime and gate no layout/draw belong here; style stays on the immutable
 * StyleConfig, where a snapshot can never go stale.
 *
 * Getters are renamed to avoid the Cocoa `copy` method family, matching
 * ENRMCodeBlockContainerView; property names are unchanged so call sites read
 * dynamic.copyLabel.
 */
@interface ENRMDynamicBlockProps : NSObject
@property (nonatomic, strong, nullable) ENRMLinkContextMenus *linkContextMenus;
@property (nonatomic, assign) BOOL enableLinkPreview;
@property (nonatomic, assign) BOOL enableBlockContextMenu;
@property (nonatomic, assign) BOOL enableCodeBlockPress;
@property (nonatomic, copy, nullable, getter=menuCopyLabel) NSString *copyLabel;
@property (nonatomic, copy, nullable, getter=menuCopyAsMarkdownLabel) NSString *copyAsMarkdownLabel;
@end

NS_ASSUME_NONNULL_END
