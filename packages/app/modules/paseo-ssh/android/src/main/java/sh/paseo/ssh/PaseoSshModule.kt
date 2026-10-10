package sh.paseo.ssh

import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition
import org.json.JSONObject

/** Android SSH bridge. Only approved keys are staged; durable storage follows a successful daemon probe. */
class PaseoSshModule : Module() {
  private val lifecycle = SshModuleLifecycle<SshSession> { it.close() }
  private val staged = mutableMapOf<String, JSONObject>()
  private val store by lazy { SshCredentialStore(requireNotNull(appContext.reactContext)) }

  override fun definition() = ModuleDefinition {
    Name("PaseoSsh")
    Events("transportEvent")

    AsyncFunction("inspect") { targetInput: Map<String, Any?>, privateKey: String, passphrase: String ->
      val target = SshTarget.from(targetInput)
      require(privateKey.length in 1..65536) { "Choose a private key smaller than 64 KiB." }
      val credentials = JSONObject().put("privateKey", privateKey).put("passphrase", passphrase)
      val client = createSshClient()
      try {
        try { loadPrivateKey(client, credentials) } catch (error: Exception) {
          throw IllegalArgumentException("Unable to read the private key. Check its format and passphrase.")
        }
        var observed: String? = null
        // Discovery rejects the handshake. No SSH login or key signature occurs before approval.
        client.addHostKeyVerifier(verifier { observed = it; false })
        runCatching { client.connect(target.hostname, target.sshPort) }
        observed ?: throw IllegalStateException("Unable to reach the SSH server. Check the hostname and port.")
      } finally { client.close() }
    }.runOnQueue(appContext.backgroundCoroutineScope)

    AsyncFunction("stage") { id: String, target: Map<String, Any?>, privateKey: String, passphrase: String, fingerprint: String ->
      SshTarget.from(target)
      require(privateKey.length in 1..65536 && fingerprint.startsWith("SHA256:")) { "Invalid SSH credentials." }
      lifecycle.withActive {
        staged[id] = JSONObject().put("privateKey", privateKey).put("passphrase", passphrase)
          .put("fingerprint", fingerprint)
      }
    }
    AsyncFunction("commit") { id: String ->
      lifecycle.withActive {
        val credentials = staged[id] ?: error("SSH key import expired. Import the key again.")
        store.save(id, credentials)
        staged.remove(id)
        Unit
      }
    }.runOnQueue(appContext.backgroundCoroutineScope)
    AsyncFunction("discard") { id: String -> lifecycle.withActive { staged.remove(id); Unit } }
    AsyncFunction("remove") { id: String -> lifecycle.withActive { staged.remove(id); store.remove(id) } }.runOnQueue(appContext.backgroundCoroutineScope)

    AsyncFunction("open") { id: String, credentialId: String, targetInput: Map<String, Any?> ->
      val target = SshTarget.from(targetInput)
      val credentials = lifecycle.withActive { staged[credentialId] } ?: store.read(credentialId)
        ?: error("Import a private key for this SSH host on this device.")
      lateinit var session: SshSession
      session = SshSession(id, target, credentials, { event -> sendEvent("transportEvent", event) }, { lifecycle.remove(id, session) })
      // Credential loading and construction can outlive teardown. Registration fences both.
      lifecycle.registerAndStart(id, session) {
        Thread({ session.open() }, "paseo-ssh-connect").apply { isDaemon = true; start() }
      }
    }.runOnQueue(appContext.backgroundCoroutineScope)
    AsyncFunction("send") { id: String, text: String?, binary: String? ->
      (lifecycle.get(id) ?: error("SSH session is closed.")).send(text, binary)
    }
    AsyncFunction("close") { id: String -> lifecycle.remove(id)?.close(); Unit }.runOnQueue(appContext.backgroundCoroutineScope)

    OnDestroy {
      lifecycle.destroy { staged.clear() }
    }
  }
}
