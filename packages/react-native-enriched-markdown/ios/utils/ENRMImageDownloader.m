#import "ENRMImageDownloader.h"
#import "ENRMImageAttachment.h"
#import "ENRMLocalImageLoader.h"
#import <CommonCrypto/CommonDigest.h>
#include <TargetConditionals.h>

static const NSUInteger kDiskCacheMemoryCapacity = 10 * 1024 * 1024;
static const NSUInteger kDiskCacheDiskCapacity = 100 * 1024 * 1024;

NSUInteger ENRMImageByteCost(RCTUIImage *image)
{
  CGImageRef cgImage = image.CGImage;
  if (!cgImage)
    return 0;
  return CGImageGetBytesPerRow(cgImage) * CGImageGetHeight(cgImage);
}

static NSDictionary<NSString *, NSString *> *ENRMNormalizedImageHeaders(NSDictionary<NSString *, NSString *> *headers)
{
  NSMutableDictionary<NSString *, NSString *> *normalized = [NSMutableDictionary dictionary];
  for (NSString *name in [headers.allKeys sortedArrayUsingSelector:@selector(compare:)])
    normalized[name.lowercaseString] = headers[name];
  return normalized;
}

NSString *ENRMImageCacheKey(NSString *url, NSDictionary<NSString *, NSString *> *headers)
{
  if (headers.count == 0) {
    return url;
  }
  NSDictionary<NSString *, NSString *> *normalized = ENRMNormalizedImageHeaders(headers);
  NSArray<NSString *> *names = [normalized.allKeys sortedArrayUsingSelector:@selector(compare:)];
  NSMutableArray<NSString *> *pairs = [NSMutableArray arrayWithCapacity:names.count];
  for (NSString *name in names) {
    [pairs addObject:[NSString stringWithFormat:@"%@:%@", name, normalized[name]]];
  }
  NSString *joined = [pairs componentsJoinedByString:@"\n"];
  NSData *data = [joined dataUsingEncoding:NSUTF8StringEncoding];
  unsigned char digest[CC_SHA256_DIGEST_LENGTH];
  CC_SHA256(data.bytes, (CC_LONG)data.length, digest);
  NSMutableString *hash = [NSMutableString stringWithCapacity:CC_SHA256_DIGEST_LENGTH * 2];
  for (int i = 0; i < CC_SHA256_DIGEST_LENGTH; i++) {
    [hash appendFormat:@"%02x", digest[i]];
  }
  return [NSString stringWithFormat:@"%@|%@", url, hash];
}

@implementation ENRMImageDownloader {
  NSURLSession *_session;
  NSURLSession *_headerSession;
  NSMutableDictionary<NSString *, NSMutableArray<ENRMImageDownloadCompletion> *> *_inFlightRequests;
}

+ (instancetype)shared
{
  static ENRMImageDownloader *instance;
  static dispatch_once_t onceToken;
  dispatch_once(&onceToken, ^{ instance = [[ENRMImageDownloader alloc] init]; });
  return instance;
}

- (instancetype)init
{
  self = [super init];
  if (self) {
    NSURLSessionConfiguration *config = [NSURLSessionConfiguration defaultSessionConfiguration];
    config.URLCache = [[NSURLCache alloc] initWithMemoryCapacity:kDiskCacheMemoryCapacity
                                                    diskCapacity:kDiskCacheDiskCapacity
                                                    directoryURL:nil];
    config.requestCachePolicy = NSURLRequestReturnCacheDataElseLoad;
    config.timeoutIntervalForRequest = 15;
    config.timeoutIntervalForResource = 30;
    _session = [NSURLSession sessionWithConfiguration:config];
    // No URL cache: it keys by URL alone and would mix header sets.
    NSURLSessionConfiguration *headerConfig = [config copy];
    headerConfig.URLCache = nil;
    _headerSession = [NSURLSession sessionWithConfiguration:headerConfig];
    _inFlightRequests = [NSMutableDictionary dictionary];
  }
  return self;
}

- (void)downloadURL:(NSString *)url
            headers:(NSDictionary<NSString *, NSString *> *)headers
         completion:(ENRMImageDownloadCompletion)completion
{
  if (url.length == 0) {
    completion(nil);
    return;
  }

  headers = ENRMNormalizedImageHeaders(headers);
  BOOL isLocal = ENRMIsLocalImageURL(url);
  NSString *cacheKey = isLocal ? url : ENRMImageCacheKey(url, headers);

  RCTUIImage *cached = [[ENRMImageAttachment originalImageCache] objectForKey:cacheKey];
  if (cached) {
    completion(cached);
    return;
  }

  if (isLocal) {
    RCTUIImage *local = ENRMLoadLocalImage(url);
    if (local) {
      [[ENRMImageAttachment originalImageCache] setObject:local forKey:cacheKey cost:ENRMImageByteCost(local)];
    }
    completion(local);
    return;
  }

  @synchronized(_inFlightRequests) {
    NSMutableArray *existing = _inFlightRequests[cacheKey];
    if (existing) {
      [existing addObject:completion];
      return;
    }
    _inFlightRequests[cacheKey] = [NSMutableArray arrayWithObject:completion];
  }

  NSURL *nsURL = [NSURL URLWithString:url];
  if (!nsURL) {
    [self dispatchCallbacksForKey:cacheKey image:nil];
    return;
  }

  NSMutableURLRequest *request = [NSMutableURLRequest requestWithURL:nsURL];
  [headers enumerateKeysAndObjectsUsingBlock:^(NSString *name, NSString *value, BOOL *stop) {
    [request setValue:value forHTTPHeaderField:name];
  }];

  NSURLSession *session = headers.count > 0 ? _headerSession : _session;
  [[session dataTaskWithRequest:request
              completionHandler:^(NSData *data, NSURLResponse *response, NSError *error) {
#if !TARGET_OS_OSX
                RCTUIImage *image = (data && !error) ? [RCTUIImage imageWithData:data] : nil;
#else
        RCTUIImage *image = (data && !error) ? [[RCTUIImage alloc] initWithData:data] : nil;
#endif

                if (image) {
                  [[ENRMImageAttachment originalImageCache] setObject:image
                                                               forKey:cacheKey
                                                                 cost:ENRMImageByteCost(image)];
                }

                [self dispatchCallbacksForKey:cacheKey image:image];
              }] resume];
}

- (void)dispatchCallbacksForKey:(NSString *)cacheKey image:(RCTUIImage *_Nullable)image
{
  NSArray<ENRMImageDownloadCompletion> *callbacks;
  @synchronized(_inFlightRequests) {
    callbacks = [_inFlightRequests[cacheKey] copy];
    [_inFlightRequests removeObjectForKey:cacheKey];
  }

  if (!callbacks)
    return;

  dispatch_async(dispatch_get_main_queue(), ^{
    for (ENRMImageDownloadCompletion cb in callbacks) {
      cb(image);
    }
  });
}

@end
