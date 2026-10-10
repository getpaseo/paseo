package sh.paseo.ssh

import java.io.BufferedOutputStream
import java.io.ByteArrayOutputStream
import java.io.IOException
import java.io.OutputStream
import org.junit.Assert.assertArrayEquals
import org.junit.Assert.assertThrows
import org.junit.Test

class SshChannelSocketTest {
  @Test fun smallFramesReachTheRemoteReaderWithoutAnExplicitFlush() {
    val remote = ByteArrayOutputStream()
    val channel = BufferedOutputStream(remote, 8192)
    val socket = SshWriteThroughOutputStream(channel)

    socket.write(byteArrayOf(1, 2, 3))
    assertArrayEquals(byteArrayOf(1, 2, 3), remote.toByteArray())
    socket.write(4)
    assertArrayEquals(byteArrayOf(1, 2, 3, 4), remote.toByteArray())
  }

  @Test fun aDisconnectedChannelFailsTheWriteImmediately() {
    val channel = object : OutputStream() {
      override fun write(value: Int) {}
      override fun flush() { throw IOException("Disconnected") }
    }
    val socket = SshWriteThroughOutputStream(channel)
    assertThrows(IOException::class.java) { socket.write(byteArrayOf(1, 2, 3)) }
  }
}
