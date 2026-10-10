package sh.paseo.ssh

import net.schmizz.sshj.SSHClient
import net.schmizz.sshj.connection.channel.direct.DirectConnection
import java.net.InetAddress
import java.net.Socket
import java.net.SocketAddress
import javax.net.SocketFactory

/** Give OkHttp a direct SSH channel without exposing the authenticated daemon on a phone TCP port. */
internal class SshChannelSocket(private val ssh: SSHClient, private val daemonPort: Int) : Socket() {
  private var channel: DirectConnection? = null
  @Volatile private var disposed = false

  override fun connect(endpoint: SocketAddress?, timeout: Int) {
    check(!disposed) { "SSH channel is closed." }
    val opened = ssh.newDirectConnection("127.0.0.1", daemonPort)
    synchronized(this) {
      if (disposed) { opened.close(); error("SSH channel is closed.") }
      channel = opened
    }
  }
  override fun connect(endpoint: SocketAddress?) = connect(endpoint, 0)
  override fun getInputStream() = requireNotNull(channel).inputStream
  override fun getOutputStream(): java.io.OutputStream {
    val output = requireNotNull(channel).outputStream
    // WebSocket frames emit to a socket without flushing it. SSHJ buffers small writes,
    // so each socket write must flush the channel to preserve ordinary TCP semantics.
    return SshWriteThroughOutputStream(output)
  }
  override fun isConnected() = channel != null && !disposed
  override fun isClosed() = disposed
  override fun getInetAddress(): InetAddress = InetAddress.getByName("127.0.0.1")
  override fun getPort() = daemonPort
  override fun getLocalPort() = 0
  // SSH owns the network socket and timeouts. OkHttp must not configure an unrelated OS socket.
  override fun setSoTimeout(timeout: Int) {}
  override fun getSoTimeout() = 0
  override fun setTcpNoDelay(enabled: Boolean) {}
  @Synchronized override fun close() {
    disposed = true
    channel?.close()
    channel = null
  }
}

/** OkHttp creates an unconnected socket, then opens its route through connect(). */
internal class SshChannelSocketFactory(private val ssh: SSHClient, private val daemonPort: Int) : SocketFactory() {
  override fun createSocket() = SshChannelSocket(ssh, daemonPort)
  override fun createSocket(host: String, port: Int): Socket = error("Use an unconnected SSH channel socket.")
  override fun createSocket(host: String, port: Int, localHost: InetAddress, localPort: Int): Socket = error("Use an unconnected SSH channel socket.")
  override fun createSocket(host: InetAddress, port: Int): Socket = error("Use an unconnected SSH channel socket.")
  override fun createSocket(host: InetAddress, port: Int, localHost: InetAddress, localPort: Int): Socket = error("Use an unconnected SSH channel socket.")
}

/** Socket writes must reach the remote reader even when the caller only emits, rather than flushes, a frame. */
internal class SshWriteThroughOutputStream(private val output: java.io.OutputStream) : java.io.OutputStream() {
  override fun write(value: Int) {
    output.write(value)
    output.flush()
  }
  override fun write(bytes: ByteArray, offset: Int, length: Int) {
    output.write(bytes, offset, length)
    output.flush()
  }
  override fun flush() = output.flush()
  override fun close() = output.close()
}
