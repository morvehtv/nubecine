package com.nubecine.tv

import android.app.Activity
import android.app.AlertDialog
import android.content.ActivityNotFoundException
import android.content.Intent
import android.net.Uri
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.provider.Settings
import android.widget.Toast
import androidx.core.content.FileProvider
import org.json.JSONObject
import java.io.File
import java.net.HttpURLConnection
import java.net.URL

/**
 * Actualizaciones automáticas desde las "Releases" de GitHub.
 * Al abrir la app comprueba si hay una versión nueva, la descarga en segundo plano
 * y pide confirmación para instalarla (Android siempre exige ese paso).
 */
class Updater(private val activity: Activity) {

    private val main = Handler(Looper.getMainLooper())
    private val prefs = activity.getSharedPreferences("nubecine", Activity.MODE_PRIVATE)

    fun checkInBackground() {
        val repo = BuildConfig.UPDATE_REPO
        if (repo.isBlank()) return
        // Como mucho una comprobación cada 5 minutos
        val now = System.currentTimeMillis()
        if (now - prefs.getLong("lastUpdateCheck", 0L) < 5 * 60 * 1000L) return
        prefs.edit().putLong("lastUpdateCheck", now).apply()

        Thread {
            try {
                val json = JSONObject(httpGet("https://api.github.com/repos/$repo/releases/latest"))
                val tag = json.optString("tag_name")                 // p. ej. "v1.7"
                val remote = tag.substringAfterLast('.').toIntOrNull() ?: return@Thread
                if (remote <= BuildConfig.VERSION_CODE) return@Thread
                val assets = json.optJSONArray("assets") ?: return@Thread
                var url: String? = null
                for (i in 0 until assets.length()) {
                    val a = assets.getJSONObject(i)
                    if (a.optString("name").endsWith(".apk")) { url = a.optString("browser_download_url"); break }
                }
                if (url.isNullOrBlank()) return@Thread
                val apk = download(url, remote)
                main.post { askToInstall(apk, tag) }
            } catch (_: Exception) {
                // Sin conexión o GitHub no disponible: se reintentará en el próximo arranque
            }
        }.start()
    }

    private fun httpGet(url: String): String {
        val c = URL(url).openConnection() as HttpURLConnection
        c.connectTimeout = 10000
        c.readTimeout = 15000
        c.setRequestProperty("User-Agent", "NubeCineApp")
        c.setRequestProperty("Accept", "application/vnd.github+json")
        try {
            if (c.responseCode != 200) throw IllegalStateException("HTTP ${c.responseCode}")
            return c.inputStream.bufferedReader().use { it.readText() }
        } finally {
            c.disconnect()
        }
    }

    private fun updatesDir(): File {
        // En Android antiguos (< 7) el instalador necesita leer el archivo desde almacenamiento externo de la app
        val base = if (Build.VERSION.SDK_INT >= 24) activity.cacheDir else (activity.externalCacheDir ?: activity.cacheDir)
        return File(base, "updates").apply { mkdirs() }
    }

    private fun download(url: String, version: Int): File {
        val dir = updatesDir()
        val target = File(dir, "NubeCine-$version.apk")
        if (target.exists() && target.length() > 0) return target
        dir.listFiles()?.forEach { it.delete() } // borra descargas antiguas
        val tmp = File(dir, "descarga.tmp")
        val c = URL(url).openConnection() as HttpURLConnection
        c.connectTimeout = 15000
        c.readTimeout = 60000
        c.instanceFollowRedirects = true
        c.setRequestProperty("User-Agent", "NubeCineApp")
        try {
            if (c.responseCode != 200) throw IllegalStateException("HTTP ${c.responseCode}")
            c.inputStream.use { input -> tmp.outputStream().use { input.copyTo(it) } }
        } finally {
            c.disconnect()
        }
        if (!tmp.renameTo(target)) throw IllegalStateException("No se pudo guardar la actualización")
        if (Build.VERSION.SDK_INT < 24) target.setReadable(true, false)
        return target
    }

    private fun askToInstall(apk: File, tag: String) {
        if (activity.isFinishing) return
        AlertDialog.Builder(activity)
            .setTitle("Actualización disponible")
            .setMessage("Se ha descargado la versión ${tag.removePrefix("v")} de la app. ¿Instalarla ahora?")
            .setPositiveButton("Instalar") { _, _ -> install(apk) }
            .setNegativeButton("Más tarde", null)
            .show()
    }

    private fun install(apk: File) {
        // Android 8+: la app necesita permiso para instalar actualizaciones (se concede una sola vez)
        if (Build.VERSION.SDK_INT >= 26 && !activity.packageManager.canRequestPackageInstalls()) {
            Toast.makeText(activity, "Activa «Permitir de esta fuente» y vuelve a la app para instalar la actualización.", Toast.LENGTH_LONG).show()
            prefs.edit().putLong("lastUpdateCheck", 0L).apply() // al volver, se vuelve a ofrecer
            try {
                activity.startActivity(Intent(Settings.ACTION_MANAGE_UNKNOWN_APP_SOURCES, Uri.parse("package:" + activity.packageName)))
            } catch (_: ActivityNotFoundException) {
                Toast.makeText(activity, "Ve a Ajustes > Aplicaciones > Acceso especial > Instalar apps desconocidas y permite NubeCine.", Toast.LENGTH_LONG).show()
            }
            return
        }
        val uri = if (Build.VERSION.SDK_INT >= 24)
            FileProvider.getUriForFile(activity, activity.packageName + ".updates", apk)
        else Uri.fromFile(apk)
        val i = Intent(Intent.ACTION_VIEW)
            .setDataAndType(uri, "application/vnd.android.package-archive")
            .addFlags(Intent.FLAG_GRANT_READ_URI_PERMISSION or Intent.FLAG_ACTIVITY_NEW_TASK)
        try {
            activity.startActivity(i)
        } catch (_: ActivityNotFoundException) {
            Toast.makeText(activity, "Este dispositivo no permite instalar la actualización automáticamente. Descárgala de nuevo desde el enlace de siempre.", Toast.LENGTH_LONG).show()
        }
    }
}
