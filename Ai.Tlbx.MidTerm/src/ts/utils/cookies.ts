/**
 * Cookie Utilities
 *
 * Functions for reading and writing browser cookies.
 */

/**
 * Get a cookie value by name
 */
export function getCookie(name: string): string | null {
  const match = document.cookie.match(new RegExp('(^| )' + name + '=([^;]+)'));
  const value = match?.[2];
  return value !== undefined ? decodeURIComponent(value) : null;
}

/**
 * Set a cookie value
 */
export function setCookie(name: string, value: string, days: number = 365): void {
  const expires = new Date(Date.now() + days * 24 * 60 * 60 * 1000).toUTCString();
  document.cookie = `${name}=${encodeURIComponent(value)}; expires=${expires}; path=/`;
}

/**
 * Delete a cookie by name
 */
export function deleteCookie(name: string): void {
  document.cookie = `${name}=; expires=Thu, 01 Jan 1970 00:00:00 UTC; path=/`;
}

/**
 * Detect clipboard shortcut style based on platform
 */
export function getClipboardStyle(setting: 'auto' | 'windows' | 'unix'): 'windows' | 'unix' {
  if (setting !== 'auto') return setting;
  const ua = navigator.userAgent || '';
  return /Windows|Win32|Win64/i.test(ua) ? 'windows' : 'unix';
}
