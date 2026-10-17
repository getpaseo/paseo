import Foundation

@main struct ShortcutTests {
    static func main() {
        var shortcut = ModifierShortcut(required: 3)
        shortcut.cancel()
        precondition(!shortcut.update(modifiers: 1))
        precondition(!shortcut.update(modifiers: 3))
        precondition(!shortcut.update(modifiers: 2))
        precondition(shortcut.update(modifiers: 0))
        precondition(!shortcut.update(modifiers: 0))
        precondition(!shortcut.update(modifiers: 2))
        precondition(!shortcut.update(modifiers: 3))
        shortcut.cancel()
        precondition(!shortcut.update(modifiers: 0))
        precondition(!shortcut.update(modifiers: 7))
        precondition(!shortcut.update(modifiers: 3))
        precondition(!shortcut.update(modifiers: 0))
        precondition(!shortcut.update(modifiers: 0))
        precondition(!shortcut.update(modifiers: 3))
        precondition(shortcut.update(modifiers: 0))
        print("Shortcut: both orders, one release, extra keys and extra modifiers passed")
    }
}
