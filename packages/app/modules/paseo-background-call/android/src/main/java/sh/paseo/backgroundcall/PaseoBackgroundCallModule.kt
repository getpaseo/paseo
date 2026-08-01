package sh.paseo.backgroundcall

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import androidx.lifecycle.Lifecycle
import androidx.lifecycle.LifecycleOwner
import expo.modules.kotlin.functions.Queues
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

private const val CALL_ACTION_EVENT_NAME = "onBackgroundCallAction"

class PaseoBackgroundCallModule : Module() {
    override fun definition() = ModuleDefinition {
        Name("PaseoBackgroundCall")

        Events(CALL_ACTION_EVENT_NAME)

        OnCreate {
            BackgroundCallLifetime.actionListener = { action ->
                sendEvent(CALL_ACTION_EVENT_NAME, mapOf("action" to action))
            }
        }

        AsyncFunction("begin") {
            val activity = requireNotNull(appContext.currentActivity) {
                "A Live Voice background call must begin while Paseo is visible"
            }
            // An app-owned React Native Modal temporarily takes window focus while its
            // selected action runs. The activity is still visible and Android permits
            // the foreground-service start, so lifecycle state is the authority here.
            val activityLifecycle = (activity as? LifecycleOwner)?.lifecycle
            check(activityLifecycle?.currentState == Lifecycle.State.RESUMED) {
                "A Live Voice background call must begin while Paseo is visible"
            }

            val context = applicationContext()
            val hasMicrophonePermission =
                context.checkSelfPermission(Manifest.permission.RECORD_AUDIO) ==
                    PackageManager.PERMISSION_GRANTED
            check(hasMicrophonePermission) {
                "Microphone permission is required before a Live Voice background call begins"
            }
            BackgroundCallLifetime.begin(context)
        }.runOnQueue(Queues.MAIN)

        AsyncFunction("update") { isMuted: Boolean ->
            appContext.reactContext?.applicationContext?.let { context ->
                BackgroundCallLifetime.update(context, isMuted)
            }
        }.runOnQueue(Queues.MAIN)

        AsyncFunction("end") {
            appContext.reactContext?.applicationContext?.let(BackgroundCallLifetime::end)
        }.runOnQueue(Queues.MAIN)

        OnDestroy {
            BackgroundCallLifetime.actionListener = null
            appContext.reactContext?.applicationContext?.let(BackgroundCallLifetime::end)
        }
    }

    private fun applicationContext(): Context {
        return requireNotNull(appContext.reactContext?.applicationContext) {
            "Paseo background-call support requires an active React context"
        }
    }
}
