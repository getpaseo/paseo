#pragma once
#import "ENRMFeatureFlags.h"
#import "ENRMMathInlineAttachment.h"

#if ENRICHED_MARKDOWN_MATH

@class ENRMRaTeXRenderResult;

@interface ENRMMathInlineAttachment () {
  CGSize _cachedSize;
  CGFloat _mathAscent;
  CGFloat _mathDescent;
  ENRMRaTeXRenderResult *_renderResult;
  // Visible-source fallback when RaTeX cannot parse the span; see ENRMMathFallback.h.
  NSAttributedString *_fallbackSource;
  BOOL _didReportError;
  BOOL _parseFailed;
  NSString *_parseMessage;
}
@end

#endif
