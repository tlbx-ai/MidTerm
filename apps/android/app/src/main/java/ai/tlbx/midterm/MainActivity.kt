package ai.tlbx.midterm

import android.app.Activity
import android.app.AlertDialog
import android.content.Intent
import android.os.Bundle
import android.view.LayoutInflater
import android.view.View
import android.view.ViewGroup
import android.widget.BaseAdapter
import android.widget.EditText
import android.widget.ImageButton
import android.widget.ListView
import android.widget.TextView

class MainActivity : Activity() {

    private lateinit var store: ServerStore
    private lateinit var servers: MutableList<Server>
    private lateinit var adapter: ServerAdapter
    private lateinit var emptyView: TextView

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        setContentView(R.layout.activity_main)

        store = ServerStore(this)
        servers = store.load()

        emptyView = findViewById(R.id.empty_view)
        val listView = findViewById<ListView>(R.id.server_list)
        adapter = ServerAdapter()
        listView.adapter = adapter
        listView.setOnItemClickListener { _, _, position, _ -> connect(servers[position]) }
        listView.setOnItemLongClickListener { _, _, position, _ -> showEditDialog(position); true }

        findViewById<View>(R.id.fab_add).setOnClickListener { showAddDialog() }
        updateEmptyState()
    }

    private fun connect(server: Server) {
        server.lastConnected = System.currentTimeMillis()
        store.save(servers)
        val intent = Intent(this, TerminalActivity::class.java).apply {
            putExtra("url", server.url)
            putExtra("password", server.password)
            putExtra("serverId", server.id)
            putExtra("certFingerprint", server.certFingerprint)
        }
        startActivity(intent)
    }

    override fun onResume() {
        super.onResume()
        servers = store.load()
        adapter.notifyDataSetChanged()
        updateEmptyState()
    }

    private fun updateEmptyState() {
        emptyView.visibility = if (servers.isEmpty()) View.VISIBLE else View.GONE
    }

    private fun showAddDialog() {
        val view = layoutInflater.inflate(R.layout.dialog_server, null)
        AlertDialog.Builder(this)
            .setTitle("Add Server")
            .setView(view)
            .setPositiveButton("Save") { _, _ ->
                val name = view.findViewById<EditText>(R.id.edit_name).text.toString().trim()
                val url = view.findViewById<EditText>(R.id.edit_url).text.toString().trim()
                val password = view.findViewById<EditText>(R.id.edit_password).text.toString()
                if (name.isNotEmpty() && url.isNotEmpty()) {
                    servers.add(Server(name = name, url = normalizeUrl(url), password = password))
                    store.save(servers)
                    adapter.notifyDataSetChanged()
                    updateEmptyState()
                }
            }
            .setNegativeButton("Cancel", null)
            .show()
    }

    private fun showEditDialog(position: Int) {
        val server = servers[position]
        val view = layoutInflater.inflate(R.layout.dialog_server, null)
        view.findViewById<EditText>(R.id.edit_name).setText(server.name)
        view.findViewById<EditText>(R.id.edit_url).setText(server.url)
        view.findViewById<EditText>(R.id.edit_password).setText(server.password)

        AlertDialog.Builder(this)
            .setTitle("Edit Server")
            .setView(view)
            .setPositiveButton("Save") { _, _ ->
                server.name = view.findViewById<EditText>(R.id.edit_name).text.toString().trim()
                server.url = normalizeUrl(view.findViewById<EditText>(R.id.edit_url).text.toString().trim())
                server.password = view.findViewById<EditText>(R.id.edit_password).text.toString()
                store.save(servers)
                adapter.notifyDataSetChanged()
            }
            .setNeutralButton("Delete") { _, _ ->
                servers.removeAt(position)
                store.save(servers)
                adapter.notifyDataSetChanged()
                updateEmptyState()
            }
            .setNegativeButton("Cancel", null)
            .show()
    }

    private fun normalizeUrl(url: String): String {
        var u = url.trimEnd('/')
        if (!u.startsWith("http://") && !u.startsWith("https://")) {
            u = "https://$u"
        }
        return u
    }

    inner class ServerAdapter : BaseAdapter() {
        override fun getCount() = servers.size
        override fun getItem(position: Int) = servers[position]
        override fun getItemId(position: Int) = position.toLong()

        override fun getView(position: Int, convertView: View?, parent: ViewGroup): View {
            val view = convertView ?: LayoutInflater.from(parent.context).inflate(R.layout.item_server, parent, false)
            val server = servers[position]
            view.findViewById<TextView>(R.id.server_name).text = server.name
            view.findViewById<TextView>(R.id.server_url).text = server.url
            view.findViewById<ImageButton>(R.id.btn_edit).setOnClickListener { showEditDialog(position) }
            return view
        }
    }
}
