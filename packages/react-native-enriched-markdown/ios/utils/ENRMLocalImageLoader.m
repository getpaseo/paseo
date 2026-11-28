#import "ENRMLocalImageLoader.h"

static NSString *_Nullable ENRMBundleRelativePath(NSString *path)
{
  NSString *bundlePath = [[NSBundle mainBundle] resourcePath];
  if (bundlePath == nil || ![path hasPrefix:bundlePath]) {
    return nil;
  }
  NSString *relative = [path substringFromIndex:bundlePath.length];
  return [relative hasPrefix:@"/"] ? [relative substringFromIndex:1] : relative;
}

static RCTUIImage *_Nullable ENRMImageNamed(NSString *name)
{
  return [RCTUIImage imageNamed:name];
}

static RCTUIImage *_Nullable ENRMImageAtPath(NSString *path)
{
  if (path.pathExtension.length == 0) {
    path = [path stringByAppendingPathExtension:@"png"];
  }
#if !TARGET_OS_OSX
  return [RCTUIImage imageWithContentsOfFile:path];
#else
  return [[RCTUIImage alloc] initWithContentsOfFile:path];
#endif
}

BOOL ENRMIsLocalImageURL(NSString *url)
{
  if ([url hasPrefix:@"file://"]) {
    return YES;
  }
  NSURL *parsed = [NSURL URLWithString:url];
  return parsed == nil || parsed.scheme.length == 0;
}

static NSDictionary<NSString *, NSString *> *ENRMLocalImageSourcePaths(NSString *url)
{
  NSString *filePath = nil;
  NSString *imageName = nil;

  if ([url hasPrefix:@"file://"]) {
    NSURL *fileURL = [NSURL URLWithString:url];
    if (fileURL.fileURL) {
      filePath = @(fileURL.fileSystemRepresentation);
    } else {
      NSString *stripped = [url substringFromIndex:@"file://".length];
      filePath = [stripped stringByRemovingPercentEncoding] ?: stripped;
    }
    imageName = ENRMBundleRelativePath(filePath);
  } else {
    NSString *decoded = [url stringByRemovingPercentEncoding] ?: url;
    if (decoded.absolutePath) {
      filePath = decoded;
    } else {
      imageName = decoded;
      filePath = [[[NSBundle mainBundle] resourcePath] stringByAppendingPathComponent:decoded];
    }
  }

  return @{@"filePath" : filePath ?: @"", @"imageName" : imageName ?: @""};
}

NSString *_Nullable ENRMResolveLocalImagePath(NSString *url)
{
  if (url.length == 0 || !ENRMIsLocalImageURL(url))
    return nil;
  NSDictionary *paths = ENRMLocalImageSourcePaths(url);
  NSString *path = paths[@"filePath"];
  if (path.length == 0)
    return nil;
  if (path.pathExtension.length == 0)
    path = [path stringByAppendingPathExtension:@"png"];
  NSMutableArray<NSString *> *candidates = [NSMutableArray new];
  if ([paths[@"imageName"] length] > 0) {
    NSString *stem = path.stringByDeletingPathExtension;
    if (![stem hasSuffix:@"@2x"] && ![stem hasSuffix:@"@3x"]) {
#if !TARGET_OS_OSX
      NSInteger scale = MAX(1, MIN(3, (NSInteger)UIScreen.mainScreen.scale));
#else
      NSInteger scale = MAX(1, MIN(3, (NSInteger)NSScreen.mainScreen.backingScaleFactor));
#endif
      for (NSNumber *candidateScale in @[ @(scale), @3, @2 ]) {
        if (candidateScale.integerValue > 1)
          [candidates addObject:[[stem stringByAppendingFormat:@"@%@x", candidateScale]
                                    stringByAppendingPathExtension:path.pathExtension]];
      }
    }
  }
  [candidates addObject:path];
  for (NSString *candidate in candidates) {
    BOOL directory = NO;
    if ([NSFileManager.defaultManager fileExistsAtPath:candidate isDirectory:&directory] && !directory)
      return [candidate stringByResolvingSymlinksInPath];
  }
  return nil;
}

RCTUIImage *_Nullable ENRMLoadLocalImage(NSString *url)
{
  NSDictionary *paths = ENRMLocalImageSourcePaths(url);
  NSString *filePath = paths[@"filePath"];
  NSString *imageName = paths[@"imageName"];
  RCTUIImage *image = imageName.length > 0 ? ENRMImageNamed(imageName) : nil;
  if (image == nil && filePath.length > 0) {
    image = ENRMImageAtPath(ENRMResolveLocalImagePath(url) ?: filePath);
  }
  return image;
}
