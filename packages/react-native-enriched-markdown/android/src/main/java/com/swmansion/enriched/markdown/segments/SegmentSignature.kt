package com.swmansion.enriched.markdown.segments

import com.swmansion.enriched.markdown.parser.MarkdownASTNode

/** FNV-1a 64-bit hashing. Constants match the iOS implementation for cross-platform parity. */
object SegmentSignature {
  // FNV-1a 64-bit constants (same as iOS)
  private const val FNV_OFFSET_BASIS = -3750763034362895579L // 14695981039346656037 as signed Long
  private const val FNV_PRIME = 1099511628211L

  internal const val TEXT_KIND_SALT = 0x7465787400000000L // "text"
  internal const val TABLE_KIND_SALT = 0x7461626C00000000L // "tabl"
  internal const val MATH_KIND_SALT = 0x6D61746800000000L // "math"
  internal const val CODE_BLOCK_KIND_SALT = 0x63626C6B00000000L // "cblk"
  internal const val BLOCKQUOTE_KIND_SALT = 0x6271746500000000L // "bqte"
  internal const val VIDEO_KIND_SALT = 0x7669646F00000000L // "video"

  private fun fnvMixByte(
    hash: Long,
    byte: Byte,
  ): Long {
    var result = hash xor (byte.toLong() and 0xFF)
    result *= FNV_PRIME
    return result
  }

  private fun fnvMixLong(
    hash: Long,
    value: Long,
  ): Long {
    var result = hash
    var remaining = value
    for (i in 0 until 8) {
      result = fnvMixByte(result, (remaining and 0xFF).toByte())
      remaining = remaining ushr 8
    }
    return result
  }

  internal fun fnvMixString(
    hash: Long,
    string: String?,
  ): Long {
    if (string == null) return hash
    var result = hash
    val bytes = string.toByteArray(Charsets.UTF_8)
    for (byte in bytes) {
      result = fnvMixByte(result, byte)
    }
    return result
  }

  fun signatureForNode(node: MarkdownASTNode?): Long {
    if (node == null) return FNV_OFFSET_BASIS

    var hash = FNV_OFFSET_BASIS
    hash = fnvMixLong(hash, node.type.ordinal.toLong())
    hash = fnvMixString(hash, node.content)

    if (node.attributes.isNotEmpty()) {
      for (key in node.attributes.keys.sorted()) {
        hash = fnvMixString(hash, key)
        hash = fnvMixString(hash, node.attributes[key])
      }
    }

    for (child in node.children) {
      hash = fnvMixLong(hash, signatureForNode(child))
    }

    return hash
  }

  fun signatureForNodes(nodes: List<MarkdownASTNode>): Long {
    var hash = FNV_OFFSET_BASIS
    for (node in nodes) {
      hash = fnvMixLong(hash, signatureForNode(node))
    }
    return hash
  }
}
