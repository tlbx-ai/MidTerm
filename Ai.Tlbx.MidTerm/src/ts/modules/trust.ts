/**
 * Trust Page Module
 *
 * Handles platform detection, certificate download, and UI interactions.
 */

import { escapeHtml } from '../utils';

export function initTrustPage(): void {
  // Platform detection
  const ua = navigator.userAgent.toLowerCase();
  const isIOS =
    /iphone|ipad|ipod/.test(ua) ||
    (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1);
  const isAndroid = /android/.test(ua);
  const isMac = /macintosh|mac os x/.test(ua) && !isIOS;
  const isLinux = /linux/.test(ua) && !isAndroid;

  const detectedPlatformEl = document.getElementById('detected-platform');
  const iosPanel = document.getElementById('ios-panel');
  const androidPanel = document.getElementById('android-panel');
  const desktopPanel = document.getElementById('desktop-panel');

  if (!detectedPlatformEl) return;

  if (isIOS) {
    detectedPlatformEl.textContent = 'iOS / iPadOS';
    iosPanel?.classList.remove('hidden');
  } else if (isAndroid) {
    detectedPlatformEl.textContent = 'Android';
    androidPanel?.classList.remove('hidden');
  } else {
    if (isMac) {
      detectedPlatformEl.textContent = 'macOS';
      showDesktopTab('macos');
    } else if (isLinux) {
      detectedPlatformEl.textContent = 'Linux';
      showDesktopTab('linux');
    } else {
      detectedPlatformEl.textContent = 'Windows';
      showDesktopTab('windows');
    }
    desktopPanel?.classList.remove('hidden');
  }

  // Desktop OS tabs
  document.querySelectorAll('.os-tab').forEach((tab) => {
    tab.addEventListener('click', () => {
      const os = (tab as HTMLElement).dataset.os;
      if (os) showDesktopTab(os);
    });
  });

  // Download buttons
  bindDownload('btn-install-ios', '/api/certificate/download/mobileconfig');
  bindDownload('btn-install-android', '/api/certificate/download/pem');
  bindDownload('btn-download-pem-desktop', '/api/certificate/download/pem');
  bindDownload('btn-download-pem-macos', '/api/certificate/download/pem');
  bindDownload('btn-download-pem-linux', '/api/certificate/download/pem');

  // Copy fingerprint
  const copyBtn = document.getElementById('copy-fingerprint');
  if (copyBtn) {
    copyBtn.addEventListener('click', async () => {
      const fpEl = document.getElementById('fingerprint');
      if (!fpEl) return;
      const fp = fpEl.textContent ?? '';
      try {
        await navigator.clipboard.writeText(fp);
        copyBtn.textContent = 'Copied!';
        setTimeout(() => (copyBtn.textContent = 'Copy'), 2000);
      } catch {
        // Fallback for older browsers
        const textarea = document.createElement('textarea');
        textarea.value = fp;
        document.body.appendChild(textarea);
        textarea.select();
        document.execCommand('copy');
        document.body.removeChild(textarea);
      }
    });
  }

  // Load certificate info
  loadCertificateInfo();
}

function showDesktopTab(os: string): void {
  document.querySelectorAll('.os-tab').forEach((t) => t.classList.remove('active'));
  document.querySelector(`.os-tab[data-os="${os}"]`)?.classList.add('active');

  document.querySelectorAll('.os-instructions').forEach((el) => el.classList.add('hidden'));
  document.getElementById(`${os}-instructions`)?.classList.remove('hidden');
}

function bindDownload(id: string, url: string): void {
  const btn = document.getElementById(id);
  if (btn) {
    btn.addEventListener('click', () => {
      window.location.href = url;
    });
  }
}

async function loadCertificateInfo(): Promise<void> {
  try {
    const response = await fetch('/api/certificate/share-packet');
    if (!response.ok) return;

    const info = await response.json();

    // Display fingerprint
    const fpEl = document.getElementById('fingerprint');
    if (fpEl) fpEl.textContent = info.certificate.fingerprintFormatted;

    // Display validity
    const validUntil = new Date(info.certificate.notAfter);
    const validEl = document.getElementById('cert-valid-until');
    if (validEl) {
      validEl.textContent =
        'Certificate valid until: ' +
        validUntil.toLocaleDateString(undefined, {
          year: 'numeric',
          month: 'long',
          day: 'numeric',
        });
    }

    // Display trusted addresses from certificate SANs
    const endpointsList = document.getElementById('endpoints-list');
    if (endpointsList) {
      const cert = info.certificate;
      const allAddresses = [...(cert.dnsNames || []), ...(cert.ipAddresses || [])];
      if (allAddresses.length > 0) {
        endpointsList.innerHTML = allAddresses
          .map(
            (addr: string) =>
              `<div class="endpoint-item">
                <span class="endpoint-addr">${escapeHtml(addr)}</span>
              </div>`,
          )
          .join('');
      } else {
        endpointsList.innerHTML = '<p>No addresses in certificate</p>';
      }
    }
  } catch {
    const fpEl = document.getElementById('fingerprint');
    if (fpEl) fpEl.textContent = 'Error loading certificate info';
  }
}
