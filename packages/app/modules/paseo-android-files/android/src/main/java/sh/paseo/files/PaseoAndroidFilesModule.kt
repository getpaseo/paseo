package sh.paseo.files

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.content.ActivityNotFoundException
import android.content.ContentUris
import android.content.ContentValues
import android.content.Intent
import android.net.Uri
import android.provider.MediaStore
import android.webkit.MimeTypeMap
import expo.modules.kotlin.exception.CodedException
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.io.File

private const val GENERIC_MIME_TYPE = "application/octet-stream"
private const val DOWNLOADS_CHANNEL_ID = "downloads"

class PaseoAndroidFilesModule : Module() {
  private val context
    get() = requireNotNull(appContext.reactContext) { "React context is not available" }

  override fun definition() = ModuleDefinition {
    Name("PaseoAndroidFiles")

    // DownloadManager can only fetch a URL, and relay/SSH hosts deliver files over the session
    // socket, so every download lands in the app cache first and is moved into Downloads here.
    // MediaStore picks a free name ("report (1).pdf") and needs no storage permission from API 29.
    AsyncFunction("moveToDownloads") { sourceUri: String, displayName: String, mimeType: String? ->
      val source = File(requireNotNull(Uri.parse(sourceUri).path) { "Not a file URI: $sourceUri" })
      val resolver = context.contentResolver
      val pending = ContentValues().apply {
        put(MediaStore.MediaColumns.DISPLAY_NAME, displayName)
        put(MediaStore.MediaColumns.MIME_TYPE, resolveMimeType(displayName, mimeType))
        put(MediaStore.MediaColumns.IS_PENDING, 1)
      }
      val target = resolver.insert(MediaStore.Downloads.EXTERNAL_CONTENT_URI, pending)
        ?: throw CodedException("ERR_DOWNLOADS_INSERT", "MediaStore refused $displayName", null)
      try {
        val output = requireNotNull(resolver.openOutputStream(target)) { "No output stream for $target" }
        source.inputStream().use { input -> output.use { input.copyTo(it) } }
      } catch (error: Exception) {
        resolver.delete(target, null, null)
        throw error
      }
      resolver.update(target, ContentValues().apply { put(MediaStore.MediaColumns.IS_PENDING, 0) }, null, null)
      source.delete()
      target.toString()
    }

    // Stands in for the notification DownloadManager would have posted. Skipped when the user
    // has turned notifications off: the in-app toast already confirmed the download.
    AsyncFunction("notifyDownloaded") { contentUri: String, channelName: String, message: String ->
      val manager = context.getSystemService(NotificationManager::class.java)
      if (!manager.areNotificationsEnabled()) return@AsyncFunction
      val uri = Uri.parse(contentUri)
      val (displayName, mimeType) = queryNameAndType(uri)
      manager.createNotificationChannel(
        NotificationChannel(DOWNLOADS_CHANNEL_ID, channelName, NotificationManager.IMPORTANCE_LOW),
      )
      val id = ContentUris.parseId(uri).toInt()
      val view = viewIntent(uri, resolveMimeType(displayName, mimeType))
        .addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
      val open = PendingIntent.getActivity(context, id, view, PendingIntent.FLAG_IMMUTABLE)
      val notification = Notification.Builder(context, DOWNLOADS_CHANNEL_ID)
        .setSmallIcon(android.R.drawable.stat_sys_download_done)
        .setContentTitle(displayName)
        .setContentText(message)
        .setContentIntent(open)
        .setAutoCancel(true)
        .build()
      manager.notify(DOWNLOADS_CHANNEL_ID, id, notification)
    }

    AsyncFunction("openWith") { contentUri: String, fileName: String, mimeType: String? ->
      val activity = appContext.currentActivity
      val intent = viewIntent(Uri.parse(contentUri), resolveMimeType(fileName, mimeType))
      if (activity == null) intent.addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
      try {
        (activity ?: context).startActivity(intent)
      } catch (error: ActivityNotFoundException) {
        throw CodedException("ERR_NO_FILE_HANDLER", "No activity handles $fileName", error)
      }
    }
  }

  // MediaStore may have renamed the file ("report (1).pdf"); show the name it actually has.
  private fun queryNameAndType(uri: Uri): Pair<String, String?> {
    val columns = arrayOf(MediaStore.MediaColumns.DISPLAY_NAME, MediaStore.MediaColumns.MIME_TYPE)
    context.contentResolver.query(uri, columns, null, null, null)?.use { cursor ->
      if (cursor.moveToFirst()) return cursor.getString(0) to cursor.getString(1)
    }
    throw CodedException("ERR_DOWNLOAD_MISSING", "No MediaStore row for $uri", null)
  }
}

private fun viewIntent(uri: Uri, mimeType: String): Intent =
  Intent(Intent.ACTION_VIEW)
    .setDataAndType(uri, mimeType)
    .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)

// The daemon reports application/octet-stream for extensions it doesn't know. Android's table
// is larger, and a generic type would leave viewers unmatched and Downloads without an icon.
private fun resolveMimeType(fileName: String, reported: String?): String {
  if (reported != null && reported != GENERIC_MIME_TYPE) return reported
  val extension = fileName.substringAfterLast('.', "").lowercase()
  return MimeTypeMap.getSingleton().getMimeTypeFromExtension(extension) ?: GENERIC_MIME_TYPE
}
