package com.swmansion.enriched.markdown.segments

import android.view.View

data class ReconciliationResult(
  val views: List<View>,
  val signatures: List<Long>,
  val viewsToRemove: List<View>,
  val viewsToAttach: List<View>,
)

object SegmentReconciler {
  fun reconcile(
    currentViews: List<View>,
    currentSignatures: List<Long>,
    renderedSegments: List<RenderedSegment>,
    reset: Boolean,
    matchesKind: (View, RenderedSegment) -> Boolean,
    createView: (RenderedSegment) -> View,
    updateView: (View, RenderedSegment) -> Unit,
  ): ReconciliationResult {
    val resetRemovals = if (reset) currentViews else emptyList()
    val sourceViews = if (reset) emptyList() else currentViews
    val sourceSignatures = if (reset) emptyList() else currentSignatures

    val signatureToIndices = HashMap<Long, ArrayDeque<Int>>(sourceSignatures.size)
    for ((index, signature) in sourceSignatures.withIndex()) {
      signatureToIndices.getOrPut(signature) { ArrayDeque() }.addLast(index)
    }

    val remainingNextSignatureCounts = HashMap<Long, Int>(renderedSegments.size)
    for (segment in renderedSegments) {
      val signature = segment.signature
      remainingNextSignatureCounts[signature] = (remainingNextSignatureCounts[signature] ?: 0) + 1
    }

    val nextViews = ArrayList<View>(renderedSegments.size)
    val nextSignatures = ArrayList<Long>(renderedSegments.size)
    val reusedViews = HashSet<View>(sourceViews.size)
    val viewsToAttach = mutableListOf<View>()

    for ((index, segment) in renderedSegments.withIndex()) {
      val existingView = sourceViews.getOrNull(index)
      val existingSignature = sourceSignatures.getOrNull(index)
      val nextSignature = segment.signature

      val remaining = remainingNextSignatureCounts.getOrDefault(nextSignature, 0)
      if (remaining > 1) {
        remainingNextSignatureCounts[nextSignature] = remaining - 1
      } else {
        remainingNextSignatureCounts.remove(nextSignature)
      }

      var view: View? = null

      // 1. Exact positional match: same index, same kind, same signature.
      if (existingView != null &&
        existingView !in reusedViews &&
        matchesKind(existingView, segment) &&
        existingSignature == nextSignature
      ) {
        view = existingView
      }

      // 2. Signature-based fallback: find an unused view with exact same signature.
      if (view == null) {
        val candidateIndices = signatureToIndices[nextSignature]
        if (candidateIndices != null) {
          while (candidateIndices.isNotEmpty()) {
            val candidateIdx = candidateIndices.removeFirst()
            val candidate = sourceViews[candidateIdx]
            if (candidate !in reusedViews && matchesKind(candidate, segment)) {
              view = candidate
              break
            }
          }
        }
      }

      // 3. Same-kind positional update. If the old signature appears later in
      // the new list, leave the view available for that exact reuse instead.
      if (view == null &&
        existingView != null &&
        existingView !in reusedViews &&
        matchesKind(existingView, segment) &&
        (existingSignature == null || (remainingNextSignatureCounts[existingSignature] ?: 0) == 0)
      ) {
        updateView(existingView, segment)
        view = existingView
      }

      // 4. No reusable view found — create a new one.
      if (view == null) {
        view = createView(segment)
        viewsToAttach.add(view)
      }

      nextViews.add(view)
      nextSignatures.add(nextSignature)
      reusedViews.add(view)
    }

    val viewsToRemove = ArrayList<View>(resetRemovals.size + sourceViews.size)
    viewsToRemove.addAll(resetRemovals)
    for (view in sourceViews) {
      if (view !in reusedViews) {
        viewsToRemove.add(view)
      }
    }

    return ReconciliationResult(
      views = nextViews,
      signatures = nextSignatures,
      viewsToRemove = viewsToRemove,
      viewsToAttach = viewsToAttach,
    )
  }
}
