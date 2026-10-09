package sh.paseo.diffprototype

import expo.modules.kotlin.modules.Module
import expo.modules.kotlin.modules.ModuleDefinition

// Experimental binding only. The layout engine has no JVM or platform dependency.
class PaseoDiffPrototypeModule : Module() {
  companion object {
    init { System.loadLibrary("paseo_diff_prototype") }
  }

  private external fun createDocument(): Double
  private external fun prepareDocument(id: Double, texts: Array<String>, widths: DoubleArray, family: String, size: Double): DoubleArray
  private external fun readDocument(id: Double, start: Int, count: Int): DoubleArray
  private external fun releaseDocument(id: Double)
  private external fun releaseAllDocuments()

  override fun definition() = ModuleDefinition {
    Name("PaseoDiffPrototype")

    Function("create") { createDocument() }
    // Expo dispatches this non-suspending AsyncFunction on its background queue.
    AsyncFunction("prepare") { id: Double, texts: List<String>, widths: List<Double>, family: String, size: Double ->
      val stats = prepareDocument(id, texts.toTypedArray(), widths.toDoubleArray(), family, size)
      mapOf(
        "cells" to stats[0], "fragments" to stats[1], "graphemes" to stats[2],
        "copyMs" to stats[3], "layoutMs" to stats[4], "geometryBytes" to stats[5]
      )
    }
    Function("read") { id: Double, start: Int, count: Int -> readDocument(id, start, count) }
    Function("release") { id: Double -> releaseDocument(id) }
    OnDestroy { releaseAllDocuments() }
  }
}
