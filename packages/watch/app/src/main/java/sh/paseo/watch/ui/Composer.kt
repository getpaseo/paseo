package sh.paseo.watch.ui

import android.app.Activity
import android.app.RemoteInput
import android.content.Intent
import android.speech.RecognizerIntent
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.runtime.Composable
import androidx.compose.runtime.remember
import androidx.wear.input.RemoteInputIntentHelper

/** Extra key the system input activity hands the typed text back under. */
private const val REMOTE_INPUT_RESULT_KEY = "sh.paseo.watch.reply"

/**
 * The two doors into a prompt string, launched on demand.
 *
 * **Voice** is Google's on-device recognizer via [RecognizerIntent], which is free,
 * works offline on Wear OS 3+, and returns a finished string — no audio ever touches
 * our code and there is no `RECORD_AUDIO` permission.
 *
 * **Text** is Wear's remote input activity via [androidx.wear.input.RemoteInputIntentHelper],
 * which opens the system input *picker*: keyboard, handwriting, emoji, and voice,
 * whichever the watch offers. Launching [RecognizerIntent] with a keyboard hint
 * instead buries text entry a tap inside the voice sheet and depends on a hint the
 * recognizer is free to ignore. Remote input is the platform's actual answer for
 * "let me type on a watch".
 *
 * Paseo's own daemon-side dictation (`dictation_stream_*`) is deliberately unused
 * here: with a phone-tethered transport, streaming PCM off the watch is a bad trade
 * against a free on-device recognizer. See design/README.md.
 */
class ComposerLaunchers(val launchVoice: () -> Unit, val launchText: () -> Unit)

/**
 * Wires both launchers to one [onText] sink.
 *
 * Lives here rather than on a screen because both entry points into a prompt — the
 * Reply button on the agent screen and the new-agent composer — need the identical
 * intent configuration, and two copies of it is two things to keep in step.
 *
 * [prompt] is what the recognizer shows above the waveform and what labels the
 * remote-input field, so it should read as an instruction ("Reply to claude").
 */
@Composable
fun rememberComposerLaunchers(prompt: String, onText: (String) -> Unit): ComposerLaunchers {
  val voiceLauncher =
    rememberLauncherForActivityResult(ActivityResultContracts.StartActivityForResult()) { result ->
      if (result.resultCode == Activity.RESULT_OK) {
        val spoken =
          composerText(
            result.data?.getStringArrayListExtra(RecognizerIntent.EXTRA_RESULTS)?.firstOrNull()
          )
        if (spoken != null) onText(spoken)
      }
    }

  val textLauncher =
    rememberLauncherForActivityResult(ActivityResultContracts.StartActivityForResult()) { result ->
      if (result.resultCode == Activity.RESULT_OK) {
        val typed =
          composerText(
            result.data
              ?.let { RemoteInput.getResultsFromIntent(it) }
              ?.getCharSequence(REMOTE_INPUT_RESULT_KEY)
          )
        if (typed != null) onText(typed)
      }
    }

  return remember(prompt, voiceLauncher, textLauncher) {
    ComposerLaunchers(
      launchVoice = { voiceLauncher.launch(voiceIntent(prompt)) },
      launchText = { textLauncher.launch(textEntryIntent(prompt)) },
    )
  }
}

private fun voiceIntent(prompt: String): Intent =
  Intent(RecognizerIntent.ACTION_RECOGNIZE_SPEECH).apply {
    putExtra(RecognizerIntent.EXTRA_LANGUAGE_MODEL, RecognizerIntent.LANGUAGE_MODEL_FREE_FORM)
    putExtra(RecognizerIntent.EXTRA_PROMPT, prompt)
    // Prefer on-device recognition so this keeps working with no phone and no
    // network. The system falls back to network recognition when unavailable.
    putExtra(RecognizerIntent.EXTRA_PREFER_OFFLINE, true)
  }

private fun textEntryIntent(prompt: String): Intent {
  // Exactly one RemoteInput: the system picker binds its result to this key, and a
  // second field would give the user a form where they asked for a text box.
  val remoteInputs =
    listOf(RemoteInput.Builder(REMOTE_INPUT_RESULT_KEY).setLabel(prompt).build())
  return RemoteInputIntentHelper.putRemoteInputsExtra(
    RemoteInputIntentHelper.createActionRemoteInputIntent(),
    remoteInputs,
  )
}

/**
 * What a composer result is worth sending: trimmed, or null.
 *
 * Both doors can hand back whitespace or nothing at all — a recognizer that heard
 * silence still returns `RESULT_OK` — and an empty prompt would show up in the
 * conversation as a turn that says nothing.
 */
internal fun composerText(raw: CharSequence?): String? = raw?.toString()?.trim()?.ifEmpty { null }
