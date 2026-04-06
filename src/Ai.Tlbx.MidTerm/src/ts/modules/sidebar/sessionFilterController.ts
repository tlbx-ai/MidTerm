import { normalizeSessionFilterValue } from './sessionListLogic';

export interface SessionFilterInputLike {
  value: string;
  focus(): void;
  blur(): void;
  setAttribute(name: string, value: string): void;
  addEventListener(
    name: 'input' | 'keydown',
    listener: (event: { key?: string; preventDefault(): void; stopPropagation(): void }) => void,
  ): void;
}

export interface SessionFilterToggleLike {
  toggleAttribute(name: string, force?: boolean): void;
}

export interface SessionFilterButtonLike extends SessionFilterToggleLike {
  setAttribute(name: string, value: string): void;
  addEventListener(
    name: 'click',
    listener: (event: { preventDefault(): void; stopPropagation(): void }) => void,
  ): void;
}

export interface SessionFilterControllerElements {
  filterBar: SessionFilterToggleLike | null;
  filterInput: SessionFilterInputLike | null;
  filterClear: SessionFilterButtonLike | null;
}

export interface SessionFilterControllerDependencies {
  getElements(): SessionFilterControllerElements;
  isEnabled(): boolean;
  areSettingsLoaded?(): boolean;
  loadStoredFilter(): string;
  persistFilter(value: string): void;
  render(): void;
  translate(key: string): string;
}

export interface SessionFilterController {
  initialize(): void;
  isEnabled(): boolean;
  isActive(): boolean;
  getFilterValue(): string;
  applySettingChange(): void;
}

export function createSessionFilterController(
  deps: SessionFilterControllerDependencies,
): SessionFilterController {
  let listenersBound = false;
  let filterValue = '';
  let previousEnabled: boolean | null = null;

  const syncControls = (): void => {
    const { filterBar, filterInput, filterClear } = deps.getElements();
    const filterEnabled = deps.isEnabled();
    filterBar?.toggleAttribute('hidden', !filterEnabled);

    const visibleValue = filterEnabled ? filterValue : '';
    if (filterInput && filterInput.value !== visibleValue) {
      filterInput.value = visibleValue;
    }

    filterClear?.toggleAttribute('hidden', !filterEnabled || filterValue === '');
  };

  const setFilter = (nextValue: string): void => {
    const normalizedValue = normalizeSessionFilterValue(nextValue);
    if (normalizedValue === filterValue) {
      syncControls();
      return;
    }

    filterValue = normalizedValue;
    deps.persistFilter(filterValue);
    syncControls();
    deps.render();
  };

  const clearFilter = (focusInput: boolean = false): void => {
    setFilter('');
    if (focusInput) {
      deps.getElements().filterInput?.focus();
    }
  };

  const bindEvents = (): void => {
    if (listenersBound) {
      return;
    }

    const { filterInput, filterClear } = deps.getElements();

    if (filterInput) {
      filterInput.setAttribute('aria-label', deps.translate('sidebar.filterTerminals'));
      filterInput.addEventListener('input', () => {
        setFilter(filterInput.value);
      });

      filterInput.addEventListener('keydown', (event) => {
        event.stopPropagation();

        if (event.key === 'Escape') {
          event.preventDefault();
          if (filterValue !== '') {
            clearFilter(true);
          } else {
            filterInput.blur();
          }
        }
      });
    }

    if (filterClear) {
      filterClear.setAttribute('aria-label', deps.translate('sidebar.clearTerminalFilter'));
      filterClear.addEventListener('click', (event) => {
        event.preventDefault();
        event.stopPropagation();
        clearFilter(true);
      });
    }

    listenersBound = true;
  };

  return {
    initialize(): void {
      filterValue = normalizeSessionFilterValue(deps.loadStoredFilter());
      syncControls();
      bindEvents();
    },
    isEnabled(): boolean {
      return deps.isEnabled();
    },
    isActive(): boolean {
      return deps.isEnabled() && filterValue !== '';
    },
    getFilterValue(): string {
      return filterValue;
    },
    applySettingChange(): void {
      const settingsLoaded = deps.areSettingsLoaded ? deps.areSettingsLoaded() : true;
      if (!settingsLoaded) {
        syncControls();
        deps.render();
        return;
      }

      const filterEnabled = deps.isEnabled();
      const shouldClearStoredFilter = !filterEnabled && previousEnabled !== false;
      previousEnabled = filterEnabled;

      if (shouldClearStoredFilter && filterValue !== '') {
        clearFilter();
        return;
      }

      syncControls();
      deps.render();
    },
  };
}
