package sh.paseo.watch.data

import android.content.Context
import android.net.Uri
import android.util.Log
import com.google.android.gms.wearable.Asset
import com.google.android.gms.wearable.DataClient
import com.google.android.gms.wearable.DataEvent
import com.google.android.gms.wearable.DataEventBuffer
import com.google.android.gms.wearable.DataItem
import com.google.android.gms.wearable.DataMapItem
import com.google.android.gms.wearable.Wearable
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.launch
import kotlinx.coroutines.tasks.await
import kotlinx.coroutines.withContext
import sh.paseo.watch.model.AgentSession
import sh.paseo.watch.model.LiveVoiceState
import sh.paseo.watch.model.Transcript
import sh.paseo.watch.model.Workspace

private const val TAG = "PaseoWear"

/** What the UI needs to know about the phone link, and nothing more. */
enum class LinkState {
  /** No snapshot yet and no known phone — show setup guidance. */
  Waiting,

  /** Snapshot received; normal operation. */
  Linked,

  /** We had data, but the phone is not currently reachable. */
  Stale,
}

/**
 * [WatchRepository] backed by the Wearable Data Layer.
 *
 * Snapshots arrive as a DataItem on [WearBridge.SNAPSHOT_PATH]. DataClient is the
 * right primitive for this: it persists, syncs on its own schedule, and — crucially —
 * redelivers the latest item when the watch comes back into range, so the list is
 * never blank just because the link blipped.
 *
 * Commands go out over MessageClient, which fails fast when the phone is
 * unreachable. That is deliberate: silently queueing "approve this permission" for
 * later delivery would be worse than an honest failure.
 */
class DataLayerRepository(
  context: Context,
  private val scope: CoroutineScope,
) : WatchRepository, DataClient.OnDataChangedListener {

  private val appContext = context.applicationContext
  private val dataClient: DataClient = Wearable.getDataClient(appContext)
  private val messageClient = Wearable.getMessageClient(appContext)
  private val nodeClient = Wearable.getNodeClient(appContext)

  private val state = MutableStateFlow<List<Workspace>>(emptyList())
  override val workspaces: StateFlow<List<Workspace>> = state

  private val transcriptState = MutableStateFlow<Map<String, Transcript>>(emptyMap())
  override val transcripts: StateFlow<Map<String, Transcript>> = transcriptState

  private val iconState = MutableStateFlow<Map<String, ByteArray>>(emptyMap())
  override val icons: StateFlow<Map<String, ByteArray>> = iconState

  private val liveVoiceState = MutableStateFlow(LiveVoiceState.Unknown)
  override val liveVoice: StateFlow<LiveVoiceState> = liveVoiceState

  private val link = MutableStateFlow(LinkState.Waiting)
  val linkState: StateFlow<LinkState> = link.asStateFlow()

  private val lastError = MutableStateFlow<String?>(null)
  val error: StateFlow<String?> = lastError.asStateFlow()

  /**
   * A second, distinct listener object for the transcript prefix.
   *
   * Play Services keys a live listener registration by the listener **object**, not
   * by the URI filter it was registered with. Registering `this` twice with two
   * different filters is therefore not two subscriptions: the second registration
   * can replace the first, and we would silently lose one of the two streams —
   * either snapshots or transcripts, with no error on either side. Two filters means
   * two objects.
   */
  private val transcriptListener =
    object : DataClient.OnDataChangedListener {
      override fun onDataChanged(events: DataEventBuffer) = handleEvents(events)
    }

  /** A third filter, so — per the rule above — a third listener object. */
  private val iconListener =
    object : DataClient.OnDataChangedListener {
      override fun onDataChanged(events: DataEventBuffer) = handleEvents(events)
    }

  /** A fourth filter, so — per the rule above — a fourth listener object. */
  private val liveVoiceListener =
    object : DataClient.OnDataChangedListener {
      override fun onDataChanged(events: DataEventBuffer) = handleEvents(events)
    }

  fun start() {
    dataClient.addListener(this, android.net.Uri.parse("wear://*$SNAPSHOT_PATH_SUFFIX"), DataClient.FILTER_PREFIX)
    // Transcripts live one-per-agent under a prefix, so this filter is a prefix
    // match on the directory rather than a single path.
    dataClient.addListener(
      transcriptListener,
      android.net.Uri.parse("wear://*$TRANSCRIPT_PATH_PREFIX/"),
      DataClient.FILTER_PREFIX,
    )
    // Icons are one-per-project under their own prefix, same shape as transcripts.
    dataClient.addListener(
      iconListener,
      android.net.Uri.parse("wear://*$ICON_PATH_PREFIX/"),
      DataClient.FILTER_PREFIX,
    )
    // Live Voice is a single item, like the snapshot, so this is a suffix match.
    dataClient.addListener(
      liveVoiceListener,
      android.net.Uri.parse("wear://*$LIVE_VOICE_PATH_SUFFIX"),
      DataClient.FILTER_PREFIX,
    )
    // Read whatever is already cached before asking for anything new: this is what
    // makes the list appear instantly on launch instead of after a round trip. The
    // same pass picks up transcripts, so reopening an agent renders its scrollback
    // immediately while the fresh copy is still in flight.
    scope.launch { loadCachedDataItems() }
    scope.launch { requestRefresh() }
  }

  fun stop() {
    dataClient.removeListener(this)
    dataClient.removeListener(transcriptListener)
    dataClient.removeListener(iconListener)
    dataClient.removeListener(liveVoiceListener)
  }

  override fun onDataChanged(events: DataEventBuffer) = handleEvents(events)

  /**
   * Shared by both listeners. Dispatch is by path rather than by which listener
   * fired, so a filter that delivers more than we asked for still routes correctly.
   */
  private fun handleEvents(events: DataEventBuffer) {
    for (event in events) {
      val path = event.dataItem.uri.path.orEmpty()
      // Icons are the only stream that cares about deletion: an item that goes away
      // means the project lost its icon, and keeping the last one we saw would show
      // a glyph the phone no longer believes in.
      if (path.contains(ICON_PATH_MARKER)) {
        if (event.type == DataEvent.TYPE_DELETED) dropIcon(path) else applyIconItem(path, event.dataItem)
        continue
      }
      // A deleted Live Voice item means the phone signed out or dropped the
      // feature. Keeping the last state we saw would leave a hang-up button that
      // can never reach a call.
      if (path.endsWith(LIVE_VOICE_PATH_SUFFIX) && event.type == DataEvent.TYPE_DELETED) {
        liveVoiceState.value = LiveVoiceState.Unknown
        continue
      }
      if (event.type != DataEvent.TYPE_CHANGED) continue
      val raw = DataMapItem.fromDataItem(event.dataItem).dataMap.getString(WearBridge.SNAPSHOT_KEY)
      when {
        path.endsWith(SNAPSHOT_PATH_SUFFIX) -> applySnapshot(raw)
        path.endsWith(LIVE_VOICE_PATH_SUFFIX) -> applyLiveVoice(raw)
        path.contains(TRANSCRIPT_PATH_MARKER) -> applyTranscript(raw)
      }
    }
    events.release()
  }

  private suspend fun loadCachedDataItems() {
    val items =
      runCatching { dataClient.dataItems.await() }
        .onFailure { Log.w(TAG, "Failed to read cached data items", it) }
        .getOrNull() ?: return
    try {
      for (item in items) {
        val path = item.uri.path.orEmpty()
        if (path.contains(ICON_PATH_MARKER)) {
          applyIconItem(path, item)
          continue
        }
        val raw = DataMapItem.fromDataItem(item).dataMap.getString(WearBridge.SNAPSHOT_KEY)
        when {
          path.endsWith(SNAPSHOT_PATH_SUFFIX) -> applySnapshot(raw)
          path.endsWith(LIVE_VOICE_PATH_SUFFIX) -> applyLiveVoice(raw)
          path.contains(TRANSCRIPT_PATH_MARKER) -> applyTranscript(raw)
        }
      }
    } finally {
      items.release()
    }
  }

  /**
   * Pull the icon [Asset] off the item and read it asynchronously.
   *
   * The Asset reference has to be taken **now**, while the buffer that owns the item
   * is still alive — `freeze()` detaches it from the buffer, which both the event
   * loop and the cached-item scan release as soon as they finish iterating. The
   * bytes themselves need a round trip through [DataClient.getFdForAsset], so that
   * part is off the main thread and necessarily lands after this returns.
   */
  private fun applyIconItem(path: String, item: DataItem) {
    val projectKey = projectKeyOf(path) ?: return
    val asset = DataMapItem.fromDataItem(item.freeze()).dataMap.getAsset(WearBridge.ICON_PAYLOAD_KEY)
    if (asset == null) {
      Log.w(TAG, "Icon item carried no asset")
      removeIcon(projectKey)
      return
    }
    scope.launch { applyIconAsset(projectKey, asset) }
  }

  private suspend fun applyIconAsset(projectKey: String, asset: Asset) {
    val bytes =
      withContext(Dispatchers.IO) {
        runCatching {
          val response = dataClient.getFdForAsset(asset).await()
          try {
            response.inputStream.use { it.readBytes() }
          } finally {
            response.release()
          }
        }
          .onFailure { Log.w(TAG, "Failed to read icon asset", it) }
          .getOrNull()
      }
    if (!isRenderableIconPayload(bytes)) {
      // An SVG, an ICO, or something that isn't an image at all. Not an error worth
      // surfacing: the colored initial is a complete fallback, and the phone is
      // allowed to publish icon formats this watch can't draw.
      Log.w(TAG, "Icon payload for $projectKey is not a decodable bitmap")
      removeIcon(projectKey)
      return
    }
    iconState.value = iconState.value + (projectKey to bytes!!)
  }

  private fun dropIcon(path: String) {
    val projectKey = projectKeyOf(path) ?: return
    removeIcon(projectKey)
  }

  private fun removeIcon(projectKey: String) {
    val current = iconState.value
    if (projectKey !in current) return
    iconState.value = current - projectKey
  }

  /**
   * `Uri.decode` is the exact inverse of the phone's `Uri.encode`; the split between
   * this and [encodedProjectKeyFromIconPath] is what keeps the path parsing itself
   * unit-testable without Android.
   */
  private fun projectKeyOf(path: String): String? =
    encodedProjectKeyFromIconPath(path)?.let { Uri.decode(it) }?.ifEmpty { null }

  private fun applyTranscript(raw: String?) {
    if (raw == null) return
    val wire = decodeTranscript(raw)
    if (wire == null || wire.agentId.isEmpty()) {
      // Malformed, or a protocol version we don't speak. Unlike a snapshot this is
      // not worth surfacing: a missing transcript already has a good fallback (the
      // summary card), and the snapshot path will raise the version complaint.
      Log.w(TAG, "Dropped unparseable or version-mismatched transcript")
      return
    }
    val incoming = wire.toTranscript()
    if (!shouldApplyTranscript(transcriptState.value[wire.agentId], incoming)) return
    transcriptState.value = transcriptState.value + (wire.agentId to incoming)
  }

  private fun applyLiveVoice(raw: String?) {
    if (raw == null) return
    val wire = decodeLiveVoice(raw)
    if (wire == null) {
      // Malformed, or a protocol version we don't speak. Unlike a snapshot this
      // needs no separate complaint: the snapshot path already raises the version
      // mismatch, and the Live Voice screen's unavailable state is a fine landing
      // place in the meantime.
      Log.w(TAG, "Dropped unparseable or version-mismatched live voice state")
      return
    }
    liveVoiceState.value = wire.toLiveVoiceState()
  }

  private fun applySnapshot(raw: String?) {
    if (raw == null) return
    val snapshot = decodeSnapshot(raw)
    if (snapshot == null) {
      // Either malformed or a protocol version we don't speak. Keep whatever we're
      // already showing rather than blanking the screen.
      Log.w(TAG, "Dropped unparseable or version-mismatched snapshot")
      lastError.value = "Update Paseo on your phone"
      return
    }
    lastError.value = null
    val workspaces = snapshot.toWorkspaces()
    state.value = workspaces
    link.value = LinkState.Linked
    pruneTranscripts(workspaces)
    pruneIcons(workspaces)
  }

  /** Keeps watch memory tracking the live agent set. See [retainingAgentsIn]. */
  private fun pruneTranscripts(workspaces: List<Workspace>) {
    val current = transcriptState.value
    val kept = current.retainingAgentsIn(workspaces)
    // Only publish when something actually went, so an unchanged agent set doesn't
    // wake every collector on each snapshot.
    if (kept.size != current.size) transcriptState.value = kept
  }

  /** Same rationale, keyed on project instead of agent. See [retainingProjectsIn]. */
  private fun pruneIcons(workspaces: List<Workspace>) {
    val current = iconState.value
    val kept = current.retainingProjectsIn(workspaces)
    if (kept.size != current.size) iconState.value = kept
  }

  override fun workspace(id: String): Workspace? = state.value.firstOrNull { it.id == id }

  override fun agent(id: String): AgentSession? =
    state.value.flatMap { it.agents }.firstOrNull { it.id == id }

  override suspend fun sendPrompt(agentId: String, text: String) {
    val agent = agent(agentId) ?: return
    send(
      WireCommand(
        kind = WireCommand.SEND_PROMPT,
        serverId = agent.serverId,
        agentId = agentId,
        text = text,
      ),
    )
  }

  override suspend fun createAgent(workspaceId: String, prompt: String) {
    val workspace = workspace(workspaceId) ?: return
    send(
      WireCommand(
        kind = WireCommand.CREATE_AGENT,
        serverId = workspace.serverId,
        workspaceId = workspaceId,
        text = prompt,
      ),
    )
  }

  override suspend fun respondToPermission(requestId: String, allow: Boolean) {
    val agent =
      state.value.flatMap { it.agents }.firstOrNull { it.pendingPermission?.id == requestId }
        ?: return
    send(
      WireCommand(
        kind = WireCommand.RESPOND_PERMISSION,
        serverId = agent.serverId,
        agentId = agent.id,
        requestId = requestId,
        allow = allow,
      ),
    )
    // Optimistically clear it so the button press feels instant. The phone's next
    // snapshot is authoritative and will correct this if the response was rejected.
    state.value =
      state.value.map { workspace ->
        workspace.copy(
          agents =
            workspace.agents.map {
              if (it.pendingPermission?.id == requestId) it.copy(pendingPermission = null) else it
            },
        )
      }
  }

  override suspend fun requestTranscript(agentId: String) {
    val agent = agent(agentId) ?: return
    send(
      WireCommand(
        kind = WireCommand.REQUEST_TRANSCRIPT,
        serverId = agent.serverId,
        agentId = agentId,
      ),
    )
  }

  override suspend fun stopAgent(agentId: String) {
    val agent = agent(agentId) ?: return
    send(
      WireCommand(
        kind = WireCommand.STOP_AGENT,
        serverId = agent.serverId,
        agentId = agentId,
      ),
    )
  }

  override suspend fun startLiveVoice(serverId: String) {
    send(WireCommand(kind = WireCommand.START_LIVE_VOICE, serverId = serverId))
  }

  /**
   * Both of these omit serverId: the phone's runtime owns the single active call
   * and already knows which host it is on. Naming one here would let a watch
   * holding a stale state item address a call that has since moved.
   */
  override suspend fun stopLiveVoice() {
    send(WireCommand(kind = WireCommand.STOP_LIVE_VOICE))
  }

  override suspend fun toggleLiveVoiceMute() {
    send(WireCommand(kind = WireCommand.TOGGLE_LIVE_VOICE_MUTE))
  }

  private suspend fun requestRefresh() {
    val payload = ByteArray(0)
    broadcast(WearBridge.REFRESH_PATH, payload)
  }

  private suspend fun send(command: WireCommand) {
    val payload = WearBridge.json.encodeToString(WireCommand.serializer(), command).toByteArray()
    broadcast(WearBridge.COMMAND_PATH, payload)
  }

  /**
   * Send to every connected node. There is normally exactly one phone, but a node
   * list of one is not guaranteed, and picking "the first" would silently drop the
   * command when the ordering isn't what we assumed.
   */
  private suspend fun broadcast(path: String, payload: ByteArray) {
    withContext(Dispatchers.IO) {
      val nodes =
        runCatching { nodeClient.connectedNodes.await() }
          .onFailure {
            Log.w(TAG, "Failed to list nodes", it)
            lastError.value = "Phone not reachable"
          }
          .getOrNull()
          .orEmpty()

      if (nodes.isEmpty()) {
        link.value = if (state.value.isEmpty()) LinkState.Waiting else LinkState.Stale
        lastError.value = "Phone not reachable"
        return@withContext
      }

      var delivered = false
      for (node in nodes) {
        val result =
          runCatching { messageClient.sendMessage(node.id, path, payload).await() }
            .onFailure { Log.w(TAG, "sendMessage to ${node.displayName} failed", it) }
        if (result.isSuccess) delivered = true
      }
      if (!delivered) {
        lastError.value = "Phone not reachable"
        link.value = if (state.value.isEmpty()) LinkState.Waiting else LinkState.Stale
      } else {
        lastError.value = null
      }
    }
  }

  private companion object {
    /**
     * DataItem URIs are `wear://<nodeId><path>`, so matching on the suffix avoids
     * hardcoding a node id.
     */
    const val SNAPSHOT_PATH_SUFFIX = WearBridge.SNAPSHOT_PATH

    /** Prefix for the per-agent transcript directory, minus the node id. */
    const val TRANSCRIPT_PATH_PREFIX = WearBridge.TRANSCRIPT_PATH_PREFIX

    /**
     * Transcript paths end in an agent id, so they can only be matched by looking
     * for the directory inside the URI rather than by suffix. The trailing slash
     * keeps `/paseo/transcripts-v2` (or any other future sibling) from matching.
     */
    const val TRANSCRIPT_PATH_MARKER = "$TRANSCRIPT_PATH_PREFIX/"

    /** Prefix for the per-project icon directory, minus the node id. */
    const val ICON_PATH_PREFIX = WearBridge.ICON_PATH_PREFIX

    /** Same shape as [TRANSCRIPT_PATH_MARKER]: the path ends in an encoded key. */
    const val ICON_PATH_MARKER = "$ICON_PATH_PREFIX/"

    /** A single item, so a suffix match like the snapshot's. */
    const val LIVE_VOICE_PATH_SUFFIX = WearBridge.LIVE_VOICE_PATH
  }
}
