package sh.paseo.wordstream

import android.view.Choreographer

/** Frame source owned by the native host; timestamps use the range props' epoch. */
interface WordFadeFrameClock {
  fun currentTimeMillis(): Long
  fun postFrameCallback(callback: Choreographer.FrameCallback)
  fun removeFrameCallback(callback: Choreographer.FrameCallback)
}

internal object AndroidWordFadeFrameClock : WordFadeFrameClock {
  override fun currentTimeMillis() = System.currentTimeMillis()
  override fun postFrameCallback(callback: Choreographer.FrameCallback) {
    Choreographer.getInstance().postFrameCallback(callback)
  }
  override fun removeFrameCallback(callback: Choreographer.FrameCallback) {
    Choreographer.getInstance().removeFrameCallback(callback)
  }
}
