package com.swmansion.enriched.markdown.spoiler

enum class SpoilerOverlay(
  internal val createStrategy: (SpoilerAnimator) -> SpoilerStrategy,
) {
  PARTICLES({ animator -> ParticleStrategy(animator) }),
  SOLID({ _ -> SolidStrategy() }),
  ;

  companion object {
    fun fromString(value: String?): SpoilerOverlay =
      when (value) {
        "solid" -> SOLID
        else -> PARTICLES
      }
  }
}
