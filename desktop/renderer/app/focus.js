// #468: a PIN field has the keyboard as soon as it appears, also when the window only gets the OS focus a moment later.

/**
 * Focuses the input now and once more when the window gets the focus (a window brought to the front takes it after the
 * dialog is already there). Never moves the focus to anything but this field, and not when the user has already chosen
 * something else in the meantime (another field or a button).
 */
export function focusField(input) {
  if (!input) return;
  const take = () => {
    if (!input.isConnected) { window.removeEventListener('focus', onWindowFocus); return; }
    const a = document.activeElement;
    if (!a || a === document.body || a === input || a.tagName === 'DIALOG') input.focus();
  };
  function onWindowFocus() { setTimeout(take, 0); }
  window.addEventListener('focus', onWindowFocus);
  input.focus();
  setTimeout(take, 0);
}
