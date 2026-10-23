import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";
import {
  UtteranceSchema,
  VoiceCapabilitiesSchema,
  VoiceSettingsPatchSchema,
  VoiceSettingsSchema,
} from "./voice-settings";

const SettingsStateSchema = z.object({
  settings: VoiceSettingsSchema,
  capabilities: VoiceCapabilitiesSchema,
});

export const getVoiceSettingsRpc = defineRpc({
  name: "pyrgos-voice.settings.get",
  input: z.object({}),
  output: SettingsStateSchema,
});

export const setVoiceSettingsRpc = defineRpc({
  name: "pyrgos-voice.settings.set",
  input: VoiceSettingsPatchSchema,
  output: SettingsStateSchema,
});

export const getPlaybackRpc = defineRpc({
  name: "pyrgos-voice.playback.get",
  input: z.object({}),
  output: z.object({
    serverNow: z.number(),
    utterance: UtteranceSchema.nullable(),
  }),
});
