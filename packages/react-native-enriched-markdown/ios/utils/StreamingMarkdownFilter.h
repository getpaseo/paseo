#pragma once

#import <Foundation/Foundation.h>

NS_ASSUME_NONNULL_BEGIN

typedef NS_ENUM(NSInteger, ENRMTableStreamingMode) {
  ENRMTableStreamingModeHidden = 0,
  ENRMTableStreamingModeProgressive,
};

typedef NS_ENUM(NSInteger, ENRMCodeBlockStreamingMode) {
  ENRMCodeBlockStreamingModeHidden = 0,
  ENRMCodeBlockStreamingModeProgressive,
};

#ifdef __cplusplus
extern "C" {
#endif

// Filtered markdown for the current streaming tick. When non-NULL,
// outEndsInsideOpenCodeFence reports whether the result ends inside a still-open
// fenced code block (the trailing block whose chrome the renderer defers).
NSString *ENRMRenderableMarkdownForStreaming(NSString *markdown, ENRMTableStreamingMode tableMode,
                                             ENRMCodeBlockStreamingMode codeBlockMode,
                                             BOOL *_Nullable outEndsInsideOpenCodeFence);

#ifdef __cplusplus
}
#endif

NS_ASSUME_NONNULL_END
