import type { AppServerControlConfigOption, AppServerControlConfigValue } from '../../api/types';
import {
  getAppServerControlQuickSettingsDraft,
  setAppServerControlQuickSettingsDraft,
} from '../appServerControl/quickSettings';
import { t } from '../i18n';

export function getAdditionalNativeConfigOptions(
  options: readonly AppServerControlConfigOption[],
): AppServerControlConfigOption[] {
  const prominent = new Set<string>();
  return options.filter((option) => {
    const id = option.configId ?? option.id;
    if (!id || !['select', 'boolean'].includes(option.type)) return false;
    const category = option.category?.toLowerCase();
    const primary =
      category === 'model' || id === 'model'
        ? 'model'
        : category === 'thought_level' || id === 'effort'
          ? 'effort'
          : null;
    if (option.type !== 'select' || !primary || prominent.has(primary)) return true;
    prominent.add(primary);
    return false;
  });
}

export function syncNativeConfigControls(
  row: HTMLElement,
  sessionId: string,
  options: readonly AppServerControlConfigOption[] | undefined,
  locked: boolean,
): void {
  let container = row.querySelector<HTMLDivElement>('.smart-input-native-config');
  if (!container) {
    container = document.createElement('div');
    container.className = 'smart-input-native-config';
    row.appendChild(container);
  }
  const visible = getAdditionalNativeConfigOptions(options ?? []);
  const signature = JSON.stringify([sessionId, visible, locked]);
  if (container.dataset.signature === signature) return;
  container.dataset.signature = signature;
  container.hidden = visible.length === 0;
  const open = container.querySelector('details')?.open ?? false;
  const details = document.createElement('details');
  details.open = open;
  const summary = document.createElement('summary');
  summary.textContent = t('appServerControl.config.settings');
  const panel = document.createElement('div');
  panel.className = 'smart-input-native-config-panel';
  panel.replaceChildren(...visible.map((option) => createControl(sessionId, option, locked)));
  details.append(summary, panel);
  container.replaceChildren(details);
}

function createControl(
  sessionId: string,
  option: AppServerControlConfigOption,
  locked: boolean,
): HTMLLabelElement {
  const id = option.configId ?? option.id ?? '';
  const label = document.createElement('label');
  label.className = 'smart-input-native-config-field';
  const name = document.createElement('span');
  name.textContent = option.name;
  label.appendChild(name);
  const control =
    option.type === 'boolean' ? document.createElement('input') : document.createElement('select');
  control.dataset.nativeConfigId = id;
  control.disabled = locked;
  if (control instanceof HTMLInputElement) {
    control.type = 'checkbox';
    control.checked = option.currentValue === true;
  } else {
    appendOptions(control, option.options ?? []);
    control.value = typeof option.currentValue === 'string' ? option.currentValue : '';
  }
  control.addEventListener('change', () => {
    const value = control instanceof HTMLInputElement ? control.checked : control.value;
    const draft = getAppServerControlQuickSettingsDraft(sessionId);
    setAppServerControlQuickSettingsDraft(sessionId, {
      configOptions: (draft.configOptions ?? []).map((entry) =>
        (entry.configId ?? entry.id) === id ? { ...entry, currentValue: value } : entry,
      ),
    });
  });
  label.appendChild(control);
  if (option.description) {
    const description = document.createElement('small');
    description.textContent = option.description;
    label.appendChild(description);
  }
  return label;
}

function appendOptions(parent: HTMLElement, options: readonly AppServerControlConfigValue[]): void {
  for (const option of options) {
    if (option.options) {
      const group = document.createElement('optgroup');
      group.label = option.name;
      appendOptions(group, option.options);
      parent.appendChild(group);
    } else if (typeof option.value === 'string') {
      const choice = document.createElement('option');
      choice.value = option.value;
      choice.textContent = option.name;
      if (option.description) choice.title = option.description;
      parent.appendChild(choice);
    }
  }
}
