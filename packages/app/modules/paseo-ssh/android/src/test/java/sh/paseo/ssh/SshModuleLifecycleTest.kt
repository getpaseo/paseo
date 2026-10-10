package sh.paseo.ssh

import java.util.concurrent.CountDownLatch
import java.util.concurrent.TimeUnit
import java.util.concurrent.atomic.AtomicReference
import org.junit.Assert.*
import org.junit.Test

class SshModuleLifecycleTest {
  @Test fun teardownRejectsAConnectionWhoseSetupFinishesLate() {
    val closed = mutableListOf<String>()
    val lifecycle = SshModuleLifecycle<String> { closed.add(it) }
    val loading = CountDownLatch(1)
    val resume = CountDownLatch(1)
    val failure = AtomicReference<Throwable>()
    var starts = 0
    val worker = Thread {
      try {
        lifecycle.withActive { Unit }
        // Stand in for credential loading or session construction outside the lifecycle lock.
        loading.countDown()
        check(resume.await(5, TimeUnit.SECONDS))
        lifecycle.registerAndStart("session", "resource") { starts++ }
      } catch (error: Throwable) { failure.set(error) }
    }
    worker.start()
    assertTrue(loading.await(5, TimeUnit.SECONDS))
    lifecycle.destroy {}
    resume.countDown()
    worker.join(5000)

    assertFalse(worker.isAlive)
    assertTrue(failure.get() is IllegalStateException)
    assertEquals(0, starts)
    assertEquals(listOf("resource"), closed)
    assertNull(lifecycle.get("session"))
  }

  @Test fun teardownClearsStagedSecretsAndPreventsLateStaging() {
    val lifecycle = SshModuleLifecycle<String> {}
    val staged = mutableMapOf<String, String>()
    lifecycle.withActive { staged["host"] = "secret" }
    lifecycle.destroy { staged.clear() }

    assertThrows(IllegalStateException::class.java) {
      lifecycle.withActive { staged["host"] = "late secret" }
    }
    assertTrue(staged.isEmpty())
  }

  @Test fun rejectingADuplicateDoesNotRemoveTheExistingSession() {
    lateinit var lifecycle: SshModuleLifecycle<Any>
    lifecycle = SshModuleLifecycle { lifecycle.remove("session", it) }
    val existing = Any()
    lifecycle.registerAndStart("session", existing) {}
    assertThrows(IllegalStateException::class.java) {
      lifecycle.registerAndStart("session", Any()) { fail("Duplicate started") }
    }
    assertSame(existing, lifecycle.get("session"))
    lifecycle.destroy {}
  }

  @Test fun teardownClosesRegisteredSessionsWithoutHoldingTheRegistryLock() {
    lateinit var lifecycle: SshModuleLifecycle<String>
    var closes = 0
    lifecycle = SshModuleLifecycle {
      val callback = Thread { lifecycle.remove("session") }
      callback.start()
      callback.join(5000)
      assertFalse(callback.isAlive)
      closes++
    }
    lifecycle.registerAndStart("session", "resource") {}
    lifecycle.destroy {}
    lifecycle.destroy {}
    assertEquals(1, closes)
    assertNull(lifecycle.get("session"))
  }
}
