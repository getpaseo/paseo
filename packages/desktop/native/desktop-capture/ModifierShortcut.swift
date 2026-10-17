struct ModifierShortcut {
    let required: UInt64
    private var currentModifiers: UInt64 = 0
    private var armed = false
    private var contaminated = false

    init(required: UInt64) { self.required = required }

    mutating func cancel() { if currentModifiers != 0 { contaminated = true } }

    mutating func update(modifiers: UInt64) -> Bool {
        currentModifiers = modifiers
        if modifiers == 0 {
            let trigger = armed && !contaminated
            armed = false
            contaminated = false
            return trigger
        }
        if modifiers & ~required != 0 { contaminated = true }
        if modifiers == required && !contaminated { armed = true }
        return false
    }
}
