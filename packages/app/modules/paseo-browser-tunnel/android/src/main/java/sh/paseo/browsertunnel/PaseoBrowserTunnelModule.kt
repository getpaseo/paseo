package sh.paseo.browsertunnel

import android.util.Base64
import expo.modules.kotlin.Promise
import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import java.net.InetAddress
import java.net.InetSocketAddress
import java.net.ServerSocket
import java.net.Socket
import java.util.UUID
import java.util.concurrent.ConcurrentHashMap
import java.util.concurrent.Executors
import java.util.concurrent.Semaphore
import java.util.concurrent.atomic.AtomicBoolean

class PaseoBrowserTunnelModule : Module() {
  private class Write(val promise: Promise) {
    val completed = AtomicBoolean(false)
    fun finish(error: Exception? = null) {
      if (!completed.compareAndSet(false, true)) return
      if (error == null) promise.resolve()
      else promise.reject("ERR_BROWSER_TUNNEL", error.message, error)
    }
  }

  private class Connection(val id: String, val tunnelId: String, val socket: Socket) {
    val writer = Executors.newSingleThreadExecutor()
    val writes = ConcurrentHashMap.newKeySet<Write>()
    val ack = Semaphore(0)
    var awaitingAck = true
    var closed = false
  }

  private val lock = Any()
  private val readers = Executors.newFixedThreadPool(40)
  private val connections = ConcurrentHashMap<String, Connection>()
  private val listeners = mutableMapOf<String, ServerSocket>()
  private var destroyed = false

  override fun definition() = ModuleDefinition {
    Name("PaseoBrowserTunnel")
    Events("onTunnelSocket")

    AsyncFunction("start") { tunnelId: String -> startListener(tunnelId) }
    AsyncFunction("stop") { tunnelId: String ->
      validateTunnelId(tunnelId)
      stopListener(tunnelId)
    }
    AsyncFunction("close") { id: String ->
      validateId(id)
      connections[id]?.let { closeConnection(it) }
    }
    AsyncFunction("resume") { id: String ->
      validateId(id)
      connections[id]?.let { connection ->
        synchronized(connection) {
          if (connection.awaitingAck && !connection.closed) {
            connection.awaitingAck = false
            connection.ack.release()
          }
        }
      }
    }
    AsyncFunction("write") { id: String, encoded: String, promise: Promise ->
      validateId(id)
      val bytes = Base64.decode(encoded, Base64.NO_WRAP)
      require(Base64.encodeToString(bytes, Base64.NO_WRAP) == encoded) { "Invalid base64" }
      val connection = connections[id] ?: throw IllegalArgumentException("Unknown connection")
      val write = Write(promise)
      synchronized(connection) {
        check(!connection.closed) { "Connection is closed" }
        connection.writes.add(write)
        connection.writer.execute {
          try {
            connection.socket.getOutputStream().write(bytes)
            connection.socket.getOutputStream().flush()
            write.finish()
          } catch (error: Exception) {
            write.finish(error)
            closeConnection(connection)
          } finally {
            connection.writes.remove(write)
          }
        }
      }
    }
    OnDestroy {
      synchronized(lock) { destroyed = true }
      synchronized(lock) { listeners.keys.toList().forEach { stopListener(it) } }
      readers.shutdownNow()
    }
  }

  private fun validateId(id: String) {
    require(UUID.fromString(id).toString() == id) { "Invalid connection ID" }
  }

  private fun validateTunnelId(id: String) {
    require(id.matches(Regex("[A-Za-z0-9_-]{1,128}"))) { "Invalid tunnel ID" }
  }

  private fun startListener(tunnelId: String): Int = synchronized(lock) {
    validateTunnelId(tunnelId)
    check(!destroyed) { "Module is closed" }
    listeners[tunnelId]?.let { return@synchronized it.localPort }
    check(listeners.size < 8) { "Too many browser tunnels" }
    val server = ServerSocket()
    try {
      server.bind(InetSocketAddress(InetAddress.getByName("127.0.0.1"), 0), 32)
      listeners[tunnelId] = server
      readers.execute { acceptConnections(tunnelId, server) }
      server.localPort
    } catch (error: Exception) {
      server.close()
      listeners.remove(tunnelId)
      throw error
    }
  }

  private fun acceptConnections(tunnelId: String, server: ServerSocket) {
    try {
      while (!server.isClosed) {
        val socket = server.accept()
        val connection = Connection(UUID.randomUUID().toString(), tunnelId, socket)
        synchronized(lock) {
          if (listeners[tunnelId] !== server || connections.size >= 32) {
            socket.close()
            connection.writer.shutdownNow()
            return@synchronized
          }
          socket.tcpNoDelay = true
          connections[connection.id] = connection
          emit("open", connection)
          readers.execute { readConnection(connection) }
        }
      }
    } catch (_: Exception) {
      synchronized(lock) { if (listeners[tunnelId] === server) stopListener(tunnelId) }
    }
  }

  private fun readConnection(connection: Connection) {
    try {
      val stream = connection.socket.getInputStream()
      val buffer = ByteArray(32768)
      connection.ack.acquire()
      while (!connection.socket.isClosed) {
        val count = stream.read(buffer)
        if (count < 0) break
        if (count == 0) continue
        synchronized(connection) {
          if (connection.closed) return
          connection.awaitingAck = true
          emit("data", connection, Base64.encodeToString(buffer, 0, count, Base64.NO_WRAP))
        }
        // One outstanding chunk per socket prevents a slow JS bridge from buffering a page.
        connection.ack.acquire()
      }
    } catch (_: Exception) {
      // Closing the socket also releases a reader that is waiting for an acknowledgement.
    } finally {
      closeConnection(connection)
    }
  }

  private fun closeConnection(connection: Connection) {
    synchronized(connection) {
      if (connection.closed) return
      connection.closed = true
      connections.remove(connection.id, connection)
      try { connection.socket.close() } catch (_: Exception) { }
      connection.ack.release()
      connection.writer.shutdownNow()
      val error = IllegalStateException("Connection is closed")
      connection.writes.forEach { it.finish(error) }
      connection.writes.clear()
      emit("close", connection)
    }
  }

  private fun stopListener(tunnelId: String) = synchronized(lock) {
    val server = listeners.remove(tunnelId)
    try { server?.close() } catch (_: Exception) { }
    connections.values.filter { it.tunnelId == tunnelId }.forEach { closeConnection(it) }
  }

  private fun emit(kind: String, connection: Connection, encoded: String? = null) {
    val event = mutableMapOf<String, Any>(
      "kind" to kind, "tunnelId" to connection.tunnelId, "connectionId" to connection.id
    )
    if (encoded != null) event["dataBase64"] = encoded
    sendEvent("onTunnelSocket", event)
  }
}
