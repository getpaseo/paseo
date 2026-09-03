package sh.paseo.watch.data

import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import com.google.android.gms.wearable.PutDataMapRequest
import com.google.android.gms.wearable.Wearable
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.tasks.await
import kotlinx.coroutines.withTimeoutOrNull
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNotNull
import org.junit.Test
import org.junit.runner.RunWith
import sh.paseo.watch.model.ActivityState

/**
 * Exercises the real Data Layer read path on a device.
 *
 * This writes a DataItem from the watch itself rather than from a paired phone. That
 * still covers everything on this side of the link — listener registration, the URI
 * filter, JSON decode, model mapping — because DataClient delivers local puts to
 * local listeners. What it does NOT cover is the physical phone-to-watch hop; that
 * needs a paired device and is called out in the package README.
 */
@RunWith(AndroidJUnit4::class)
class DataLayerRepositoryTest {

  private val context = InstrumentationRegistry.getInstrumentation().targetContext

  private val snapshotJson =
    """
    {"v":1,"updatedAt":1750000000000,"workspaces":[
      {"id":"ws-1","name":"jubilant-wombat","projectKey":"github.com/getpaseo/paseo",
       "projectName":"paseo","serverId":"srv-1","agents":[
         {"id":"a-1","provider":"Claude","state":"needsInput","age":"1m",
          "permission":{"id":"perm-1","title":"Run command?","detail":"git push"}}]},
      {"id":"ws-2","name":"main","projectKey":"github.com/getpaseo/website",
       "projectName":"website","serverId":"srv-1","agents":[
         {"id":"a-2","provider":"Claude","state":"running","age":"3m"},
         {"id":"a-3","provider":"Codex","state":"idle","age":"2h"}]}
    ]}
    """.trimIndent()

  @Test
  fun repositoryPicksUpASnapshotPublishedToTheDataLayer() = runBlocking {
    val scope = CoroutineScope(SupervisorJob() + Dispatchers.Main)
    val repository = DataLayerRepository(context, scope)

    try {
      val request =
        PutDataMapRequest.create(WearBridge.SNAPSHOT_PATH).apply {
          dataMap.putString(WearBridge.SNAPSHOT_KEY, snapshotJson)
          dataMap.putLong("stamp", System.currentTimeMillis())
        }
      Wearable.getDataClient(context)
        .putDataItem(request.asPutDataRequest().setUrgent())
        .await()

      repository.start()

      // start() reads the cached item immediately, so this normally resolves on the
      // first poll; the timeout is for the case where DataClient defers delivery.
      val workspaces =
        withTimeoutOrNull(15_000) {
          var current = repository.workspaces.value
          while (current.isEmpty()) {
            kotlinx.coroutines.delay(200)
            current = repository.workspaces.value
          }
          current
        }

      assertNotNull("Repository never received the published snapshot", workspaces)
      requireNotNull(workspaces)

      assertEquals(2, workspaces.size)

      val urgent = workspaces.first { it.id == "ws-1" }
      assertEquals("jubilant-wombat", urgent.name)
      assertEquals("srv-1", urgent.serverId)
      assertEquals(ActivityState.NeedsInput, urgent.state)
      assertEquals("perm-1", urgent.agents.single().pendingPermission?.id)
      assertEquals("git push", urgent.agents.single().pendingPermission?.detail)

      val multi = workspaces.first { it.id == "ws-2" }
      assertEquals(2, multi.agents.size)
      assertEquals(ActivityState.Running, multi.state)
    } finally {
      repository.stop()
      runCatching {
        val local = Wearable.getNodeClient(context).localNode.await()
        Wearable.getDataClient(context)
          .deleteDataItems(android.net.Uri.parse("wear://${local.id}${WearBridge.SNAPSHOT_PATH}"))
          .await()
      }
      scope.cancel()
    }
  }
}
