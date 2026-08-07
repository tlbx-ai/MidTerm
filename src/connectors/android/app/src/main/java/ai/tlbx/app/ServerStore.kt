package ai.tlbx.app

import android.content.Context
import org.json.JSONArray
import org.json.JSONObject

class ServerStore(context: Context) {

    private val prefs = context.applicationContext
        .getSharedPreferences(PREFERENCES_NAME, Context.MODE_PRIVATE)

    @Synchronized
    fun loadAll(): List<Server> {
        val stored = prefs.getString(KEY_SERVERS, null)
        if (stored != null) {
            return runCatching {
                val array = JSONArray(stored)
                buildList {
                    for (index in 0 until array.length()) {
                        add(Server.fromJson(array.getJSONObject(index)))
                    }
                }
            }.getOrDefault(emptyList())
        }

        val legacy = prefs.getString(KEY_LEGACY_SERVER, null) ?: return emptyList()
        val migrated = runCatching { Server.fromJson(JSONObject(legacy)) }.getOrNull()
            ?: return emptyList()
        persist(listOf(migrated), migrated.id)
        prefs.edit().remove(KEY_LEGACY_SERVER).apply()
        return listOf(migrated)
    }

    fun load(id: String): Server? = loadAll().firstOrNull { it.id == id }

    fun active(): Server? {
        val servers = loadAll()
        val activeId = prefs.getString(KEY_ACTIVE_SERVER, null)
        return servers.firstOrNull { it.id == activeId } ?: servers.firstOrNull()
    }

    @Synchronized
    fun save(server: Server, makeActive: Boolean = true) {
        val servers = loadAll().toMutableList()
        val existingIndex = servers.indexOfFirst { it.id == server.id }
        if (existingIndex >= 0) servers[existingIndex] = server else servers.add(server)
        persist(servers, if (makeActive) server.id else prefs.getString(KEY_ACTIVE_SERVER, null))
    }

    @Synchronized
    fun delete(id: String) {
        val remaining = loadAll().filterNot { it.id == id }
        val activeId = prefs.getString(KEY_ACTIVE_SERVER, null)
        persist(remaining, if (activeId == id) remaining.firstOrNull()?.id else activeId)
    }

    @Synchronized
    fun markConnected(id: String) = update(id) { it.lastConnected = System.currentTimeMillis() }

    @Synchronized
    fun markRefreshed(id: String) = update(id) { it.lastRefresh = System.currentTimeMillis() }

    private fun update(id: String, action: (Server) -> Unit) {
        val servers = loadAll().toMutableList()
        val index = servers.indexOfFirst { it.id == id }
        if (index < 0) return
        action(servers[index])
        persist(servers, prefs.getString(KEY_ACTIVE_SERVER, null))
    }

    private fun persist(servers: List<Server>, activeId: String?) {
        val array = JSONArray()
        servers.forEach { array.put(it.toJson()) }
        prefs.edit()
            .putString(KEY_SERVERS, array.toString())
            .putString(KEY_ACTIVE_SERVER, activeId)
            .apply()
    }

    companion object {
        private const val PREFERENCES_NAME = "midterm_connector"
        private const val KEY_SERVERS = "saved_servers_v2"
        private const val KEY_ACTIVE_SERVER = "active_server_id"
        private const val KEY_LEGACY_SERVER = "saved_server"
    }
}
