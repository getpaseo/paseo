package com.swmansion.enriched.markdown.spoiler

import android.graphics.Canvas
import android.graphics.Color
import android.graphics.Paint
import kotlin.math.cos
import kotlin.math.max
import kotlin.math.sin
import kotlin.random.Random

// Uses a flat FloatArray (struct-of-arrays) to avoid GC pressure.
class SpoilerParticleDrawable(
  particleColor: Int,
  particleDensity: Float,
  particleSpeed: Float,
) {
  private var particleData = FloatArray(INITIAL_CAPACITY * STRIDE)
  private var particleCount = 0

  private val paint = Paint(Paint.ANTI_ALIAS_FLAG)
  private val colorRed = Color.red(particleColor)
  private val colorGreen = Color.green(particleColor)
  private val colorBlue = Color.blue(particleColor)

  private var width = 0f
  private var height = 0f
  private var primaryBirthRate = 0f
  private var secondaryBirthRate = 0f
  private var accumulatedPrimaryBirths = 0f
  private var accumulatedSecondaryBirths = 0f

  private val densityFactor = particleDensity / BASE_PARTICLE_DENSITY
  private val speedFactor = particleSpeed / BASE_PARTICLE_SPEED

  private var isRevealing = false
  private var revealStartTime = -1L
  private var revealCallback: (() -> Unit)? = null

  var overallAlpha = 1f
    private set
  var revealFinished = false
    private set

  fun setSize(
    newWidth: Float,
    newHeight: Float,
  ) {
    val wasEmpty = width <= 0f || height <= 0f
    if (newWidth == width && newHeight == height) return
    width = newWidth
    height = newHeight
    val area = newWidth * newHeight
    primaryBirthRate = max(3f, area * PRIMARY_DOT.densityFactor * densityFactor)
    secondaryBirthRate = max(1.5f, area * SECONDARY_DOT.densityFactor * densityFactor)

    if (wasEmpty && newWidth > 0f && newHeight > 0f && !isRevealing && particleCount == 0) {
      seedInitialParticles()
    }
  }

  fun startReveal(onComplete: () -> Unit) {
    if (isRevealing) return
    isRevealing = true
    revealStartTime = -1L
    revealCallback = onComplete

    for (index in 0 until particleCount) {
      val base = index * STRIDE
      particleData[base + VELOCITY_X] *= REVEAL_VELOCITY_MULTIPLIER
      particleData[base + VELOCITY_Y] *= REVEAL_VELOCITY_MULTIPLIER
      particleData[base + ALPHA_SPEED] *= REVEAL_ALPHA_SPEED_MULTIPLIER
    }
  }

  fun update(
    deltaTime: Float,
    currentTimeMs: Long,
  ) {
    if (revealFinished) return

    if (!isRevealing) spawnParticles(deltaTime)
    updateAndCompact(deltaTime)

    if (isRevealing) {
      if (revealStartTime < 0L) revealStartTime = currentTimeMs
      val progress = ((currentTimeMs - revealStartTime).toFloat() / REVEAL_DURATION_MS).coerceIn(0f, 1f)
      overallAlpha = (1f - progress) * (1f - progress)

      if (progress >= 1f) {
        revealFinished = true
        particleCount = 0
        revealCallback?.invoke()
        revealCallback = null
      }
    }
  }

  fun draw(
    canvas: Canvas,
    offsetX: Float,
    offsetY: Float,
  ) {
    if (width <= 0 || height <= 0 || particleCount == 0) return

    canvas.save()
    canvas.clipRect(offsetX, offsetY, offsetX + width, offsetY + height)

    for (index in 0 until particleCount) {
      val base = index * STRIDE
      val alpha = (particleData[base + PARTICLE_ALPHA] * overallAlpha * 255f).toInt().coerceIn(0, 255)
      if (alpha <= 0) continue

      paint.color = Color.argb(alpha, colorRed, colorGreen, colorBlue)
      canvas.drawCircle(
        offsetX + particleData[base + POSITION_X],
        offsetY + particleData[base + POSITION_Y],
        DOT_RADIUS * particleData[base + PARTICLE_SCALE],
        paint,
      )
    }

    canvas.restore()
  }

  private fun updateAndCompact(deltaTime: Float) {
    var writeIndex = 0
    for (readIndex in 0 until particleCount) {
      val readBase = readIndex * STRIDE
      val age = particleData[readBase + PARTICLE_AGE] + deltaTime
      val alpha = (particleData[readBase + PARTICLE_ALPHA] + particleData[readBase + ALPHA_SPEED] * deltaTime).coerceIn(0f, 1f)
      if (age >= particleData[readBase + PARTICLE_LIFETIME] || alpha <= 0f) continue

      val writeBase = writeIndex * STRIDE
      if (writeBase != readBase) System.arraycopy(particleData, readBase, particleData, writeBase, STRIDE)
      particleData[writeBase + POSITION_X] += particleData[writeBase + VELOCITY_X] * deltaTime
      particleData[writeBase + POSITION_Y] += particleData[writeBase + VELOCITY_Y] * deltaTime
      particleData[writeBase + PARTICLE_ALPHA] = alpha
      particleData[writeBase + PARTICLE_AGE] = age
      writeIndex++
    }
    particleCount = writeIndex
  }

  // Pre-populates particles so the field looks established on the first frame,
  // matching iOS CAEmitterLayer which renders immediately.
  private fun seedInitialParticles() {
    val frameDeltaTime = 16f / 1000f
    repeat(SEED_FRAMES) {
      spawnParticles(frameDeltaTime)
      for (index in 0 until particleCount) {
        val base = index * STRIDE
        particleData[base + PARTICLE_AGE] += frameDeltaTime
        particleData[base + POSITION_X] += particleData[base + VELOCITY_X] * frameDeltaTime
        particleData[base + POSITION_Y] += particleData[base + VELOCITY_Y] * frameDeltaTime
        particleData[base + PARTICLE_ALPHA] =
          (particleData[base + PARTICLE_ALPHA] + particleData[base + ALPHA_SPEED] * frameDeltaTime).coerceIn(0f, 1f)
      }
    }
    updateAndCompact(0f)
  }

  private fun spawnParticles(deltaTime: Float) {
    accumulatedPrimaryBirths += primaryBirthRate * deltaTime
    accumulatedSecondaryBirths += secondaryBirthRate * deltaTime
    while (accumulatedPrimaryBirths >= 1f) {
      accumulatedPrimaryBirths -= 1f
      emitParticle(PRIMARY_DOT)
    }
    while (accumulatedSecondaryBirths >= 1f) {
      accumulatedSecondaryBirths -= 1f
      emitParticle(SECONDARY_DOT)
    }
  }

  private fun emitParticle(type: DotType) {
    ensureCapacity(particleCount + 1)
    val base = particleCount * STRIDE
    val angle = Random.nextFloat() * TWO_PI
    val velocity = type.velocity * speedFactor * (1f + (Random.nextFloat() - 0.5f) * VELOCITY_RANGE * 2f)

    particleData[base + POSITION_X] = Random.nextFloat() * width
    particleData[base + POSITION_Y] = Random.nextFloat() * height
    particleData[base + VELOCITY_X] = cos(angle) * velocity
    particleData[base + VELOCITY_Y] = sin(angle) * velocity
    particleData[base + PARTICLE_ALPHA] = (1f - ALPHA_RANGE + Random.nextFloat() * ALPHA_RANGE * 2f).coerceIn(0f, 1f)
    particleData[base + ALPHA_SPEED] = type.alphaSpeed
    particleData[base + PARTICLE_SCALE] = type.scale * (1f + (Random.nextFloat() - 0.5f) * SCALE_RANGE * 2f)
    particleData[base + PARTICLE_LIFETIME] = type.lifetime * (1f + (Random.nextFloat() - 0.5f) * LIFETIME_RANGE * 2f)
    particleData[base + PARTICLE_AGE] = 0f
    particleCount++
  }

  private fun ensureCapacity(needed: Int) {
    val requiredLength = needed * STRIDE
    if (requiredLength <= particleData.size) return
    particleData = particleData.copyOf((particleData.size * 2).coerceAtLeast(requiredLength))
  }

  private class DotType(
    val lifetime: Float,
    val velocity: Float,
    val scale: Float,
    val alphaSpeed: Float,
    val densityFactor: Float,
  )

  companion object {
    private const val DOT_RADIUS = 3f
    private const val REVEAL_VELOCITY_MULTIPLIER = 10f
    private const val REVEAL_ALPHA_SPEED_MULTIPLIER = 6f
    private const val SEED_FRAMES = 30
    private const val INITIAL_CAPACITY = 64
    private val TWO_PI = (Math.PI * 2).toFloat()

    private const val LIFETIME_RANGE = 0.3f
    private const val VELOCITY_RANGE = 0.5f
    private const val SCALE_RANGE = 0.3f
    private const val ALPHA_RANGE = 0.2f

    private val PRIMARY_DOT = DotType(lifetime = 1.6f, velocity = 8f, scale = 0.25f, alphaSpeed = -0.25f, densityFactor = 0.013f)
    private val SECONDARY_DOT = DotType(lifetime = 1.2f, velocity = 12f, scale = 0.18f, alphaSpeed = -0.3f, densityFactor = 0.007f)

    private const val POSITION_X = 0
    private const val POSITION_Y = 1
    private const val VELOCITY_X = 2
    private const val VELOCITY_Y = 3
    private const val PARTICLE_ALPHA = 4
    private const val ALPHA_SPEED = 5
    private const val PARTICLE_SCALE = 6
    private const val PARTICLE_LIFETIME = 7
    private const val PARTICLE_AGE = 8
    private const val STRIDE = 9

    private const val BASE_PARTICLE_DENSITY = 8f
    private const val BASE_PARTICLE_SPEED = 20f
  }
}
