// Game entry point: splash screen, menu, connection to the server, game loop.
//
// Flow:
//   splash (real loading: level + server connection, min 1.5 s)
//   -> menu (room code)
//   -> lobby: character selection (fire / water, never the same), waiting for the other player
//   -> playing  <-> dead / complete (server restarts the level)

import {
  CHARACTER,
  FIXED_DT,
  CLIENT_SEND_RATE,
  INTERPOLATION_DELAY,
} from '/shared/constants.js';
import { createPlayer, stepPlayer, playerSnapshot } from '/shared/physics.js';
import { createInput } from './input.js';
import { createRenderer } from './render.js';

const FIRST_LEVEL_ID = 'level1';
const SPLASH_MIN_TIME = 1500; // ms
const CODE_LENGTH = 4; // room code: 4 digits
const SEND_INTERVAL = 1 / CLIENT_SEND_RATE; // s
const MAX_SNAPSHOTS = 30; // remote states kept for interpolation

// ---------------------------------------------------------------------------
// DOM
// ---------------------------------------------------------------------------

const $ = (id) => document.getElementById(id);

const canvas = $('canvas');
const controlsEl = $('controls');
const fullscreenBtn = $('fullscreen-btn');

const splashEl = $('splash');
const loadingFill = $('loading-fill');
const loadingText = $('loading-text');

const tapText = $('tap-text');

const menuEl = $('menu');
const keypadEl = $('keypad');
const codeBoxes = [...document.querySelectorAll('.code-box')];
const menuStatus = $('menu-status');

const selectEl = $('select');
const selectCode = $('select-code');
const selectStatus = $('select-status');
const selectBack = $('select-back');
const cards = [...document.querySelectorAll('.card')];

const messageEl = $('message');
const messageText = $('message-text');
const messageSub = $('message-sub');

const show = (el) => el.classList.remove('hidden');
const hide = (el) => el.classList.add('hidden');

function showMessage(text, sub = '') {
  messageText.textContent = text;
  messageSub.textContent = sub;
  show(messageEl);
}

function setMenuStatus(text, isError = false) {
  menuStatus.textContent = text;
  menuStatus.classList.toggle('error', isError);
}

function setSelectStatus(text, isError = false) {
  selectStatus.textContent = text;
  selectStatus.classList.toggle('error', isError);
}

// ---------------------------------------------------------------------------
// Game state
// ---------------------------------------------------------------------------

const input = createInput(controlsEl);
const socket = io({ autoConnect: false });
const levels = {}; // levelId -> parsed JSON

let phase = 'loading'; // loading | menu | lobby | playing | dead | complete
let roomCode = null;
let myCharacter = null;
let otherLeft = false; // the other player disconnected (shown on the selection screen)

let level = null;
let renderer = null;
let world = { buttons: {}, doors: {} };

let localPlayer = null;
let remote = null; // { character, snapshots: [{ t, x, y, facing, state, alive }] }

// ---------------------------------------------------------------------------
// Splash screen with real loading steps
// ---------------------------------------------------------------------------

function setProgress(fraction, text) {
  loadingFill.style.width = `${Math.round(fraction * 100)}%`;
  loadingText.textContent = text;
}

async function loadLevel(levelId) {
  if (!levels[levelId]) {
    const response = await fetch(`/levels/${levelId}.json`);
    if (!response.ok) throw new Error(`Cannot load level ${levelId}`);
    levels[levelId] = await response.json();
  }
  return levels[levelId];
}

function connectToServer() {
  return new Promise((resolve) => {
    socket.once('connect', resolve);
    socket.connect();
  });
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// Resolves on the first tap / click / key press on the element.
function waitForTap(el) {
  return new Promise((resolve) => {
    const done = () => {
      el.removeEventListener('click', done);
      window.removeEventListener('keydown', done);
      resolve();
    };
    el.addEventListener('click', done);
    window.addEventListener('keydown', done);
  });
}

async function boot() {
  const startedAt = performance.now();

  try {
    setProgress(0.1, 'Loading level…');
    useLevel(await loadLevel(FIRST_LEVEL_ID));

    setProgress(0.5, 'Connecting to server…');
    await connectToServer();

    setProgress(1, 'Ready');
  } catch (error) {
    console.error(error);
    setProgress(0, 'Loading failed. Reload the page to try again.');
    return;
  }

  // Keep the splash visible for a minimum time, so it doesn't just flash.
  const elapsed = performance.now() - startedAt;
  if (elapsed < SPLASH_MIN_TIME) await wait(SPLASH_MIN_TIME - elapsed);

  // Browsers allow fullscreen and orientation lock only after a user gesture,
  // so the splash ends with "Tap to start".
  hide(document.getElementById('loading-bar'));
  hide(loadingText);
  show(tapText);
  await waitForTap(splashEl);
  enterFullscreen();

  splashEl.classList.add('fade-out');
  await wait(400);
  hide(splashEl);

  phase = 'menu';
  show(menuEl);
}

function useLevel(newLevel) {
  if (level !== newLevel) {
    level = newLevel;
    renderer = createRenderer(canvas, level);
  }
}

// ---------------------------------------------------------------------------
// Menu
// ---------------------------------------------------------------------------

// The room code is typed with the in-game keypad, never with the system keyboard:
// the system keyboard follows the real phone orientation, the keypad follows the game.

let typedCode = '';

function renderCode() {
  codeBoxes.forEach((box, i) => {
    box.textContent = typedCode[i] ?? '';
    box.classList.toggle('current', i === typedCode.length);
  });
}

function pressKey(key) {
  if (phase !== 'menu') return; // code is locked after joining

  if (/^[0-9]$/.test(key)) {
    if (typedCode.length < CODE_LENGTH) typedCode += key;
    setMenuStatus('');
  } else if (key === 'delete') {
    typedCode = typedCode.slice(0, -1);
    setMenuStatus('');
  } else if (key === 'join') {
    if (typedCode.length !== CODE_LENGTH) {
      setMenuStatus(`Enter ${CODE_LENGTH} digits`, true);
      return;
    }
    roomCode = typedCode;
    setMenuStatus('Joining…');
    socket.emit('room:join', roomCode);
    // A tap is a user gesture: re-enter fullscreen in case the player left it.
    enterFullscreen();
  }

  renderCode();
}

keypadEl.addEventListener('click', (event) => {
  const key = event.target.closest('[data-key]')?.dataset.key;
  if (key) pressKey(key);
});

// Physical keyboard on a PC: digits, Backspace, Enter.
window.addEventListener('keydown', (event) => {
  if (menuEl.classList.contains('hidden')) return;
  if (/^[0-9]$/.test(event.key)) pressKey(event.key);
  else if (event.key === 'Backspace') pressKey('delete');
  else if (event.key === 'Enter') pressKey('join');
});

renderCode();

// ---------------------------------------------------------------------------
// Character selection (lobby)
// Each player taps Fire or Water. A character taken by the other player is disabled.
// Tapping the other free card switches character. The game starts when both have chosen.
// ---------------------------------------------------------------------------

function showSelect(code, me, other) {
  selectCode.textContent = code;

  for (const card of cards) {
    const character = card.dataset.character;
    const mine = me.character === character;
    const taken = other?.character === character;
    card.classList.toggle('mine', mine);
    card.classList.toggle('taken', taken);
    card.disabled = taken;
    card.querySelector('.card-tag').textContent = mine ? 'You' : taken ? 'Other player' : '';
  }

  if (!other) {
    setSelectStatus(otherLeft ? 'The other player left. Waiting for someone to join…' : 'Waiting for the other player to join…');
  } else if (!me.character) {
    setSelectStatus('Choose Fire or Water');
  } else if (!other.character) {
    setSelectStatus('Waiting for the other player to choose…');
  } else {
    setSelectStatus('Starting…');
  }

  show(selectEl);
}

for (const card of cards) {
  card.addEventListener('click', () => {
    if (phase !== 'lobby' || card.disabled) return;
    const character = card.dataset.character;
    if (character !== myCharacter) socket.emit('player:choose', character);
  });
}

// "Back": leave the room and return to the keypad with an empty code.
selectBack.addEventListener('click', () => {
  if (phase !== 'lobby') return;
  socket.emit('room:leave');

  phase = 'menu';
  roomCode = null;
  myCharacter = null;
  otherLeft = false;
  typedCode = '';
  renderCode();
  setMenuStatus('');
  hide(selectEl);
  show(menuEl);
});

// ---------------------------------------------------------------------------
// Socket events
// ---------------------------------------------------------------------------

socket.on('room:error', ({ message }) => {
  if (phase === 'menu') {
    roomCode = null; // could not join: stay on the menu
    setMenuStatus(message, true);
  } else {
    setSelectStatus(message, true);
  }
});

socket.on('room:update', ({ code, players }) => {
  const me = players.find((p) => p.id === socket.id);
  if (!me) return;
  myCharacter = me.character;

  // During the game the character can't change: ignore updates until we're back in the lobby.
  if (phase === 'playing' || phase === 'dead' || phase === 'complete') return;

  phase = 'lobby';
  hide(menuEl);
  hide(messageEl);
  hide(controlsEl);
  showSelect(code, me, players.find((p) => p.id !== socket.id));
});

socket.on('game:start', async ({ levelId, world: startWorld, players }) => {
  useLevel(await loadLevel(levelId));

  myCharacter = players.find((p) => p.id === socket.id)?.character ?? myCharacter;
  const otherCharacter = myCharacter === CHARACTER.FIRE ? CHARACTER.WATER : CHARACTER.FIRE;
  localPlayer = createPlayer(myCharacter, level);
  remote = { character: otherCharacter, snapshots: [] };
  world = startWorld;
  otherLeft = false;

  input.reset();
  hide(menuEl);
  hide(selectEl);
  hide(messageEl);
  show(controlsEl);
  phase = 'playing';
});

socket.on('player:state', (data) => {
  if (!remote || data.character !== remote.character) return;
  remote.snapshots.push({ t: performance.now(), ...data });
  if (remote.snapshots.length > MAX_SNAPSHOTS) remote.snapshots.shift();
});

socket.on('world:update', (newWorld) => {
  world = newWorld;
});

socket.on('player:died', ({ character }) => {
  phase = 'dead';
  const who = character === myCharacter ? 'You died!' : `${character === CHARACTER.FIRE ? 'Fire' : 'Water'} died!`;
  showMessage(who, 'Restarting…');
});

socket.on('level:complete', () => {
  phase = 'complete';
  showMessage('Level complete!', 'Well done, both of you');
});

// The server follows this with a room:update, which brings back the selection screen.
socket.on('player:disconnected', () => {
  phase = 'lobby';
  otherLeft = true;
  localPlayer = null;
  remote = null;
  hide(controlsEl);
  hide(messageEl);
});

socket.on('disconnect', () => {
  if (phase === 'loading' || phase === 'menu') return;
  hide(controlsEl);
  showMessage('Connection lost', 'Reconnecting…');
});

// After a reconnection the server sees a new player: join the same room again.
socket.on('connect', () => {
  if (roomCode && phase !== 'loading' && phase !== 'menu') {
    phase = 'lobby';
    hide(selectEl);
    showMessage('Reconnected', `Rejoining room ${roomCode}…`);
    socket.emit('room:join', roomCode);
  }
});

// ---------------------------------------------------------------------------
// Remote player interpolation
// The other player is drawn INTERPOLATION_DELAY ms in the past, between the two
// snapshots that surround that moment. This hides network jitter.
// ---------------------------------------------------------------------------

function remotePlayerForRender(now) {
  const { character, snapshots } = remote;

  if (snapshots.length === 0) {
    return createPlayer(character, level); // not moved yet: standing on its spawn
  }

  const renderTime = now - INTERPOLATION_DELAY;
  const newest = snapshots[snapshots.length - 1];

  if (renderTime >= newest.t || snapshots.length === 1) {
    return { character, ...newest };
  }

  for (let i = snapshots.length - 1; i > 0; i--) {
    const a = snapshots[i - 1];
    const b = snapshots[i];
    if (a.t <= renderTime && renderTime <= b.t) {
      const k = (renderTime - a.t) / (b.t - a.t || 1);
      return {
        character,
        x: a.x + (b.x - a.x) * k,
        y: a.y + (b.y - a.y) * k,
        facing: b.facing,
        state: b.state,
        alive: b.alive,
      };
    }
  }

  return { character, ...snapshots[0] };
}

// ---------------------------------------------------------------------------
// Game loop: fixed-step physics, network send at CLIENT_SEND_RATE, render every frame
// ---------------------------------------------------------------------------

let lastFrame = performance.now();
let accumulator = 0;
let sendTimer = 0;

function sendState() {
  socket.emit('player:state', playerSnapshot(localPlayer));
}

function update(dt) {
  if (phase !== 'playing' || !localPlayer) return;

  const { died } = stepPlayer(localPlayer, input.state, level, world.doors);
  if (died) {
    sendState(); // tell the server immediately
    phase = 'dead';
    return;
  }

  sendTimer += dt;
  if (sendTimer >= SEND_INTERVAL) {
    sendTimer -= SEND_INTERVAL;
    sendState();
  }
}

function loop(now) {
  // Clamp long pauses (tab in background) so physics doesn't try to catch up for seconds.
  const frameTime = Math.min((now - lastFrame) / 1000, 0.25);
  lastFrame = now;

  accumulator += frameTime;
  while (accumulator >= FIXED_DT) {
    update(FIXED_DT);
    accumulator -= FIXED_DT;
  }

  if (renderer) {
    const players = [];
    if (remote) players.push(remotePlayerForRender(now));
    if (localPlayer) players.push(localPlayer);
    renderer.draw({ time: now / 1000, players, world });
  }

  requestAnimationFrame(loop);
}

// ---------------------------------------------------------------------------
// Fullscreen + landscape lock
// ---------------------------------------------------------------------------

const root = document.documentElement;
const fullscreenSupported = !!(root.requestFullscreen || root.webkitRequestFullscreen);

function isFullscreen() {
  return !!(document.fullscreenElement || document.webkitFullscreenElement);
}

async function enterFullscreen() {
  if (!fullscreenSupported || isFullscreen()) return;
  try {
    await (root.requestFullscreen?.() ?? root.webkitRequestFullscreen?.());
    // Works on Android in fullscreen; ignored where not supported.
    await screen.orientation?.lock?.('landscape');
  } catch {
    // Not allowed or not supported: the CSS rotation still keeps the game in landscape.
  }
}

async function exitFullscreen() {
  try {
    await (document.exitFullscreen?.() ?? document.webkitExitFullscreen?.());
  } catch {
    // ignore
  }
}

if (fullscreenSupported) {
  fullscreenBtn.addEventListener('click', () => {
    if (isFullscreen()) exitFullscreen();
    else enterFullscreen();
  });
} else {
  // e.g. iPhone Safari: no Fullscreen API for pages (use "Add to Home Screen" instead).
  hide(fullscreenBtn);
}

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

requestAnimationFrame(loop);
boot();