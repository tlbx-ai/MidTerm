export function buildPreviewTabLabel(url: string | null | undefined): string {
  const trimmed = url?.trim();
  if (!trimmed) {
    return 'New Tab';
  }

  try {
    const parsed = new URL(trimmed);
    if (parsed.host) {
      return parsed.host;
    }
    if (parsed.hostname) {
      return parsed.hostname;
    }
  } catch {
    // Fall back to the raw value when the URL is malformed or still being edited.
  }

  return trimmed;
}
