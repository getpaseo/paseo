package com.swmansion.enriched.markdown

import java.util.concurrent.Executor

// Keep populated views in step with Fabric geometry when streaming blocks move or collapse.
// First mounts retain worker preparation so large history rows do not parse on the UI thread.
internal fun dispatchMarkdownRender(hasContent: Boolean, executor: Executor, render: () -> Unit) {
  if (hasContent) render() else executor.execute(render)
}
