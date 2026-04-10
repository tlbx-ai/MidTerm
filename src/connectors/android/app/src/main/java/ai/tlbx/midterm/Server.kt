package ai.tlbx.midterm

import org.json.JSONObject

data class Server(
    var url: String,
    var lastConnected: Long = 0
) {
    fun toJson(): JSONObject = JSONObject().apply {
        put("url", url)
        put("lastConnected", lastConnected)
    }

    companion object {
        fun fromJson(json: JSONObject) = Server(
            url = normalizeUrl(json.getString("url")),
            lastConnected = json.optLong("lastConnected", 0)
        )

        fun normalizeUrl(url: String): String {
            var normalized = url.trim().trimEnd('/')
            if (!normalized.startsWith("http://") && !normalized.startsWith("https://")) {
                normalized = "https://$normalized"
            }
            return normalized
        }
    }
}
