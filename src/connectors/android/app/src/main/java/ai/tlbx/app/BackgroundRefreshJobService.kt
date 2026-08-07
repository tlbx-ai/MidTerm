package ai.tlbx.app

import android.app.job.JobInfo
import android.app.job.JobParameters
import android.app.job.JobScheduler
import android.app.job.JobService
import android.content.ComponentName
import android.content.Context
import android.net.Uri
import java.net.HttpURLConnection
import java.net.URL
import java.util.concurrent.Executors

class BackgroundRefreshJobService : JobService() {
    private val executor = Executors.newSingleThreadExecutor()

    override fun onStartJob(params: JobParameters): Boolean {
        executor.execute {
            val store = ServerStore(applicationContext)
            store.loadAll().forEach { server ->
                if (probe(server.url)) store.markRefreshed(server.id)
            }
            jobFinished(params, false)
        }
        return true
    }

    override fun onStopJob(params: JobParameters): Boolean = true

    override fun onDestroy() {
        executor.shutdownNow()
        super.onDestroy()
    }

    private fun probe(serverUrl: String): Boolean = runCatching {
        val endpoint = Uri.parse(serverUrl).buildUpon()
            .path("/api/version")
            .clearQuery()
            .fragment(null)
            .build()
            .toString()
        (URL(endpoint).openConnection() as HttpURLConnection).run {
            connectTimeout = 10_000
            readTimeout = 10_000
            instanceFollowRedirects = false
            setRequestProperty("Accept", "application/json")
            setRequestProperty("User-Agent", "tlbx-app-background-refresh")
            try {
                responseCode in 100..599
            } finally {
                disconnect()
            }
        }
    }.getOrDefault(false)
}

object BackgroundRefreshScheduler {
    private const val JOB_ID = 0x746c6278
    private const val REFRESH_INTERVAL_MS = 15 * 60 * 1000L

    fun schedule(context: Context) {
        val scheduler = context.getSystemService(JobScheduler::class.java)
        val job = JobInfo.Builder(
            JOB_ID,
            ComponentName(context, BackgroundRefreshJobService::class.java)
        )
            .setRequiredNetworkType(JobInfo.NETWORK_TYPE_ANY)
            .setPeriodic(REFRESH_INTERVAL_MS)
            .setPersisted(true)
            .build()
        scheduler.schedule(job)
    }
}
