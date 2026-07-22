import { useEffect, useState } from 'react';

import { authenticatedFetch } from '../../../utils/api';
import { useUiPreferences } from '../../../hooks/useUiPreferences';
import { useVoiceConfig } from '../../../hooks/useVoiceConfig';

// Voice UI is gated on the `voiceEnabled` UI preference (toggled in Quick Settings /
// the Settings modal) and a configured voice backend.
let healthRequest: Promise<boolean> | null = null;

function checkVoiceHealth(): Promise<boolean> {
  if (healthRequest) return healthRequest;
  const request = authenticatedFetch('/api/voice/health')
    .then(async (response) => {
      if (!response.ok) throw new Error(`Voice health check failed (${response.status})`);
      const data = await response.json();
      return data?.configured === true;
    })
    .finally(() => {
      healthRequest = null;
    });
  healthRequest = request;
  return request;
}

export function useVoiceAvailable(): boolean {
  const { preferences } = useUiPreferences();
  const { config } = useVoiceConfig();
  const enabled = preferences.voiceEnabled;
  const hasBaseUrl = config.baseUrl.trim().length > 0;
  const [available, setAvailable] = useState(false);

  useEffect(() => {
    let active = true;
    let requestId = 0;

    const check = async () => {
      if (!enabled) {
        setAvailable(false);
        return;
      }
      if (hasBaseUrl) {
        setAvailable(true);
        return;
      }
      const id = ++requestId;
      try {
        const result = await checkVoiceHealth();
        if (active && id === requestId) setAvailable(result);
      } catch {
        if (active && id === requestId) setAvailable(false);
      }
    };

    void check();
    return () => {
      active = false;
    };
  }, [enabled, hasBaseUrl]);

  return enabled && available;
}
