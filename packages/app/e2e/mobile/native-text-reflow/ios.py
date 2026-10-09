import lldb


def __lldb_init_module(debugger, _internal_dict):
    process = debugger.GetSelectedTarget().GetProcess()
    main_threads = [thread for thread in process if thread.GetQueueName() == "com.apple.main-thread"]
    if len(main_threads) != 1 or not process.SetSelectedThread(main_threads[0]):
        raise RuntimeError("Could not select the UIKit main thread")
    debugger.HandleCommand("expression -l objc++ -- @import UIKit")
    frame = process.GetSelectedThread().GetSelectedFrame()
    options = lldb.SBExpressionOptions()
    options.SetLanguage(lldb.eLanguageTypeObjC_plus_plus)
    is_main_thread = frame.EvaluateExpression("(BOOL)[NSThread isMainThread]", options)
    if is_main_thread.GetError().Fail() or is_main_thread.GetValueAsUnsigned() != 1:
        raise RuntimeError("Refusing to run UIKit probe outside the main thread")
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
            auto keptSelection = text.selectedRange;
            // Fabric recycles the view: the container keeps its size in the pool,
            // and the next paragraph mounts it 30 points wider (a list-item paragraph
            // reused by a full-width one) or at the same size.
            [host performSelector:@selector(prepareForRecycle)];
            frame.size.width = 530;
            container.frame = frame;
            [container layoutIfNeeded];
            CGFloat reusedWider = text.frame.size.width;
            [host performSelector:@selector(prepareForRecycle)];
            container.frame = frame;
            [container layoutIfNeeded];
            CGFloat reusedSame = text.frame.size.width;
            BOOL ok = text != nil && narrow == 240 && wide == 500 &&
                reusedWider == 530 && reusedSame == 530 &&
                selection.location == keptSelection.location &&
                selection.length == keptSelection.length &&
                selection.location == 12 && selection.length == 9;
            [NSString stringWithFormat:@"NATIVE_REFLOW_%@ narrow=%.0f wide=%.0f recycled=%.0f,%.0f selection=%lu:%lu",
                ok ? @"PASS" : @"FAIL", narrow, wide, reusedWider, reusedSame,
                (unsigned long)keptSelection.location,
                (unsigned long)keptSelection.length];
        })''',
        options,
    )
    if result.GetError().Fail():
        raise RuntimeError(result.GetError().GetCString())
    print(result.GetObjectDescription())
