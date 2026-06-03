package sh.paseo.unifiedpush

import android.content.ComponentName
import android.content.Context
import android.content.Intent
import android.content.ServiceConnection
import android.content.pm.PackageManager
import android.graphics.Bitmap
import android.graphics.Canvas
import android.graphics.drawable.BitmapDrawable
import android.graphics.drawable.Drawable
import android.os.IBinder
import android.util.Base64
import android.util.Log
import androidx.core.graphics.createBitmap
import androidx.core.os.bundleOf
import expo.modules.kotlin.Promise
import expo.modules.kotlin.exception.CodedException
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import org.unifiedpush.android.connector.INSTANCE_DEFAULT
import org.unifiedpush.android.connector.PushService
import org.unifiedpush.android.connector.UnifiedPush
import java.io.ByteArrayOutputStream

class PaseoUnifiedPushModule : Module() {
  override fun definition() = ModuleDefinition {
    Name("PaseoUnifiedPush")

    Events("message")

    Function("getDistributors") {
      val context = appContext.activityProvider?.currentActivity ?: return@Function emptyList<Map<String, Any?>>()
      val saved = UnifiedPush.getSavedDistributor(context)
      val connected = UnifiedPush.getAckDistributor(context)

      return@Function UnifiedPush.getDistributors(context).map { distributor ->
        val isInternal = distributor == appContext.reactContext?.packageName
        mapOf(
          "id" to distributor,
          "name" to if (isInternal) "Internal FCM Distributor" else getPackageName(distributor),
          "icon" to getDistributorIcon(distributor),
          "isInternal" to isInternal,
          "isSaved" to (distributor == saved),
          "isConnected" to (distributor == connected),
        )
      }
    }

    Function("getSavedDistributor") {
      val context = appContext.activityProvider?.currentActivity ?: return@Function null
      return@Function UnifiedPush.getSavedDistributor(context)
    }

    Function("saveDistributor") { distributor: String? ->
      val context = appContext.activityProvider?.currentActivity ?: return@Function
      if (distributor == null) {
        UnifiedPush.removeDistributor(context)
      } else {
        UnifiedPush.saveDistributor(context, distributor)
      }
    }

    AsyncFunction("registerDevice") { vapidPublicKey: String, instance: String?, promise: Promise ->
      val context = appContext.activityProvider?.currentActivity
      if (context == null) {
        promise.reject(CodedException("App context for PaseoUnifiedPush is not ready"))
        return@AsyncFunction
      }

      val saved = UnifiedPush.getSavedDistributor(context)
      if (saved == null) {
        promise.reject(CodedException("A UnifiedPush distributor must be selected before registration"))
        return@AsyncFunction
      }

      val appName = getPackageName(context.packageName) ?: "Paseo"
      UnifiedPush.register(
        context,
        instance ?: INSTANCE_DEFAULT,
        "$appName is registering for push notifications",
        vapidPublicKey,
      )
      promise.resolve()
    }

    Function("unregisterDevice") { instance: String? ->
      val context = appContext.activityProvider?.currentActivity ?: return@Function
      UnifiedPush.unregister(context, instance ?: INSTANCE_DEFAULT)
    }

    OnCreate {
      runCatching { bindService() }.onFailure { error ->
        Log.e(TAG, "Error binding UnifiedPush service", error)
        sendPushEvent(
          "error",
          bundleOf("message" to error.message, "stackTrace" to error.stackTraceToString()),
        )
      }
    }

    OnDestroy {
      runCatching { unbindService() }.onFailure { error ->
        Log.e(TAG, "Error unbinding UnifiedPush service", error)
      }
    }
  }

  private fun getPackageName(id: String): String? {
    val packageManager = appContext.reactContext?.packageManager ?: return null
    val info = packageManager.getPackageInfo(id, 0).applicationInfo ?: return null
    return packageManager.getApplicationLabel(info).toString()
  }

  private fun getDistributorIcon(distributor: String): String? {
    val icon = appContext.reactContext?.packageManager?.getApplicationIcon(distributor)
    val base64 = drawableToBase64(icon) ?: return null
    return "data:image/png;base64,$base64"
  }

  private fun drawableToBase64(drawable: Drawable?): String? {
    if (drawable == null) return null

    val bitmap: Bitmap = if (drawable is BitmapDrawable) {
      drawable.bitmap
    } else {
      val width = maxOf(1, drawable.intrinsicWidth)
      val height = maxOf(1, drawable.intrinsicHeight)
      val rendered = createBitmap(width, height)
      val canvas = Canvas(rendered)
      drawable.setBounds(0, 0, canvas.width, canvas.height)
      drawable.draw(canvas)
      rendered
    }

    val output = ByteArrayOutputStream()
    bitmap.compress(Bitmap.CompressFormat.PNG, 100, output)
    return Base64.encodeToString(output.toByteArray(), Base64.NO_WRAP)
  }

  private fun sendPushEvent(action: String, data: android.os.Bundle) {
    sendEvent("message", bundleOf("action" to action, "data" to data))
  }

  private fun bindService() {
    val context = appContext.activityProvider?.currentActivity ?: return
    if (service != null) return
    context.bindService(
      Intent(context, PaseoUnifiedPushService::class.java),
      connection,
      Context.BIND_AUTO_CREATE,
    )
  }

  private fun unbindService() {
    val context = appContext.activityProvider?.currentActivity ?: return
    if (service == null) return
    context.unbindService(connection)
    service = null
  }

  private var service: PaseoUnifiedPushService? = null

  private val connection = object : ServiceConnection {
    override fun onServiceConnected(className: ComponentName, binder: IBinder) {
      val boundService = (binder as PushService.PushBinder).getService() as PaseoUnifiedPushService
      boundService.setEventSink(::sendPushEvent)
      service = boundService
    }

    override fun onServiceDisconnected(className: ComponentName) {
      service?.setEventSink(null)
      service = null
    }
  }

  private companion object {
    private const val TAG = "PaseoUnifiedPush"
  }
}
