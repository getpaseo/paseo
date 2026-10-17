enum ModifierShortcutEvent { case began, ended, cancelled }

struct ModifierShortcut {
  let required: UInt64
  private var currentModifiers: UInt64 = 0
  private var active = false
  private var consumed = false
  private var contaminated = false

  init(required: UInt64) { self.required = required }

  mutating func cancel() -> ModifierShortcutEvent? {
    if currentModifiers != 0 { contaminated = true }
    guard active else { return nil }
    active = false
    consumed = true
    return .cancelled
  }

  mutating func update(modifiers: UInt64) -> ModifierShortcutEvent? {
    currentModifiers = modifiers
    let extra = modifiers & ~required != 0
    var event: ModifierShortcutEvent?
    if active && modifiers != required {
      active = false
      consumed = true
      event = extra ? .cancelled : .ended
    }
    if extra { contaminated = true }
    if modifiers == required && !active && !consumed && !contaminated {
      active = true
      event = .began
    }
    if modifiers == 0 {
      contaminated = false
      consumed = false
    }
    return event
  }
}
