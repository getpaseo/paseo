#pragma once
#import "ENRMUIKit.h"

NS_ASSUME_NONNULL_BEGIN

/// Decoded pixel cost, shared by native image caches.
FOUNDATION_EXPORT NSUInteger ENRMImageByteCost(RCTUIImage *image);

typedef void (^ENRMImageDownloadCompletion)(RCTUIImage *_Nullable image);

/**
 * Cache identity for a remote image request. Returns the URL itself when no
 * headers are set; otherwise appends a SHA-256 digest of the sorted header
 * pairs, so the same URL fetched with different headers is cached and
 * deduplicated separately without embedding header values in the key.
 * Header names are compared case-insensitively.
 */
NSString *ENRMImageCacheKey(NSString *url, NSDictionary<NSString *, NSString *> *_Nullable headers);

@interface ENRMImageDownloader : NSObject

+ (instancetype)shared;

- (void)downloadURL:(NSString *)url
            headers:(nullable NSDictionary<NSString *, NSString *> *)headers
         completion:(ENRMImageDownloadCompletion)completion;

@end

NS_ASSUME_NONNULL_END
