package ai.tlbx.midterm

import android.content.Context
import org.json.JSONObject

class ServerStore(private val context: Context) {

    private val prefs = context.getSharedPreferences("midterm_connector", Context.MODE_PRIVATE)

    fun load(): Server? {
        val json = prefs.getString(KEY_SERVER, null) ?: return null
        return runCatching { Server.fromJson(JSONObject(json)) }.getOrNull()
    }

    fun save(server: Server) {
        prefs.edit()
            .putString(KEY_SERVER, server.toJson().toString())
            .apply()
    }

    companion object {
        private const val KEY_SERVER = "saved_server"
    }
}
