import { useCallback, useEffect, useState } from 'react';

import { voicePlayer, voiceId, type VoiceSnapshot } from '../../../lib/voicePlayer';
import { useVoiceConfig } from '../../../hooks/useVoiceConfig';

export type TtsState = VoiceSnapshot['state'];

/**
 * Thin adapter over the app-level voicePlayer. Playback lives outside React (see
 * lib/voicePlayer), so switching chats or re-rendering a message no longer cuts the
 * audio off. This hook just reflects the player's state for one message and forwards taps.
 */
export function useTts(getText: () => string) {
  const { config } = useVoiceConfig();
  const content = getText();
  const id = voiceId(content, config);

  const [snap, setSnap] = useState<VoiceSnapshot>(() => voicePlayer.getSnapshot(id));

  useEffect(() => {
    const update = () =>
      setSnap((prev) => {
        const next = voicePlayer.getSnapshot(id);
        return prev.state === next.state && prev.error === next.error ? prev : next;
      });
    update();
    return voicePlayer.subscribe(update);
  }, [id]);

  const toggle = useCallback(() => {
    voicePlayer.unlock(); // synchronous, within the click gesture (iOS)
    voicePlayer.toggle(content, config);
  }, [content, config]);

  return { state: snap.state, toggle, error: snap.error };
}
