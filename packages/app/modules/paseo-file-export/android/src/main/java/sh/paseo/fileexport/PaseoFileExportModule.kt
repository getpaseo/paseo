package sh.paseo.fileexport

import android.app.Activity
import android.content.Context
import android.content.Intent
import android.net.Uri
import android.provider.DocumentsContract
import expo.modules.kotlin.activityresult.AppContextActivityResultContract
import expo.modules.kotlin.activityresult.AppContextActivityResultLauncher
import expo.modules.kotlin.exception.CodedException
import expo.modules.kotlin.exception.Exceptions
import expo.modules.kotlin.functions.Coroutine
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.sync.Mutex
import kotlinx.coroutines.withContext
import java.io.File
import java.io.IOException
import java.io.Serializable

private data class CreateDocumentOptions(val fileName: String, val mimeType: String) : Serializable
private data class CreateDocumentResult(val resultCode: Int, val uri: Uri?)

private class CreateDocumentContract : AppContextActivityResultContract<CreateDocumentOptions, CreateDocumentResult> {
  override fun createIntent(context: Context, input: CreateDocumentOptions) =
    Intent(Intent.ACTION_CREATE_DOCUMENT).apply {
      addCategory(Intent.CATEGORY_OPENABLE)
      type = input.mimeType
      putExtra(Intent.EXTRA_TITLE, input.fileName)
    }

  override fun parseResult(input: CreateDocumentOptions, resultCode: Int, intent: Intent?) =
    CreateDocumentResult(resultCode, intent?.data)
}

class PaseoFileExportModule : Module() {
  private lateinit var createDocument: AppContextActivityResultLauncher<CreateDocumentOptions, CreateDocumentResult>
  private val saving = Mutex()

  override fun definition() = ModuleDefinition {
    Name("PaseoFileExport")

    RegisterActivityContracts {
      createDocument = registerForActivityResult(CreateDocumentContract()) { _, _ -> }
    }

    AsyncFunction("saveFileAsync") Coroutine { uri: String, fileName: String, mimeType: String ->
      if (!saving.tryLock()) {
        throw CodedException("A file save is already in progress.")
      }
      try {
        val context = appContext.reactContext ?: throw Exceptions.ReactContextLost()
        val sourceUri = Uri.parse(uri)
        require(sourceUri.scheme == "file") { "Only downloaded local files can be saved." }
        val source = File(requireNotNull(sourceUri.path)).canonicalFile
        val isPrivateFile = source.toPath().startsWith(context.cacheDir.canonicalFile.toPath()) ||
          source.toPath().startsWith(context.filesDir.canonicalFile.toPath())
        require(isPrivateFile && source.isFile) { "The download is not an app-owned file." }

        val result = createDocument.launch(CreateDocumentOptions(fileName, mimeType))
        if (result.resultCode != Activity.RESULT_OK) return@Coroutine false
        val destination = result.uri ?: throw IOException("The save picker returned no destination.")
        // Stream on the IO dispatcher: direct downloads can be much larger than the JS heap.
        withContext(Dispatchers.IO) {
          try {
            source.inputStream().use { input ->
              val output = context.contentResolver.openOutputStream(destination, "w")
                ?: throw IOException("Could not open the selected destination.")
              output.use { input.copyTo(it) }
            }
          } catch (error: Exception) {
            try {
              DocumentsContract.deleteDocument(context.contentResolver, destination)
            } catch (cleanupError: Exception) {
              error.addSuppressed(cleanupError)
            }
            throw error
          }
        }
        true
      } finally {
        saving.unlock()
      }
    }
  }
}
