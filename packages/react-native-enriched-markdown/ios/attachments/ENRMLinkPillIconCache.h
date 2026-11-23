#pragma once
#import "ENRMUIKit.h"

#if !TARGET_OS_OSX
NS_ASSUME_NONNULL_BEGIN

/// Pill icons, kept small in one bounded cache. Local files decode synchronously, so a bundled
/// icon is there on the first layout; every other source goes through the shared image
/// downloader, like markdown images, and arrives asynchronously.

/// A local file icon, or nil when the source is not a readable local file.
FOUNDATION_EXPORT UIImage *_Nullable ENRMLoadLinkPillIcon(NSString *_Nullable iconUri);

FOUNDATION_EXPORT UIImage *_Nullable ENRMCachedLinkPillIcon(NSString *iconUri,
                                                            NSDictionary<NSString *, NSString *> *_Nullable headers);

/// YES for a while after an asynchronous load of this source failed; callers then do not
/// reserve an icon slot. The source is tried again once that period has passed.
FOUNDATION_EXPORT BOOL ENRMLinkPillIconDidFail(NSString *iconUri,
                                               NSDictionary<NSString *, NSString *> *_Nullable headers);

/// Loads through the shared image pipeline. `completion` runs on the main thread; nil means the source failed.
FOUNDATION_EXPORT void ENRMLoadLinkPillIconAsync(NSString *iconUri,
                                                 NSDictionary<NSString *, NSString *> *_Nullable headers,
                                                 void (^completion)(UIImage *_Nullable icon));

NS_ASSUME_NONNULL_END
#endif
