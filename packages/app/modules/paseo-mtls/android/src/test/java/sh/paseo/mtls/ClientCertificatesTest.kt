package sh.paseo.mtls

import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import javax.net.ssl.SSLContext
import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import okhttp3.mockwebserver.MockResponse
import okhttp3.mockwebserver.MockWebServer
import okhttp3.tls.HandshakeCertificates
import okhttp3.tls.HeldCertificate
import org.junit.Assert.*
import org.junit.Test

class ClientCertificatesTest {
  private val ca = HeldCertificate.Builder().certificateAuthority(1).build()
  private val serverIdentity = HeldCertificate.Builder().commonName("localhost")
    .addSubjectAlternativeName("localhost").signedBy(ca).build()
  private val clientIdentity = HeldCertificate.Builder().commonName("Synthetic Client")
    .signedBy(ca).build()
  private val trust = HandshakeCertificates.Builder().addTrustedCertificate(ca.certificate).build()

  @Test fun `HTTPS presents the identity only to the selected host and port`() {
    val server = MockWebServer()
    val other = MockWebServer()
    val serverTls = HandshakeCertificates.Builder()
      .heldCertificate(serverIdentity, ca.certificate).addTrustedCertificate(ca.certificate).build()
    server.useHttps(serverTls.sslSocketFactory(), false)
    server.requireClientAuth()
    other.useHttps(serverTls.sslSocketFactory(), false)
    other.requestClientAuth()
    server.start()
    other.start()
    try {
      val origin = CertificateOrigin.of("localhost", server.port)
      val manager = OriginKeyManager(mapOf(origin to "selected")) {
        ClientIdentity(it, clientIdentity.keyPair.private, arrayOf(clientIdentity.certificate, ca.certificate))
      }
      val context = SSLContext.getInstance("TLS").apply {
        init(arrayOf(manager), arrayOf(trust.trustManager), null)
      }
      val client = OkHttpClient.Builder().sslSocketFactory(context.socketFactory, trust.trustManager).build()
      server.enqueue(MockResponse().setBody("authenticated"))
      client.newCall(Request.Builder().url(server.url("/")).build()).execute().use {
        assertEquals("authenticated", it.body!!.string())
      }
      assertEquals(clientIdentity.certificate, server.takeRequest().handshake!!.peerCertificates.first())
      val directory = java.nio.file.Files.createTempDirectory("paseo-certificate-download").toFile()
      try {
        val destination = java.io.File(directory, "synthetic-download.bin")
        val bytes = ByteArray(2 * 1024 * 1024) { (it % 251).toByte() }
        server.enqueue(MockResponse().setBody(okio.Buffer().write(bytes)))
        var received = 0L
        downloadWithCertificate(client, server.url("/download").toString(), destination, emptyMap()) { count, _ -> received = count }
        assertArrayEquals(bytes, destination.readBytes())
        assertEquals(bytes.size.toLong(), received)
        assertEquals(1, directory.listFiles()!!.size)
        server.takeRequest()
        server.enqueue(MockResponse().setResponseCode(503))
        assertThrows(java.io.IOException::class.java) {
          downloadWithCertificate(client, server.url("/download").toString(), destination, emptyMap()) { _, _ -> }
        }
        assertArrayEquals(bytes, destination.readBytes())
        assertEquals(1, directory.listFiles()!!.size)
        server.takeRequest()
      } finally {
        directory.deleteRecursively()
      }
      other.enqueue(MockResponse().setBody("ordinary TLS"))
      client.newCall(Request.Builder().url(other.url("/")).build()).execute().use {
        assertEquals("ordinary TLS", it.body!!.string())
      }
      assertEquals(emptyList<java.security.cert.Certificate>(), other.takeRequest().handshake!!.peerCertificates)
      client.connectionPool.evictAll()
      client.dispatcher.executorService.shutdown()
    } finally {
      server.shutdown()
      other.shutdown()
    }
  }

  @Test fun `origin normalization distinguishes ports and rejects invalid input`() {
    assertEquals(CertificateOrigin.of("example.invalid", 443), CertificateOrigin.of("EXAMPLE.INVALID", 443))
    assertNotEquals(CertificateOrigin.of("example.invalid", 443), CertificateOrigin.of("example.invalid", 8444))
    assertThrows(IllegalArgumentException::class.java) { CertificateOrigin.of("example.invalid/path", 443) }
    assertThrows(IllegalArgumentException::class.java) { CertificateOrigin.of("example.invalid", 0) }
  }

  @Test fun `unknown origins never load an identity and a revoked identity fails closed`() {
    val context = SSLContext.getDefault()
    val manager = OriginKeyManager(mapOf(CertificateOrigin.of("example.invalid", 8444) to "revoked")) {
      throw java.io.IOException("Credential was revoked")
    }
    assertNull(manager.chooseEngineClientAlias(arrayOf("EC", "RSA"), null, context.createSSLEngine("other.invalid", 8444)))
    assertNull(manager.chooseEngineClientAlias(arrayOf("EC", "RSA"), null, context.createSSLEngine("example.invalid", 443)))
    assertThrows(java.io.IOException::class.java) {
      manager.chooseEngineClientAlias(arrayOf("EC", "RSA"), null, context.createSSLEngine("example.invalid", 8444))
    }
  }

  @Test fun `WebSockets use client certificates and retain normal server verification`() {
    val server = MockWebServer()
    val serverTls = HandshakeCertificates.Builder()
      .heldCertificate(serverIdentity, ca.certificate).addTrustedCertificate(ca.certificate).build()
    server.useHttps(serverTls.sslSocketFactory(), false)
    server.requireClientAuth()
    server.start()
    val manager = OriginKeyManager(mapOf(CertificateOrigin.of("localhost", server.port) to "selected")) {
      ClientIdentity(it, clientIdentity.keyPair.private, arrayOf(clientIdentity.certificate, ca.certificate))
    }
    val context = SSLContext.getInstance("TLS").apply {
      init(arrayOf(manager), arrayOf(trust.trustManager), null)
    }
    val client = OkHttpClient.Builder().sslSocketFactory(context.socketFactory, trust.trustManager).build()
    try {
      val opened = CountDownLatch(1)
      val failure = java.util.concurrent.atomic.AtomicReference<Throwable?>(null)
      server.enqueue(MockResponse().withWebSocketUpgrade(object : WebSocketListener() {}))
      val socket = client.newWebSocket(Request.Builder().url(server.url("/ws")).build(), object : WebSocketListener() {
        override fun onOpen(webSocket: WebSocket, response: Response) { opened.countDown() }
        override fun onFailure(webSocket: WebSocket, t: Throwable, response: Response?) {
          failure.set(t)
          opened.countDown()
        }
      })
      assertTrue(opened.await(5, TimeUnit.SECONDS))
      assertNull(failure.get())
      assertEquals(clientIdentity.certificate, server.takeRequest().handshake!!.peerCertificates.first())
      socket.cancel()

      // The configured client identity must not make a different server certificate trusted.
      val wrongHost = server.url("/").newBuilder().host("127.0.0.1").build()
      assertThrows(javax.net.ssl.SSLPeerUnverifiedException::class.java) {
        client.newCall(Request.Builder().url(wrongHost).build()).execute().close()
      }
    } finally {
      client.connectionPool.evictAll()
      client.dispatcher.executorService.shutdownNow()
      server.shutdown()
    }
  }

  @Test fun `a stuck identity provider times out without blocking subsequent work`() {
    val release = CountDownLatch(1)
    val calls = BoundedIdentityLoader(timeoutMillis = 100)
    try {
      assertThrows(java.io.IOException::class.java) {
        calls.load {
          release.await(5, TimeUnit.SECONDS)
          error("released")
        }
      }
      assertEquals("ready", calls.load { "ready" })
    } finally {
      release.countDown()
      calls.close()
    }
  }
}
