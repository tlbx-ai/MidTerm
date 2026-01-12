/**
 * Password Modal Module
 *
 * Handles password set/change modal and form submission.
 */

import { authStatus } from '../../state';
import { bindClick } from '../../utils';
import { checkAuthStatus, dismissSecurityWarning } from './status';

let passwordModalHasPassword = false;

/**
 * Show the password modal for setting or changing password
 */
export function showPasswordModal(_isInitialSetup: boolean): void {
  const modal = document.getElementById('password-modal');
  const title = document.getElementById('password-modal-title');
  const currentGroup = document.getElementById('current-password-group');
  const errorEl = document.getElementById('password-error');

  if (!modal) return;

  passwordModalHasPassword = authStatus?.passwordSet ?? false;

  if (title) {
    title.textContent = passwordModalHasPassword ? 'Change Password' : 'Set Password';
  }

  if (currentGroup) {
    currentGroup.style.display = passwordModalHasPassword ? 'block' : 'none';
  }

  if (errorEl) {
    errorEl.classList.add('hidden');
    errorEl.textContent = '';
  }

  const form = document.getElementById('password-form') as HTMLFormElement | null;
  if (form) {
    form.reset();
  }

  modal.classList.remove('hidden');

  const focusFieldId = passwordModalHasPassword ? 'current-password' : 'new-password';
  const field = document.getElementById(focusFieldId) as HTMLInputElement | null;
  if (field) {
    field.focus();
  }
}

/**
 * Hide the password modal
 */
export function hidePasswordModal(): void {
  const modal = document.getElementById('password-modal');
  if (modal) {
    modal.classList.add('hidden');
  }
}

/**
 * Handle password form submission
 */
export function handlePasswordSubmit(e: Event): void {
  e.preventDefault();

  const currentPw = document.getElementById('current-password') as HTMLInputElement | null;
  const newPw = document.getElementById('new-password') as HTMLInputElement | null;
  const confirmPw = document.getElementById('confirm-password') as HTMLInputElement | null;
  const saveBtn = document.getElementById('btn-save-password') as HTMLButtonElement | null;

  const newPassword = newPw?.value ?? '';
  const confirmPassword = confirmPw?.value ?? '';

  if (!newPassword) {
    showPasswordError('New password is required');
    return;
  }

  if (newPassword !== confirmPassword) {
    showPasswordError('Passwords do not match');
    return;
  }

  if (newPassword.length < 4) {
    showPasswordError('Password must be at least 4 characters');
    return;
  }

  const payload = {
    currentPassword: passwordModalHasPassword && currentPw ? currentPw.value : null,
    newPassword: newPassword,
  };

  if (saveBtn) {
    saveBtn.disabled = true;
    saveBtn.textContent = 'Saving...';
  }

  fetch('/api/auth/change-password', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  })
    .then((r) => r.json().then((data) => ({ ok: r.ok, data })))
    .then((result) => {
      if (saveBtn) {
        saveBtn.disabled = false;
        saveBtn.textContent = 'Save';
      }

      if (result.ok && result.data.success) {
        hidePasswordModal();
        checkAuthStatus();
      } else {
        showPasswordError(result.data.error || 'Failed to change password');
      }
    })
    .catch(() => {
      if (saveBtn) {
        saveBtn.disabled = false;
        saveBtn.textContent = 'Save';
      }
      showPasswordError('Connection error');
    });
}

/**
 * Show an error message in the password modal
 */
export function showPasswordError(msg: string): void {
  const errorEl = document.getElementById('password-error');
  if (errorEl) {
    errorEl.textContent = msg;
    errorEl.classList.remove('hidden');
  }
}

/**
 * Bind all auth-related event handlers
 */
export function bindAuthEvents(): void {
  bindClick('btn-set-password-warning', () => {
    showPasswordModal(true);
  });
  bindClick('btn-dismiss-warning', dismissSecurityWarning);

  bindClick('btn-change-password', () => {
    showPasswordModal(false);
  });
  bindClick('btn-close-password', hidePasswordModal);
  bindClick('btn-cancel-password', hidePasswordModal);

  const passwordBackdrop = document.querySelector('#password-modal .modal-backdrop');
  if (passwordBackdrop) {
    passwordBackdrop.addEventListener('click', hidePasswordModal);
  }

  const passwordForm = document.getElementById('password-form');
  if (passwordForm) {
    passwordForm.addEventListener('submit', handlePasswordSubmit);
  }
}
