package org.gnu.usememo.mobileaudio

import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.ServiceInfo
import android.os.Build
import android.os.IBinder
import android.os.PowerManager

class RecordingForegroundService : Service() {
    private var wakeLock: PowerManager.WakeLock? = null

    override fun onCreate() {
        super.onCreate()
        val pm = getSystemService(Context.POWER_SERVICE) as PowerManager
        wakeLock = pm.newWakeLock(
            PowerManager.PARTIAL_WAKE_LOCK,
            "UseMemo::LocalAudioCaptureWakeLock"
        ).apply {
            setReferenceCounted(false)
            acquire(4 * 60 * 60 * 1000L) // Bounded 4-hour safety ceiling
        }
    }

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        val notification = buildNotification()
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
            val fgsType = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.R) {
                ServiceInfo.FOREGROUND_SERVICE_TYPE_MICROPHONE
            } else {
                0
            }
            if (fgsType != 0) {
                startForeground(NOTIFICATION_ID, notification, fgsType)
            } else {
                startForeground(NOTIFICATION_ID, notification)
            }
        } else {
            startForeground(NOTIFICATION_ID, notification)
        }
        return START_STICKY
    }

    override fun onDestroy() {
        try {
            wakeLock?.let {
                if (it.isHeld) it.release()
            }
        } catch (_: Throwable) {
        }
        wakeLock = null
        super.onDestroy()
    }

    override fun onBind(intent: Intent?): IBinder? = null

    private fun buildNotification(): Notification {
        val manager = getSystemService(Context.NOTIFICATION_SERVICE) as NotificationManager
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            val channel = NotificationChannel(
                CHANNEL_ID,
                "Local Audio Recording",
                NotificationManager.IMPORTANCE_LOW
            ).apply {
                description = "Keeps on-device meeting audio recording active while screen is off"
                setShowBadge(false)
            }
            manager.createNotificationChannel(channel)
            return Notification.Builder(this, CHANNEL_ID)
                .setContentTitle("Recording local memo")
                .setContentText("Audio is saved strictly on this device.")
                .setSmallIcon(android.R.drawable.ic_btn_speak_now)
                .setOngoing(true)
                .build()
        }

        @Suppress("DEPRECATION")
        return Notification.Builder(this)
            .setContentTitle("Recording local memo")
            .setContentText("Audio is saved strictly on this device.")
            .setSmallIcon(android.R.drawable.ic_btn_speak_now)
            .setOngoing(true)
            .build()
    }

    companion object {
        private const val CHANNEL_ID = "memo_local_recording_channel"
        private const val NOTIFICATION_ID = 4102
    }
}
