package sh.paseo.mtls

import java.io.File
import java.io.IOException
import java.nio.file.Files
import java.nio.file.StandardCopyOption
import okhttp3.OkHttpClient
import okhttp3.Request

fun downloadWithCertificate(
  client: OkHttpClient,
  url: String,
  destination: File,
  headers: Map<String, String>,
  progress: (Long, Long) -> Unit,
) {
  val request = Request.Builder().url(url).apply {
    require(url.startsWith("https://")) { "Client certificates require HTTPS" }
    headers.forEach { (name, value) -> header(name, value) }
  }.build()
  val temporary = File.createTempFile("paseo-download-", ".part", destination.parentFile)
  try {
    client.newCall(request).execute().use { response ->
      if (!response.isSuccessful) throw IOException("Download failed (HTTP ${response.code})")
      val body = response.body ?: throw IOException("Download response is empty")
      val total = body.contentLength()
      var written = 0L
      var lastProgress = 0L
      body.byteStream().use { input ->
        temporary.outputStream().use { output ->
          val bytes = ByteArray(64 * 1024)
          while (true) {
            val count = input.read(bytes)
            if (count == -1) break
            output.write(bytes, 0, count)
            written += count
            val now = System.nanoTime()
            if (now - lastProgress >= 100_000_000) {
              progress(written, total)
              lastProgress = now
            }
          }
        }
      }
      if (total >= 0 && written != total) throw IOException("File transfer is incomplete")
      Files.move(temporary.toPath(), destination.toPath(), StandardCopyOption.ATOMIC_MOVE, StandardCopyOption.REPLACE_EXISTING)
      progress(written, total)
    }
  } finally {
    temporary.delete()
  }
}
