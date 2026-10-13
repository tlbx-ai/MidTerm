/** Open contextual controls through their actual summary before interacting. */
export async function revealControl(control) {
  const menus=control.locator('xpath=ancestor::details');
  for(const menu of await menus.all()) if(await menu.getAttribute('open')===null) await menu.locator(':scope > summary').click();
}

export async function clickControl(control, options) { await revealControl(control); await control.click(options); }
export async function tapControl(control, options) { await revealControl(control); await control.tap(options); }
