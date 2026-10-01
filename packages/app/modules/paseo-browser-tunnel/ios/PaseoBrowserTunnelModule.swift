import ExpoModulesCore
import Foundation
import Network

public class PaseoBrowserTunnelModule: Module {
  private class Connection {
    let id = UUID().uuidString.lowercased()
    let tunnelId: String
    let socket: NWConnection
    var opened = false
    var awaitingAck = false
    var reachedEnd = false
    var writes: [UUID: Promise] = [:]

    init(_ socket: NWConnection, tunnelId: String) {
      self.socket = socket
      self.tunnelId = tunnelId
    }
  }

  private class Tunnel {
    let listener: NWListener
    var starts: [Promise] = []
    var ready = false
    init(_ listener: NWListener) { self.listener = listener }
  }

  private let io = DispatchQueue(label: "sh.paseo.browser-tunnel.io")
  private var tunnels: [String: Tunnel] = [:]
  private var connections: [String: Connection] = [:]
  private var destroyed = false

  public func definition() -> ModuleDefinition {
    Name("PaseoBrowserTunnel")
    Events("onTunnelSocket")

    AsyncFunction("start") { (tunnelId: String, promise: Promise) in
      guard self.validTunnelId(tunnelId) else {
        promise.reject("ERR_BROWSER_TUNNEL", "Invalid tunnel ID")
        return
      }
      self.io.async {
        guard !self.destroyed else {
          promise.reject("ERR_BROWSER_TUNNEL", "Module is closed")
          return
        }
        if let tunnel = self.tunnels[tunnelId] {
          if tunnel.ready, let port = tunnel.listener.port { promise.resolve(Int(port.rawValue)) }
          else { tunnel.starts.append(promise) }
          return
        }
        guard self.tunnels.count < 8 else {
          promise.reject("ERR_BROWSER_TUNNEL", "Too many browser tunnels")
          return
        }
        do {
          let parameters = NWParameters.tcp
          parameters.requiredLocalEndpoint = .hostPort(host: "127.0.0.1", port: .any)
          let listener = try NWListener(using: parameters)
          let tunnel = Tunnel(listener)
          tunnel.starts.append(promise)
          self.tunnels[tunnelId] = tunnel
          listener.newConnectionHandler = { [weak self, weak tunnel] socket in
            guard let self, let tunnel, self.tunnels[tunnelId] === tunnel else {
              socket.cancel()
              return
            }
            self.accept(socket, tunnelId: tunnelId)
          }
          listener.stateUpdateHandler = { [weak self, weak tunnel] state in
            guard let self, let tunnel, self.tunnels[tunnelId] === tunnel else { return }
            switch state {
            case .ready:
              guard let port = tunnel.listener.port else { return }
              tunnel.ready = true
              let promises = tunnel.starts
              tunnel.starts.removeAll()
              promises.forEach { $0.resolve(Int(port.rawValue)) }
            case .failed(let error):
              self.stopListener(tunnelId, error: error)
            default:
              break
            }
          }
          listener.start(queue: self.io)
        } catch {
          promise.reject(error)
        }
      }
    }
    AsyncFunction("stop") { (tunnelId: String, promise: Promise) in
      guard self.validTunnelId(tunnelId) else {
        promise.reject("ERR_BROWSER_TUNNEL", "Invalid tunnel ID")
        return
      }
      self.io.async {
        self.stopListener(tunnelId)
        promise.resolve(nil)
      }
    }
    AsyncFunction("close") { (id: String, promise: Promise) in
      guard self.validId(id) else {
        promise.reject("ERR_BROWSER_TUNNEL", "Invalid connection ID")
        return
      }
      self.io.async {
        if let connection = self.connections[id] { self.closeConnection(connection) }
        promise.resolve(nil)
      }
    }
    AsyncFunction("resume") { (id: String, promise: Promise) in
      guard self.validId(id) else {
        promise.reject("ERR_BROWSER_TUNNEL", "Invalid connection ID")
        return
      }
      self.io.async {
        if let connection = self.connections[id], connection.awaitingAck {
          connection.awaitingAck = false
          if connection.reachedEnd { self.closeConnection(connection) }
          else { self.receive(connection) }
        }
        promise.resolve(nil)
      }
    }
    AsyncFunction("write") { (id: String, encoded: String, promise: Promise) in
      guard self.validId(id) else {
        promise.reject("ERR_BROWSER_TUNNEL", "Invalid connection ID")
        return
      }
      guard let data = Data(base64Encoded: encoded), data.base64EncodedString() == encoded else {
        promise.reject("ERR_BROWSER_TUNNEL", "Invalid base64")
        return
      }
      self.io.async {
        guard let connection = self.connections[id] else {
          promise.reject("ERR_BROWSER_TUNNEL", "Unknown connection")
          return
        }
        let writeId = UUID()
        connection.writes[writeId] = promise
        connection.socket.send(content: data, completion: .contentProcessed { [weak self] error in
          guard let self, let pending = connection.writes.removeValue(forKey: writeId) else { return }
          if let error {
            pending.reject(error)
            self.closeConnection(connection)
          } else {
            pending.resolve(nil)
          }
        })
      }
    }
    OnDestroy {
      self.io.async {
        self.destroyed = true
        for tunnelId in Array(self.tunnels.keys) { self.stopListener(tunnelId) }
      }
    }
  }

  private func validId(_ id: String) -> Bool {
    UUID(uuidString: id)?.uuidString.lowercased() == id
  }

  private func validTunnelId(_ id: String) -> Bool {
    id.range(of: "^[A-Za-z0-9_-]{1,128}$", options: .regularExpression) != nil
  }

  private func accept(_ socket: NWConnection, tunnelId: String) {
    guard connections.count < 32 else {
      socket.cancel()
      return
    }
    let connection = Connection(socket, tunnelId: tunnelId)
    connections[connection.id] = connection
    socket.stateUpdateHandler = { [weak self, weak connection] state in
      guard let self, let connection, self.connections[connection.id] === connection else { return }
      switch state {
      case .ready:
        guard !connection.opened else { return }
        connection.opened = true
        connection.awaitingAck = true
        self.emit("open", connection)
      case .failed, .cancelled:
        self.closeConnection(connection)
      default:
        break
      }
    }
    socket.start(queue: io)
  }

  private func receive(_ connection: Connection) {
    connection.socket.receive(minimumIncompleteLength: 1, maximumLength: 32768) {
      [weak self, weak connection] data, _, complete, error in
      guard let self, let connection, self.connections[connection.id] === connection else { return }
      if let data, !data.isEmpty {
        connection.awaitingAck = true
        connection.reachedEnd = complete || error != nil
        self.emit("data", connection, data.base64EncodedString())
        // Deliver the final bytes before closing; the ACK drains them through JS first.
      } else if complete || error != nil {
        self.closeConnection(connection)
      } else {
        self.receive(connection)
      }
    }
  }

  private func closeConnection(_ connection: Connection) {
    guard connections.removeValue(forKey: connection.id) != nil else { return }
    connection.socket.cancel()
    connection.writes.values.forEach { $0.reject("ERR_BROWSER_TUNNEL", "Connection is closed") }
    connection.writes.removeAll()
    if connection.opened { emit("close", connection) }
  }

  private func stopListener(_ tunnelId: String, error: Error? = nil) {
    guard let tunnel = tunnels.removeValue(forKey: tunnelId) else { return }
    tunnel.listener.cancel()
    let promises = tunnel.starts
    tunnel.starts.removeAll()
    for promise in promises {
      if let error { promise.reject(error) }
      else { promise.reject("ERR_BROWSER_TUNNEL", "Listener stopped") }
    }
    for connection in connections.values.filter({ $0.tunnelId == tunnelId }) {
      closeConnection(connection)
    }
  }

  private func emit(_ kind: String, _ connection: Connection, _ encoded: String? = nil) {
    var event: [String: Any] = [
      "kind": kind, "tunnelId": connection.tunnelId, "connectionId": connection.id
    ]
    if let encoded { event["dataBase64"] = encoded }
    sendEvent("onTunnelSocket", event)
  }
}
