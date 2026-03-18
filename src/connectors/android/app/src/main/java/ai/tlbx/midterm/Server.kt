package ai.tlbx.midterm

import org.json.JSONArray
import org.json.JSONObject

data class Server(
    val id: String = java.util.UUID.randomUUID().toString(),
    var name: String,
    var url: String,
    var password: String = "",
    var certFingerprint: String = "",
    var lastConnected: Long = 0
) {
    fun toJson(): JSONObject = JSONObject().apply {
        put("id", id)
        put("name", name)
        put("url", url)
        put("password", password)
        put("certFingerprint", certFingerprint)
        put("lastConnected", lastConnected)
    }

    companion object {
        fun fromJson(json: JSONObject) = Server(
            id = json.getString("id"),
            name = json.getString("name"),
            url = json.getString("url"),
            password = json.optString("password", ""),
            certFingerprint = json.optString("certFingerprint", ""),
            lastConnected = json.optLong("lastConnected", 0)
        )

        fun listToJson(servers: List<Server>): String {
            val arr = JSONArray()
            servers.forEach { arr.put(it.toJson()) }
            return arr.toString()
        }

        fun listFromJson(json: String): MutableList<Server> {
            if (json.isBlank()) return mutableListOf()
            val arr = JSONArray(json)
            val list = mutableListOf<Server>()
            for (i in 0 until arr.length()) {
                list.add(fromJson(arr.getJSONObject(i)))
            }
            return list
        }
    }
}
