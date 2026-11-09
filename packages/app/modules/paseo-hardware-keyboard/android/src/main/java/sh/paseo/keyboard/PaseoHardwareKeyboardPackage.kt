package sh.paseo.keyboard

import android.app.Activity
import android.content.Context
import android.os.Bundle
import expo.modules.core.interfaces.Package
import expo.modules.core.interfaces.ReactActivityLifecycleListener

class PaseoHardwareKeyboardPackage : Package {
  override fun createReactActivityLifecycleListeners(activityContext: Context): List<ReactActivityLifecycleListener> = listOf(
    object : ReactActivityLifecycleListener {
      override fun onCreate(activity: Activity, savedInstanceState: Bundle?) { HardwareKeyboard.observe(activity.window) }
      override fun onResume(activity: Activity) { HardwareKeyboard.observe(activity.window) }
      override fun onDestroy(activity: Activity) { HardwareKeyboard.release(activity.window) }
    }
  )
}
