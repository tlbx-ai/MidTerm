package ai.tlbx.midterm

import android.app.Activity
import android.content.Intent
import android.os.Bundle
import android.widget.Button
import android.widget.EditText
import android.widget.Toast

class MainActivity : Activity() {

    private lateinit var store: ServerStore
    private lateinit var addressInput: EditText

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_main)

        store = ServerStore(this)
        addressInput = findViewById(R.id.edit_url)
        addressInput.setText(store.load()?.url.orEmpty())

        findViewById<Button>(R.id.btn_open).setOnClickListener {
            openMidTerm()
        }
    }

    private fun openMidTerm() {
        val rawUrl = addressInput.text.toString().trim()
        if (rawUrl.isEmpty()) {
            Toast.makeText(this, R.string.address_required, Toast.LENGTH_SHORT).show()
            return
        }

        val server = Server(
            url = Server.normalizeUrl(rawUrl),
            lastConnected = System.currentTimeMillis()
        )
        store.save(server)

        startActivity(Intent(this, TerminalActivity::class.java).apply {
            putExtra("url", server.url)
        })
    }
}
