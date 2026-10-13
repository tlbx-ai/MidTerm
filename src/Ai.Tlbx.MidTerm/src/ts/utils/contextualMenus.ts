const menuSelector =
  'details.file-visibility-menu[open], details.file-listing-options[open], details.file-actions-menu[open], details.git-operation-menu[open], details.git-diff-options[open]';

if (typeof document !== 'undefined' && typeof document.addEventListener === 'function') {
  document.addEventListener('pointerdown', (event) => {
    if (!(event.target instanceof Node)) return;
    for (const menu of document.querySelectorAll<HTMLDetailsElement>(menuSelector))
      if (!menu.contains(event.target)) menu.open = false;
  });
  document.addEventListener(
    'keydown',
    (event) => {
      if (event.key !== 'Escape') return;
      const menus = [...document.querySelectorAll<HTMLDetailsElement>(menuSelector)];
      if (menus.length === 0) return;
      const active = menus.find((menu) => menu.contains(document.activeElement));
      menus.forEach((menu) => {
        menu.open = false;
      });
      active?.querySelector<HTMLElement>('summary')?.focus();
      event.preventDefault();
      event.stopImmediatePropagation();
    },
    { capture: true },
  );
}
