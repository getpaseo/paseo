package sh.paseo.mtls

import java.io.IOException
import java.util.concurrent.TimeUnit
import javax.net.ssl.SSLException
import okhttp3.OkHttpClient
import okhttp3.Request

/** Check TLS using normal trust and origin-scoped identities, without following redirects. */
fun requiresClientCertificate(client: OkHttpClient, origin: CertificateOrigin): Boolean {
  val probe = client.newBuilder().followRedirects(false).followSslRedirects(false)
    .callTimeout(5, TimeUnit.SECONDS).build()
  try {
    probe.newCall(Request.Builder().url(origin.storageKey).head().build()).execute().use { return false }
  } catch (failure: IOException) {
    // Offline hosts and server-trust errors keep the normal connection error path.
    // Only a TLS request for a missing identity should open the Android picker.
    return isMissingClientCertificate(failure)
  }
}

internal fun isMissingClientCertificate(failure: IOException): Boolean =
  generateSequence<Throwable>(failure) { it.cause }.any {
      val message = it.message.orEmpty().lowercase()
      it is SSLException && (message.contains("certificate_required") || message.contains("certificate required"))
  }
