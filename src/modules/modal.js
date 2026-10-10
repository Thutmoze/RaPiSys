/**
 * RaPiSys — modal dialog behaviour shared by the confirm, sign-in and
 * dashboard-name dialogs.
 *
 * The overlays are plain divs; this makes each one a real dialog for
 * assistive tech (role, aria-modal, label), keeps Tab inside it, makes the
 * page behind unreachable (inert), and on close returns focus to whatever
 * opened it. Toasts stay reachable while a dialog is open.
 */
const FOCUSABLE = 'button, input, select, textarea, a[href], [tabindex]:not([tabindex="-1"])';
let seq = 0;

/** A unique id for aria-labelledby / aria-describedby. */
export function modalId(prefix) { return `${prefix}-${++seq}`; }

/**
 * Turn `ov` (the overlay) into a modal around `card`, appending it to the
 * page if needed. Returns close(): removes the overlay, restores the page,
 * and refocuses the opener.
 */
export function openModal(ov, card, { labelledBy = null, describedBy = null } = {}) {
  const opener = document.activeElement;
  card.setAttribute('role', 'dialog');
  card.setAttribute('aria-modal', 'true');
  if (labelledBy) card.setAttribute('aria-labelledby', labelledBy);
  if (describedBy) card.setAttribute('aria-describedby', describedBy);
  if (!ov.isConnected) document.body.appendChild(ov);

  // Everything else on the page becomes inert (only what was not already:
  // a dialog opened from another dialog restores exactly what it changed).
  const madeInert = [];
  for (const el of document.body.children) {
    if (el === ov || el.inert || el.tagName === 'SCRIPT' || el.classList.contains('toast-container')) continue;
    el.inert = true;
    madeInert.push(el);
  }

  // Tab and Shift+Tab wrap inside the dialog (visible, enabled controls only;
  // `a[href]`, not `[href]`, which would also match SVG <use href> icons).
  ov.addEventListener('keydown', (e) => {
    if (e.key !== 'Tab') return;
    const f = [...card.querySelectorAll(FOCUSABLE)].filter((x) => !x.disabled && x.getClientRects().length);
    if (!f.length) return;
    const first = f[0], last = f[f.length - 1];
    if (e.shiftKey && (document.activeElement === first || !card.contains(document.activeElement))) {
      e.preventDefault(); last.focus();
    } else if (!e.shiftKey && (document.activeElement === last || !card.contains(document.activeElement))) {
      e.preventDefault(); first.focus();
    }
  });

  let closed = false;
  return function close() {
    if (closed) return;
    closed = true;
    ov.remove();
    for (const el of madeInert) el.inert = false;
    if (opener && opener.isConnected && typeof opener.focus === 'function') opener.focus();
  };
}
