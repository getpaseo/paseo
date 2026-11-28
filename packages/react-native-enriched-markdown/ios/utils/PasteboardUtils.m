#import "PasteboardUtils.h"
#import "ENRMImageAttachment.h"
#import "ENRMLinkPillText.h"
#import "HTMLGenerator.h"
#import "MarkdownExtractor.h"
#import "RTFExportUtils.h"
#import "StyleConfig.h"
#include <TargetConditionals.h>
#if !TARGET_OS_OSX
#import <UIKit/UIPasteboard.h>
#endif

static NSString *const kUTIRTFD = @"com.apple.rtfd";
static NSString *const kUTIFlatRTFD = @"com.apple.flat-rtfd";
static NSString *const kUTIRTF = @"public.rtf";

#pragma mark - Private Helpers

static void addRTFData(NSMutableDictionary *items, NSAttributedString *attributedString, NSRange range,
                       NSString *documentType, NSString *uti)
{
  NSError *error = nil;
  NSData *data = [attributedString dataFromRange:range
                              documentAttributes:@{NSDocumentTypeDocumentAttribute : documentType}
                                           error:&error];
  if (data && !error) {
    items[uti] = data;
  }
}

static void addRTFDData(NSMutableDictionary *items, NSAttributedString *attributedString, NSRange range)
{
  NSError *error = nil;
  NSFileWrapper *wrapper =
      [attributedString fileWrapperFromRange:range
                          documentAttributes:@{NSDocumentTypeDocumentAttribute : NSRTFDTextDocumentType}
                                       error:&error];
  if (wrapper && !error) {
    NSData *data = [wrapper serializedRepresentation];
    if (data) {
      items[kUTIFlatRTFD] = data;
    }
  }
}

static void addHTMLData(NSMutableDictionary *items, NSAttributedString *attributedString, StyleConfig *styleConfig)
{
  NSString *html = generateHTML(attributedString, styleConfig);
  if (html) {
    NSData *data = [html dataUsingEncoding:NSUTF8StringEncoding];
    if (data) {
      items[kUTIHTML] = data;
    }
  }
}

#pragma mark - Public API

void copyStringToPasteboard(NSString *string)
{
#if !TARGET_OS_OSX
  [[UIPasteboard generalPasteboard] setString:string];
#else
  NSPasteboard *pasteboard = [NSPasteboard generalPasteboard];
  [pasteboard clearContents];
  [pasteboard setString:string forType:kUTIPlainText];
#endif
}

void copyItemsToPasteboard(NSDictionary<NSString *, id> *items)
{
#if !TARGET_OS_OSX
  [[UIPasteboard generalPasteboard] setItems:@[ items ]];
#else
  NSPasteboard *pasteboard = [NSPasteboard generalPasteboard];
  [pasteboard clearContents];
  for (NSString *type in items) {
    id value = items[type];
    if ([value isKindOfClass:[NSString class]]) {
      [pasteboard setString:value forType:type];
    } else if ([value isKindOfClass:[NSData class]]) {
      [pasteboard setData:value forType:type];
    }
  }
#endif
}

void copyAttributedStringToPasteboard(NSAttributedString *attributedString, NSString *_Nullable markdown,
                                      StyleConfig *_Nullable styleConfig)
{
  if (!attributedString || attributedString.length == 0)
    return;

  // Expanded once here for the plain-text flavor; the exporters below then have nothing left to expand.
  attributedString = ENRMAttributedStringByExpandingLinkPills(attributedString, NULL);

  NSMutableDictionary *items = [NSMutableDictionary dictionary];

  items[kUTIPlainText] = attributedString.string;

  if (markdown.length > 0) {
    items[kUTIMarkdown] = markdown;
  }

  if (styleConfig) {
    addHTMLData(items, attributedString, styleConfig);
  }

  // RTF export requires preprocessing (backgrounds, markers, normalized spacing)
  NSAttributedString *rtfPrepared = prepareAttributedStringForRTFExport(attributedString, styleConfig);
  NSRange rtfRange = NSMakeRange(0, rtfPrepared.length);

  addRTFDData(items, rtfPrepared, rtfRange);
  addRTFData(items, rtfPrepared, rtfRange, NSRTFTextDocumentType, kUTIRTF);

  copyItemsToPasteboard(items);
}

#pragma mark - Content Extraction

NSString *_Nullable markdownForRange(NSAttributedString *attributedText, NSRange range,
                                     NSString *_Nullable cachedMarkdown)
{
  if (!cachedMarkdown || range.length == 0)
    return nil;

  if (!attributedText || range.location >= attributedText.length)
    return nil;

  range.length = MIN(range.length, attributedText.length - range.location);

  // Full selection: use cached markdown directly
  BOOL isFullSelection = (range.location == 0 && range.length >= attributedText.length - 1);
  if (isFullSelection) {
    return cachedMarkdown;
  }

  // Partial selection: reverse-engineer from attributes
  return extractMarkdownFromAttributedString(attributedText, range);
}

NSArray<NSString *> *imageURLsInRange(NSAttributedString *attributedText, NSRange range)
{
  if (!attributedText || range.location == NSNotFound || range.length == 0 || range.location >= attributedText.length) {
    return @[];
  }

  range.length = MIN(range.length, attributedText.length - range.location);

  NSMutableArray<NSString *> *urls = [NSMutableArray array];

  [attributedText enumerateAttribute:NSAttachmentAttributeName
                             inRange:range
                             options:0
                          usingBlock:^(id value, NSRange r, BOOL *stop) {
                            if (![value isKindOfClass:[ENRMImageAttachment class]])
                              return;

                            NSString *url = ((ENRMImageAttachment *)value).imageURL;
                            if ([url hasPrefix:@"http://"] || [url hasPrefix:@"https://"]) {
                              [urls addObject:url];
                            }
                          }];

  return urls;
}
