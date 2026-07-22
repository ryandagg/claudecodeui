import { useCallback } from 'react';

import { useSettings } from '../contexts/SettingsContext';

export type VoiceConfig = {
  baseUrl: string;
  apiKey: string;
  sttModel: string;
  ttsModel: string;
  ttsVoice: string;
  ttsFormat: string;
};

export const VOICE_CONFIG_STORAGE_KEY = 'voiceConfig';
const DEFAULTS: VoiceConfig = { baseUrl: '', apiKey: '', sttModel: '', ttsModel: '', ttsVoice: '', ttsFormat: '' };

export function parseVoiceConfig(raw: string | null): VoiceConfig {
  if (!raw) return { ...DEFAULTS };
  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return { ...DEFAULTS };
    const config = { ...DEFAULTS };
    for (const key of Object.keys(DEFAULTS) as (keyof VoiceConfig)[]) {
      if (typeof parsed[key] === 'string') config[key] = parsed[key];
    }
    return config;
  } catch {
    return { ...DEFAULTS };
  }
}

// Headers the voice proxy reads to target a per-user OpenAI-compatible backend.
// Empty fields are omitted so the server's env defaults apply.
export function voiceConfigHeaders(config: VoiceConfig): Record<string, string> {
  const h: Record<string, string> = {};
  if (config.apiKey) h['x-voice-api-key'] = config.apiKey;
  if (config.sttModel) h['x-voice-stt-model'] = config.sttModel;
  if (config.ttsModel) h['x-voice-tts-model'] = config.ttsModel;
  if (config.ttsVoice) h['x-voice-tts-voice'] = config.ttsVoice;
  if (config.ttsFormat.trim()) h['x-voice-tts-format'] = config.ttsFormat.trim();
  return h;
}

export function useVoiceConfig() {
  const { getSetting, setSetting } = useSettings();
  const config = parseVoiceConfig(getSetting(VOICE_CONFIG_STORAGE_KEY));

  const update = useCallback(
    (patch: Partial<VoiceConfig>) => {
      const next = { ...parseVoiceConfig(getSetting(VOICE_CONFIG_STORAGE_KEY)), ...patch };
      const stored: Partial<VoiceConfig> = { ...next };
      if (next.ttsFormat.trim()) stored.ttsFormat = next.ttsFormat.trim();
      else delete stored.ttsFormat;
      setSetting(VOICE_CONFIG_STORAGE_KEY, JSON.stringify(stored));
    },
    [getSetting, setSetting],
  );

  return { config, update };
}
