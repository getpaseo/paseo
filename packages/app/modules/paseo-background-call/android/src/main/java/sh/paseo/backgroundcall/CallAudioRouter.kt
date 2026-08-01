package sh.paseo.backgroundcall

import android.content.Context
import android.media.AudioDeviceCallback
import android.media.AudioDeviceInfo
import android.media.AudioManager
import android.os.Build
import android.os.Handler
import android.os.Looper
import android.util.Log

private const val TAG = "PaseoCallAudio"

/**
 * Owns the audio route for an active Live Voice call.
 *
 * `react-native-webrtc` does not touch `AudioManager` on Android at all — it
 * leaves mode and routing to the app. Without this the call runs in
 * `MODE_NORMAL`, which costs the platform echo canceller and never engages a
 * Bluetooth headset's microphone, so a paired headset plays the agent but keeps
 * capturing from the phone.
 *
 * Choosing a communication device is also what puts a call on a Wear OS watch. A
 * watch with a speaker and mic presents to the phone as a Bluetooth SCO (or LE
 * Audio) headset, and WebRTC's recorder follows the communication route because
 * it captures from `VOICE_COMMUNICATION` — so no WebRTC-level change is needed to
 * talk into your wrist. That is the whole reason this exists.
 *
 * Devices are ranked by [AudioDeviceInfo.getType] and never by product name:
 * reading a Bluetooth device's name on Android 12+ needs `BLUETOOTH_CONNECT`,
 * while routing to it needs only `MODIFY_AUDIO_SETTINGS`, which the app already
 * holds. Keeping the ranking type-only is what keeps this from dragging in a
 * runtime permission prompt.
 */
internal object CallAudioRouter {
    private var audioManager: AudioManager? = null
    private var previousMode: Int? = null
    private var deviceCallback: AudioDeviceCallback? = null

    /**
     * Preference order.
     *
     * Bluetooth first, because the watch is the device this feature exists for and
     * a wired headset plugged into a phone that is in your pocket is the rarer
     * setup. With two Bluetooth audio devices connected — earbuds and a watch —
     * there is nothing here that can tell them apart, and the first the system
     * offers wins; disambiguating would mean asking the user, which a background
     * service has no way to do.
     *
     * The tail is speaker rather than earpiece, matching iOS's `.defaultToSpeaker`:
     * an agent call is hands-free by nature, and nobody holds a phone to their ear
     * for it.
     */
    private val PREFERRED_TYPES: List<Int>
        get() = buildList {
            if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
                add(AudioDeviceInfo.TYPE_BLE_HEADSET)
            }
            add(AudioDeviceInfo.TYPE_BLUETOOTH_SCO)
            add(AudioDeviceInfo.TYPE_WIRED_HEADSET)
            add(AudioDeviceInfo.TYPE_WIRED_HEADPHONES)
            add(AudioDeviceInfo.TYPE_USB_HEADSET)
            add(AudioDeviceInfo.TYPE_BUILTIN_SPEAKER)
        }

    fun attach(context: Context) {
        val manager = context.getSystemService(AudioManager::class.java) ?: return
        audioManager = manager

        if (previousMode == null) {
            previousMode = manager.mode
        }
        // WebRTC's recorder already asks for VOICE_COMMUNICATION, but the platform
        // only gives it the call-grade echo canceller and Bluetooth routing when
        // the whole device is in communication mode.
        runCatching { manager.mode = AudioManager.MODE_IN_COMMUNICATION }
            .onFailure { Log.w(TAG, "Failed to enter communication mode", it) }

        applyRoute(manager)
        registerDeviceCallback(manager)
    }

    fun detach() {
        val manager = audioManager ?: return
        audioManager = null

        deviceCallback?.let { manager.unregisterAudioDeviceCallback(it) }
        deviceCallback = null

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            runCatching { manager.clearCommunicationDevice() }
                .onFailure { Log.w(TAG, "Failed to clear the communication device", it) }
        } else {
            @Suppress("DEPRECATION")
            runCatching {
                if (manager.isBluetoothScoOn) {
                    manager.isBluetoothScoOn = false
                    manager.stopBluetoothSco()
                }
                manager.isSpeakerphoneOn = false
            }.onFailure { Log.w(TAG, "Failed to release the legacy audio route", it) }
        }

        // Restoring the mode matters more than it looks: leaving the device in
        // MODE_IN_COMMUNICATION ducks every other app's audio until something else
        // happens to reset it.
        previousMode?.let { mode ->
            runCatching { manager.mode = mode }
                .onFailure { Log.w(TAG, "Failed to restore the audio mode", it) }
        }
        previousMode = null
    }

    /**
     * Re-route when the set of devices changes.
     *
     * Without this the route is decided once, at the instant the call starts, and a
     * watch that finishes connecting a second later — or a headset unplugged
     * mid-call — never takes effect.
     */
    private fun registerDeviceCallback(manager: AudioManager) {
        if (deviceCallback != null) {
            return
        }
        val callback = object : AudioDeviceCallback() {
            override fun onAudioDevicesAdded(addedDevices: Array<out AudioDeviceInfo>?) {
                applyRoute(manager)
            }

            override fun onAudioDevicesRemoved(removedDevices: Array<out AudioDeviceInfo>?) {
                applyRoute(manager)
            }
        }
        runCatching {
            manager.registerAudioDeviceCallback(callback, Handler(Looper.getMainLooper()))
            deviceCallback = callback
        }.onFailure { Log.w(TAG, "Failed to watch for audio device changes", it) }
    }

    private fun applyRoute(manager: AudioManager) {
        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.S) {
            applyModernRoute(manager)
        } else {
            applyLegacyRoute(manager)
        }
    }

    private fun applyModernRoute(manager: AudioManager) {
        val available = runCatching { manager.availableCommunicationDevices }
            .onFailure { Log.w(TAG, "Failed to list communication devices", it) }
            .getOrNull()
            .orEmpty()
        if (available.isEmpty()) {
            return
        }

        val target = PREFERRED_TYPES.firstNotNullOfOrNull { type ->
            available.firstOrNull { it.type == type }
        } ?: return

        // Already there: re-setting the same device tears the Bluetooth SCO link
        // down and brings it back up, which is audible as a gap in the call.
        if (manager.communicationDevice?.id == target.id) {
            return
        }

        val accepted = runCatching { manager.setCommunicationDevice(target) }
            .onFailure { Log.w(TAG, "Failed to set communication device ${target.type}", it) }
            .getOrDefault(false)
        if (!accepted) {
            Log.w(TAG, "Communication device ${target.type} was refused")
        }
    }

    /**
     * Pre-Android 12 there is no device selection, only two toggles. Bluetooth SCO
     * has to be asked for explicitly and takes a moment to come up; the system
     * falls back to the speaker on its own if it never does.
     */
    @Suppress("DEPRECATION")
    private fun applyLegacyRoute(manager: AudioManager) {
        val hasBluetooth = runCatching {
            manager.getDevices(AudioManager.GET_DEVICES_OUTPUTS).any {
                it.type == AudioDeviceInfo.TYPE_BLUETOOTH_SCO
            }
        }.getOrDefault(false)

        runCatching {
            if (hasBluetooth) {
                manager.startBluetoothSco()
                manager.isBluetoothScoOn = true
                manager.isSpeakerphoneOn = false
                return
            }
            if (manager.isBluetoothScoOn) {
                manager.isBluetoothScoOn = false
                manager.stopBluetoothSco()
            }
            val hasWired = manager.getDevices(AudioManager.GET_DEVICES_OUTPUTS).any {
                it.type == AudioDeviceInfo.TYPE_WIRED_HEADSET ||
                    it.type == AudioDeviceInfo.TYPE_WIRED_HEADPHONES ||
                    it.type == AudioDeviceInfo.TYPE_USB_HEADSET
            }
            manager.isSpeakerphoneOn = !hasWired
        }.onFailure { Log.w(TAG, "Failed to apply the legacy audio route", it) }
    }
}
