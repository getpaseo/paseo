package sh.paseo.unifiedpush

import android.Manifest
import android.app.NotificationChannel
import android.app.PendingIntent
import android.content.Intent
import android.content.pm.PackageManager
import android.os.Build
import android.os.Bundle
import android.util.Log
import androidx.core.app.NotificationCompat
import androidx.core.app.NotificationManagerCompat
import androidx.core.net.toUri
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.intOrNull
import kotlinx.serialization.json.jsonObject
import kotlinx.serialization.json.jsonPrimitive
import org.unifiedpush.android.connector.FailedReason
import org.unifiedpush.android.connector.PushService
import org.unifiedpush.android.connector.data.PushEndpoint
import org.unifiedpush.android.connector.data.PushMessage

class PaseoUnifiedPushService : PushService() {
  private var eventSink: ((String, Bundle) -> Unit)? = null

  fun setEventSink(sink: ((String, Bundle) -> Unit)?) {
    eventSink = sink
  }

  override fun onMessage(message: PushMessage, instance: String) {
    val content = if (message.decrypted) String(message.content) else null
    val data = Bundle().apply {
      if (content == null) {
        putByteArray("message", message.content)
      } else {
        putString("message", content)
      }
      putBoolean("decrypted", message.decrypted)
      putString("instance", instance)
    }

    sendPushEvent("message", data)

    if (content != null) {
      showNotification(content)
    }
  }

  override fun onNewEndpoint(endpoint: PushEndpoint, instance: String) {
    val data = Bundle().apply {
      putString("url", endpoint.url)
      putString("pubKey", endpoint.pubKeySet?.pubKey)
      putString("auth", endpoint.pubKeySet?.auth)
      putString("instance", instance)
    }
    sendPushEvent("registered", data)
  }

  override fun onRegistrationFailed(reason: FailedReason, instance: String) {
    val data = Bundle().apply {
      putString("reason", reason.name)
      putString("instance", instance)
    }
    sendPushEvent("registrationFailed", data)
  }

  override fun onUnregistered(instance: String) {
    val data = Bundle().apply {
      putString("instance", instance)
    }
    sendPushEvent("unregistered", data)
  }

  private fun sendPushEvent(action: String, data: Bundle) {
    eventSink?.invoke(action, data)
  }

  private fun showNotification(message: String) {
    if (!canPostNotifications()) return

    val payload = runCatching {
      Json.parseToJsonElement(message).jsonObject
    }.onFailure { error ->
      Log.e(TAG, "Error parsing UnifiedPush notification payload", error)
      sendPushEvent(
        "error",
        Bundle().apply {
          putString("message", error.message)
          putString("stackTrace", error.stackTraceToString())
        },
      )
    }.getOrNull() ?: return

    val id = payload["id"]?.jsonPrimitive?.intOrNull ?: System.currentTimeMillis().toInt()
    val url = payload["url"]?.jsonPrimitive?.content
    val title = payload["title"]?.jsonPrimitive?.content ?: getAppName()
    val body = payload["body"]?.jsonPrimitive?.content
    val count = payload["number"]?.jsonPrimitive?.intOrNull
    val silent = payload["silent"]?.jsonPrimitive?.booleanOrNull

    createNotificationChannel()

    val notification = NotificationCompat.Builder(this, CHANNEL_ID)
      .setSmallIcon(android.R.drawable.sym_action_chat)
      .setContentTitle(title)
      .setContentText(body)
      .setStyle(NotificationCompat.BigTextStyle().bigText(body))
      .setContentIntent(getOpenIntent(url))
      .setAutoCancel(true)
      .setPriority(NotificationCompat.PRIORITY_DEFAULT)

    if (count != null) {
      notification.setNumber(count)
    }
    if (silent != null) {
      notification.setSilent(silent)
    }

    NotificationManagerCompat.from(this).notify(id, notification.build())
  }

  private fun canPostNotifications(): Boolean {
    return Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU ||
      checkSelfPermission(Manifest.permission.POST_NOTIFICATIONS) == PackageManager.PERMISSION_GRANTED
  }

  private fun createNotificationChannel() {
    if (Build.VERSION.SDK_INT < Build.VERSION_CODES.O) return

    val appName = getAppName()
    val channel = NotificationChannel(
      CHANNEL_ID,
      "$appName notifications",
      android.app.NotificationManager.IMPORTANCE_DEFAULT,
    ).apply {
      description = "$appName push notifications"
    }
    NotificationManagerCompat.from(this).createNotificationChannel(channel)
  }

  private fun getOpenIntent(url: String?): PendingIntent {
    val intent = if (url == null) {
      packageManager.getLaunchIntentForPackage(packageName)
    } else {
      Intent(Intent.ACTION_VIEW, url.toUri().normalizeScheme())
    } ?: Intent()

    intent.flags = Intent.FLAG_ACTIVITY_NEW_TASK or Intent.FLAG_ACTIVITY_CLEAR_TASK
    return PendingIntent.getActivity(this, 0, intent, PendingIntent.FLAG_IMMUTABLE)
  }

  private fun getAppName(): String {
    val info = applicationInfo
    return packageManager.getApplicationLabel(info).toString()
  }

  private companion object {
    private const val TAG = "PaseoUnifiedPush"
    private const val CHANNEL_ID = "paseo_unified_push"
  }
}
