// Smoke part of #475: a new app PIN needs at least 6 characters; an old shorter one still unlocks and shows the notice
// on the lock screen until it is changed. Runs inside the 'pin' area with no PIN set; leaves none set.

export async function pinLengthCheck({ api, config, hashPin, lockNow, sleep, js, isOpened, errors }) {
  const shortSet = await api.setPin({ next: '25801' }).then(() => 'saved', (e) => e.message);
  if (!/mindestens 6 Zeichen|at least 6 characters/.test(shortSet)) errors.push(`pin: 5-character PIN not refused (${shortSet})`);
  if (config.get().appPin) errors.push('pin: a refused PIN was saved');
  // An old 4-character PIN (set before the rule): unknown as short until entered, then marked.
  config.update({ appPin: await hashPin('2580'), pinGuard: null });
  if ((await api.state()).pinShort) errors.push('pin: short notice before the PIN was entered');
  await lockNow();
  await api.verifyPin('2580');
  await api.unlock({ entra: true });
  if (!isOpened()) errors.push('pin: old 4-character PIN no longer unlocks');
  if (!(await api.state()).pinShort) errors.push('pin: old short PIN not marked');
  await api.verifyPin('2580'); // 0.9.33 review: locking clears a PIN entered just before
  await lockNow();
  if (await api.unlock({ entra: true }).then(() => true, () => false)) errors.push('pin: a PIN entered before locking unlocked afterwards');
  await sleep(800);
  if (!(await js(`!!document.querySelector('.pin-short')`))) errors.push('pin: lock screen shows no notice for the short PIN');
  await api.verifyPin('2580');
  await api.unlock({ entra: true });
  await api.setPin({ current: '2580', next: '258013' });
  if ((await api.state()).pinShort) errors.push('pin: notice stays after changing to 6 characters');
  await api.setPin({ current: '258013', next: null });
}
