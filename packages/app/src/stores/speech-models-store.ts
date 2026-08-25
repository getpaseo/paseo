import AsyncStorage from "@react-native-async-storage/async-storage";
import { create } from "zustand";
import { createJSONStorage, persist } from "zustand/middleware";

interface SpeechModelsState {
  activeSttModelId: string;
  activeTtsModelId: string;
  modelLanguages: Record<string, string>;
  modelSpeakers: Record<string, number>;
  setActiveSttModelId: (id: string) => void;
  setActiveTtsModelId: (id: string) => void;
  setModelLanguage: (modelId: string, language: string) => void;
  setModelSpeaker: (modelId: string, speakerId: number) => void;
}

export const useSpeechModelsStore = create<SpeechModelsState>()(
  persist(
    (set) => ({
      activeSttModelId: "parakeet-tdt-0.6b-v3-int8",
      activeTtsModelId: "kokoro-multi-v1_0",
      modelLanguages: {},
      modelSpeakers: {},
      setActiveSttModelId: (id) => set({ activeSttModelId: id }),
      setActiveTtsModelId: (id) => set({ activeTtsModelId: id }),
      setModelLanguage: (modelId, language) =>
        set((state) => ({
          modelLanguages: {
            ...state.modelLanguages,
            [modelId]: language,
          },
        })),
      setModelSpeaker: (modelId, speakerId) =>
        set((state) => ({
          modelSpeakers: {
            ...state.modelSpeakers,
            [modelId]: speakerId,
          },
        })),
    }),
    {
      name: "paseo-speech-models-preferences",
      storage: createJSONStorage(() => AsyncStorage),
    },
  ),
);
