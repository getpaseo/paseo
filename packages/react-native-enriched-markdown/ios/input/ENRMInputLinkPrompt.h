#pragma once

#import "ENRMUIKit.h"

NS_ASSUME_NONNULL_BEGIN

void ENRMShowLinkPrompt(RCTUIView *sourceView, NSString *_Nullable existingURL, void (^completion)(NSString *url));

NS_ASSUME_NONNULL_END
