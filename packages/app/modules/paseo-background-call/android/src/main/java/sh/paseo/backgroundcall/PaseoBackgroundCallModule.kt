package sh.paseo.backgroundcall

import android.Manifest
import android.content.Context
import android.content.pm.PackageManager
import expo.modules.kotlin.functions.Queues
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

class PaseoBackgroundCallModule : Module() {
    override fun definition() = ModuleDefinition {
        Name("PaseoBackgroundCall")

        AsyncFunction("begin") {
            val activity = requireNotNull(appContext.currentActivity) {
                "A Live Voice background call must begin while Paseo is visible"
            }
            check(activity.hasWindowFocus()) {
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

        AsyncFunction("end") {
            appContext.reactContext?.applicationContext?.let(BackgroundCallLifetime::end)
        }.runOnQueue(Queues.MAIN)

        OnDestroy {
            appContext.reactContext?.applicationContext?.let(BackgroundCallLifetime::end)
        }
    }

    private fun applicationContext(): Context {
        return requireNotNull(appContext.reactContext?.applicationContext) {
            "Paseo background-call support requires an active React context"
        }
    }
}
