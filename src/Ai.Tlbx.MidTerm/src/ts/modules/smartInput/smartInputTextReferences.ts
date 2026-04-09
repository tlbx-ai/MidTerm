export const SMART_INPUT_TEXT_REFERENCE_MIN_LINES = 16;

export interface SmartInputTextReferenceStats {
  charCount: number;
  lineCount: number;
}

export function getSmartInputTextReferenceStats(text: string): SmartInputTextReferenceStats {
  return {
    charCount: text.length,
    lineCount: text.length === 0 ? 0 : text.split(/\r\n|\r|\n/).length,
  };
}

export function shouldConvertPastedTextToSmartInputReference(text: string): boolean {
  return getSmartInputTextReferenceStats(text).lineCount >= SMART_INPUT_TEXT_REFERENCE_MIN_LINES;
}

export function buildSmartInputTextReferenceFile(text: string): File {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  return new File([text], `pasted-text-${timestamp}.txt`, {
    type: 'text/plain',
  });
}
