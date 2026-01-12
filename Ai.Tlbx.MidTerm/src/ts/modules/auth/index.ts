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
} from './status';

export {
  showPasswordModal,
  hidePasswordModal,
  handlePasswordSubmit,
  showPasswordError,
  bindAuthEvents,
} from './password';
