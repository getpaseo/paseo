package sh.paseo.connection

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Intent
import android.os.IBinder

class BackgroundConnectionService : Service() {
  override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
    val manager = getSystemService(NotificationManager::class.java)
    manager.createNotificationChannel(
      NotificationChannel(CHANNEL_ID, getString(R.string.paseo_connection_channel), NotificationManager.IMPORTANCE_LOW)
    )
    val launchIntent = packageManager.getLaunchIntentForPackage(packageName)
    val notification = Notification.Builder(this, CHANNEL_ID)
      .setSmallIcon(android.R.drawable.stat_notify_sync)
      .setContentTitle(applicationInfo.loadLabel(packageManager))
      .setContentText(getString(R.string.paseo_connection_notification))
      .setOngoing(true)
      .setOnlyAlertOnce(true)
      .setCategory(Notification.CATEGORY_SERVICE)
    if (launchIntent != null) {
      notification.setContentIntent(
        PendingIntent.getActivity(this, 0, launchIntent, PendingIntent.FLAG_IMMUTABLE or PendingIntent.FLAG_UPDATE_CURRENT)
      )
    }
    startForeground(NOTIFICATION_ID, notification.build())
    running = true
    // A killed process has already lost its sockets. The next app launch owns recovery.
    return START_NOT_STICKY
  }

  override fun onBind(intent: Intent?): IBinder? = null

  override fun onDestroy() {
    running = false
    super.onDestroy()
  }

  companion object {
    @Volatile var running = false
      private set
    private const val CHANNEL_ID = "paseo-server-connection"
    private const val NOTIFICATION_ID = 6767
  }
}
