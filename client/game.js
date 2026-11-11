// Game entry point: splash screen, menu, connection to the server, game loop.
//
// Flow:
//   splash (real loading: levels + server connection, min 1.5 s)
//   -> home (Play / Settings)
//   -> level selection
//   -> menu (room code)
//   -> lobby: character selection (fire / water, never the same), waiting for the other player
//   -> playing  <-> dead / complete (server restarts the level)

import {
  CHARACTER,
  WORLD_WIDTH,
  WORLD_HEIGHT,
  PLAYER_WIDTH,
  PLAYER_HEIGHT,
  FIXED_DT,
  CLIENT_SEND_RATE,
  INTERPOLATION_DELAY,
} from '/shared/constants.js';
import { createPlayer, stepPlayer, playerSnapshot } from '/shared/physics.js';
import { createInput } from './input.js';
import { createRenderer } from './render.js';

const SPLASH_MIN_TIME = 1500; // ms
const CODE_LENGTH = 4; // room code: 4 digits
const SEND_INTERVAL = 1 / CLIENT_SEND_RATE; // s
const MAX_SNAPSHOTS = 30; // remote states kept for interpolation

// Camera: while playing, the view is zoomed in and follows this phone's character.
// In the menus the whole level is visible (zoom 1).
const CAMERA_ZOOM = 1.8; // 1.8 -> about 18 × 10 tiles visible
const CAMERA_FOLLOW_SPEED = 8; // higher = camera catches up faster
const CAMERA_ZOOM_SPEED = 3;

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

const homeEl = $('home');
const settingsEl = $('settings');
const levelsEl = $('levels');
const levelList = $('level-list');

const menuEl = $('menu');
const menuLevel = $('menu-level');
const keypadEl = $('keypad');
const codeBoxes = [...document.querySelectorAll('.code-box')];
const menuStatus = $('menu-status');

const selectEl = $('select');
const selectCode = $('select-code');
const selectLevelEl = $('select-level');
const selectStatus = $('select-status');
const selectBack = $('select-back');
const cards = [...document.querySelectorAll('.card')];

const messageEl = $('message');
const messageText = $('message-text');
const messageSub = $('message-sub');

const show = (el) => el.classList.remove('hidden');
const hide = (el) => el.classList.add('hidden');

// Menu screens: only one is visible at a time.
const SCREENS = { home: homeEl, settings: settingsEl, levels: levelsEl, menu: menuEl, select: selectEl };

function showScreen(name) {
  for (const [key, el] of Object.entries(SCREENS)) {
    if (key === name) show(el);
    else hide(el);
  }
}

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
let levelIndex = []; // [{ id, name }] from levels/index.json
let selectedLevelId = null;

// loading | home | settings | levels | menu (room code) | lobby (character) | playing | dead | complete
let phase = 'loading';
let roomCode = null;
let myCharacter = null;
let otherLeft = false; // the other player disconnected (shown on the selection screen)

let level = null;
let renderer = null;
let world = { buttons: {}, doors: {} };

let localPlayer = null;
let remote = null; // { character, snapshots: [{ t, x, y, facing, state, alive }] }

const camera = { x: 0, y: 0, zoom: 1 };

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

async function loadLevelIndex() {
  const response = await fetch('/levels/index.json');
  if (!response.ok) throw new Error('Cannot load the level list');
  return (await response.json()).levels;
}

async function boot() {
  const startedAt = performance.now();

  try {
    setProgress(0.1, 'Loading levels…');
    levelIndex = await loadLevelIndex();
    for (let i = 0; i < levelIndex.length; i++) {
      await loadLevel(levelIndex[i].id);
      setProgress(0.1 + (0.5 * (i + 1)) / levelIndex.length, 'Loading levels…');
    }
    selectedLevelId = levelIndex[0].id;
    useLevel(levels[selectedLevelId]); // shown behind the menus

    setProgress(0.7, 'Connecting to server…');
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

  buildLevelList();

  splashEl.classList.add('fade-out');
  await wait(400);
  hide(splashEl);

  goTo('home');
}

function useLevel(newLevel) {
  if (level !== newLevel) {
    level = newLevel;
    renderer = createRenderer(canvas, level);
  }
}

// ---------------------------------------------------------------------------
// Navigation: home -> (settings) / levels -> room code -> character selection
// ---------------------------------------------------------------------------

const MENU_PHASES = new Set(['loading', 'home', 'settings', 'levels', 'menu']);

function goTo(screen) {
  phase = screen;
  showScreen(screen);
}

// "Level 1 · First Steps"
function levelLabel(levelId) {
  const i = levelIndex.findIndex((l) => l.id === levelId);
  return i >= 0 ? `Level ${i + 1} · ${levelIndex[i].name}` : levelId;
}

$('play-btn').addEventListener('click', () => {
  // A tap is a user gesture: the browser allows fullscreen here (Android).
  enterFullscreen();
  goTo('levels');
});

$('settings-btn').addEventListener('click', () => goTo('settings'));

// Back buttons with data-back="<screen>"
for (const button of document.querySelectorAll('[data-back]')) {
  button.addEventListener('click', () => goTo(button.dataset.back));
}

// One card per level in levels/index.json, plus a locked "coming soon" card.
function buildLevelList() {
  levelList.innerHTML = '';

  levelIndex.forEach((info, i) => {
    const card = document.createElement('button');
    card.className = 'level-card';
    card.innerHTML = `<span class="level-number">${i + 1}</span><span class="level-name"></span>`;
    card.querySelector('.level-name').textContent = info.name;
    card.addEventListener('click', () => selectLevel(info.id));
    levelList.appendChild(card);
  });

  const locked = document.createElement('button');
  locked.className = 'level-card locked';
  locked.disabled = true;
  locked.innerHTML = '<span class="level-number">?</span><span class="level-name">Coming soon</span>';
  levelList.appendChild(locked);
}

function selectLevel(levelId) {
  selectedLevelId = levelId;
  useLevel(levels[levelId]); // preview it behind the menu
  menuLevel.textContent = levelLabel(levelId);
  typedCode = '';
  renderCode();
  setMenuStatus('');
  goTo('menu');
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
    socket.emit('room:join', { code: roomCode, levelId: selectedLevelId });
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

function showSelect(code, levelId, me, other) {
  selectCode.textContent = code;
  selectLevelEl.textContent = levelLabel(levelId);

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

  showScreen('select');
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

  roomCode = null;
  myCharacter = null;
  otherLeft = false;
  typedCode = '';
  renderCode();
  setMenuStatus('');
  goTo('menu');
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

socket.on('room:update', ({ code, levelId, players }) => {
  const me = players.find((p) => p.id === socket.id);
  if (!me) return;
  myCharacter = me.character;

  // During the game the character can't change: ignore updates until we're back in the lobby.
  if (phase === 'playing' || phase === 'dead' || phase === 'complete') return;

  // If we joined a room created by the other player, the room's level wins.
  if (levels[levelId]) {
    selectedLevelId = levelId;
    useLevel(levels[levelId]);
  }

  phase = 'lobby';
  hide(messageEl);
  hide(controlsEl);
  showSelect(code, levelId, me, players.find((p) => p.id !== socket.id));
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
  showScreen(null); // hide every menu screen
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
  if (MENU_PHASES.has(phase)) return;
  hide(controlsEl);
  showMessage('Connection lost', 'Reconnecting…');
});

// After a reconnection the server sees a new player: join the same room again.
socket.on('connect', () => {
  if (roomCode && !MENU_PHASES.has(phase)) {
    phase = 'lobby';
    hide(selectEl);
    showMessage('Reconnected', `Rejoining room ${roomCode}…`);
    socket.emit('room:join', { code: roomCode, levelId: selectedLevelId });
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

  resizeCanvas();
  updateCamera(frameTime);

  if (renderer) {
    const players = [];
    if (remote) players.push(remotePlayerForRender(now));
    if (localPlayer) players.push(localPlayer);
    renderer.draw({ time: now / 1000, players, world, camera, localCharacter: myCharacter });
  }

  requestAnimationFrame(loop);
}

// ---------------------------------------------------------------------------
// Canvas resolution: match the real screen pixels (CSS size × devicePixelRatio),
// so drawing stays sharp on high-density phone screens, also when zoomed in.
// ---------------------------------------------------------------------------

function resizeCanvas() {
  // clientWidth/Height are the layout size, not affected by the CSS rotation.
  const dpr = Math.min(window.devicePixelRatio || 1, 3);
  const width = Math.round(canvas.clientWidth * dpr);
  const height = Math.round(canvas.clientHeight * dpr);
  if (width > 0 && height > 0 && (canvas.width !== width || canvas.height !== height)) {
    canvas.width = width;
    canvas.height = height;
  }
}

// ---------------------------------------------------------------------------
// Camera: smoothly zooms in and follows the local player, without showing outside the level
// ---------------------------------------------------------------------------

const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

function updateCamera(dt) {
  const targetZoom = localPlayer ? CAMERA_ZOOM : 1;
  camera.zoom += (targetZoom - camera.zoom) * Math.min(1, dt * CAMERA_ZOOM_SPEED);

  const viewW = WORLD_WIDTH / camera.zoom;
  const viewH = WORLD_HEIGHT / camera.zoom;

  // Point to keep in the center: the local player, or the level center in the menus
  const focusX = localPlayer ? localPlayer.x + PLAYER_WIDTH / 2 : WORLD_WIDTH / 2;
  const focusY = localPlayer ? localPlayer.y + PLAYER_HEIGHT / 2 : WORLD_HEIGHT / 2;

  const targetX = clamp(focusX - viewW / 2, 0, WORLD_WIDTH - viewW);
  const targetY = clamp(focusY - viewH / 2, 0, WORLD_HEIGHT - viewH);

  const follow = Math.min(1, dt * CAMERA_FOLLOW_SPEED);
  camera.x = clamp(camera.x + (targetX - camera.x) * follow, 0, WORLD_WIDTH - viewW);
  camera.y = clamp(camera.y + (targetY - camera.y) * follow, 0, WORLD_HEIGHT - viewH);
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