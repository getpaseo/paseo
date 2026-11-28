package sh.paseo.mtls

import java.io.Closeable
import java.io.IOException
import java.net.Socket
import java.security.Principal
import java.security.PrivateKey
import java.security.cert.X509Certificate
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.SynchronousQueue
import java.util.concurrent.ThreadPoolExecutor
import java.util.concurrent.TimeUnit
import javax.net.ssl.SSLEngine
import javax.net.ssl.SSLSocket
import javax.net.ssl.X509ExtendedKeyManager
import okhttp3.HttpUrl

@ConsistentCopyVisibility
data class CertificateOrigin private constructor(val host: String, val port: Int) {
  val storageKey: String get() = HttpUrl.Builder().scheme("https").host(host).port(port).build().toString()

  companion object {
    fun of(host: String, port: Int): CertificateOrigin {
      val url = HttpUrl.Builder().scheme("https").host(host).port(port).build()
      return CertificateOrigin(url.host, url.port)
    }
  }
}

data class ClientIdentity(val alias: String, val key: PrivateKey, val chain: Array<X509Certificate>) {
  fun accepts(types: Array<out String>?, issuers: Array<out Principal>?): Boolean =
    types.orEmpty().any { key.algorithm.equals(it.substringBefore('_'), ignoreCase = true) } &&
      (issuers.isNullOrEmpty() || chain.any { certificate -> issuers.any { it == certificate.issuerX500Principal } })
}

/** A blocked KeyChain binder must not freeze startup or exhaust unbounded worker threads. */
class BoundedIdentityLoader(private val timeoutMillis: Long = 3000) : Closeable {
  private val workers = ThreadPoolExecutor(0, 2, 30, TimeUnit.SECONDS, SynchronousQueue<Runnable>())

  fun <T> load(read: () -> T): T {
    val future = try { workers.submit<T> { read() } } catch (failure: Exception) {
      throw IOException("Client certificate storage is busy. Try again.", failure)
    }
    try {
      return future.get(timeoutMillis, TimeUnit.MILLISECONDS)
    } catch (failure: Exception) {
      future.cancel(true)
      if (failure is InterruptedException) Thread.currentThread().interrupt()
      throw IOException("Client certificate is unavailable. Select it again in connection settings.", failure)
    }
  }

  override fun close() { workers.shutdownNow() }
}

/** The TLS peer, rather than the requesting JS caller, decides which identity may be used. */
class OriginKeyManager(
  private val aliases: Map<CertificateOrigin, String>,
  private val load: (String) -> ClientIdentity,
) : X509ExtendedKeyManager() {
  private val identities = ConcurrentHashMap<String, ClientIdentity>()

  private fun choose(host: String?, port: Int, types: Array<out String>?, issuers: Array<out Principal>?): String? {
    if (host == null || port !in 1..65535) return null
    val origin = CertificateOrigin.of(host, port)
    val alias = aliases[origin] ?: return null
    val identity = load(alias)
    if (!identity.accepts(types, issuers)) return null
    return origin.storageKey.also { identities[it] = identity }
  }

  override fun chooseClientAlias(types: Array<out String>?, issuers: Array<out Principal>?, socket: Socket?): String? {
    val session = (socket as? SSLSocket)?.handshakeSession ?: return null
    return choose(session.peerHost, session.peerPort, types, issuers)
  }

  override fun chooseEngineClientAlias(types: Array<out String>?, issuers: Array<out Principal>?, engine: SSLEngine?): String? =
    choose(engine?.peerHost, engine?.peerPort ?: -1, types, issuers)

  // An alias must never be enumerated without the TLS peer's host and port.
  override fun getClientAliases(type: String?, issuers: Array<out Principal>?): Array<String>? = null
  override fun getCertificateChain(alias: String?): Array<X509Certificate>? = alias?.let { identities[it]?.chain?.clone() }
  override fun getPrivateKey(alias: String?): PrivateKey? = alias?.let { identities[it]?.key }
  override fun getServerAliases(type: String?, issuers: Array<out Principal>?): Array<String>? = null
  override fun chooseServerAlias(type: String?, issuers: Array<out Principal>?, socket: Socket?): String? = null
}
