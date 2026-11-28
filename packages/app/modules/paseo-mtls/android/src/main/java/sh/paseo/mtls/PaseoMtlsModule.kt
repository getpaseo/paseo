package sh.paseo.mtls

import android.security.KeyChain
import expo.modules.kotlin.Promise
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.util.concurrent.Executors
import java.util.concurrent.atomic.AtomicBoolean
import java.io.File
import android.net.Uri

class PaseoMtlsModule : Module() {
  private val choosing = AtomicBoolean(false)
  private val validation = Executors.newSingleThreadExecutor()

  override fun definition() = ModuleDefinition {
    Name("PaseoMtls")
    Events("downloadProgress")

    AsyncFunction("download") { url: String, destination: String, headers: Map<String, String>, id: String ->
      val context = requireNotNull(appContext.reactContext)
      val uri = Uri.parse(destination)
      require(uri.scheme == "file") { "Download destination must be a local file" }
      val file = File(requireNotNull(uri.path)).canonicalFile
      require(file.toPath().startsWith(context.cacheDir.canonicalFile.toPath()) ||
        file.toPath().startsWith(context.filesDir.canonicalFile.toPath())) { "Download destination must be private app storage" }
      downloadWithCertificate(PaseoMtls.client(), url, file, headers) { written, total ->
        sendEvent("downloadProgress", mapOf("id" to id, "totalBytesWritten" to written, "totalBytesExpectedToWrite" to total))
      }
      destination
    }

    Function("selected") { host: String, port: Int ->
      PaseoMtls.selected(CertificateOrigin.of(host, port))
    }

    AsyncFunction("requiresCertificate") { host: String, port: Int ->
      requiresClientCertificate(PaseoMtls.client(), CertificateOrigin.of(host, port))
    }

    AsyncFunction("remove") { host: String, port: Int ->
      PaseoMtls.select(CertificateOrigin.of(host, port), null)
    }

    AsyncFunction("choose") { host: String, port: Int, promise: Promise ->
      val origin = CertificateOrigin.of(host, port)
      val activity = appContext.currentActivity
      if (activity == null || !choosing.compareAndSet(false, true)) {
        promise.reject("ERR_CLIENT_CERTIFICATE", "Certificate selection is unavailable. Try again.", null)
      } else {
        activity.runOnUiThread {
          try {
            KeyChain.choosePrivateKeyAlias(activity, { alias ->
              try {
                validation.execute {
                  try {
                    if (alias != null) {
                      PaseoMtls.load(alias)
                      PaseoMtls.select(origin, alias)
                    }
                    promise.resolve(alias)
                  } catch (failure: Exception) {
                    promise.reject("ERR_CLIENT_CERTIFICATE", "Unable to use this certificate. Check that it is valid and try again.", failure)
                  } finally {
                    choosing.set(false)
                  }
                }
              } catch (failure: java.util.concurrent.RejectedExecutionException) {
                choosing.set(false)
                promise.reject("ERR_CLIENT_CERTIFICATE", "Certificate selection was interrupted. Try again.", failure)
              }
            }, arrayOf("RSA", "EC"), null, origin.host, origin.port, PaseoMtls.selected(origin))
          } catch (failure: Exception) {
            choosing.set(false)
            promise.reject("ERR_CLIENT_CERTIFICATE", "Could not open Android certificate selection.", failure)
          }
        }
      }
    }

    OnDestroy { validation.shutdown() }
  }
}
