package ai.tlbx.app

import org.json.JSONObject
import java.net.URI
import java.util.UUID

data class Server(
    val id: String = UUID.randomUUID().toString(),
    var name: String,
    var url: String,
    var lastConnected: Long = 0,
    var lastRefresh: Long = 0
) {
    fun toJson(): JSONObject = JSONObject().apply {
        put("id", id)
        put("name", name)
        put("url", url)
        put("lastConnected", lastConnected)
        put("lastRefresh", lastRefresh)
    }

    companion object {
        fun fromJson(json: JSONObject): Server {
            val normalizedUrl = normalizeUrl(json.getString("url"))
            return Server(
                id = json.optString("id").ifBlank { UUID.randomUUID().toString() },
                name = json.optString("name").ifBlank { defaultName(normalizedUrl) },
                url = normalizedUrl,
                lastConnected = json.optLong("lastConnected", 0),
                lastRefresh = json.optLong("lastRefresh", 0)
            )
        }

        fun normalizeUrl(input: String): String {
            var normalized = input.trim().trimEnd('/')
            require(normalized.isNotEmpty()) { "Address is required" }
            if (!normalized.contains("://")) normalized = "https://$normalized"

            val uri = runCatching { URI(normalized) }
                .getOrElse { throw IllegalArgumentException("Enter a valid tlbx address") }
            require(uri.scheme.equals("https", ignoreCase = true)) {
                "Use an HTTPS address"
            }
            require(!uri.host.isNullOrBlank()) { "Enter a valid tlbx host" }
            require(uri.userInfo == null) { "Do not put credentials in the address" }
            require(uri.fragment == null) { "Remove the address fragment" }

            return uri.normalize().toASCIIString().trimEnd('/')
        }

        fun defaultName(url: String): String {
            val uri = URI(url)
            return if (uri.port > 0) "${uri.host}:${uri.port}" else uri.host
        }
    }
}
