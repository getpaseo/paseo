#pragma once
#import "ENRMUIKit.h"
#import <Foundation/Foundation.h>

extern NSString *const ENRMScriptAttributeName;
extern NSString *const ENRMScriptValueSuperscript;
extern NSString *const ENRMScriptValueSubscript;

void ENRMApplyBaselineShift(NSMutableAttributedString *output, NSRange range, CGFloat fontScale,
                            CGFloat baselineOffsetScale);
