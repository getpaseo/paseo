#import "ENRMLinkPillIconCache.h"
#import "ENRMImageDownloader.h"
#import "ENRMLocalImageLoader.h"
#if !TARGET_OS_OSX
#import <ImageIO/ImageIO.h>
#import <QuartzCore/QuartzCore.h>

// Icons are drawn at the label's font size, so even a large heading at 3x needs few pixels.
static const CGFloat kMaxIconPixelSize = 128;

static NSCache<NSString *, UIImage *> *ENRMLinkPillIcons(void)
{
  static NSCache<NSString *, UIImage *> *icons;
  static dispatch_once_t once;
  dispatch_once(&once, ^{
    icons = [NSCache new];
    icons.countLimit = 64;
    icons.totalCostLimit = 8 * 1024 * 1024;
  });
  return icons;
}

// A failed source is left alone for a while, so a broken URL is not requested on every
// render, and then tried again, so a transient failure does not hide the icon for good.
static const CFTimeInterval kFailedIconRetryInterval = 30;

static NSCache<NSString *, NSNumber *> *ENRMFailedLinkPillIcons(void)
{
  static NSCache<NSString *, NSNumber *> *failed;
  static dispatch_once_t once;
  dispatch_once(&once, ^{
    failed = [NSCache new];
    failed.countLimit = 256;
  });
  return failed;
}

// A local icon and the state of its file when it was decoded.
@interface ENRMLocalLinkPillIcon : NSObject
@property (nonatomic, strong) UIImage *image;
@property (nonatomic, copy) NSString *path;
@property (nonatomic, strong, nullable) NSDate *modified;
@property (nonatomic, assign) unsigned long long fileSize;
@property (nonatomic, assign) CFTimeInterval checkedAt;
@end

@implementation ENRMLocalLinkPillIcon
@end

// Every render asks for the same icons again, so the file is looked at no more than once
// per interval; a file replaced under the same path is picked up after that.
static const CFTimeInterval kLocalIconRevalidateInterval = 1;

static NSCache<NSString *, ENRMLocalLinkPillIcon *> *ENRMLocalLinkPillIcons(void)
{
  static NSCache<NSString *, ENRMLocalLinkPillIcon *> *icons;
  static dispatch_once_t once;
  dispatch_once(&once, ^{
    icons = [NSCache new];
    icons.countLimit = 64;
    icons.totalCostLimit = 8 * 1024 * 1024;
  });
  return icons;
}

static UIImage *ENRMDecodeLinkPillIcon(NSString *path)
{
  CGImageSourceRef source = CGImageSourceCreateWithURL((__bridge CFURLRef)[NSURL fileURLWithPath:path], NULL);
  if (!source)
    return nil;
  NSDictionary *options = @{
    (__bridge NSString *)kCGImageSourceCreateThumbnailFromImageAlways : @YES,
    (__bridge NSString *)kCGImageSourceCreateThumbnailWithTransform : @YES,
    (__bridge NSString *)kCGImageSourceShouldCacheImmediately : @YES,
    (__bridge NSString *)kCGImageSourceThumbnailMaxPixelSize : @(kMaxIconPixelSize),
  };
  CGImageRef decoded = CGImageSourceCreateThumbnailAtIndex(source, 0, (__bridge CFDictionaryRef)options);
  CFRelease(source);
  if (!decoded)
    return nil;
  UIImage *image = [UIImage imageWithCGImage:decoded];
  CGImageRelease(decoded);
  return image;
}

UIImage *ENRMLoadLinkPillIcon(NSString *iconUri)
{
  if (iconUri.length == 0)
    return nil;
  NSCache<NSString *, ENRMLocalLinkPillIcon *> *icons = ENRMLocalLinkPillIcons();
  ENRMLocalLinkPillIcon *cached = [icons objectForKey:iconUri];
  CFTimeInterval now = CACurrentMediaTime();
  if (cached && now - cached.checkedAt < kLocalIconRevalidateInterval)
    return cached.image;

  NSString *path = cached.path ?: ENRMResolveLocalImagePath(iconUri);
  if (!path)
    return nil;
  NSDictionary *attributes = [NSFileManager.defaultManager attributesOfItemAtPath:path error:nil];
  NSDate *modified = attributes[NSFileModificationDate];
  unsigned long long fileSize = [attributes[NSFileSize] unsignedLongLongValue];
  if (cached && attributes && cached.fileSize == fileSize && [cached.modified isEqualToDate:modified]) {
    cached.checkedAt = now;
    return cached.image;
  }

  UIImage *image = attributes ? ENRMDecodeLinkPillIcon(path) : nil;
  if (!image) {
    [icons removeObjectForKey:iconUri];
    return nil;
  }
  ENRMLocalLinkPillIcon *entry = [ENRMLocalLinkPillIcon new];
  entry.image = image;
  entry.path = path;
  entry.modified = modified;
  entry.fileSize = fileSize;
  entry.checkedAt = now;
  [icons setObject:entry forKey:iconUri cost:ENRMImageByteCost(image)];
  return image;
}

UIImage *ENRMCachedLinkPillIcon(NSString *iconUri, NSDictionary<NSString *, NSString *> *headers)
{
  return [ENRMLinkPillIcons() objectForKey:ENRMImageCacheKey(iconUri, headers)];
}

BOOL ENRMLinkPillIconDidFail(NSString *iconUri, NSDictionary<NSString *, NSString *> *headers)
{
  NSString *key = ENRMImageCacheKey(iconUri, headers);
  NSNumber *failedAt = [ENRMFailedLinkPillIcons() objectForKey:key];
  if (!failedAt)
    return NO;
  if (CACurrentMediaTime() - failedAt.doubleValue < kFailedIconRetryInterval)
    return YES;
  [ENRMFailedLinkPillIcons() removeObjectForKey:key];
  return NO;
}

static UIImage *ENRMLinkPillThumbnail(UIImage *image)
{
  CGFloat pixelWidth = image.size.width * image.scale;
  CGFloat pixelHeight = image.size.height * image.scale;
  CGFloat longest = MAX(pixelWidth, pixelHeight);
  if (longest <= kMaxIconPixelSize || longest <= 0)
    return image;
  CGFloat ratio = kMaxIconPixelSize / longest;
  CGSize size = CGSizeMake(MAX(1, floor(pixelWidth * ratio)), MAX(1, floor(pixelHeight * ratio)));
  UIGraphicsImageRendererFormat *format = [UIGraphicsImageRendererFormat preferredFormat];
  format.scale = 1;
  format.opaque = NO;
  UIGraphicsImageRenderer *renderer = [[UIGraphicsImageRenderer alloc] initWithSize:size format:format];
  return [renderer imageWithActions:^(UIGraphicsImageRendererContext *context) {
    [image drawInRect:(CGRect){CGPointZero, size}];
  }];
}

void ENRMLoadLinkPillIconAsync(NSString *iconUri, NSDictionary<NSString *, NSString *> *headers,
                               void (^completion)(UIImage *_Nullable icon))
{
  NSString *key = ENRMImageCacheKey(iconUri, headers);
  [[ENRMImageDownloader shared] downloadURL:iconUri
                                    headers:headers
                                 completion:^(RCTUIImage *image) {
                                   // Drawn pills are cached by icon identity: every pill waiting
                                   // for this icon gets the same image.
                                   UIImage *icon = [ENRMLinkPillIcons() objectForKey:key];
                                   if (!icon && image) {
                                     icon = ENRMLinkPillThumbnail(image);
                                     [ENRMLinkPillIcons() setObject:icon forKey:key cost:ENRMImageByteCost(icon)];
                                   }
                                   if (!icon) {
                                     [ENRMFailedLinkPillIcons() setObject:@(CACurrentMediaTime()) forKey:key];
                                   }
                                   if (NSThread.isMainThread) {
                                     completion(icon);
                                   } else {
                                     dispatch_async(dispatch_get_main_queue(), ^{ completion(icon); });
                                   }
                                 }];
}
#endif
