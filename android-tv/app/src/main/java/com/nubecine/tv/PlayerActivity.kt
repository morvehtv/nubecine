package com.nubecine.tv

import android.app.Activity
import android.content.Intent
import android.content.pm.ActivityInfo
import android.graphics.Color
import android.net.Uri
import android.os.Build
import android.os.Bundle
import android.os.Handler
import android.os.Looper
import android.view.View
import android.view.WindowInsets
import android.view.WindowInsetsController
import android.view.WindowManager
import android.webkit.CookieManager
import android.widget.Toast
import androidx.annotation.OptIn
import androidx.media3.common.C
import androidx.media3.common.MediaItem
import androidx.media3.common.MediaMetadata
import androidx.media3.common.MimeTypes
import androidx.media3.common.PlaybackException
import androidx.media3.common.Player
import androidx.media3.common.TrackSelectionOverride
import androidx.media3.common.Tracks
import androidx.media3.common.util.UnstableApi
import androidx.media3.datasource.DefaultHttpDataSource
import androidx.media3.exoplayer.ExoPlayer
import androidx.media3.exoplayer.source.DefaultMediaSourceFactory
import androidx.media3.ui.PlayerView
import org.json.JSONArray
import org.json.JSONObject
import java.net.HttpURLConnection
import java.net.URL

/**
 * Reproductor nativo (ExoPlayer) a pantalla completa.
 * Al salir (Atrás) o al terminar el vídeo devuelve la posición a la web,
 * que guarda el progreso y muestra la ficha.
 */
@OptIn(UnstableApi::class)
class PlayerActivity : Activity() {

    companion object {
        const val EXTRA_URL = "url"
        const val EXTRA_BASE = "base"
        const val EXTRA_TITLE = "title"
        const val EXTRA_START_MS = "startMs"
        const val EXTRA_SUBS = "subs"
        const val EXTRA_FILE_ID = "fileId"
        const val EXTRA_AUDIO = "audio"
        const val RESULT_POS = "pos"
        const val RESULT_DUR = "dur"
    }

    private var player: ExoPlayer? = null
    private lateinit var playerView: PlayerView
    private val handler = Handler(Looper.getMainLooper())
    private var cookie: String? = null
    private var finished = false
    private var audioChosen = false

    private val saver = object : Runnable {
        override fun run() {
            saveProgress()
            handler.postDelayed(this, 15000)
        }
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        window.decorView.setBackgroundColor(Color.BLACK)
        requestedOrientation = ActivityInfo.SCREEN_ORIENTATION_SENSOR_LANDSCAPE

        val url = intent.getStringExtra(EXTRA_URL) ?: run { finish(); return }
        cookie = CookieManager.getInstance().getCookie(url)

        playerView = PlayerView(this).apply {
            setBackgroundColor(Color.BLACK)
            keepScreenOn = true
            controllerShowTimeoutMs = 3500
            setShowNextButton(false)
            setShowPreviousButton(false)
            setShowSubtitleButton(true)
            isFocusable = true
            isFocusableInTouchMode = true
        }
        setContentView(playerView)
        hideSystemUi()

        // Las peticiones de vídeo y subtítulos llevan la sesión de la web
        val headers = HashMap<String, String>()
        cookie?.let { headers["Cookie"] = it }
        val http = DefaultHttpDataSource.Factory()
            .setUserAgent("NubeCineApp/1.0")
            .setAllowCrossProtocolRedirects(true)
            .setDefaultRequestProperties(headers)

        val subsJson = JSONArray(intent.getStringExtra(EXTRA_SUBS) ?: "[]")
        val subtitles = (0 until subsJson.length()).map { i ->
            val s = subsJson.getJSONObject(i)
            MediaItem.SubtitleConfiguration.Builder(Uri.parse(s.getString("url")))
                .setMimeType(MimeTypes.TEXT_VTT)
                .setLanguage(s.optString("lang", "es"))
                .setLabel(s.optString("label", "Subtítulos"))
                .setSelectionFlags(if (i == 0) C.SELECTION_FLAG_DEFAULT else 0)
                .build()
        }

        val item = MediaItem.Builder()
            .setUri(url)
            .setSubtitleConfigurations(subtitles)
            .setMediaMetadata(MediaMetadata.Builder().setTitle(intent.getStringExtra(EXTRA_TITLE) ?: "").build())
            .build()

        val exo = ExoPlayer.Builder(this)
            .setMediaSourceFactory(DefaultMediaSourceFactory(http))
            .setSeekBackIncrementMs(10_000)
            .setSeekForwardIncrementMs(10_000)
            .build()
        // Preferencia inicial: español
        exo.trackSelectionParameters = exo.trackSelectionParameters.buildUpon().setPreferredAudioLanguage("es").build()
        player = exo
        playerView.player = exo
        exo.setMediaItem(item, intent.getLongExtra(EXTRA_START_MS, 0L))
        exo.prepare()
        exo.playWhenReady = true
        exo.addListener(object : Player.Listener {
            override fun onPlaybackStateChanged(state: Int) {
                if (state == Player.STATE_ENDED) close(ended = true)
            }

            override fun onTracksChanged(tracks: Tracks) {
                if (!audioChosen) chooseCastellano(tracks)
            }

            override fun onPlayerError(error: PlaybackException) {
                Toast.makeText(this@PlayerActivity, "No se pudo reproducir el vídeo (${error.errorCodeName}). Usa MP4 H.264/AAC.", Toast.LENGTH_LONG).show()
                close(ended = false)
            }
        })
        playerView.requestFocus()
        handler.postDelayed(saver, 15000)
    }

    /** Elige la pista de audio en castellano (una sola vez; luego el usuario puede cambiarla). */
    private fun chooseCastellano(tracks: Tracks) {
        val groups = tracks.groups.filter { it.type == C.TRACK_TYPE_AUDIO }
        if (groups.isEmpty()) return
        audioChosen = true
        if (groups.size < 2) return

        val hint = try { JSONObject(intent.getStringExtra(EXTRA_AUDIO) ?: "{}") } catch (_: Exception) { JSONObject() }
        val serverPref = if (hint.has("pref") && !hint.isNull("pref")) hint.optInt("pref", -1) else -1

        val castellano = Regex("castellano|españa|espana|es-es|es_es|spain|\\bcast\\b")
        val latino = Regex("latino|latam|latinoam|419|m[eé]xic|\\blat\\b")
        val espanol = Regex("español|espanol|spanish")
        fun score(i: Int): Int {
            val f = groups[i].getTrackFormat(0)
            val lang = (f.language ?: "").lowercase()
            val txt = "$lang ${(f.label ?: "").lowercase()}"
            val isEs = lang.startsWith("es") || lang.startsWith("spa") || espanol.containsMatchIn(txt) || castellano.containsMatchIn(txt)
            return when {
                !isEs -> 0
                latino.containsMatchIn(txt) -> 10
                castellano.containsMatchIn(txt) -> 100
                else -> 50
            }
        }
        val ranked = groups.indices.filter { score(it) > 0 }.sortedByDescending { score(it) }
        // Si una pista dice claramente "castellano" manda esa; si no, la que detectó el servidor
        val order = mutableListOf<Int>()
        if (ranked.isNotEmpty() && score(ranked[0]) >= 100) order.add(ranked[0])
        if (serverPref in groups.indices && serverPref !in order) order.add(serverPref)
        ranked.forEach { if (it !in order) order.add(it) }
        if (order.isEmpty()) return

        val pick = order.firstOrNull { groups[it].isTrackSupported(0) } ?: return
        if (pick != order[0]) {
            Toast.makeText(this, "La pista en castellano usa un formato de audio que este dispositivo no puede reproducir. Se usa otra.", Toast.LENGTH_LONG).show()
        }
        val p = player ?: return
        p.trackSelectionParameters = p.trackSelectionParameters.buildUpon()
            .setOverrideForType(TrackSelectionOverride(groups[pick].mediaTrackGroup, 0))
            .build()
    }

    private fun hideSystemUi() {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
            window.insetsController?.let {
                it.hide(WindowInsets.Type.statusBars() or WindowInsets.Type.navigationBars())
                it.systemBarsBehavior = WindowInsetsController.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
            }
        } else {
            @Suppress("DEPRECATION")
            window.decorView.systemUiVisibility = (View.SYSTEM_UI_FLAG_FULLSCREEN
                or View.SYSTEM_UI_FLAG_HIDE_NAVIGATION
                or View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY
                or View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN
                or View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION
                or View.SYSTEM_UI_FLAG_LAYOUT_STABLE)
        }
    }

    override fun onWindowFocusChanged(hasFocus: Boolean) {
        super.onWindowFocusChanged(hasFocus)
        if (hasFocus) hideSystemUi()
    }

    /** Guarda el progreso en el servidor (en segundo plano). */
    private fun saveProgress(pos: Long? = null, dur: Long? = null) {
        val p = player ?: return
        val base = intent.getStringExtra(EXTRA_BASE) ?: return
        val fileId = intent.getStringExtra(EXTRA_FILE_ID) ?: return
        val d = dur ?: p.duration
        if (d <= 0 || d == C.TIME_UNSET) return
        val t = pos ?: p.currentPosition
        val body = JSONObject().put("fileId", fileId).put("t", t / 1000.0).put("d", d / 1000.0).toString()
        val ck = cookie
        Thread {
            try {
                val c = URL("$base/api/progress").openConnection() as HttpURLConnection
                c.requestMethod = "POST"
                c.doOutput = true
                c.connectTimeout = 8000
                c.readTimeout = 8000
                c.setRequestProperty("Content-Type", "application/json")
                if (ck != null) c.setRequestProperty("Cookie", ck)
                c.outputStream.use { it.write(body.toByteArray()) }
                c.responseCode
                c.disconnect()
            } catch (_: Exception) {
            }
        }.start()
    }

    private fun close(ended: Boolean) {
        if (finished) return
        finished = true
        val p = player
        val dur = p?.duration?.takeIf { it > 0 && it != C.TIME_UNSET } ?: 0L
        val pos = if (ended) dur else (p?.currentPosition ?: 0L)
        saveProgress(pos, dur)
        setResult(RESULT_OK, Intent()
            .putExtra(EXTRA_FILE_ID, intent.getStringExtra(EXTRA_FILE_ID))
            .putExtra(RESULT_POS, pos / 1000.0)
            .putExtra(RESULT_DUR, dur / 1000.0))
        finish()
    }

    @Deprecated("Botón Atrás: vuelve a la ficha")
    override fun onBackPressed() {
        close(ended = false)
    }

    override fun onPause() {
        super.onPause()
        if (!finished) saveProgress()
        player?.pause()
    }

    override fun onDestroy() {
        handler.removeCallbacks(saver)
        player?.release()
        player = null
        super.onDestroy()
    }
}
