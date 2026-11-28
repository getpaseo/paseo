#import "ENRMInputLinkPrompt.h"

static const CGFloat kMacOSURLFieldWidth = 260;
static const CGFloat kMacOSURLFieldHeight = 24;

void ENRMShowLinkPrompt(RCTUIView *sourceView, NSString *existingURL, void (^completion)(NSString *url))
{
  BOOL isEditing = existingURL.length > 0;
  NSString *title = isEditing ? @"Edit Link" : @"Add Link";
  NSString *confirmTitle = isEditing ? @"Update" : @"Add";

#if !TARGET_OS_OSX
  UIAlertController *alert = [UIAlertController alertControllerWithTitle:title
                                                                 message:nil
                                                          preferredStyle:UIAlertControllerStyleAlert];

  [alert addTextFieldWithConfigurationHandler:^(UITextField *textField) {
    textField.placeholder = @"URL";
    textField.text = existingURL ?: @"";
    textField.keyboardType = UIKeyboardTypeURL;
    textField.autocapitalizationType = UITextAutocapitalizationTypeNone;
    textField.autocorrectionType = UITextAutocorrectionTypeNo;
  }];

  UIAlertAction *confirmAction = [UIAlertAction actionWithTitle:confirmTitle
                                                          style:UIAlertActionStyleDefault
                                                        handler:^(UIAlertAction *action) {
                                                          NSString *url = alert.textFields.firstObject.text;
                                                          completion(url);
                                                        }];
  confirmAction.enabled = isEditing;

  [alert addAction:[UIAlertAction actionWithTitle:@"Cancel" style:UIAlertActionStyleCancel handler:nil]];
  [alert addAction:confirmAction];

  UITextField *urlField = alert.textFields.firstObject;
  [NSNotificationCenter.defaultCenter
      addObserverForName:UITextFieldTextDidChangeNotification
                  object:urlField
                   queue:NSOperationQueue.mainQueue
              usingBlock:^(NSNotification *note) { confirmAction.enabled = urlField.text.length > 0; }];

  UIViewController *presenter = sourceView.window.rootViewController;
  while (presenter.presentedViewController) {
    presenter = presenter.presentedViewController;
  }
  [presenter presentViewController:alert animated:YES completion:nil];
#else
  NSAlert *alert = [[NSAlert alloc] init];
  alert.messageText = title;
  alert.informativeText = @"Enter the URL for the link.";
  [alert addButtonWithTitle:confirmTitle];
  [alert addButtonWithTitle:@"Cancel"];

  NSTextField *urlField =
      [[NSTextField alloc] initWithFrame:NSMakeRect(0, 0, kMacOSURLFieldWidth, kMacOSURLFieldHeight)];
  urlField.placeholderString = @"URL";
  urlField.stringValue = existingURL ?: @"";
  alert.accessoryView = urlField;

  [alert beginSheetModalForWindow:sourceView.window
                completionHandler:^(NSModalResponse returnCode) {
                  if (returnCode == NSAlertFirstButtonReturn) {
                    NSString *url = urlField.stringValue;
                    if (url.length > 0) {
                      completion(url);
                    }
                  }
                }];
#endif
}
