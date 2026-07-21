import { useSettings } from '../../../contexts/SettingsContext';

export function useSelectedProvider() {
  const { getSetting } = useSettings();
  return getSetting('selected-provider', 'claude') ?? 'claude';
}
