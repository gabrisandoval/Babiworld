// Input handling: touch controls (multitouch), plus keyboard and mouse for testing on a PC.
//
// Usage:
//   const input = createInput(document.getElementById('controls'));
//   input.state  -> { left, right, jump } (booleans, read every frame)
//   input.reset() -> releases everything (e.g. when the game restarts)

const ACTIONS = ['left', 'right', 'jump'];

const KEY_MAP = {
  ArrowLeft: 'left',
  KeyA: 'left',
  ArrowRight: 'right',
  KeyD: 'right',
  ArrowUp: 'jump',
  KeyW: 'jump',
  Space: 'jump',
};

function emptyState() {
  return { left: false, right: false, jump: false };
}

export function createInput(controlsEl) {
  const buttons = [...controlsEl.querySelectorAll('[data-control]')];

  // Each input source keeps its own state; they are combined when read.
  let touch = emptyState();
  let keys = emptyState();
  let mouse = emptyState();

  const controlsVisible = () => !controlsEl.classList.contains('hidden');

  // Returns the action ('left' | 'right' | 'jump') of the control under a screen point, if any.
  // elementFromPoint works in screen coordinates, so it also works when the app is rotated.
  function actionAt(x, y) {
    const el = document.elementFromPoint(x, y)?.closest('[data-control]');
    return el && controlsEl.contains(el) ? el.dataset.control : null;
  }

  // Highlights the buttons that are currently pressed.
  function refreshButtons() {
    const current = combined();
    for (const button of buttons) {
      button.classList.toggle('active', current[button.dataset.control]);
    }
  }

  function combined() {
    const result = emptyState();
    for (const action of ACTIONS) {
      result[action] = touch[action] || keys[action] || mouse[action];
    }
    return result;
  }

  // ---------------------------------------------------------------------------
  // Touch: on every touch event, rebuild the state from ALL fingers on screen.
  // This gives multitouch for free (run + jump) and lets a finger slide
  // from one button to another without lifting it.
  // ---------------------------------------------------------------------------

  function onTouch(event) {
    if (!controlsVisible()) return;

    const next = emptyState();
    let onControl = false;

    for (const t of event.touches) {
      const action = actionAt(t.clientX, t.clientY);
      if (action) {
        next[action] = true;
        onControl = true;
      }
    }

    // Block scrolling, zooming and fake mouse clicks while touching the controls.
    if (onControl || event.target.closest?.('[data-control]')) {
      event.preventDefault();
    }

    touch = next;
    refreshButtons();
  }

  for (const type of ['touchstart', 'touchmove', 'touchend', 'touchcancel']) {
    document.addEventListener(type, onTouch, { passive: false });
  }

  // ---------------------------------------------------------------------------
  // Mouse: click and hold the on-screen buttons (useful for desktop testing).
  // ---------------------------------------------------------------------------

  for (const button of buttons) {
    button.addEventListener('pointerdown', (event) => {
      if (event.pointerType !== 'mouse') return;
      mouse[button.dataset.control] = true;
      refreshButtons();
    });
  }

  window.addEventListener('pointerup', (event) => {
    if (event.pointerType !== 'mouse') return;
    mouse = emptyState();
    refreshButtons();
  });

  // ---------------------------------------------------------------------------
  // Keyboard: arrows / WASD / space.
  // ---------------------------------------------------------------------------

  function onKey(event, pressed) {
    const action = KEY_MAP[event.code];
    if (!action) return;
    // Don't steal keys while typing the room code.
    if (event.target instanceof HTMLInputElement) return;

    keys[action] = pressed;
    if (controlsVisible()) event.preventDefault();
    refreshButtons();
  }

  window.addEventListener('keydown', (event) => onKey(event, true));
  window.addEventListener('keyup', (event) => onKey(event, false));

  // ---------------------------------------------------------------------------
  // Safety: release everything when the page loses focus, so no button gets "stuck".
  // ---------------------------------------------------------------------------

  function reset() {
    touch = emptyState();
    keys = emptyState();
    mouse = emptyState();
    refreshButtons();
  }

  window.addEventListener('blur', reset);
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) reset();
  });

  return {
    get state() {
      return combined();
    },
    reset,
  };
}