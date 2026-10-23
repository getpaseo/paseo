---
title: 语音
description: Paseo 的语音架构、本地优先的模型执行以及 Provider 配置。
nav: 语音
---

# 语音 {#voice}

Paseo 对语音提供一流的支持，可用于口述输入，以及与编程环境进行语音模式对话。

## 设计理念 {#philosophy}

语音以本地优先。你可以完全在设备上运行语音功能，也可以为语音功能选择 OpenAI。对于语音推理和编排，Paseo 复用你机器上已安装并完成认证的 Agent Provider。

这让凭据和执行都留在你的环境中，也避免了引入一套独立的、只能在云端运行的语音系统。

## 架构 {#architecture}

- 语音输入输出：每个功能各自的 STT 和 TTS Provider（`local` 或 `openai`）
- 本地语音运行时：默认在 CPU 上执行的 ONNX 模型
- 语音 LLM 编排：使用你配置的 Provider（`claude`、`codex` 或 `opencode`）的隐藏 Agent 会话
- 工具路径：用于语音工具和 Agent 控制的 MCP stdio 桥

## 本地语音 {#local-speech}

本地语音默认使用模型 ID `parakeet-tdt-0.6b-v2-int8`（STT）和 `kokoro-en-v0_19`（TTS，speaker 0 / voice 00）。

缺失的模型会在 daemon 启动时下载到 `$PASEO_HOME/models/local-speech`。只会下载缺失的文件。

### 本地 STT 模型与语言支持 {#local-stt-models-and-language-support}

| 模型 ID                     | 语言                                                                                                                                                                                                                                                                  |
| --------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `parakeet-tdt-0.6b-v2-int8` | 仅英语（默认）。包含标点和大小写。                                                                                                                                                                                                                                    |
| `parakeet-tdt-0.6b-v3-int8` | 25 种欧洲语言，自动检测：保加利亚语、克罗地亚语、捷克语、丹麦语、荷兰语、英语、爱沙尼亚语、芬兰语、法语、德语、希腊语、匈牙利语、意大利语、拉脱维亚语、立陶宛语、马耳他语、波兰语、葡萄牙语、罗马尼亚语、俄语、斯洛伐克语、斯洛文尼亚语、西班牙语、瑞典语、乌克兰语。 |

**要使用英语以外的语言，请把本地 STT 模型切换为 `parakeet-tdt-0.6b-v3-int8`。** v3 会自动检测说话的语言，没有针对单个语言的设置。下面的 `language` 字段**不会**影响本地 Parakeet 模型（v2 仅支持英语，v3 自动检测）；它只适用于 OpenAI STT Provider。

```json
{
  "version": 1,
  "features": {
    "dictation": {
      "stt": { "provider": "local", "model": "parakeet-tdt-0.6b-v2-int8", "language": "en" }
    },
    "voiceMode": {
      "llm": { "provider": "claude", "model": "haiku" },
      "stt": { "provider": "local", "model": "parakeet-tdt-0.6b-v2-int8", "language": "en" },
      "tts": { "provider": "local", "model": "kokoro-en-v0_19", "speakerId": 0 }
    }
  },
  "providers": {
    "local": {
      "modelsDir": "~/.paseo/models/local-speech"
    }
  }
}
```

对于多语言的本地口述，请把模型设置为 v3。它会自动检测语言，因此不需要 `language` 字段：

```json
{
  "version": 1,
  "features": {
    "dictation": {
      "stt": { "provider": "local", "model": "parakeet-tdt-0.6b-v3-int8" }
    }
  }
}
```

`language` 字段只适用于 OpenAI STT Provider：口述使用 `features.dictation.stt.language`，语音模式使用 `features.voiceMode.stt.language`。如果省略语音语言，Paseo 会先使用口述语言，再退回到 `en`。它对本地 Parakeet 模型没有任何作用。

## OpenAI 语音选项 {#openai-voice-option}

把 Provider 字段设置为 `openai` 并提供 OpenAI 凭据，即可把口述、语音 STT 和语音 TTS 切换到 OpenAI。

```json
{
  "version": 1,
  "features": {
    "dictation": { "stt": { "provider": "openai" } },
    "voiceMode": {
      "stt": { "provider": "openai" },
      "tts": { "provider": "openai" }
    }
  },
  "providers": {
    "openai": {
      "stt": {
        "apiKey": "...",
        "baseUrl": "https://api.openai.com/v1"
      },
      "tts": {
        "apiKey": "...",
        "baseUrl": "https://api.openai.com/v1"
      }
    }
  }
}
```

`providers.openai.stt` 用于口述和语音模式的语音转文字，`providers.openai.tts` 用于语音模式的文字转语音。由于两者独立解析，你可以把 STT 和 TTS 指向不同的端点。未设置时，各自先退回到 `providers.openai.apiKey`/`baseUrl`，再退回到 `OPENAI_API_KEY`/`OPENAI_BASE_URL`。这些设置只配置 Paseo 的 OpenAI 语音流量，不会改变 Codex 或其他基于 OpenAI 的工具。

Paseo 在配置的 OpenAI base URL 下使用以下路径：

- 口述 STT：`/v1/audio/transcriptions`
- 语音模式 STT：`/v1/audio/transcriptions`
- 语音模式 TTS：`/v1/audio/speech`

## 环境变量 {#environment-variables}

- `PASEO_VOICE_LLM_PROVIDER`：覆盖语音 Agent 的 Provider
- `PASEO_DICTATION_STT_PROVIDER`、`PASEO_VOICE_STT_PROVIDER`、`PASEO_VOICE_TTS_PROVIDER`：选择语音 Provider（`local` 或 `openai`）
- `OPENAI_STT_API_KEY`、`OPENAI_STT_BASE_URL`：OpenAI 语音转文字端点（口述 + 语音模式 STT）
- `OPENAI_TTS_API_KEY`、`OPENAI_TTS_BASE_URL`：OpenAI 文字转语音端点（语音模式 TTS）
- `PASEO_LOCAL_MODELS_DIR`：本地模型存储目录
- `PASEO_DICTATION_LOCAL_STT_MODEL`：本地口述 STT 模型 ID
- `PASEO_VOICE_LOCAL_STT_MODEL`、`PASEO_VOICE_LOCAL_TTS_MODEL`：本地语音 STT/TTS 模型 ID
- `PASEO_DICTATION_LANGUAGE`：口述 STT 语言（仅限 OpenAI STT；本地 Parakeet 会忽略）
- `PASEO_VOICE_LANGUAGE`：语音模式 STT 语言；未设置时退回到 `PASEO_DICTATION_LANGUAGE`（仅限 OpenAI STT；本地 Parakeet 会忽略）
- `PASEO_VOICE_LOCAL_TTS_SPEAKER_ID`、`PASEO_VOICE_LOCAL_TTS_SPEED`：可选的本地语音 TTS 调优

## 使用须知 {#operational-notes}

语音模式可以启动和控制 Agent。请像对待直接的 Agent 指令一样谨慎对待语音提示词，尤其是在指定工作目录或执行破坏性操作时。
