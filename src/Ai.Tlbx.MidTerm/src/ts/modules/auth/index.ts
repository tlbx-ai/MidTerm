/**
 * Auth Module
 *
 * Re-exports all authentication-related functionality.
 */

export {
  checkAuthStatus,
  updateSecurityWarning,
  updatePasswordStatus,
  dismissSecurityWarning,
  logout,
} from './status';

export { showPasswordModal, handlePasswordSubmit, bindAuthEvents } from './password';
