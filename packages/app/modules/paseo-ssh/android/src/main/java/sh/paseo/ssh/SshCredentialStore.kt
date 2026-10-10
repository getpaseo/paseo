package sh.paseo.ssh

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import android.util.Base64
import org.json.JSONObject
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

/** Encrypts SSH secrets with a non-exportable Android Keystore key in backup-excluded storage. */
internal class SshCredentialStore(context: Context) {
  private val directory = java.io.File(context.noBackupFilesDir, "paseo-ssh").apply { mkdirs() }
  private val alias = "paseo-ssh-credentials-v1"

  private fun key(): SecretKey {
    val store = KeyStore.getInstance("AndroidKeyStore").apply { load(null) }
    (store.getKey(alias, null) as? SecretKey)?.let { return it }
    return KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore").apply {
      init(KeyGenParameterSpec.Builder(alias, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
        .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
        .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE).build())
    }.generateKey()
  }

  private fun file(id: String): java.io.File {
    val digest = java.security.MessageDigest.getInstance("SHA-256").digest(id.toByteArray())
    return java.io.File(directory, digest.joinToString("") { "%02x".format(it) })
  }

  @Synchronized fun save(id: String, value: JSONObject) {
    val cipher = Cipher.getInstance("AES/GCM/NoPadding").apply { init(Cipher.ENCRYPT_MODE, key()) }
    cipher.updateAAD(id.toByteArray())
    val data = JSONObject().put("iv", Base64.encodeToString(cipher.iv, Base64.NO_WRAP))
      .put("data", Base64.encodeToString(cipher.doFinal(value.toString().toByteArray()), Base64.NO_WRAP))
    val atomic = android.util.AtomicFile(file(id))
    val stream = atomic.startWrite()
    try {
      stream.write(data.toString().toByteArray())
      atomic.finishWrite(stream)
    } catch (error: Exception) {
      atomic.failWrite(stream)
      throw error
    }
  }

  @Synchronized fun read(id: String): JSONObject? {
    val target = file(id)
    if (!target.exists()) return null
    val data = JSONObject(android.util.AtomicFile(target).openRead().use { it.readBytes().toString(Charsets.UTF_8) })
    val cipher = Cipher.getInstance("AES/GCM/NoPadding").apply {
      init(Cipher.DECRYPT_MODE, key(), GCMParameterSpec(128, Base64.decode(data.getString("iv"), Base64.NO_WRAP)))
    }
    cipher.updateAAD(id.toByteArray())
    return JSONObject(cipher.doFinal(Base64.decode(data.getString("data"), Base64.NO_WRAP)).toString(Charsets.UTF_8))
  }

  @Synchronized fun remove(id: String) { android.util.AtomicFile(file(id)).delete() }
}
