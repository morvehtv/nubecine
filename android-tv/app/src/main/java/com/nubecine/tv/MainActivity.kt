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

    private companion object { const val REQ_PLAYER = 42 }

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

        val saved = prefs.getString("url", null)
        val url = saved ?: BuildConfig.SERVER_URL.takeIf { it.isNotBlank() }
        if (url == null) askForServer() else openWeb(url)
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
        @JavascriptInterface fun hasNativePlayer(): Boolean = true

        /** Abre el reproductor nativo (ExoPlayer) a pantalla completa. */
        @JavascriptInterface
        fun play(url: String, title: String, startSec: Double, subsJson: String, fileId: String) = runOnUiThread {
            val u = Uri.parse(url)
            val base = u.scheme + "://" + u.authority
            val i = Intent(this@MainActivity, PlayerActivity::class.java)
                .putExtra(PlayerActivity.EXTRA_URL, url)
                .putExtra(PlayerActivity.EXTRA_BASE, base)
                .putExtra(PlayerActivity.EXTRA_TITLE, title)
                .putExtra(PlayerActivity.EXTRA_START_MS, (startSec * 1000).toLong())
                .putExtra(PlayerActivity.EXTRA_SUBS, subsJson)
                .putExtra(PlayerActivity.EXTRA_FILE_ID, fileId)
            CookieManager.getInstance().flush()
            @Suppress("DEPRECATION")
            startActivityForResult(i, REQ_PLAYER)
        }
    }

    // ---------- Vuelta del reproductor nativo: la web guarda el progreso y muestra la ficha ----------
    @Deprecated("Activity result API clásica")
    override fun onActivityResult(requestCode: Int, resultCode: Int, data: Intent?) {
        @Suppress("DEPRECATION")
        super.onActivityResult(requestCode, resultCode, data)
        if (requestCode != REQ_PLAYER || data == null) return
        val fileId = (data.getStringExtra(PlayerActivity.EXTRA_FILE_ID) ?: "").replace("'", "")
        val pos = data.getDoubleExtra(PlayerActivity.RESULT_POS, 0.0)
        val dur = data.getDoubleExtra(PlayerActivity.RESULT_DUR, 0.0)
        web?.evaluateJavascript("window.onNativePlayerClosed && window.onNativePlayerClosed('$fileId', $pos, $dur)", null)
        web?.requestFocus()
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
        CookieManager.getInstance().flush()
        web?.onPause()
    }

    override fun onResume() {
        super.onResume()
        web?.onResume()
    }

    override fun onDestroy() {
        web?.destroy()
        super.onDestroy()
    }
}
