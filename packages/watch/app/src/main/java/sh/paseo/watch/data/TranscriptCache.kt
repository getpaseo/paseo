package sh.paseo.watch.data

import sh.paseo.watch.model.Transcript
import sh.paseo.watch.model.Workspace

/**
 * Policy for the watch's per-agent transcript cache.
 *
 * These are pure functions kept out of [DataLayerRepository] on purpose: they are
 * the part with edge cases worth pinning, and the repository itself cannot be
 * instantiated without Play Services, so anything inside it is only reachable from
 * an on-device test.
 */

/**
 * Whether an arriving transcript should replace the one already held for that agent.
 *
 * The cached-DataItem scan at startup races the live listener, and the two can
 * deliver the same agent's transcript in either order — so arrival order is not
 * recency order. Strictly-older loses. Equal still applies: identical timestamps
 * mean identical content, so re-applying costs nothing and avoids a rule that
 * depends on which copy got there first.
 */
fun shouldApplyTranscript(held: Transcript?, incoming: Transcript): Boolean =
  held == null || incoming.updatedAt >= held.updatedAt

/**
 * Keep only the transcripts whose agent still exists somewhere in [workspaces].
 *
 * Without this the cache keeps an entry for every agent ever opened, for as long as
 * the app lives — an archived agent's conversation would sit in watch memory
 * forever. The snapshot is authoritative about which agents exist, so it is the
 * right thing to prune against.
 */
fun Map<String, Transcript>.retainingAgentsIn(
  workspaces: List<Workspace>,
): Map<String, Transcript> {
  if (isEmpty()) return this
  val live = workspaces.flatMapTo(mutableSetOf()) { workspace ->
    workspace.agents.map { "${workspace.serverId}\u0000${it.id}" }
  }
  return filterKeys { it in live }
}
