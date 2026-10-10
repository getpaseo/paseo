package sh.paseo.ssh

import java.util.Base64
import net.schmizz.sshj.SSHClient
import net.schmizz.sshj.common.Buffer
import net.schmizz.sshj.transport.verification.HostKeyVerifier
import net.schmizz.sshj.userauth.password.PasswordUtils
import org.json.JSONObject
import java.security.MessageDigest
import java.security.PublicKey

/** Explicit destinations only: Android has no access to the desktop's SSH config or agent. */
internal data class SshTarget(val host: String, val sshPort: Int, val daemonPort: Int) {
  val username: String get() = host.substringBeforeLast('@')
  val hostname: String get() = host.substringAfterLast('@')
  init {
    require(host.contains('@') && username.isNotBlank() && hostname.isNotBlank() &&
      !host.any { it.isWhitespace() } && !hostname.startsWith("-")) { "Enter ssh://user@hostname with an explicit username." }
    require(sshPort in 1..65535 && daemonPort in 1..65535) { "Invalid SSH or daemon port." }
  }
  companion object {
    fun from(value: Map<String, Any?>) = SshTarget(value["host"] as String,
      (value["sshPort"] as? Number)?.toInt() ?: 22, (value["daemonPort"] as? Number)?.toInt() ?: 6767)
  }
}

/** Hash the SSH wire encoding, rather than the Java X.509 public-key encoding. */
internal fun fingerprint(key: PublicKey): String {
  val wire = Buffer.PlainBuffer().putPublicKey(key).compactData
  return "SHA256:" + Base64.getEncoder().withoutPadding().encodeToString(MessageDigest.getInstance("SHA-256").digest(wire))
}

internal fun verifier(check: (String) -> Boolean) = object : HostKeyVerifier {
  override fun verify(hostname: String, port: Int, key: PublicKey) = check(fingerprint(key))
  override fun findExistingAlgorithms(hostname: String, port: Int): List<String> = emptyList()
}

/** Forces lazy key decoding now, so a bad key or passphrase fails in the import form. */
internal fun loadPrivateKey(client: SSHClient, credentials: JSONObject) = client.loadKeys(
  credentials.getString("privateKey"), null,
  PasswordUtils.createOneOff(credentials.optString("passphrase").toCharArray())
).also { it.private }

/** Keep full SSH crypto separate from Android's stripped BC provider without replacing platform providers. */
@Synchronized internal fun createSshClient(): SSHClient {
  val providerName = "PaseoSSH"
  if (java.security.Security.getProvider(providerName) == null) {
    val provider = object : java.security.Provider(providerName, 1.0, "Paseo SSH cryptography") {}
    org.bouncycastle.jce.provider.BouncyCastleProvider().entries
      .filter { !(it.key as String).startsWith("Provider.id ") }
      .forEach { provider[it.key] = it.value }
    java.security.Security.addProvider(provider)
  }
  net.schmizz.sshj.common.SecurityUtils.setSecurityProvider(providerName)
  return SSHClient().apply { connectTimeout = 10000; timeout = 10000 }
}
