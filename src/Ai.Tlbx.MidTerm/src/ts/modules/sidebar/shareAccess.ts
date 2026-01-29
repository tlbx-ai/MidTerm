/**
 * Share Access Module
 *
 * Handles the "Share Access" button that opens email client
 * with connection info for sharing terminal access with others.
 */

import { createLogger } from '../logging';
import { getSharePacket, type SharePacketInfo } from '../../api/client';

const log = createLogger('shareAccess');

export function initShareAccessButton(): void {
  const el = document.getElementById('btn-share-access');
  log.info(() => `initShareAccessButton: element found = ${!!el}`);
  if (el) {
    el.addEventListener('click', () => {
      log.info(() => 'Share Access button clicked');
      openShareEmail();
    });
  }
}

async function openShareEmail(): Promise<void> {
  try {
    const { data, response } = await getSharePacket();
    if (!response.ok || !data) {
      log.error(() => 'Failed to fetch share packet');
      showFallbackMessage('Failed to load connection info');
      return;
    }

    const info = data;
    const subject = `MidTerm Terminal Access - ${location.hostname}`;
    const body = generateEmailBody(info);
    const mailtoUrl = `mailto:?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;

    log.info(() => `Opening mailto link (${mailtoUrl.length} chars)`);

    // Try to open email client
    tryOpenMailto(mailtoUrl);

    // Give the email client a moment to open, then show fallback if still here
    setTimeout(() => {
      if (document.hasFocus()) {
        log.info(() => 'Page still has focus - email client may not have opened');
        showCopyFallback(subject, body, info.trustPageUrl ?? location.href);
      }
    }, 1000);
  } catch (e) {
    log.error(() => `Failed to open share email: ${e}`);
    showFallbackMessage('Failed to generate share info');
  }
}

function tryOpenMailto(url: string): boolean {
  // Try window.open first (works better in some browsers)
  const win = window.open(url, '_self');
  return win !== null;
}

function showFallbackMessage(message: string): void {
  // Simple alert for errors
  alert(message);
}

function showCopyFallback(subject: string, body: string, trustPageUrl: string): void {
  const copyText = `${subject}\n\n${body}`;

  // Try to copy to clipboard
  navigator.clipboard
    .writeText(copyText)
    .then(() => {
      alert(
        'No email client detected.\n\nConnection info has been copied to your clipboard!\n\nYou can also visit the trust page directly:\n' +
          trustPageUrl,
      );
    })
    .catch(() => {
      // Clipboard failed, show the trust page URL at least
      alert('No email client detected.\n\nVisit the trust page to share access:\n' + trustPageUrl);
    });
}

function generateEmailBody(info: SharePacketInfo): string {
  const endpointsList = (info.endpoints ?? []).map((ep) => `• ${ep.name}: ${ep.url}`).join('\n');

  const notAfter = info.certificate?.notAfter;
  const validUntil = notAfter
    ? new Date(notAfter).toLocaleDateString(undefined, {
        year: 'numeric',
        month: 'long',
        day: 'numeric',
      })
    : 'Unknown';

  const thumbprint = info.certificate?.fingerprint ?? 'Unknown';

  return `MidTerm Terminal Access
=======================

SECURITY: VERIFY FINGERPRINT FIRST
----------------------------------
SHA-256: ${thumbprint}

Compare this with your browser's certificate fingerprint before entering any passwords.
Click the padlock icon in your browser's address bar > Certificate > SHA-256 fingerprint.

CONNECTION ENDPOINTS
--------------------
${endpointsList}

INSTALL CERTIFICATE
-------------------
Visit: ${info.trustPageUrl ?? location.href}

This page will detect your device and guide you through installation.

Certificate valid until: ${validUntil}

TIP: Send this email to yourself, your work email, and family members
who may need terminal access from their phones or tablets.

---
MidTerm - Web Terminal Multiplexer
`;
}
