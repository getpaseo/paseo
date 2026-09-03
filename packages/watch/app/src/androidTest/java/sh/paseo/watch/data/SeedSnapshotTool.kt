package sh.paseo.watch.data

import androidx.test.ext.junit.runners.AndroidJUnit4
import androidx.test.platform.app.InstrumentationRegistry
import com.google.android.gms.wearable.PutDataMapRequest
import com.google.android.gms.wearable.Wearable
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.tasks.await
import org.junit.Test
import org.junit.runner.RunWith

/**
 * Not a test — a tool. Publishes a realistic snapshot to the Data Layer and leaves
 * it there so the app can be launched and screenshotted against real wire JSON
 * without a paired phone.
 *
 *   gradle :app:connectedDebugAndroidTest \
 *     -Pandroid.testInstrumentationRunnerArguments.class=sh.paseo.watch.data.SeedSnapshotTool
 *
 * The payload below is the exact shape packages/app/src/wear/wear-snapshot.ts emits.
 */
@RunWith(AndroidJUnit4::class)
class SeedSnapshotTool {

  private val payload =
    """
    {"v":1,"updatedAt":1750000000000,"workspaces":[
      {"id":"ws-jubilant","name":"jubilant-wombat","projectKey":"github.com/getpaseo/paseo",
       "projectName":"paseo","serverId":"srv-1","agents":[
        {"id":"a-jubilant","provider":"Claude","state":"needsInput","age":"1m",
         "summary":"Branch is ready. Needs a push before opening the change request.",
         "permission":{"id":"perm-1","title":"Run command?","detail":"git push origin jubilant-wombat"}}]},
      {"id":"ws-crimson","name":"crimson-falcon","projectKey":"github.com/getpaseo/paseo",
       "projectName":"paseo","serverId":"srv-1","agents":[
        {"id":"a-crimson","provider":"Claude","state":"running","age":"12m",
         "summary":"Rewrote the retry loop in relay-transport.ts; running the transport tests now."}]},
      {"id":"ws-main","name":"main","projectKey":"github.com/getpaseo/website",
       "projectName":"website","serverId":"srv-1","agents":[
        {"id":"a-main-claude","provider":"Claude","state":"running","age":"3m","intent":"docs rewrite",
         "summary":"Restructured the landing page copy; rebuilding the site."},
        {"id":"a-main-codex","provider":"Codex","state":"idle","age":"2h",
         "summary":"Pricing table is responsive at 320px."},
        {"id":"a-main-copilot","provider":"Copilot","state":"idle","age":"4h",
         "summary":"Redirect config already covers it."}]},
      {"id":"ws-relay","name":"relay-tls","projectKey":"github.com/getpaseo/paseo-relay",
       "projectName":"relay","serverId":"srv-1","agents":[]}
    ]}
    """.trimIndent()

  // Must return Unit: JUnit4 rejects a test method with a non-void return type, and
  // runBlocking would otherwise hand back the DataItem.
  @Test
  fun seed() {
    runBlocking {
      val context = InstrumentationRegistry.getInstrumentation().targetContext
      val request =
        PutDataMapRequest.create(WearBridge.SNAPSHOT_PATH).apply {
          dataMap.putString(WearBridge.SNAPSHOT_KEY, payload)
          dataMap.putLong("stamp", System.currentTimeMillis())
        }
      Wearable.getDataClient(context)
        .putDataItem(request.asPutDataRequest().setUrgent())
        .await()
    }
  }
}
