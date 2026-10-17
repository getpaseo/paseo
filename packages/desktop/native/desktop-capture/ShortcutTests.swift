import Foundation

@main struct ShortcutTests {
  static func main() {
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
