// Smoke check #516: the storage step of the personal vault wizard shows "OneDrive direkt" as a second way, greyed out
// with "(demnächst verfügbar)" / "(coming soon)", and it cannot be chosen. Called by firstStartCheck
// (desktop/smoke-first-start.js) while its wizard is open at the start; leaves it at the start again.

import en from '../extension/core/i18n-en.js';
import { until } from './smoke-wait.js';

const BOX = 'dialog[open].wizard-modal .personal-storage';
const DIRECT = `${BOX} input[data-storage="onedrive-direct"]`;
const LABEL_DE = 'OneDrive direkt (demnächst verfügbar)';

export async function personalStorageCheck({ js, fail }, drive) {
  const f = (msg) => fail('firstwizard', `OneDrive direkt (#516): ${msg}`);
  await drive.primary();
  if (!(await drive.atStep(1))) return f(`storage step not reached, ${await drive.stopped()}`);
  if (!(await until(() => js(`!!document.querySelector(${JSON.stringify(BOX)})`), 3000))) return f('no choice of the storage in the storage step');
  const read = () => js(`(() => {
    const i = document.querySelector(${JSON.stringify(DIRECT)});
    const folder = document.querySelector(${JSON.stringify(`${BOX} input:not([data-storage])`)});
    return { found: !!i, disabled: !!i?.disabled, checked: !!i?.checked, text: i?.closest('label')?.textContent || '', folder: !!folder?.checked };
  })()`);
  const before = await read();
  if (!before.found) return f('option "OneDrive direkt" missing');
  if (!before.disabled) f('option "OneDrive direkt" is not disabled');
  if (before.text.trim() !== LABEL_DE) f(`label is "${before.text.trim()}", expected "${LABEL_DE}"`);
  if (!before.folder) f('the folder way is not the chosen one');
  await js(`document.querySelector(${JSON.stringify(DIRECT)})?.click(); true`);
  const after = await read();
  if (after.checked || !after.folder) f('clicking the greyed-out option chose it');
  if (!/\(coming soon\)$/.test(en[LABEL_DE] || '')) f(`English text missing or without "(coming soon)": "${en[LABEL_DE] || ''}"`);
  // Back to the start, where the caller goes on.
  await drive.click('dialog[open].wizard-modal .wizard-buttons .btn');
  if (!(await drive.atStep(0))) f(`"Zurück" did not lead back to the start, ${await drive.stopped()}`);
  return undefined;
}
