import { command } from './backend';
import { withManagerPasswordConfirmation } from './managerLogin';

export type RecoveryLinkKind = 'confirm' | 'reset';
export type RecoveryStatus = { email: string; verified: boolean; reset_enabled: boolean; pending?: boolean };

export const managerRecoveryStatus = () => command<RecoveryStatus | null>('manager_recovery_status');
export const managerRecoveryAvailable = () => command<boolean>('manager_recovery_available');

export function enrollManagerRecovery(user: { id: string; email: string }, password: string) {
  return withManagerPasswordConfirmation(user, password, (previous_session, accessToken) =>
    command<boolean>('manager_recovery_enroll', { previous_session }, { accessToken }));
}

export function requestManagerRecovery(login: string) {
  return command<void>('manager_recovery_request', { login });
}

export function recoveryLinkKind(kind?: string, token?: string): RecoveryLinkKind | null {
  return token && /^[0-9a-f]{64}$/.test(token) && (kind === 'confirm' || kind === 'reset') ? kind : null;
}

export function recoveryPasswordValid(password: string) {
  return [...password].length >= 12 && new TextEncoder().encode(password).length <= 72;
}

export const confirmManagerRecovery = (token: string) => command<boolean>('manager_recovery_confirm', { token });
export const resetManagerRecovery = (token: string, password: string) => command<boolean>('manager_recovery_reset', { token, password });
