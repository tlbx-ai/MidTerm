export interface SmartInputEnterEvent {
  altKey: boolean;
  ctrlKey: boolean;
  key: string;
  metaKey: boolean;
  shiftKey: boolean;
}

function isEnterKey(event: SmartInputEnterEvent): boolean {
  return event.key === 'Enter';
}

export function shouldSubmitSmartInputOnEnter(event: SmartInputEnterEvent): boolean {
  return isEnterKey(event) && !event.shiftKey && !event.ctrlKey && !event.altKey && !event.metaKey;
}

export function shouldInsertLineBreakOnEnter(event: SmartInputEnterEvent): boolean {
  return isEnterKey(event) && !event.metaKey && (event.shiftKey || event.ctrlKey || event.altKey);
}

export function insertSmartInputLineBreak(textarea: HTMLTextAreaElement): void {
  const start = textarea.selectionStart;
  const end = textarea.selectionEnd;

  textarea.setRangeText('\n', start, end, 'end');
  textarea.dispatchEvent(new Event('input'));
}
