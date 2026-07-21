import { createContext, useContext } from 'react';

import type { PendingPermissionRequest } from '../components/chat/types/types';

export interface PermissionContextValue {
  pendingPermissionRequests: PendingPermissionRequest[];
  handlePermissionDecision: (
    requestIds: string | string[],
    decision: { allow?: boolean; message?: string; rememberEntry?: string | null; updatedInput?: unknown },
  ) => void;
}

const PermissionContext = createContext<PermissionContextValue | null>(null);

// eslint-disable-next-line react-refresh/only-export-components
export function usePermission(): PermissionContextValue | null {
  return useContext(PermissionContext);
}

export default PermissionContext;
