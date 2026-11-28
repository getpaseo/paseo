#include "CodeBlockHighlighter.hpp"
#include "CodeBlockLanguages.hpp"
#include "MD4CParser.hpp"
#include "TextLinkRecognizer.hpp"
#include <android/log.h>
#include <jni.h>
#include <string>
#include <string_view>
#include <vector>

using namespace Markdown;

#define ENRICHEDMARKDOWN_LOG_TAG "EnrichedMarkdownJNI"
#define LOGI(...) __android_log_print(ANDROID_LOG_INFO, ENRICHEDMARKDOWN_LOG_TAG, __VA_ARGS__)
#define LOGE(...) __android_log_print(ANDROID_LOG_ERROR, ENRICHEDMARKDOWN_LOG_TAG, __VA_ARGS__)

// Helper function to convert C++ NodeType to Kotlin enum ordinal
static jint nodeTypeToJavaOrdinal(NodeType type) {
  switch (type) {
    case NodeType::Document:
      return 0;
    case NodeType::Paragraph:
      return 1;
    case NodeType::Text:
      return 2;
    case NodeType::Link:
      return 3;
    case NodeType::Heading:
      return 4;
    case NodeType::LineBreak:
      return 5;
    case NodeType::Strong:
      return 6;
    case NodeType::Emphasis:
      return 7;
    case NodeType::Strikethrough:
      return 8;
    case NodeType::Underline:
      return 9;
    case NodeType::Code:
      return 10;
    case NodeType::Image:
      return 11;
    case NodeType::Blockquote:
      return 12;
    case NodeType::UnorderedList:
      return 13;
    case NodeType::OrderedList:
      return 14;
    case NodeType::ListItem:
      return 15;
    case NodeType::CodeBlock:
      return 16;
    case NodeType::ThematicBreak:
      return 17;
    case NodeType::Table:
      return 18;
    case NodeType::TableHead:
      return 19;
    case NodeType::TableBody:
      return 20;
    case NodeType::TableRow:
      return 21;
    case NodeType::TableHeaderCell:
      return 22;
    case NodeType::TableCell:
      return 23;
    case NodeType::LatexMathInline:
      return 24;
    case NodeType::LatexMathDisplay:
      return 25;
    case NodeType::Spoiler:
      return 26;
    case NodeType::Superscript:
      return 27;
    case NodeType::Subscript:
      return 28;
    case NodeType::Highlight:
      return 29;
    case NodeType::SoftBreak:
      return 30;
    case NodeType::BlankLine:
      return 31;
    case NodeType::Admonition:
      return 32;
    case NodeType::Video:
      return 33;
    default:
      return 0;
  }
}

// Helper function to create a Kotlin MarkdownASTNode object from C++ AST node
static jobject createJavaNode(JNIEnv *env, std::shared_ptr<MarkdownASTNode> node) {
  if (!node) {
    return nullptr;
  }

  // Find the MarkdownASTNode class
  jclass nodeClass = env->FindClass("com/swmansion/enriched/markdown/parser/MarkdownASTNode");
  if (!nodeClass) {
    LOGE("Failed to find MarkdownASTNode class");
    return nullptr;
  }

  // Find the NodeType enum class
  jclass nodeTypeClass = env->FindClass("com/swmansion/enriched/markdown/parser/MarkdownASTNode$NodeType");
  if (!nodeTypeClass) {
    LOGE("Failed to find NodeType enum class");
    return nullptr;
  }

  // Get the enum values array
  jmethodID valuesMethod = env->GetStaticMethodID(
      nodeTypeClass, "values", "()[Lcom/swmansion/enriched/markdown/parser/MarkdownASTNode$NodeType;");
  if (!valuesMethod) {
    LOGE("Failed to find NodeType.values() method");
    return nullptr;
  }

  jobjectArray enumValues = (jobjectArray)env->CallStaticObjectMethod(nodeTypeClass, valuesMethod);
  if (!enumValues) {
    LOGE("Failed to get NodeType enum values");
    return nullptr;
  }

  // Get the enum value for this node type
  jint ordinal = nodeTypeToJavaOrdinal(node->type);
  jobject nodeTypeEnum = env->GetObjectArrayElement(enumValues, ordinal);
  if (!nodeTypeEnum) {
    LOGE("Failed to get NodeType enum value at index %d", ordinal);
    return nullptr;
  }

  // Create content string
  jstring contentStr = env->NewStringUTF(node->content.c_str());
  if (!contentStr && !node->content.empty()) {
    LOGE("Failed to create content string");
    return nullptr;
  }

  // Create attributes HashMap
  jclass mapClass = env->FindClass("java/util/HashMap");
  jmethodID mapInit = env->GetMethodID(mapClass, "<init>", "(I)V");
  jmethodID mapPut = env->GetMethodID(mapClass, "put", "(Ljava/lang/Object;Ljava/lang/Object;)Ljava/lang/Object;");

  jobject attributesMap = env->NewObject(mapClass, mapInit, static_cast<jint>(node->attributes.size()));

  for (const auto &pair : node->attributes) {
    jstring key = env->NewStringUTF(pair.first.c_str());
    jstring value = env->NewStringUTF(pair.second.c_str());
    env->CallObjectMethod(attributesMap, mapPut, key, value);
    env->DeleteLocalRef(key);
    env->DeleteLocalRef(value);
  }

  // Create children ArrayList
  jclass listClass = env->FindClass("java/util/ArrayList");
  jmethodID listInit = env->GetMethodID(listClass, "<init>", "(I)V");
  jmethodID listAdd = env->GetMethodID(listClass, "add", "(Ljava/lang/Object;)Z");

  jobject childrenList = env->NewObject(listClass, listInit, static_cast<jint>(node->children.size()));

  for (const auto &child : node->children) {
    jobject childObj = createJavaNode(env, child);
    if (childObj) {
      env->CallBooleanMethod(childrenList, listAdd, childObj);
      env->DeleteLocalRef(childObj);
    }
  }

  // Find the MarkdownASTNode constructor
  // Constructor signature: (Lcom/swmansion/enriched/markdown/parser/MarkdownASTNode$NodeType;Ljava/lang/String;Ljava/util/Map;Ljava/util/List;)V
  jmethodID constructor = env->GetMethodID(nodeClass, "<init>",
                                           "(Lcom/swmansion/enriched/markdown/parser/MarkdownASTNode$NodeType;Ljava/"
                                           "lang/String;Ljava/util/Map;Ljava/util/List;)V");
  if (!constructor) {
    LOGE("Failed to find MarkdownASTNode constructor");
    return nullptr;
  }

  // Create the Kotlin MarkdownASTNode object
  jobject javaNode = env->NewObject(nodeClass, constructor, nodeTypeEnum, contentStr, attributesMap, childrenList);

  // Clean up local references
  env->DeleteLocalRef(nodeTypeClass);
  env->DeleteLocalRef(enumValues);
  env->DeleteLocalRef(nodeTypeEnum);
  if (contentStr)
    env->DeleteLocalRef(contentStr);
  env->DeleteLocalRef(attributesMap);
  env->DeleteLocalRef(childrenList);

  return javaNode;
}

// UTF-16 via NewString, not NewStringUTF: the matcher's offsets must count the same units
// the core maps back to bytes, and modified UTF-8 cannot carry 4-byte sequences.
static std::u16string toUtf16(std::string_view utf8) {
  std::u16string out;
  out.reserve(utf8.size());
  for (size_t i = 0; i < utf8.size();) {
    unsigned char lead = static_cast<unsigned char>(utf8[i]);
    size_t length = lead < 0x80 ? 1 : lead < 0xE0 ? 2 : lead < 0xF0 ? 3 : 4;
    if (i + length > utf8.size())
      break;
    uint32_t codePoint = length == 1   ? lead
                         : length == 2 ? ((lead & 0x1Fu) << 6) | (utf8[i + 1] & 0x3Fu)
                         : length == 3 ? ((lead & 0x0Fu) << 12) | ((utf8[i + 1] & 0x3Fu) << 6) | (utf8[i + 2] & 0x3Fu)
                                       : ((lead & 0x07u) << 18) | ((utf8[i + 1] & 0x3Fu) << 12) |
                                             ((utf8[i + 2] & 0x3Fu) << 6) | (utf8[i + 3] & 0x3Fu);
    if (codePoint >= 0x10000) {
      codePoint -= 0x10000;
      out.push_back(static_cast<char16_t>(0xD800 + (codePoint >> 10)));
      out.push_back(static_cast<char16_t>(0xDC00 + (codePoint & 0x3FF)));
    } else {
      out.push_back(static_cast<char16_t>(codePoint));
    }
    i += length;
  }
  return out;
}

static jobjectArray toJavaStrings(JNIEnv *env, const std::vector<std::string_view> &strings) {
  jclass stringClass = env->FindClass("java/lang/String");
  jobjectArray array = env->NewObjectArray(static_cast<jsize>(strings.size()), stringClass, nullptr);
  for (size_t i = 0; i < strings.size(); i++) {
    std::u16string utf16 = toUtf16(strings[i]);
    jstring value = env->NewString(reinterpret_cast<const jchar *>(utf16.data()), static_cast<jsize>(utf16.size()));
    env->SetObjectArrayElement(array, static_cast<jsize>(i), value);
    env->DeleteLocalRef(value);
  }
  env->DeleteLocalRef(stringClass);
  return array;
}

// A host exception must not leak into later JNI calls; recognition is dropped for that call.
static bool clearHostException(JNIEnv *env) {
  if (!env->ExceptionCheck())
    return false;
  env->ExceptionDescribe();
  env->ExceptionClear();
  return true;
}

// Host matchers for the core recognizer: one JNI round trip per kind per parse, into TextLinkMatching.
// Capturing env is safe because the core invokes these synchronously, inside this native call.
static Markdown::TextLinkMatchers makeTextLinkMatchers(JNIEnv *env, jobject textConfig, jobject codeConfig) {
  Markdown::TextLinkMatchers matchers;
  if (!textConfig && !codeConfig)
    return matchers;
  jclass matchingClass = env->FindClass("com/swmansion/enriched/markdown/parser/TextLinkMatching");
  if (!matchingClass) {
    clearHostException(env);
    return matchers;
  }
  const char *configSig = "com/swmansion/enriched/markdown/utils/common/LinkRegexConfig";

  if (textConfig) {
    jmethodID method = env->GetStaticMethodID(matchingClass, "matchText",
                                              ("([Ljava/lang/String;L" + std::string(configSig) + ";)[I").c_str());
    if (!method) {
      clearHostException(env);
      return matchers;
    }
    matchers.text = [env, matchingClass, method, textConfig](const std::vector<std::string_view> &runs) {
      std::vector<std::vector<Markdown::TextRange>> all(runs.size());
      jobjectArray javaRuns = toJavaStrings(env, runs);
      jintArray triples = (jintArray)env->CallStaticObjectMethod(matchingClass, method, javaRuns, textConfig);
      env->DeleteLocalRef(javaRuns);
      if (clearHostException(env))
        return all;
      if (triples) {
        jsize count = env->GetArrayLength(triples);
        jint *data = env->GetIntArrayElements(triples, nullptr);
        for (jsize i = 0; i + 2 < count; i += 3) {
          size_t run = static_cast<size_t>(data[i]);
          if (run < all.size())
            all[run].push_back({static_cast<size_t>(data[i + 1]), static_cast<size_t>(data[i + 2])});
        }
        env->ReleaseIntArrayElements(triples, data, JNI_ABORT);
        env->DeleteLocalRef(triples);
      }
      return all;
    };
  }

  if (codeConfig) {
    jmethodID method = env->GetStaticMethodID(matchingClass, "matchWholeCode",
                                              ("([Ljava/lang/String;L" + std::string(configSig) + ";)[Z").c_str());
    if (!method) {
      clearHostException(env);
      return matchers;
    }
    matchers.inlineCode = [env, matchingClass, method, codeConfig](const std::vector<std::string_view> &spans) {
      std::vector<uint8_t> matched(spans.size(), 0);
      jobjectArray javaSpans = toJavaStrings(env, spans);
      jbooleanArray flags = (jbooleanArray)env->CallStaticObjectMethod(matchingClass, method, javaSpans, codeConfig);
      env->DeleteLocalRef(javaSpans);
      if (clearHostException(env))
        return matched;
      if (flags) {
        jsize count = env->GetArrayLength(flags);
        jboolean *data = env->GetBooleanArrayElements(flags, nullptr);
        for (jsize i = 0; i < count && static_cast<size_t>(i) < matched.size(); i++)
          matched[i] = data[i] == JNI_TRUE ? 1 : 0;
        env->ReleaseBooleanArrayElements(flags, data, JNI_ABORT);
        env->DeleteLocalRef(flags);
      }
      return matched;
    };
  }
  return matchers;
}

extern "C" {

JNIEXPORT jobject JNICALL Java_com_swmansion_enriched_markdown_parser_Parser_nativeParseMarkdown(
    JNIEnv *env, jobject /* this */, jstring markdown, jobject flags, jboolean isGFM, jobject textLinkRegex,
    jobject inlineCodeLinkRegex) {
  if (!markdown) {
    LOGE("Markdown string is null");
    return nullptr;
  }

  const char *markdownStr = env->GetStringUTFChars(markdown, nullptr);
  if (!markdownStr) {
    LOGE("Failed to get UTF-8 chars from markdown string");
    return nullptr;
  }

  try {
    // Extract flags from Kotlin Md4cFlags data class
    Md4cFlags md4cFlags;
    if (flags) {
      jclass flagsClass = env->GetObjectClass(flags);
      if (flagsClass) {
        jfieldID underlineField = env->GetFieldID(flagsClass, "underline", "Z");
        if (underlineField) {
          md4cFlags.underline = env->GetBooleanField(flags, underlineField) == JNI_TRUE;
        }
        jfieldID latexMathField = env->GetFieldID(flagsClass, "latexMath", "Z");
        if (latexMathField) {
          md4cFlags.latexMath = env->GetBooleanField(flags, latexMathField) == JNI_TRUE;
        }
        jfieldID superscriptField = env->GetFieldID(flagsClass, "superscript", "Z");
        if (superscriptField) {
          md4cFlags.superscript = env->GetBooleanField(flags, superscriptField) == JNI_TRUE;
        }
        jfieldID subscriptField = env->GetFieldID(flagsClass, "subscript", "Z");
        if (subscriptField) {
          md4cFlags.subscript = env->GetBooleanField(flags, subscriptField) == JNI_TRUE;
        }
        jfieldID highlightField = env->GetFieldID(flagsClass, "highlight", "Z");
        if (highlightField) {
          md4cFlags.highlight = env->GetBooleanField(flags, highlightField) == JNI_TRUE;
        }
        jfieldID permissiveAutolinksField = env->GetFieldID(flagsClass, "permissiveAutolinks", "Z");
        if (permissiveAutolinksField) {
          md4cFlags.permissiveAutolinks = env->GetBooleanField(flags, permissiveAutolinksField) == JNI_TRUE;
        }
        jfieldID hardSoftBreaksField = env->GetFieldID(flagsClass, "hardSoftBreaks", "Z");
        if (hardSoftBreaksField) {
          md4cFlags.hardSoftBreaks = env->GetBooleanField(flags, hardSoftBreaksField) == JNI_TRUE;
        }
        jfieldID preserveBlankLinesField = env->GetFieldID(flagsClass, "preserveBlankLines", "Z");
        if (preserveBlankLinesField) {
          md4cFlags.preserveBlankLines = env->GetBooleanField(flags, preserveBlankLinesField) == JNI_TRUE;
        }
        jfieldID admonitionsField = env->GetFieldID(flagsClass, "admonitions", "Z");
        if (admonitionsField) {
          md4cFlags.admonitions = env->GetBooleanField(flags, admonitionsField) == JNI_TRUE;
        }
        env->DeleteLocalRef(flagsClass);
      }
    }

    MD4CParser parser;
    auto ast = parser.parse(std::string(markdownStr), md4cFlags, isGFM == JNI_TRUE);

    env->ReleaseStringUTFChars(markdown, markdownStr);

    if (!ast) {
      LOGE("Parser returned null AST");
      return nullptr;
    }

    if (textLinkRegex || inlineCodeLinkRegex) {
      Markdown::recognizeTextLinks(*ast, makeTextLinkMatchers(env, textLinkRegex, inlineCodeLinkRegex));
    }

    // Convert C++ AST to Kotlin MarkdownASTNode object
    jobject javaNode = createJavaNode(env, ast);

    if (!javaNode) {
      LOGE("Failed to create Java node from AST");
    }

    return javaNode;
  } catch (const std::exception &e) {
    env->ReleaseStringUTFChars(markdown, markdownStr);
    LOGE("Exception during parsing: %s", e.what());
    return nullptr;
  } catch (...) {
    env->ReleaseStringUTFChars(markdown, markdownStr);
    LOGE("Unknown exception during parsing");
    return nullptr;
  }
}

JNIEXPORT jstring JNICALL Java_com_swmansion_enriched_markdown_utils_common_CodeBlockNode_nativeDisplayLanguageName(
    JNIEnv *env, jobject /* this */, jstring language) {
  if (!language) {
    return nullptr;
  }
  const char *languageStr = env->GetStringUTFChars(language, nullptr);
  if (!languageStr) {
    return nullptr;
  }
  std::string display = displayNameForLanguage(languageStr);
  env->ReleaseStringUTFChars(language, languageStr);
  return env->NewStringUTF(display.c_str());
}

// Returns highlight tokens as (start, end, type) int triplets with UTF-16
// offsets, or null when highlighting is unavailable. See
// cpp/highlight/CodeBlockHighlighter.hpp for the seam contract.
JNIEXPORT jintArray JNICALL Java_com_swmansion_enriched_markdown_utils_common_CodeBlockHighlighter_nativeHighlightCode(
    JNIEnv *env, jobject /* this */, jstring code, jstring language) {
  if (!code) {
    return nullptr;
  }

  const char *codeStr = env->GetStringUTFChars(code, nullptr);
  if (!codeStr) {
    return nullptr;
  }
  const char *languageStr = language ? env->GetStringUTFChars(language, nullptr) : nullptr;

  std::vector<HighlightToken> tokens;
  try {
    tokens = highlightCode(codeStr, languageStr ? languageStr : "");
  } catch (const std::exception &e) {
    LOGE("Exception during highlighting: %s", e.what());
    tokens.clear();
  } catch (...) {
    LOGE("Unknown exception during highlighting");
    tokens.clear();
  }

  env->ReleaseStringUTFChars(code, codeStr);
  if (languageStr) {
    env->ReleaseStringUTFChars(language, languageStr);
  }

  if (tokens.empty()) {
    return nullptr;
  }

  std::vector<jint> flat;
  flat.reserve(tokens.size() * 3);
  for (const auto &token : tokens) {
    flat.push_back(static_cast<jint>(token.start));
    flat.push_back(static_cast<jint>(token.end));
    flat.push_back(static_cast<jint>(token.type));
  }

  jintArray result = env->NewIntArray(static_cast<jsize>(flat.size()));
  if (!result) {
    return nullptr;
  }
  env->SetIntArrayRegion(result, 0, static_cast<jsize>(flat.size()), flat.data());
  return result;
}

} // extern "C"
