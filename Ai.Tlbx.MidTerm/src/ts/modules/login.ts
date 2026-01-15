/**
 * Login Page Module
 *
 * Handles login form submission and certificate TOFU display.
 */

const CERT_HIDDEN_KEY = 'mt-cert-info-hidden';

export function initLoginPage(): void {
  const form = document.getElementById('login-form') as HTMLFormElement | null;
  const passwordInput = document.getElementById('password') as HTMLInputElement | null;
  const errorDiv = document.getElementById('error-message');
  const loginBtn = document.getElementById('login-btn') as HTMLButtonElement | null;

  if (!form || !passwordInput || !errorDiv || !loginBtn) return;

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
      const response = await fetch('/api/auth/login', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ password }),
      });

      const result = await response.json();

      if (response.ok && result.success) {
        window.location.href = '/';
      } else {
        showError(errorDiv, result.error || 'Login failed');
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
    const response = await fetch('/api/certificate/info');
    if (!response.ok) return;

    const info = await response.json();
    if (!info.fingerprint) return;

    // Format fingerprint with colons every 2 chars
    const fp = info.fingerprint.match(/.{1,2}/g)?.join(':') ?? '';
    const fpEl = document.getElementById('cert-fingerprint');
    if (fpEl) fpEl.textContent = fp;

    // Format dates
    const formatDate = (iso: string): string => {
      if (!iso) return '';
      const d = new Date(iso);
      return d.toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
    };

    const validFromEl = document.getElementById('cert-valid-from');
    const validUntilEl = document.getElementById('cert-valid-until');
    if (validFromEl) validFromEl.textContent = 'From: ' + formatDate(info.notBefore);
    if (validUntilEl) validUntilEl.textContent = 'Until: ' + formatDate(info.notAfter);

    certInfoDiv.classList.remove('hidden');
  } catch {
    // Silently fail - this is optional info
  }
}
