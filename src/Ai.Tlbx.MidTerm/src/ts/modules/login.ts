/**
 * Login Page Module
 *
 * Handles login form submission and certificate TOFU display.
 */

import { login, getBootstrapLogin } from '../api/client';

const CERT_HIDDEN_KEY = 'mt-cert-info-hidden';

export function initLoginPage(): void {
  const form = document.getElementById('login-form') as HTMLFormElement | null;
  const passwordInput = document.getElementById('password') as HTMLInputElement | null;
  const errorDiv = document.getElementById('error-message');
  const loginBtn = document.getElementById('login-btn') as HTMLButtonElement | null;

  if (!form || !passwordInput || !errorDiv || !loginBtn) return;

  // Load version and insider info
  loadVersionAndPaths();

  form.addEventListener('submit', async (e) => {
    e.preventDefault();

    const password = passwordInput.value;
    if (!password) {
      showError(errorDiv, 'Password required');
      return;
    }

    loginBtn.disabled = true;
    loginBtn.textContent = 'Logging in...';
    errorDiv.classList.add('hidden');

    try {
      const { data, response } = await login(password);

      if (response.ok && data?.success) {
        window.location.href = '/';
      } else {
        showError(errorDiv, data?.error ?? 'Login failed');
        passwordInput.value = '';
        passwordInput.focus();
      }
    } catch {
      showError(errorDiv, 'Connection error. Please try again.');
    } finally {
      loginBtn.disabled = false;
      loginBtn.textContent = 'Login';
    }
  });

  // Certificate TOFU display
  const certInfoDiv = document.getElementById('cert-info');
  const certHideBtn = document.getElementById('cert-hide-btn');

  if (certInfoDiv && certHideBtn) {
    if (localStorage.getItem(CERT_HIDDEN_KEY) !== 'true') {
      loadCertificateInfo(certInfoDiv);
    }

    certHideBtn.addEventListener('click', () => {
      localStorage.setItem(CERT_HIDDEN_KEY, 'true');
      certInfoDiv.classList.add('hidden');
    });
  }
}

function showError(errorDiv: HTMLElement, msg: string): void {
  errorDiv.textContent = msg;
  errorDiv.classList.remove('hidden');
}

async function loadCertificateInfo(certInfoDiv: HTMLElement): Promise<void> {
  try {
    const { data } = await getBootstrapLogin();
    if (!data?.certificate?.fingerprint) return;

    // Format fingerprint with colons every 2 chars
    const fp = data.certificate.fingerprint.match(/.{1,2}/g)?.join(':') ?? '';
    const fpEl = document.getElementById('cert-fingerprint');
    if (fpEl) fpEl.textContent = fp;

    // Format dates
    const formatDate = (iso: string | null): string => {
      if (!iso) return '';
      const d = new Date(iso);
      return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
    };

    const validFromEl = document.getElementById('cert-valid-from');
    const validUntilEl = document.getElementById('cert-valid-until');
    if (validFromEl) validFromEl.textContent = 'From: ' + formatDate(data.certificate.notBefore);
    if (validUntilEl) validUntilEl.textContent = 'Until: ' + formatDate(data.certificate.notAfter);

    certInfoDiv.classList.remove('hidden');
  } catch {
    // Silently fail - this is optional info
  }
}

async function loadVersionAndPaths(): Promise<void> {
  const versionEl = document.getElementById('login-version');
  const insiderEl = document.getElementById('login-insider');

  // Fetch version (public endpoint)
  try {
    const versionRes = await fetch('/api/version');
    if (versionRes.ok) {
      const version = await versionRes.text();
      if (versionEl) versionEl.textContent = `v${version}`;
    }
  } catch {
    // Silently fail
  }

  // Fetch paths for insider info (may require auth, that's ok)
  try {
    const pathsRes = await fetch('/api/paths');
    if (pathsRes.ok && insiderEl) {
      const paths = await pathsRes.json();
      const lines = [
        `settings: ${paths.settingsFile || 'n/a'}`,
        `logs: ${paths.logDirectory || 'n/a'}`,
      ];
      insiderEl.textContent = lines.join('\n');
    }
  } catch {
    // Silently fail - insider info is optional
  }
}
