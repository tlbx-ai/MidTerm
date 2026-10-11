import { t } from '../i18n';
import { registerBackButtonLayer } from '../navigation/backButtonGuard';

export interface OperationChoice {
  value: string;
  label: string;
  danger?: boolean;
}

/** A real form with scoped keyboard handling and focus restoration. */
export function operationDialog(
  title: string,
  message: string,
  choices: OperationChoice[],
  input?: { label: string; value: string; options?: Array<{ value: string; label: string }> },
): Promise<{ action: string; value: string } | null> {
  return new Promise((resolve) => {
    const previous = document.activeElement;
    const overlay = document.createElement('div');
    overlay.className = 'modal-overlay file-operation-overlay';
    const form = document.createElement('form');
    form.className = 'modal dialog-modal';
    form.setAttribute('role', 'dialog');
    form.setAttribute('aria-modal', 'true');
    const heading = document.createElement('h3');
    heading.id = `file-operation-${crypto.randomUUID()}`;
    heading.textContent = title;
    form.setAttribute('aria-labelledby', heading.id);
    const content = document.createElement('div');
    content.className = 'modal-content dialog-content';
    const header = document.createElement('div');
    header.className = 'modal-header';
    header.append(heading);
    const body = document.createElement('div');
    body.className = 'modal-body';
    const text = document.createElement('p');
    text.className = 'file-operation-message';
    text.textContent = message;
    body.append(text);
    let field: HTMLInputElement | HTMLSelectElement | null = null;
    if (input) {
      const label = document.createElement('label');
      label.textContent = input.label;
      if (input.options) {
        field = document.createElement('select');
        for (const choice of input.options) {
          const option = document.createElement('option');
          option.value = choice.value;
          option.textContent = choice.label;
          field.append(option);
        }
      } else {
        field = document.createElement('input');
        field.autocomplete = 'off';
      }
      field.className = 'file-operation-input';
      field.value = input.value;
      field.required = true;
      label.append(field);
      body.append(label);
    }
    const footer = document.createElement('div');
    footer.className = 'modal-footer';
    let done = false;
    let releaseBack: (() => void) | null = null;
    const close = (value: { action: string; value: string } | null): void => {
      if (done) return;
      done = true;
      releaseBack?.();
      overlay.remove();
      if (previous instanceof HTMLElement && previous.isConnected)
        previous.focus({ preventScroll: true });
      resolve(value);
    };
    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.className = 'btn-secondary';
    cancel.textContent = t('dialog.cancel');
    cancel.dataset.operationChoice = 'cancel';
    cancel.onclick = () => {
      close(null);
    };
    footer.append(cancel);
    for (const choice of choices) {
      const button = document.createElement('button');
      button.type = 'submit';
      button.value = choice.value;
      button.dataset.operationChoice = choice.value;
      button.className = choice.danger ? 'btn-danger' : 'btn-primary';
      button.textContent = choice.label;
      footer.append(button);
    }
    form.addEventListener('submit', (event) => {
      event.preventDefault();
      const button = event.submitter as HTMLButtonElement | null;
      close({ action: button?.value ?? choices[0]?.value ?? '', value: field?.value ?? '' });
    });
    overlay.addEventListener('keydown', (event) => {
      event.stopPropagation();
      if (event.key === 'Escape') {
        event.preventDefault();
        close(null);
      }
      if (event.key !== 'Tab') return;
      const focusable = [...form.querySelectorAll<HTMLElement>('input, select, button')];
      const first = focusable[0],
        last = focusable[focusable.length - 1];
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault();
        last?.focus();
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault();
        first?.focus();
      }
    });
    content.append(header, body, footer);
    form.append(content);
    overlay.append(form);
    document.body.append(overlay);
    releaseBack = registerBackButtonLayer(() => {
      close(null);
    });
    if (field) {
      field.focus();
      if (field instanceof HTMLInputElement) field.select();
    } else cancel.focus();
  });
}
