package com.nubecine.tv

import android.annotation.SuppressLint
import android.app.Activity
import android.app.AlertDialog
import android.app.UiModeManager
import android.content.Intent
import android.content.res.Configuration
import android.graphics.Color
import android.net.Uri
import android.os.Bundle
import android.text.InputType
import android.view.KeyEvent
import android.view.View
import android.view.WindowManager
import android.webkit.CookieManager
import android.webkit.JavascriptInterface
import android.webkit.WebChromeClient
import android.webkit.WebResourceError
import android.webkit.WebResourceRequest
import android.webkit.WebView
import android.webkit.WebViewClient
import android.widget.EditText

/**
 * App de NubeCine para Android TV y Fire TV.
 * Abre la web del servidor a pantalla completa; la web ya está preparada para el mando
 * (flechas, OK, Atrás, Play/Pausa, Avance/Retroceso).
 */
class MainActivity : Activity() {


    private var web: WebView? = null
    private val isTv by lazy {
        (getSystemService(UI_MODE_SERVICE) as UiModeManager).currentModeType == Configuration.UI_MODE_TYPE_TELEVISION ||
            packageManager.hasSystemFeature("android.software.leanback") ||
            packageManager.hasSystemFeature("amazon.hardware.fire_tv")
    }
    private val prefs by lazy { getSharedPreferences("nubecine", MODE_PRIVATE) }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        window.addFlags(WindowManager.LayoutParams.FLAG_KEEP_SCREEN_ON)
        if (isTv) requestedOrientation = android.content.pm.ActivityInfo.SCREEN_ORIENTATION_LANDSCAPE
        window.decorView.setBackgroundColor(Color.parseColor("#0A0C10"))

        // La dirección antigua por IP pasa a la nueva con HTTPS (cine.morvehtv.com)
        if (prefs.getString("url", "")?.contains("94.143.140.93") == true) prefs.edit().remove("url").apply()
        val saved = prefs.getString("url", null)
        val url = saved ?: BuildConfig.SERVER_URL.takeIf { it.isNotBlank() }
        if (url == null) askForServer() else openWeb(url)
    }

    private val updater by lazy { Updater(this) }

    // Mientras la app está abierta, busca actualizaciones cada 15 minutos
    private val updateHandler = android.os.Handler(android.os.Looper.getMainLooper())
    private val periodicUpdate = object : Runnable {
        override fun run() {
            updater.checkInBackground()
            updateHandler.postDelayed(this, 15 * 60 * 1000L)
        }
    }

    // ---------- Primera configuración: dirección del servidor ----------
    private fun askForServer(current: String = "") {
        val input = EditText(this).apply {
            hint = "https://tu-dominio.com"
            setText(current)
            setSingleLine()
            inputType = InputType.TYPE_CLASS_TEXT or InputType.TYPE_TEXT_VARIATION_URI
        }
        AlertDialog.Builder(this)
            .setTitle("Dirección del servidor")
            .setMessage("Escribe la dirección de tu web (la misma que abres en el navegador).")
            .setView(input)
            .setCancelable(false)
            .setPositiveButton("Conectar") { _, _ ->
                var u = input.text.toString().trim().trimEnd('/')
                if (u.isEmpty()) { askForServer(); return@setPositiveButton }
                if (!u.startsWith("http://") && !u.startsWith("https://")) u = "https://$u"
                prefs.edit().putString("url", u).apply()
                openWeb(u)
            }
            .setNegativeButton("Salir") { _, _ -> finish() }
            .show()
        input.requestFocus()
    }

    // ---------- WebView ----------
    @SuppressLint("SetJavaScriptEnabled")
    private fun openWeb(url: String) {
        val home = Uri.parse(url)
        val view = WebView(this)
        web = view
        setContentView(view)

        view.setBackgroundColor(Color.parseColor("#0A0C10"))
        view.isFocusable = true
        view.isFocusableInTouchMode = true
        view.setLayerType(View.LAYER_TYPE_HARDWARE, null)

        with(view.settings) {
            javaScriptEnabled = true
            domStorageEnabled = true
            mediaPlaybackRequiresUserGesture = false
            loadWithOverviewMode = true
            useWideViewPort = true
            userAgentString = "$userAgentString NubeCineApp/1.0" + (if (isTv) " Android TV" else "")
        }
        CookieManager.getInstance().setAcceptCookie(true)
        CookieManager.getInstance().setAcceptThirdPartyCookies(view, false)

        // Puente JS: la web detecta window.NubeTV y activa el modo TV
        view.addJavascriptInterface(Bridge(), "NubeTV")

        view.webViewClient = object : WebViewClient() {
            override fun shouldOverrideUrlLoading(v: WebView, req: WebResourceRequest): Boolean {
                // Solo se navega dentro del propio servidor
                return req.url.host != home.host
            }

            override fun onReceivedError(v: WebView, req: WebResourceRequest, err: WebResourceError) {
                if (req.isForMainFrame) showConnectionError(url)
            }
        }
        view.webChromeClient = WebChromeClient()
        view.requestFocus()
        view.loadUrl(url)
    }

    private fun showConnectionError(url: String) {
        if (isFinishing) return
        AlertDialog.Builder(this)
            .setTitle("No se puede conectar")
            .setMessage("No se ha podido abrir $url.\nComprueba la conexión a Internet y que el servidor esté encendido.")
            .setCancelable(false)
            .setPositiveButton("Reintentar") { _, _ -> web?.loadUrl(url) }
            .setNeutralButton("Cambiar servidor") { _, _ -> changeServer() }
            .setNegativeButton("Salir") { _, _ -> finish() }
            .show()
    }

    private fun changeServer() {
        val current = prefs.getString("url", "") ?: ""
        prefs.edit().remove("url").apply()
        web?.destroy()
        web = null
        setContentView(View(this))
        askForServer(current)
    }

    inner class Bridge {
        @JavascriptInterface fun exit() = runOnUiThread { finish() }
        @JavascriptInterface fun changeServer() = runOnUiThread { this@MainActivity.changeServer() }
        @JavascriptInterface fun version(): String = BuildConfig.VERSION_NAME
        @JavascriptInterface fun isTV(): Boolean = isTv
        /** El reproductor web pide pantalla completa (y horizontal en el móvil) al empezar un vídeo. */
        @JavascriptInterface
        fun fullscreen(on: Boolean) = runOnUiThread { setVideoMode(on) }
    }

    // ---------- Modo vídeo: horizontal y sin barras del sistema ----------
    private fun setVideoMode(on: Boolean) {
        if (!isTv) {
            requestedOrientation = if (on) android.content.pm.ActivityInfo.SCREEN_ORIENTATION_SENSOR_LANDSCAPE
            else android.content.pm.ActivityInfo.SCREEN_ORIENTATION_UNSPECIFIED
        }
        if (android.os.Build.VERSION.SDK_INT >= 30) {
            window.insetsController?.let {
                val bars = android.view.WindowInsets.Type.statusBars() or android.view.WindowInsets.Type.navigationBars()
                if (on) {
                    it.hide(bars)
                    it.systemBarsBehavior = android.view.WindowInsetsController.BEHAVIOR_SHOW_TRANSIENT_BARS_BY_SWIPE
                } else it.show(bars)
            }
        } else {
            @Suppress("DEPRECATION")
            window.decorView.systemUiVisibility = if (on) (View.SYSTEM_UI_FLAG_FULLSCREEN or View.SYSTEM_UI_FLAG_HIDE_NAVIGATION
                or View.SYSTEM_UI_FLAG_IMMERSIVE_STICKY or View.SYSTEM_UI_FLAG_LAYOUT_FULLSCREEN
                or View.SYSTEM_UI_FLAG_LAYOUT_HIDE_NAVIGATION or View.SYSTEM_UI_FLAG_LAYOUT_STABLE) else 0
        }
    }

    // ---------- Botón Atrás del mando ----------
    override fun dispatchKeyEvent(event: KeyEvent): Boolean {
        val view = web
        if (event.keyCode == KeyEvent.KEYCODE_BACK && view != null) {
            if (event.action == KeyEvent.ACTION_UP) {
                // La web decide: cerrar reproductor, volver atrás... Si devuelve false, salimos.
                view.evaluateJavascript("(window.handleBack && window.handleBack()) ? '1' : '0'") { r ->
                    if (r != "\"1\"") finish()
                }
            }
            return true
        }
        return super.dispatchKeyEvent(event)
    }

    override fun onPause() {
        super.onPause()
        updateHandler.removeCallbacks(periodicUpdate)
        CookieManager.getInstance().flush()
        web?.onPause()
    }

    override fun onResume() {
        super.onResume()
        web?.onResume()
        updateHandler.removeCallbacks(periodicUpdate)
        periodicUpdate.run() // busca y descarga actualizaciones de la app
    }

    override fun onDestroy() {
        web?.destroy()
        super.onDestroy()
    }
}
