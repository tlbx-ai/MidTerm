package ai.tlbx.midterm

import android.content.Context
import android.security.keystore.KeyGenParameterSpec
import android.security.keystore.KeyProperties
import java.security.KeyStore
import javax.crypto.Cipher
import javax.crypto.KeyGenerator
import javax.crypto.SecretKey
import javax.crypto.spec.GCMParameterSpec

class ServerStore(private val context: Context) {

    private val prefs = context.getSharedPreferences("servers", Context.MODE_PRIVATE)

    fun load(): MutableList<Server> {
        val encrypted = prefs.getString("data", null) ?: return mutableListOf()
        val iv = prefs.getString("iv", null) ?: return mutableListOf()
        return try {
            val json = decrypt(
                android.util.Base64.decode(encrypted, android.util.Base64.NO_WRAP),
                android.util.Base64.decode(iv, android.util.Base64.NO_WRAP)
            )
            Server.listFromJson(json)
        } catch (_: Exception) {
            mutableListOf()
        }
    }

    fun save(servers: List<Server>) {
        val json = Server.listToJson(servers)
        val cipher = getCipher(Cipher.ENCRYPT_MODE)
        val encrypted = cipher.doFinal(json.toByteArray(Charsets.UTF_8))
        prefs.edit()
            .putString("data", android.util.Base64.encodeToString(encrypted, android.util.Base64.NO_WRAP))
            .putString("iv", android.util.Base64.encodeToString(cipher.iv, android.util.Base64.NO_WRAP))
            .apply()
    }

    private fun getCipher(mode: Int, iv: ByteArray? = null): Cipher {
        val cipher = Cipher.getInstance("AES/GCM/NoPadding")
        val key = getOrCreateKey()
        if (iv != null) {
            cipher.init(mode, key, GCMParameterSpec(128, iv))
        } else {
            cipher.init(mode, key)
        }
        return cipher
    }

    private fun decrypt(data: ByteArray, iv: ByteArray): String {
        val cipher = getCipher(Cipher.DECRYPT_MODE, iv)
        return String(cipher.doFinal(data), Charsets.UTF_8)
    }

    private fun getOrCreateKey(): SecretKey {
        val ks = KeyStore.getInstance("AndroidKeyStore")
        ks.load(null)
        ks.getKey(KEY_ALIAS, null)?.let { return it as SecretKey }

        val spec = KeyGenParameterSpec.Builder(KEY_ALIAS, KeyProperties.PURPOSE_ENCRYPT or KeyProperties.PURPOSE_DECRYPT)
            .setBlockModes(KeyProperties.BLOCK_MODE_GCM)
            .setEncryptionPaddings(KeyProperties.ENCRYPTION_PADDING_NONE)
            .setKeySize(256)
            .build()
        val gen = KeyGenerator.getInstance(KeyProperties.KEY_ALGORITHM_AES, "AndroidKeyStore")
        gen.init(spec)
        return gen.generateKey()
    }

    companion object {
        private const val KEY_ALIAS = "midterm_server_key"
    }
}
