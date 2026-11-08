// Clickjacking at the field menu (#373). The page owns the styles of our host element: it can make the menu transparent
// or lay something over it with pointer-events: none, so a real click lands on a menu the person can't see. isTrusted and
// the closed shadow root don't help, and elementFromPoint looks through such a cover. IntersectionObserver v2 asks the
// browser's compositor instead: isVisible is false when anything covers the element, also a transparent or filtered
// ancestor or frame. A click counts only after the element was visible without a break for minMs, so a menu that
// pops up under a click on its way doesn't take it either. Reports come up to 100 ms late (the browser's minimum delay).
// isVisible says nothing when the page only moves or scales the element (transform) and may say nothing about clip-path
// and mask, so these are watched once per frame while the guard runs (Konrad F4): a check at the click alone is too late,
// the page can keep the menu out of sight and bring it back as soon as the pointer is on its bait. Any change counts like
// just appeared, and the element must lie fully inside the window. The frame's own viewport says nothing about a parent
// page moving the whole frame: the observer's ratio covers that, it is measured against the top window.
// Without the API nothing counts as visible: the menu shows but fills nothing.
const CLIPPED = (s) => [s.clipPath, s.mask, s.maskImage, s.webkitMask, s.webkitMaskImage].some((v) => v && v !== 'none');
const IN_VIEW = 0.99; // not 1: a box at fractional pixels may never report a ratio of exactly 1

globalThis.kvpwsafeVisibleGuard = (element, minMs = 500) => {
  let since = 0;
  let watcher = null;
  let place = null;
  let frame = 0;
  // Up through the shadow root to the host and its ancestors: all of them are the page's to style.
  const clipped = () => {
    if (typeof getComputedStyle !== 'function') return false;
    for (let node = element; node; node = node.parentElement || node.parentNode?.host || null) {
      if (node.nodeType === 1 && CLIPPED(getComputedStyle(node))) return true;
    }
    return false;
  };
  const where = () => {
    const r = element.getBoundingClientRect();
    return `${r.left},${r.top},${r.width},${r.height},${clipped()}`;
  };
  const inWindow = () => {
    const r = element.getBoundingClientRect();
    return r.width > 0 && r.height > 0 && r.left >= 0 && r.top >= 0 && r.right <= window.innerWidth && r.bottom <= window.innerHeight;
  };
  const restart = () => {
    since = Date.now();
    place = where();
  };
  // Runs only while the guard does: stop() ends it when the menu or bar closes.
  const eachFrame = () => {
    if (since && where() !== place) restart();
    frame = requestAnimationFrame(eachFrame);
  };
  if (typeof IntersectionObserver === 'function') {
    watcher = new IntersectionObserver((seen) => {
      const { isVisible, intersectionRatio } = seen.at(-1);
      if (!isVisible || intersectionRatio < IN_VIEW) since = 0;
      else if (!since) restart();
    }, { trackVisibility: true, delay: 100, threshold: [IN_VIEW] });
    watcher.observe(element);
    frame = requestAnimationFrame(eachFrame);
  }
  return {
    clear: () => {
      if (!since) return false;
      if (where() !== place) {
        restart();
        return false;
      }
      return !clipped() && inWindow() && Date.now() - since >= minMs;
    },
    /** The owner moved the element itself (scrolling): the new place counts, and the time starts over if it changed. */
    moved: () => {
      if (since && where() !== place) restart();
    },
    stop: () => {
      watcher?.disconnect();
      if (frame) cancelAnimationFrame(frame);
    },
  };
};
