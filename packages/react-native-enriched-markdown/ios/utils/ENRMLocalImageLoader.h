#pragma once
#import "ENRMUIKit.h"

NS_ASSUME_NONNULL_BEGIN

/**
 * Local (non-network) image loading for markdown sources (issue #377).
 *
 * React Native's asset system resolves `require('./img.png')` to a Metro http
 * URL in dev, but to a `file://` URL near the app bundle in release builds
 * (`AssetSourceResolver.scaledAssetURLNearBundle`), and libraries like
 * expo-asset also hand out percent-encoded `file://` paths in the caches
 * directory. These should not go through NSURLSession + NSURLCache: they gain
 * nothing from HTTP caching or timeouts, and bundle assets lose `@2x`/`@3x`
 * scale selection and asset-catalog resolution.
 *
 * Resolution mirrors RN's RCTImageFromLocalAssetURL: bundle-relative names are
 * tried with `imageNamed:` first (scale suffixes, asset catalogs, and system
 * caching for free), then the loader falls back to loading the file directly,
 * appending `.png` when the path has no extension.
 */

/// YES when the URL refers to a non-network source: any `file://` URL, or a
/// scheme-less string (bare bundle-relative asset name or absolute path).
BOOL ENRMIsLocalImageURL(NSString *url);

/// Resolves a local file or file-backed bundle asset, including scale suffixes.
/// Does not decode pixels. Asset-catalog-only names have no file path and return nil.
FOUNDATION_EXPORT NSString *_Nullable ENRMResolveLocalImagePath(NSString *url);

/// Synchronously loads a local image; returns nil when the source cannot be
/// resolved. Safe to call off the main thread.
RCTUIImage *_Nullable ENRMLoadLocalImage(NSString *url);

NS_ASSUME_NONNULL_END
