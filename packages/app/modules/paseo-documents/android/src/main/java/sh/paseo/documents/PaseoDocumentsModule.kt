package sh.paseo.documents

import android.app.Activity
import android.content.ClipData
import android.content.Context
import android.content.Intent
import android.net.Uri
import androidx.core.content.FileProvider
import expo.modules.kotlin.activityresult.AppContextActivityResultContract
import expo.modules.kotlin.activityresult.AppContextActivityResultLauncher
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.functions.Coroutine
import expo.modules.kotlin.modules.ModuleDefinition
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.withContext
import java.io.File
import java.io.Serializable

internal data class SaveOptions(val name: String, val mime: String) : Serializable
internal class SaveContract : AppContextActivityResultContract<SaveOptions, String?> {
  override fun createIntent(context: Context, input: SaveOptions) = Intent(Intent.ACTION_CREATE_DOCUMENT).apply {
    addCategory(Intent.CATEGORY_OPENABLE)
    type = input.mime
    putExtra(Intent.EXTRA_TITLE, input.name)
  }
  override fun parseResult(input: SaveOptions, resultCode: Int, intent: Intent?): String? =
    if (resultCode == Activity.RESULT_OK) intent?.data?.toString() else null
}

class PaseoDocumentsModule : Module() {
  private lateinit var saveLauncher: AppContextActivityResultLauncher<SaveOptions, String?>
  private val context: Context get() = requireNotNull(appContext.reactContext)

  private fun cacheFile(uri: String): File {
    val parsed = Uri.parse(uri)
    require(parsed.scheme == "file") { "A local cached document is required" }
    val file = File(requireNotNull(parsed.path)).canonicalFile
    val root = File(context.cacheDir, "paseo-documents").canonicalFile
    require(file.path.startsWith(root.path + File.separator) && file.isFile) { "Document is outside the application cache" }
    return file
  }

  override fun definition() = ModuleDefinition {
    Name("PaseoDocuments")
    RegisterActivityContracts {
      saveLauncher = registerForActivityResult(SaveContract()) { _, _ -> }
    }
    AsyncFunction("open") { source: String, mime: String ->
      val file = cacheFile(source)
      require(file.extension.lowercase() !in setOf("apk", "dex", "sh", "exe")) { "Save this file without executing it" }
      val uri = FileProvider.getUriForFile(context, context.packageName + ".enhancedfiles", file)
      val view = Intent(Intent.ACTION_VIEW).apply {
        setDataAndType(uri, mime)
        clipData = ClipData.newRawUri(file.name, uri)
        addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION)
      }
      val chooser = Intent.createChooser(view, null).apply { addFlags(Intent.FLAG_ACTIVITY_NEW_TASK) }
      context.startActivity(chooser)
    }
    AsyncFunction("save") Coroutine { source: String, name: String, mime: String ->
      val file = cacheFile(source)
      val destination = saveLauncher.launch(SaveOptions(name, mime)) ?: return@Coroutine false
      withContext(Dispatchers.IO) {
        val output = requireNotNull(context.contentResolver.openOutputStream(Uri.parse(destination))) { "Cannot write the selected destination" }
        output.use { sink -> file.inputStream().use { it.copyTo(sink) } }
      }
      true
    }
  }
}
