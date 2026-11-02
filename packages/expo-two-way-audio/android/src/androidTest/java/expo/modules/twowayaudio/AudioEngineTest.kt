package expo.modules.twowayaudio

import AudioEngine
import android.app.Activity
import android.content.Context
import android.content.Intent
import android.media.AudioAttributes
import android.media.AudioFocusRequest
import android.media.AudioManager
import android.os.Handler
import android.os.Looper
import android.os.SystemClock
import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import androidx.test.filters.SdkSuppress
import org.junit.After
import org.junit.Assert.*
import org.junit.Before
import org.junit.Test
import org.junit.runner.RunWith
import java.util.concurrent.CopyOnWriteArrayList
import java.util.concurrent.atomic.AtomicInteger

class AudioEngineTestActivity : Activity()

/** Real AudioManager and AudioRecord: focus loss is delivered by Android, never injected. */
@RunWith(AndroidJUnit4::class)
class AudioEngineTest {
    private val instrumentation = InstrumentationRegistry.getInstrumentation()
    private lateinit var activity: Activity
    private lateinit var engine: AudioEngine
    private lateinit var audio: AudioManager
    private val packets = AtomicInteger()
    private val events = CopyOnWriteArrayList<String>()
    private val requests = mutableListOf<AudioFocusRequest>()

    @Before fun setUp() {
        val context = instrumentation.context
        shell("pm grant ${context.packageName} android.permission.RECORD_AUDIO")
        activity = instrumentation.startActivitySync(
            Intent(context, AudioEngineTestActivity::class.java).addFlags(Intent.FLAG_ACTIVITY_NEW_TASK)
        )
        instrumentation.waitForIdleSync()
        audio = activity.getSystemService(Context.AUDIO_SERVICE) as AudioManager
        main {
            engine = AudioEngine(activity)
            engine.onMicDataCallback = { packets.incrementAndGet() }
            engine.onAudioInterruptionCallback = { events.add(it) }
        }
    }

    @After fun tearDown() {
        shell("cmd sensor_privacy disable 0 microphone")
        main {
            requests.forEach { audio.abandonAudioFocusRequest(it) }
            engine.tearDown()
            activity.finish()
        }
    }

    @Test fun dictationContinuesWhenMusicTakesFocus() {
        assertDictationSurvives(AudioManager.AUDIOFOCUS_GAIN)
    }

    @Test fun dictationContinuesWhenFocusIsTemporarilyLost() {
        assertDictationSurvives(AudioManager.AUDIOFOCUS_GAIN_TRANSIENT)
    }

    @Test fun dictationContinuesWhenAnotherAppRequestsDucking() {
        assertDictationSurvives(AudioManager.AUDIOFOCUS_GAIN_TRANSIENT_MAY_DUCK)
    }

    @Test fun conversationStillStopsOnFocusLoss() {
        main { assertTrue(engine.toggleRecording(true)) }
        await("conversation microphone data") { packets.get() > 2 }
        takeFocus(AudioManager.AUDIOFOCUS_GAIN)
        await("terminal conversation interruption") { events.contains("blocked") }
        assertFalse(engine.isRecording)
    }

    @Test fun dictationStartsWhileMusicOwnsFocusAndCanBeStartedAgain() {
        takeFocus(AudioManager.AUDIOFOCUS_GAIN)
        startDictation()
        main { engine.toggleRecording(false); engine.releaseAudioSession() }
        val stoppedAt = packets.get()
        startDictation()
        await("new recording data") { packets.get() > stoppedAt + 2 }
        assertFalse(events.contains("blocked"))
    }

    @Test fun cancellingWhileBackgroundedDoesNotRestartOnResume() {
        startDictation()
        main {
            engine.pauseRecordingAndPlayer()
            engine.toggleRecording(false)
            engine.releaseAudioSession()
            engine.resumeRecordingAndPlayer()
        }
        assertFalse(engine.isRecording)
    }

    @Test fun dictationKeepsItsCaptureModeAfterBackgroundResume() {
        startDictation()
        main { engine.pauseRecordingAndPlayer(); engine.resumeRecordingAndPlayer() }
        val resumedAt = packets.get()
        takeFocus(AudioManager.AUDIOFOCUS_GAIN)
        await("resumed dictation data after focus loss") { packets.get() > resumedAt + 3 }
        assertTrue(engine.isRecording)
        assertFalse(events.contains("blocked"))
    }

    @Test @SdkSuppress(minSdkVersion = 31)
    fun microphonePrivacyInterruptionPreservesCaptureAndRecovers() {
        startDictation()
        shell("cmd sensor_privacy enable 0 microphone")
        await("input paused") { events.contains("capture_paused") }
        assertTrue(engine.isRecording)
        assertFalse(events.contains("blocked"))
        // Once Android reports silencing, do not enqueue artificial silence for transcription.
        SystemClock.sleep(100)
        val pausedAt = packets.get()
        SystemClock.sleep(150)
        assertEquals(pausedAt, packets.get())
        shell("cmd sensor_privacy disable 0 microphone")
        await("input resumed") { events.contains("capture_resumed") }
        await("microphone data after recovery") { packets.get() > pausedAt + 3 }
        assertTrue(engine.isRecording)
        assertEquals(listOf("capture_paused", "capture_resumed"), events.toList())
    }

    @Test @SdkSuppress(minSdkVersion = 31)
    fun startingWithMicrophonePrivacyEnabledWaitsAndRecovers() {
        shell("cmd sensor_privacy enable 0 microphone")
        main { assertTrue(engine.startDictation()) }
        await("initial input paused") { events.contains("capture_paused") }
        assertTrue(engine.isRecording)
        assertFalse(events.contains("blocked"))
        shell("cmd sensor_privacy disable 0 microphone")
        await("initial input resumed") { events.contains("capture_resumed") }
        await("microphone data") { packets.get() > 3 }
    }

    @Test fun resumingDictationDoesNotTakeFocusBackFromMusic() {
        startDictation()
        main { engine.pauseRecordingAndPlayer() }
        val changes = CopyOnWriteArrayList<Int>()
        val request = AudioFocusRequest.Builder(AudioManager.AUDIOFOCUS_GAIN)
            .setOnAudioFocusChangeListener({ changes.add(it) }, Handler(Looper.getMainLooper()))
            .build()
        requests.add(request)
        main { assertEquals(AudioManager.AUDIOFOCUS_REQUEST_GRANTED, audio.requestAudioFocus(request)) }
        val before = packets.get()
        main { engine.resumeRecordingAndPlayer() }
        await("resumed microphone data") { packets.get() > before + 3 }
        assertTrue(engine.isRecording)
        assertTrue("Music lost focus on dictation resume: $changes", changes.isEmpty())
    }

    @Test @SdkSuppress(minSdkVersion = 31)
    fun stoppingDictationReleasesTheCommunicationRoute() {
        startDictation()
        await("selected communication route") { hasCommunicationRoute() }
        main { engine.toggleRecording(false); engine.releaseAudioSession() }
        await("normal audio mode") { audio.mode == AudioManager.MODE_NORMAL }
        await("cleared communication route") { !hasCommunicationRoute() }
        assertFalse(engine.isRecording)
    }

    private fun assertDictationSurvives(gain: Int) {
        startDictation()
        val before = packets.get()
        val request = takeFocus(gain)
        await("microphone data while focus is lost") { packets.get() > before + 3 }
        assertTrue(engine.isRecording)
        assertFalse(events.contains("blocked"))
        val during = packets.get()
        main { audio.abandonAudioFocusRequest(request) }
        await("microphone data after focus release") { packets.get() > during + 3 }
        assertTrue(engine.isRecording)
        assertFalse(events.contains("blocked"))
    }

    private fun startDictation() {
        val before = packets.get()
        main { assertTrue(engine.startDictation()) }
        await("initial microphone data") { packets.get() > before + 3 }
    }

    private fun takeFocus(gain: Int): AudioFocusRequest {
        val request = AudioFocusRequest.Builder(gain)
            .setAudioAttributes(AudioAttributes.Builder()
                .setUsage(AudioAttributes.USAGE_MEDIA)
                .setContentType(AudioAttributes.CONTENT_TYPE_MUSIC).build())
            .setOnAudioFocusChangeListener({}, Handler(Looper.getMainLooper()))
            .build()
        requests.add(request)
        main { assertEquals(AudioManager.AUDIOFOCUS_REQUEST_GRANTED, audio.requestAudioFocus(request)) }
        return request
    }

    private fun main(action: () -> Unit) = instrumentation.runOnMainSync(action)

    private fun await(description: String, condition: () -> Boolean) {
        val deadline = SystemClock.elapsedRealtime() + 5000
        while (!condition() && SystemClock.elapsedRealtime() < deadline) SystemClock.sleep(20)
        assertTrue("Timed out waiting for $description; events=$events packets=${packets.get()}", condition())
    }

    // communicationDevice reports the effective system device even after our selection is cleared.
    // Inspect only current route clients, never the historical routing event log.
    private fun hasCommunicationRoute(): Boolean {
        val dump = shell("dumpsys audio")
        assertTrue("Missing Android communication route diagnostics", dump.contains("Communication route clients:"))
        return dump.lineSequence().any {
            it.trimStart().startsWith("[CommunicationRouteClient: mUid: ${android.os.Process.myUid()} ")
        }
    }

    private fun shell(command: String): String =
        instrumentation.uiAutomation.executeShellCommand(command).use {
            android.os.ParcelFileDescriptor.AutoCloseInputStream(it).readBytes().toString(Charsets.UTF_8)
        }
}
