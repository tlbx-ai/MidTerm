package ai.tlbx.midterm

import android.app.Activity
import android.app.AlertDialog
import android.content.Intent
import android.os.Bundle
import android.view.View
import android.widget.Button
import android.widget.CheckBox
import android.widget.EditText
import android.widget.LinearLayout
import android.widget.TextView
import android.widget.Toast

class MainActivity : Activity() {

    private lateinit var store: ServerStore
    private lateinit var nameInput: EditText
    private lateinit var addressInput: EditText
    private lateinit var certificateInput: CheckBox
    private lateinit var serverList: LinearLayout
    private lateinit var saveButton: Button
    private lateinit var cancelButton: Button
    private var editingId: String? = null
    private var launchedAutomatically = false

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_main)

        store = ServerStore(this)
        nameInput = findViewById(R.id.edit_name)
        addressInput = findViewById(R.id.edit_url)
        certificateInput = findViewById(R.id.allow_untrusted_certificate)
        serverList = findViewById(R.id.server_list)
        saveButton = findViewById(R.id.btn_save)
        cancelButton = findViewById(R.id.btn_cancel)

        saveButton.setOnClickListener { saveAndOpen() }
        cancelButton.setOnClickListener { resetEditor() }
        BackgroundRefreshScheduler.schedule(this)

        renderServers()
        if (savedInstanceState == null) {
            store.active()?.let {
                launchedAutomatically = true
                openServer(it)
            }
        }
    }

    override fun onResume() {
        super.onResume()
        if (launchedAutomatically) launchedAutomatically = false else renderServers()
    }

    private fun renderServers() {
        serverList.removeAllViews()
        val servers = store.loadAll()
        findViewById<View>(R.id.saved_instances_heading).visibility =
            if (servers.isEmpty()) View.GONE else View.VISIBLE

        servers.forEach { server ->
            val row = LinearLayout(this).apply {
                orientation = LinearLayout.VERTICAL
                setPadding(0, dp(8), 0, dp(8))
            }
            row.addView(Button(this).apply {
                text = getString(R.string.instance_button, server.name, server.url)
                isAllCaps = false
                setOnClickListener { openServer(server) }
            })
            row.addView(LinearLayout(this).apply {
                orientation = LinearLayout.HORIZONTAL
                addView(Button(this@MainActivity).apply {
                    text = getString(R.string.edit_instance)
                    layoutParams = LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f)
                    setOnClickListener { editServer(server) }
                })
                addView(Button(this@MainActivity).apply {
                    text = getString(R.string.remove_instance)
                    layoutParams = LinearLayout.LayoutParams(0, LinearLayout.LayoutParams.WRAP_CONTENT, 1f)
                    setOnClickListener { confirmDelete(server) }
                })
            })
            serverList.addView(row)
        }
    }

    private fun editServer(server: Server) {
        editingId = server.id
        nameInput.setText(server.name)
        addressInput.setText(server.url)
        certificateInput.isChecked = server.allowUntrustedCertificate
        saveButton.setText(R.string.save_and_open)
        cancelButton.visibility = View.VISIBLE
        addressInput.requestFocus()
    }

    private fun resetEditor() {
        editingId = null
        nameInput.text.clear()
        addressInput.text.clear()
        certificateInput.isChecked = false
        saveButton.setText(R.string.add_and_open)
        cancelButton.visibility = View.GONE
    }

    private fun saveAndOpen() {
        val normalizedUrl = try {
            Server.normalizeUrl(addressInput.text.toString())
        } catch (error: IllegalArgumentException) {
            Toast.makeText(this, error.message ?: getString(R.string.invalid_address), Toast.LENGTH_LONG).show()
            return
        }
        val existing = editingId?.let(store::load)
        val server = Server(
            id = existing?.id ?: java.util.UUID.randomUUID().toString(),
            name = nameInput.text.toString().trim().ifBlank { Server.defaultName(normalizedUrl) },
            url = normalizedUrl,
            allowUntrustedCertificate = certificateInput.isChecked,
            lastConnected = existing?.lastConnected ?: 0,
            lastRefresh = existing?.lastRefresh ?: 0
        )
        store.save(server)
        BackgroundRefreshScheduler.schedule(this)
        resetEditor()
        renderServers()
        openServer(server)
    }

    private fun openServer(server: Server) {
        store.save(server)
        startActivity(Intent(this, TerminalActivity::class.java).apply {
            putExtra(TerminalActivity.EXTRA_SERVER_ID, server.id)
        })
    }

    private fun confirmDelete(server: Server) {
        AlertDialog.Builder(this)
            .setTitle(getString(R.string.remove_instance_title, server.name))
            .setMessage(R.string.remove_instance_body)
            .setNegativeButton(android.R.string.cancel, null)
            .setPositiveButton(R.string.remove_instance) { _, _ ->
                store.delete(server.id)
                if (editingId == server.id) resetEditor()
                renderServers()
            }
            .show()
    }

    private fun dp(value: Int): Int = (value * resources.displayMetrics.density).toInt()
}
