import lldb


def __lldb_init_module(debugger, _internal_dict):
    debugger.HandleCommand("expression -l objc++ -- @import UIKit")
    frame = debugger.GetSelectedTarget().GetProcess().GetSelectedThread().GetSelectedFrame()
    options = lldb.SBExpressionOptions()
    options.SetLanguage(lldb.eLanguageTypeObjC_plus_plus)
    result = frame.EvaluateExpression(
        r'''({
            UIView *host = (UIView *)[[NSClassFromString(@"RNUITextView") alloc] init];
            auto hostFrame = host.frame;
            hostFrame.size.width = 500;
            hostFrame.size.height = 200;
            host.frame = hostFrame;
            UIView *container = (UIView *)[host performSelector:@selector(contentView)];
            container.frame = host.bounds;
            UITextView *text = nil;
            for (UIView *child in host.subviews) {
                if ([child isKindOfClass:UITextView.class]) text = (UITextView *)child;
                for (UIView *nested in child.subviews) {
                    if ([nested isKindOfClass:UITextView.class]) text = (UITextView *)nested;
                }
            }
            text.frame = container.bounds;
            text.font = [UIFont systemFontOfSize:16];
            text.text = @"A realistic multiline paragraph must reflow when Explorer narrows the available chat width, then fill the restored width without replacing the text view or discarding a selection.";
            auto range = text.selectedRange;
            range.location = 12;
            range.length = 9;
            text.selectedRange = range;
            auto frame = container.frame;
            frame.size.width = 240;
            container.frame = frame;
            [container layoutIfNeeded];
            CGFloat narrow = text.frame.size.width;
            auto selection = text.selectedRange;
            frame.size.width = 500;
            container.frame = frame;
            [container layoutIfNeeded];
            CGFloat wide = text.frame.size.width;
            BOOL ok = text != nil && narrow == 240 && wide == 500 &&
                selection.location == text.selectedRange.location &&
                selection.length == text.selectedRange.length &&
                selection.location == 12 && selection.length == 9;
            [NSString stringWithFormat:@"NATIVE_REFLOW_%@ narrow=%.0f wide=%.0f selection=%lu:%lu",
                ok ? @"PASS" : @"FAIL", narrow, wide,
                (unsigned long)text.selectedRange.location,
                (unsigned long)text.selectedRange.length];
        })''',
        options,
    )
    if result.GetError().Fail():
        raise RuntimeError(result.GetError().GetCString())
    print(result.GetObjectDescription())
