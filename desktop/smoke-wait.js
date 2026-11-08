// Waiting for an event in the smoke checks instead of a fixed pause (#397). Waiting says nothing about the result: the check
// after it asks again and fails as before, also when the limit ran out. So a pause may only go where something should
// happen. Where something must NOT happen (a key that may not answer a question), the fixed time window is the check.

/** Asks until the answer is truthy, at least once and once more when the limit is over. Gives the last answer. */
export async function until(check, limitMs = 3000, everyMs = 25) {
  const end = Date.now() + limitMs;
  for (;;) {
    const answer = await check();
    if (answer || Date.now() >= end) return answer;
    await new Promise((r) => setTimeout(r, everyMs));
  }
}

/**
 * The next animation frame has been. The browser delivers a dialog's close event in the frame, before its callbacks. A
 * never shown window, as in every smoke run, has about one frame a second (measured for #397), a shown one 60.
 */
export const nextFrame = (js, limitMs = 3000) => js(`new Promise((done) => {
  const limit = setTimeout(() => done(false), ${limitMs});
  requestAnimationFrame(() => { clearTimeout(limit); done(true); });
})`);

/**
 * The questions of AI agents are through, including their close event. The dialog leaves the page at once, the event
 * comes with the next frame, and it starts the delay of every question open by then again (renderer/app/requests.js).
 * Without this wait the next question gets its delay started a second time, up to a second after it opened.
 */
export async function questionsGone(js, limitMs = 2000) {
  await until(() => js('!document.querySelector("dialog.question-modal")'), limitMs);
  await nextFrame(js);
}
