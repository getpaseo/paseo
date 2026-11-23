# ProGuard/R8 consumer rules for react-native-enriched-markdown
#
# JNI: Classes accessed from C++ (jni-adapter.cpp) via FindClass/GetFieldID.
# R8 cannot trace hardcoded string lookups in native code.

-keep class com.swmansion.enriched.markdown.parser.MarkdownASTNode { *; }
-keep class com.swmansion.enriched.markdown.parser.MarkdownASTNode$NodeType { *; }
-keep class com.swmansion.enriched.markdown.parser.Md4cFlags { *; }
-keep class com.swmansion.enriched.markdown.parser.TextLinkMatching { *; }
-keep class com.swmansion.enriched.markdown.utils.common.LinkRegexConfig { *; }

# Reflection: Math classes loaded via Class.forName when enableMath=true.
-keep class com.swmansion.enriched.markdown.spans.MathInlineSpan { *; }
-keep class com.swmansion.enriched.markdown.spans.MathInlinePlaceholderSpan { *; }
-keep class com.swmansion.enriched.markdown.spans.MathMeasureHelper { *; }
-keep class com.swmansion.enriched.markdown.views.MathContainerView { *; }
-keep class com.swmansion.enriched.markdown.renderer.MathInlineRenderer { *; }

# Reflection: Video container loaded via Class.forName when enableVideo=true.
-keep class com.swmansion.enriched.markdown.segments.VideoContainerView { *; }

# RaTeX uses JNI to instantiate Java objects from native code.
# R8 cannot trace these lookups and will strip or rename the referenced classes.
-keep class io.ratex.** { *; }
