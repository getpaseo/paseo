package sh.paseo.ssh

import okhttp3.OkHttpClient
import okhttp3.Request
import okhttp3.Response
import okhttp3.WebSocket
import okhttp3.WebSocketListener
import okio.ByteString
import okio.ByteString.Companion.decodeBase64
import org.json.JSONObject
import java.util.concurrent.TimeUnit

/** Owns one tunnel and WebSocket. Closing during setup prevents late resources from escaping. */
internal class SshSession(
  private val id: String,
  private val target: SshTarget,
  private val credentials: JSONObject,
  private val emit: (Map<String, Any?>) -> Unit,
  private val onClosed: () -> Unit,
) {
  private val ssh = createSshClient()
  private val http = OkHttpClient.Builder().connectTimeout(10, TimeUnit.SECONDS)
    .readTimeout(0, TimeUnit.MILLISECONDS).pingInterval(20, TimeUnit.SECONDS)
    .proxy(java.net.Proxy.NO_PROXY).socketFactory(SshChannelSocketFactory(ssh, target.daemonPort)).build()
  private var socket: WebSocket? = null
  @Volatile private var closed = false
  @Volatile private var fingerprintChanged = false

  fun open() {
    try {
      ssh.addHostKeyVerifier(verifier { actual ->
        if (actual != credentials.getString("fingerprint")) {
          fingerprintChanged = true
          return@verifier false
        }
        true
      })
      if (closed) return
      // SSHJ starts its keepalive thread during connect, only when the interval is already set.
      ssh.connection.keepAlive.keepAliveInterval = 15
      ssh.connect(target.hostname, target.sshPort)
      if (closed) return
      ssh.authPublickey(target.username, loadPrivateKey(ssh, credentials))

      synchronized(this) {
        if (closed) return
        socket = http.newWebSocket(Request.Builder().url("http://127.0.0.1:${target.daemonPort}/ws").build(), object : WebSocketListener() {
          override fun onOpen(webSocket: WebSocket, response: Response) { event("open") }
          override fun onMessage(webSocket: WebSocket, text: String) { event("message", mapOf("text" to text)) }
          override fun onMessage(webSocket: WebSocket, bytes: ByteString) { event("message", mapOf("binaryBase64" to bytes.base64())) }
          override fun onClosing(webSocket: WebSocket, code: Int, reason: String) {
            webSocket.close(code, reason)
          }
          override fun onClosed(webSocket: WebSocket, code: Int, reason: String) { finish(code, reason) }
          override fun onFailure(webSocket: WebSocket, error: Throwable, response: Response?) { fail("Unable to connect to the remote Paseo daemon.") }
        })
      }
    } catch (error: Exception) {
      // Library exceptions can contain key material; emit only a controlled error to JS.
      fail(if (fingerprintChanged) "SSH server fingerprint changed. Remove and re-add the connection after verifying the server."
        else "SSH connection failed. Check the host, private key, passphrase, and remote daemon.")
    } finally {
      if (closed) runCatching { ssh.close() }
    }
  }

  @Synchronized fun send(text: String?, binary: String?) {
    check(!closed) { "SSH connection is closed." }
    val accepted = if (text != null) socket?.send(text) else socket?.send((binary ?: "").decodeBase64() ?: error("Invalid binary message."))
    check(accepted == true) { "Unable to send over SSH." }
  }

  @Synchronized private fun event(kind: String, data: Map<String, Any?> = emptyMap()) {
    if (!closed) emit(mapOf("sessionId" to id, "kind" to kind) + data)
  }

  private fun fail(message: String) {
    event("error", mapOf("error" to message))
    finish(1006, message)
  }

  @Synchronized private fun finish(code: Int, reason: String) {
    if (closed) return
    event("close", mapOf("code" to code, "reason" to reason))
    close()
  }

  @Synchronized fun close() {
    if (closed) return
    closed = true
    try {
      // Channel.close waits for the peer. Break transport I/O before cancelling OkHttp's channel.
      runCatching { ssh.socket?.close() }
      runCatching { ssh.close() }
      runCatching { socket?.cancel() }
    } finally {
      http.dispatcher.executorService.shutdown()
      http.connectionPool.evictAll()
      onClosed()
    }
  }
}
