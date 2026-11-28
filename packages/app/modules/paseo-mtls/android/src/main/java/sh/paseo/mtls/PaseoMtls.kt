package sh.paseo.mtls

import android.content.Context
import android.security.KeyChain
import com.facebook.react.modules.network.NetworkingModule
import com.facebook.react.modules.websocket.WebSocketModule
import java.security.KeyStore
import java.security.cert.X509Certificate
import javax.net.ssl.SSLContext
import javax.net.ssl.TrustManagerFactory
import javax.net.ssl.X509TrustManager
import okhttp3.ConnectionPool
import okhttp3.HttpUrl.Companion.toHttpUrl
import okhttp3.OkHttpClient
import okhttp3.Protocol

object PaseoMtls {
  private lateinit var context: Context
  private val loader = BoundedIdentityLoader()
  private val preferences get() = context.getSharedPreferences("paseo-client-certificates", Context.MODE_PRIVATE)
  private data class Transport(val context: SSLContext, val trust: X509TrustManager, val pool: ConnectionPool, val hasIdentities: Boolean)
  @Volatile private var transport: Transport? = null

  @Synchronized fun install(application: Context) {
    if (::context.isInitialized) return
    context = application.applicationContext
    NetworkingModule.setCustomClientBuilder { configure(it) }
    WebSocketModule.setCustomClientBuilder { configure(it) }
  }

  fun selected(origin: CertificateOrigin): String? = preferences.getString(origin.storageKey, null)

  fun load(alias: String): ClientIdentity = loader.load {
    val key = KeyChain.getPrivateKey(context, alias) ?: error("Client certificate key is unavailable")
    val chain = KeyChain.getCertificateChain(context, alias) ?: error("Client certificate chain is unavailable")
    require(chain.isNotEmpty()) { "Client certificate chain is empty" }
    chain.forEach(X509Certificate::checkValidity)
    ClientIdentity(alias, key, chain)
  }

  @Synchronized fun select(origin: CertificateOrigin, alias: String?) {
    val edit = preferences.edit()
    if (alias == null) edit.remove(origin.storageKey) else edit.putString(origin.storageKey, alias)
    check(edit.commit()) { "Could not save the client certificate selection" }
    transport?.pool?.evictAll()
    transport = null
  }

  @Synchronized private fun configure(builder: OkHttpClient.Builder) {
    val state = transport ?: run {
      val aliases = preferences.all.map { (key, value) ->
        val url = key.toHttpUrl()
        CertificateOrigin.of(url.host, url.port) to value as String
      }.toMap()
      val trust = TrustManagerFactory.getInstance(TrustManagerFactory.getDefaultAlgorithm()).apply {
        init(null as KeyStore?)
      }.trustManagers.filterIsInstance<X509TrustManager>().single()
      val ssl = SSLContext.getInstance("TLS").apply {
        init(arrayOf(OriginKeyManager(aliases, ::load)), arrayOf(trust), null)
      }
      Transport(ssl, trust, ConnectionPool(), aliases.isNotEmpty()).also { transport = it }
    }
    // Both RN transports share this generation, including its isolated session cache and pool.
    builder.sslSocketFactory(state.context.socketFactory, state.trust).connectionPool(state.pool)
    // HTTP/2 coalescing could reuse an authenticated socket for a different SAN hostname.
    if (state.hasIdentities) builder.protocols(listOf(Protocol.HTTP_1_1))
  }

  fun client(): OkHttpClient = OkHttpClient.Builder().also(::configure)
    .followRedirects(false).followSslRedirects(false).build()
}
