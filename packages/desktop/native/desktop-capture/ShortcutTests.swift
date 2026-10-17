import Foundation

@main struct ShortcutTests {
  static func main() {
    precondition(
      captureLocalPath("file:///Users/test/Projet%20%C3%A9t%C3%A9/") == "/Users/test/Projet été")
    precondition(captureLocalPath("/Users/test/Dossier") == "/Users/test/Dossier")
    precondition(captureLocalPath("https://example.com/folder") == nil)
    precondition(captureLocalPath("file://remote-server/folder") == nil)
    precondition(captureLocalPath("Dossier") == nil)

    precondition(
      captureFinderBreadcrumbURL([
        ("AXStaticText", "file:///"),
        ("AXStaticText", "file:///Users/test/Projet%20%C3%A9t%C3%A9/"),
      ]) == "file:///Users/test/Projet%20%C3%A9t%C3%A9/")
    precondition(captureFinderBreadcrumbURL([("AXLayoutItem", "file:///Users/test/")]) == nil)
    precondition(captureFinderBreadcrumbURL([("AXStaticText", "https://example.com/")]) == nil)
    for order in [[UInt64(1), 3, 2, 0], [UInt64(2), 3, 1, 0]] {
      var shortcut = ModifierShortcut(required: 3)
      precondition(shortcut.update(modifiers: order[0]) == nil)
      precondition(shortcut.update(modifiers: order[1]) == .began)
      precondition(shortcut.update(modifiers: 3) == nil)
      precondition(shortcut.update(modifiers: order[2]) == .ended)
      precondition(shortcut.update(modifiers: order[3]) == nil)
    }
    var shortcut = ModifierShortcut(required: 3)
    precondition(shortcut.cancel() == nil)
    precondition(shortcut.update(modifiers: 3) == .began)
    precondition(shortcut.cancel() == .cancelled)
    precondition(shortcut.update(modifiers: 0) == nil)
    precondition(shortcut.update(modifiers: 7) == nil)
    precondition(shortcut.update(modifiers: 3) == nil)
    precondition(shortcut.update(modifiers: 0) == nil)
    precondition(shortcut.update(modifiers: 3) == .began)
    precondition(shortcut.update(modifiers: 7) == .cancelled)
    precondition(shortcut.update(modifiers: 0) == nil)
    print("Shortcut: hold begins once, first release ends once, cancellation never sends")
  }
}
