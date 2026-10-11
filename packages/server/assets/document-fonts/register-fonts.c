#include <CoreFoundation/CoreFoundation.h>
#include <CoreText/CoreText.h>
#include <stdio.h>
#include <string.h>

// Persistent user registration makes fonts discoverable by the separate LibreOffice process.
int main(int argc, char **argv) {
  if (argc < 2) return 2;
  for (int index = 1; index < argc; index++) {
    CFURLRef url = CFURLCreateFromFileSystemRepresentation(
        kCFAllocatorDefault, (const UInt8 *)argv[index], strlen(argv[index]), false);
    if (!url) return 2;
    CFErrorRef error = NULL;
    bool registered = CTFontManagerRegisterFontsForURL(url, kCTFontManagerScopePersistent, &error);
    CFRelease(url);
    if (!registered && (!error || CFErrorGetCode(error) != kCTFontManagerErrorAlreadyRegistered)) {
      if (error) {
        CFStringRef message = CFErrorCopyDescription(error);
        char buffer[2048];
        if (CFStringGetCString(message, buffer, sizeof(buffer), kCFStringEncodingUTF8))
          fprintf(stderr, "%s\n", buffer);
        CFRelease(message);
        CFRelease(error);
      }
      return 1;
    }
    if (error) CFRelease(error);
  }
  return 0;
}
