// Typed in-memory adapters for the Android/RN calls made by the production
// handlers. The test runner inserts the unchanged handler bodies below.
data class KeyEvent(
  val keyCode: Int = KEYCODE_ENTER,
  val action: Int = ACTION_DOWN,
  val deviceId: Int = 3,
  val flags: Int = 0,
  val modifiers: Int = 0,
  val repeatCount: Int = 0
) {
  fun hasNoModifiers() = modifiers == 0
  companion object {
    const val KEYCODE_ENTER = 66
    const val KEYCODE_NUMPAD_ENTER = 160
    const val ACTION_DOWN = 0
    const val ACTION_UP = 1
    const val FLAG_SOFT_KEYBOARD = 2
  }
}

class Editable(var value: String = "hello", var composingStart: Int = -1)
object BaseInputConnection {
  fun getComposingSpanStart(text: Editable) = text.composingStart
}
object R { object id { const val react_test_id = 1 } }
open class ReactContext {
  val events = mutableListOf<String>()
  fun emitDeviceEvent(name: String) { events.add(name) }
}
class ThemedReactContext : ReactContext()
open class ReactEditText(val context: Any = ThemedReactContext()) {
  val text = Editable()
  var tag: String? = "paseo-composer-input"
  fun getTag(id: Int): String? { check(id == R.id.react_test_id); return tag }
  open fun onKeyPreIme(keyCode: Int, event: KeyEvent) = false
}
open class ActivityAdapter {
  var currentFocus: Any? = null
  open fun dispatchKeyEvent(event: KeyEvent) = false
}

// HANDLERS

fun main() {
  fun verify(name: String, action: () -> Unit) {
    action()
    println("PASS " + name)
  }

  fun deliver(input: ComposerInput, activity: HardwareActivity, event: KeyEvent): Boolean {
    // Android delivers pre-IME first; unconsumed events may reach the Activity.
    val consumed = input.onKeyPreIme(event.keyCode, event) || activity.dispatchKeyEvent(event)
    // The editing adapter models default Enter insertion, not Xiaoyi internals.
    if (!consumed && event.action == KeyEvent.ACTION_DOWN &&
        (event.keyCode == KeyEvent.KEYCODE_ENTER || event.keyCode == KeyEvent.KEYCODE_NUMPAD_ENTER)) {
      input.text.value += "\n"
    }
    return consumed
  }

  for (code in listOf(KeyEvent.KEYCODE_ENTER, KeyEvent.KEYCODE_NUMPAD_ENTER)) {
    for (device in listOf(0, 3)) {
      verify("physical Enter code=$code device=$device submits once across both handlers") {
        val input = ComposerInput()
        val activity = HardwareActivity().apply { currentFocus = input }
        val down = KeyEvent(keyCode = code, deviceId = device)
        check(deliver(input, activity, down))
        check(deliver(input, activity, down.copy(repeatCount = 1)))
        check(deliver(input, activity, down.copy(action = KeyEvent.ACTION_UP)))
        check((input.context as ReactContext).events == listOf("paseoHardwareKeyboardSubmit"))
        check(input.text.value == "hello")
        check(deliver(input, activity, down))
        check(deliver(input, activity, down.copy(action = KeyEvent.ACTION_UP)))
        check((input.context as ReactContext).events.size == 2)
      }
    }
  }

  val ignored = listOf(
    "shift" to KeyEvent(modifiers = 1),
    "ctrl" to KeyEvent(modifiers = 4096),
    "virtual" to KeyEvent(deviceId = -1),
    "software" to KeyEvent(flags = KeyEvent.FLAG_SOFT_KEYBOARD),
    "orphan-repeat" to KeyEvent(repeatCount = 1)
  )
  for ((name, event) in ignored) {
    verify("$name falls through with text editing and no submission") {
      val input = ComposerInput()
      val activity = HardwareActivity().apply { currentFocus = input }
      check(!deliver(input, activity, event))
      check(!deliver(input, activity, event.copy(action = KeyEvent.ACTION_UP)))
      check(input.text.value == "hello\n")
      check((input.context as ReactContext).events.isEmpty())
    }
  }
  verify("composition is not submitted") {
    val input = ComposerInput().apply { text.composingStart = 0 }
    val activity = HardwareActivity().apply { currentFocus = input }
    check(!deliver(input, activity, KeyEvent()))
    check(input.text.value == "hello\n")
    check((input.context as ReactContext).events.isEmpty())
  }
  verify("unmarked text fields retain Enter") {
    val input = ComposerInput().apply { tag = "search" }
    val activity = HardwareActivity().apply { currentFocus = input }
    check(!deliver(input, activity, KeyEvent()))
    check(input.text.value == "hello\n")
    check((input.context as ReactContext).events.isEmpty())
  }
  verify("non-Enter keys and unmatched key-up are not consumed") {
    val input = ComposerInput()
    val activity = HardwareActivity().apply { currentFocus = input }
    check(!deliver(input, activity, KeyEvent(keyCode = 29)))
    check(!deliver(input, activity, KeyEvent(action = KeyEvent.ACTION_UP)))
    check(input.text.value == "hello")
    check((input.context as ReactContext).events.isEmpty())
  }
  verify("Activity fallback submits once and consumes the matching release") {
    val input = ReactEditText()
    val activity = HardwareActivity().apply { currentFocus = input }
    check(activity.dispatchKeyEvent(KeyEvent()))
    check(activity.dispatchKeyEvent(KeyEvent(repeatCount = 1)))
    check(activity.dispatchKeyEvent(KeyEvent(action = KeyEvent.ACTION_UP)))
    check(!activity.dispatchKeyEvent(KeyEvent(action = KeyEvent.ACTION_UP)))
    check((input.context as ReactContext).events == listOf("paseoHardwareKeyboardSubmit"))
    check(input.text.value == "hello")
  }
  verify("Activity ignores missing focus, non-input focus and non-RN context") {
    val activity = HardwareActivity()
    check(!activity.dispatchKeyEvent(KeyEvent()))
    activity.currentFocus = "button"
    check(!activity.dispatchKeyEvent(KeyEvent()))
    activity.currentFocus = ReactEditText(context = "not-react")
    check(!activity.dispatchKeyEvent(KeyEvent()))
  }
}
