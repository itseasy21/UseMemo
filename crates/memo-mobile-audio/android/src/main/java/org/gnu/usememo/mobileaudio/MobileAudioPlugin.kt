package org.gnu.usememo.mobileaudio

import android.Manifest
import android.app.Activity
import android.content.Context
import android.media.AudioAttributes
import android.media.AudioFocusRequest
import android.media.AudioManager
import android.os.Build
import app.tauri.PermissionState
import app.tauri.annotation.Command
import app.tauri.annotation.Permission
import app.tauri.annotation.PermissionCallback
import app.tauri.annotation.TauriPlugin
import app.tauri.plugin.Invoke
import app.tauri.plugin.JSObject
import app.tauri.plugin.Plugin

@TauriPlugin(
    permissions = [
        Permission(
            strings = [Manifest.permission.RECORD_AUDIO],
            alias = "microphone",
        )
    ]
)
class MobileAudioPlugin(private val activity: Activity) : Plugin(activity) {
    private val audioManager =
        activity.getSystemService(Context.AUDIO_SERVICE) as AudioManager
    private val focusListener = object : AudioManager.OnAudioFocusChangeListener {
        override fun onAudioFocusChange(focusChange: Int) {}
    }
    private var focusRequest: AudioFocusRequest? = null

    @Command
    fun microphonePermission(invoke: Invoke) {
        invoke.resolve(permissionResult())
    }

    @Command
    fun requestMicrophonePermission(invoke: Invoke) {
        if (getPermissionState("microphone") == PermissionState.GRANTED) {
            invoke.resolve(permissionResult())
            return
        }
        requestPermissionForAlias("microphone", invoke, "microphonePermissionCallback")
    }

    @PermissionCallback
    private fun microphonePermissionCallback(invoke: Invoke) {
        invoke.resolve(permissionResult())
    }

    /**
     * Ask for transient-exclusive focus so other playback does not bleed into
     * the microphone. Focus is advisory; capture still proceeds if denied.
     */
    @Command
    fun configureAudioSession(invoke: Invoke) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val request = AudioFocusRequest.Builder(
                AudioManager.AUDIOFOCUS_GAIN_TRANSIENT_EXCLUSIVE
            )
                .setAudioAttributes(
                    AudioAttributes.Builder()
                        .setUsage(AudioAttributes.USAGE_VOICE_COMMUNICATION)
                        .setContentType(AudioAttributes.CONTENT_TYPE_SPEECH)
                        .build()
                )
                .setOnAudioFocusChangeListener(focusListener)
                .build()
            focusRequest = request
            audioManager.requestAudioFocus(request)
        } else {
            @Suppress("DEPRECATION")
            audioManager.requestAudioFocus(
                focusListener,
                AudioManager.STREAM_VOICE_CALL,
                AudioManager.AUDIOFOCUS_GAIN_TRANSIENT_EXCLUSIVE
            )
        }

        val result = JSObject()
        result.put("configured", true)
        result.put("backend", "android")
        invoke.resolve(result)
    }

    @Command
    fun deactivateAudioSession(invoke: Invoke) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            focusRequest?.let { audioManager.abandonAudioFocusRequest(it) }
            focusRequest = null
        } else {
            @Suppress("DEPRECATION")
            audioManager.abandonAudioFocus(focusListener)
        }
        val result = JSObject()
        result.put("deactivated", true)
        invoke.resolve(result)
    }

    private fun permissionResult(): JSObject {
        val result = JSObject()
        val status = when (getPermissionState("microphone")) {
            PermissionState.GRANTED -> "granted"
            PermissionState.DENIED -> "denied"
            else -> "prompt"
        }
        result.put("status", status)
        return result
    }
}
