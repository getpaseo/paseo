package sh.paseo.hardwarekeyboard

import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

private const val HARDWARE_SUBMIT_EVENT_NAME = "onHardwareKeyboardSubmit"

class PaseoHardwareKeyboardModule : Module() {
  private val submitListener: (SubmitKeyPress) -> Unit = { press ->
    sendEvent(
      HARDWARE_SUBMIT_EVENT_NAME,
      mapOf(
        "targetNativeId" to press.targetNativeId,
        "ctrlKey" to press.ctrlKey,
        "metaKey" to press.metaKey,
      ),
    )
  }

  override fun definition() = ModuleDefinition {
    Name("PaseoHardwareKeyboard")

    Events(HARDWARE_SUBMIT_EVENT_NAME)

    OnCreate {
      PaseoHardwareKeyboardDispatcher.attach(submitListener)
    }

    Function("setHardwareKeyboardSubmitEnabled") { enabled: Boolean, targetNativeId: String? ->
      PaseoHardwareKeyboardDispatcher.setEnabled(enabled, targetNativeId)
    }

    OnActivityDestroys {
      PaseoHardwareKeyboardDispatcher.setEnabled(false, null)
    }

    OnDestroy {
      PaseoHardwareKeyboardDispatcher.detach(submitListener)
    }
  }
}
