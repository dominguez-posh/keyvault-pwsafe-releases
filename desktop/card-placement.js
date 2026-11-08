// Where a Keevault card (#459) goes, without Electron so it can be tested: top centre over a reference rectangle (the app
// window or the screen's work area), then pulled into the visible work area of that screen. A minimised or off-screen
// app window (Windows reports -32000/-32000) can never put the card where nobody sees it.

const clamp = (v, lo, hi) => Math.max(lo, Math.min(v, hi));

/** size {width, height}, ref and workArea {x, y, width, height} → {x, y} inside workArea (top-left if the card is larger). */
export function placeCard({ width, height }, ref, workArea) {
  const x = Math.round(ref.x + (ref.width - width) / 2);
  const y = Math.round(ref.y + 40);
  return {
    x: clamp(x, workArea.x, Math.max(workArea.x, workArea.x + workArea.width - width)),
    y: clamp(y, workArea.y, Math.max(workArea.y, workArea.y + workArea.height - height)),
  };
}
