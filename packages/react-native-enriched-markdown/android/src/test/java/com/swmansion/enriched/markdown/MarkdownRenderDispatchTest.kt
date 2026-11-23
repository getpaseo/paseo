package com.swmansion.enriched.markdown

import java.util.concurrent.CountDownLatch
import java.util.concurrent.Executors
import java.util.concurrent.TimeUnit
import org.junit.Assert.*
import org.junit.Test

class MarkdownRenderDispatchTest {
  @Test fun populatedViewUpdatesBeforeReturningEvenWithBusyWorker() {
    val executor = Executors.newSingleThreadExecutor()
    val release = CountDownLatch(1)
    val started = CountDownLatch(1)
    try {
      executor.execute { started.countDown(); release.await() }
      assertTrue(started.await(5, TimeUnit.SECONDS))
      val caller = Thread.currentThread()
      var rendered = false
      dispatchMarkdownRender(true, executor) {
        assertSame(caller, Thread.currentThread())
        rendered = true
      }
      assertTrue(rendered)
    } finally {
      release.countDown()
      executor.shutdownNow()
    }
  }

  @Test fun firstMountPreparesOnWorker() {
    val executor = Executors.newSingleThreadExecutor()
    val finished = CountDownLatch(1)
    val caller = Thread.currentThread()
    var worker: Thread? = null
    try {
      dispatchMarkdownRender(false, executor) {
        worker = Thread.currentThread()
        finished.countDown()
      }
      assertTrue(finished.await(5, TimeUnit.SECONDS))
      assertNotSame(caller, worker)
    } finally {
      executor.shutdownNow()
    }
  }
}
