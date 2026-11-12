// Game entry point: splash screen, menu, connection to the server, game loop.
//
// Flow:
//   splash (real loading: levels + server connection, min 1.5 s)
//   -> home (Play / Settings)
//   -> menu (room code / PIN, once per session)
//   -> character selection (fire / water, never the same)
//   -> level selection, shared: one player proposes, the other confirms
//   -> playing <-> dead (restart) -> complete (Play again / Next level / Levels)
// The room lasts until a player goes back to Home.

import {
  CHARACTER,
  WORLD_WIDTH,
  WORLD_HEIGHT,
  PLAYER_WIDTH,
  PLAYER_HEIGHT,
  TILE_SIZE,
  FIXED_DT,
  CLIENT_SEND_RATE,
  INTERPOLATION_DELAY,
} from '/shared/constants.js';
import { createPlayer, stepPlayer, playerSnapshot, createElevatorState, stepElevators } from '/shared/physics.js';
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
const levelsCode = $('levels-code');
const levelsStatus = $('levels-status');
const proposalEl = $('proposal');
const proposalText = $('proposal-text');
const proposalAccept = $('proposal-accept');
const proposalCancel = $('proposal-cancel');

const menuEl = $('menu');
const keypadEl = $('keypad');
const codeBoxes = [...document.querySelectorAll('.code-box')];
const menuStatus = $('menu-status');

const selectEl = $('select');
const selectCode = $('select-code');
const selectStatus = $('select-status');
const selectBack = $('select-back');
const cards = [...document.querySelectorAll('.card')];

const quitEl = $('quit');
const quitTitle = $('quit-title');
const quitText = $('quit-text');
const quitCancel = $('quit-cancel');
const quitLeave = $('quit-leave');

const completeEl = $('complete');
const completeLevel = $('complete-level');
const completeStatus = $('complete-status');
const completeReplay = $('complete-replay');
const completeNext = $('complete-next');

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
let sprites = null; // character sprites (null = draw characters with shapes)

// loading | home | settings | menu (room code) | select | levels | playing | dead | complete
let phase = 'loading';
let roomCode = null;
let myCharacter = null;
let otherLeft = false; // the other player disconnected (shown on the selection screen)

let level = null;
let renderer = null;
let world = { buttons: {}, doors: {}, elevators: {} };
let elevatorOffsets = {}; // elevator positions, moved locally (see stepElevators)

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

// Loads client/sprites/sprites.json and the character images.
// If anything is missing, returns null and the characters are drawn with shapes.
async function loadSprites() {
  try {
    const response = await fetch('/sprites/sprites.json');
    if (!response.ok) return null;
    const config = await response.json();

    const bySource = {};
    await Promise.all(
      [...new Set(Object.values(config.characters))].map(
        (src) =>
          new Promise((resolve) => {
            const img = new Image();
            img.onload = () => {
              bySource[src] = img;
              resolve();
            };
            img.onerror = () => resolve(); // missing image: fall back to shapes
            img.src = `/${src}`;
          }),
      ),
    );

    const images = {};
    for (const [character, src] of Object.entries(config.characters)) {
      if (bySource[src]) images[character] = bySource[src];
    }
    return { ...config, images };
  } catch (error) {
    console.warn('Sprites not loaded, using shapes', error);
    return null;
  }
}

// Shows the sprite (front-facing frame) on the character selection cards.
function applySpritePreviews() {
  if (!sprites) return;
  const { frameSize, preview } = sprites;
  for (const card of cards) {
    const src = sprites.characters[card.dataset.character];
    if (!sprites.images[card.dataset.character]) continue;
    const el = card.querySelector('.char');
    el.classList.add('has-sprite');
    el.style.backgroundImage = `url('/${src}')`;
    el.style.backgroundPosition = `-${preview.frame * frameSize}px -${preview.row * frameSize}px`;
  }
}

async function boot() {
  const startedAt = performance.now();

  try {
    setProgress(0.05, 'Loading characters…');
    sprites = await loadSprites();
    applySpritePreviews();

    setProgress(0.25, 'Loading levels…');
    levelIndex = await loadLevelIndex();
    for (let i = 0; i < levelIndex.length; i++) {
      await loadLevel(levelIndex[i].id);
      setProgress(0.25 + (0.4 * (i + 1)) / levelIndex.length, 'Loading levels…');
    }
    useLevel(levels[levelIndex[0].id]); // shown behind the menus

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

  // Show the home screen first, underneath the splash, then fade the splash out:
  // this way there is never a moment with no background.
  goTo('home');
  splashEl.classList.add('fade-out');
  await wait(400);
  hide(splashEl);
}

function useLevel(newLevel) {
  if (level !== newLevel) {
    level = newLevel;
    renderer = createRenderer(canvas, level, sprites);
  }
}

// ---------------------------------------------------------------------------
// Navigation
//   Home -> Play -> room code (PIN) -> character selection -> level selection -> game
// The room lasts for the whole session: after a level both players go back to the
// level selection together. "Home" on the level screen leaves the room.
// ---------------------------------------------------------------------------

const MENU_PHASES = new Set(['loading', 'home', 'settings', 'menu']);
const GAME_PHASES = new Set(['playing', 'dead', 'complete']);

function goTo(screen) {
  phase = screen;
  showScreen(screen);
}

// ---------------------------------------------------------------------------
// Progress: completed levels are saved on this phone (used later for the story Skip)
// ---------------------------------------------------------------------------

const PROGRESS_KEY = 'babiworld.completedLevels';

function completedLevels() {
  try {
    return new Set(JSON.parse(localStorage.getItem(PROGRESS_KEY) ?? '[]'));
  } catch {
    return new Set();
  }
}

function markCompleted(levelId) {
  try {
    const done = completedLevels();
    done.add(levelId);
    localStorage.setItem(PROGRESS_KEY, JSON.stringify([...done]));
  } catch {
    // storage not available (e.g. private mode): progress just isn't saved
  }
}

// "Level 1 · First Steps"
function levelLabel(levelId) {
  const i = levelIndex.findIndex((l) => l.id === levelId);
  return i >= 0 ? `Level ${i + 1} · ${levelIndex[i].name}` : levelId;
}

$('play-btn').addEventListener('click', () => {
  // A tap is a user gesture: the browser allows fullscreen here (Android).
  enterFullscreen();
  typedCode = '';
  renderCode();
  setMenuStatus('');
  goTo('menu');
});

$('settings-btn').addEventListener('click', () => goTo('settings'));

// Back buttons with data-back="<screen>"
for (const button of document.querySelectorAll('[data-back]')) {
  button.addEventListener('click', () => goTo(button.dataset.back));
}

// ---------------------------------------------------------------------------
// Room code (PIN)
// The code is typed with the in-game keypad, never with the system keyboard:
// the system keyboard follows the real phone orientation, the keypad follows the game.
// ---------------------------------------------------------------------------

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
    socket.emit('room:join', { code: roomCode });
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
// Room state from the server
// room:update = { code, status: 'select' | 'levels' | 'playing' | 'dead' | 'complete',
//                 levelId, proposal: { levelId, by } | null, players: [{ id, character }] }
// ---------------------------------------------------------------------------

let room = null; // last room:update

function me() {
  return room?.players.find((p) => p.id === socket.id);
}

function other() {
  return room?.players.find((p) => p.id !== socket.id);
}

// Leaves the game view (controls, overlays, players) and goes back to a lobby screen.
function exitGameView() {
  localPlayer = null; // the camera zooms back out to the whole level
  remote = null;
  world = { buttons: {}, doors: {}, elevators: {} };
  elevatorOffsets = {};
  input.reset();
  hide(controlsEl);
  hide(quitEl);
  hide(completeEl);
  hide(messageEl);
}

// Shows the right lobby screen for the current room status.
function showLobby() {
  if (!room) return;
  if (room.status === 'levels') {
    phase = 'levels';
    renderLevels();
    showScreen('levels');
  } else {
    phase = 'select';
    renderSelect();
    showScreen('select');
  }
}

// ---------------------------------------------------------------------------
// Character selection
// Each player taps Fire or Water. A character taken by the other player is disabled.
// Tapping the other free card switches character. When both have chosen, the room
// moves on to the level selection.
// ---------------------------------------------------------------------------

function renderSelect() {
  const mine = me();
  const theirs = other();
  selectCode.textContent = room.code;

  for (const card of cards) {
    const character = card.dataset.character;
    const isMine = mine?.character === character;
    const taken = theirs?.character === character;
    card.classList.toggle('mine', isMine);
    card.classList.toggle('taken', taken);
    card.disabled = taken;
    card.querySelector('.card-tag').textContent = isMine ? 'You' : taken ? 'Other player' : '';
  }

  if (!theirs) {
    setSelectStatus(otherLeft ? 'The other player left. Waiting for someone to join…' : 'Waiting for the other player to join…');
  } else if (!mine?.character) {
    setSelectStatus('Choose Fire or Water');
  } else {
    setSelectStatus('Waiting for the other player to choose…');
  }
}

for (const card of cards) {
  card.addEventListener('click', () => {
    if (phase !== 'select' || card.disabled) return;
    if (card.dataset.character !== me()?.character) socket.emit('player:choose', card.dataset.character);
  });
}

// "Back" on the character screen: leave the room and return to the keypad (e.g. wrong code).
selectBack.addEventListener('click', () => {
  if (phase !== 'select') return;
  leaveRoom();
  typedCode = '';
  renderCode();
  setMenuStatus('');
  goTo('menu');
});

function leaveRoom() {
  socket.emit('room:leave');
  room = null;
  roomCode = null;
  myCharacter = null;
  otherLeft = false;
}

// ---------------------------------------------------------------------------
// Level selection (shared by both players)
// Tapping a level proposes it; the other player confirms with "Play"
// (or by tapping the same level). Tapping another level changes the proposal.
// ---------------------------------------------------------------------------

function renderLevels() {
  levelsCode.textContent = room.code;
  const done = completedLevels();
  const proposal = room.proposal;
  const mineProposal = proposal?.by === socket.id;

  levelList.innerHTML = '';
  levelIndex.forEach((info, i) => {
    const card = document.createElement('button');
    card.className = 'level-card';
    card.innerHTML = `<span class="level-number">${i + 1}</span><span class="level-name"></span>`;
    card.querySelector('.level-name').textContent = info.name;
    if (done.has(info.id)) card.insertAdjacentHTML('beforeend', '<span class="level-done" aria-label="Completed">&#10003;</span>');
    if (proposal?.levelId === info.id) card.classList.add(mineProposal ? 'proposed' : 'proposed-other');
    card.addEventListener('click', () => {
      if (phase === 'levels') socket.emit('level:propose', info.id);
    });
    levelList.appendChild(card);
  });

  const locked = document.createElement('button');
  locked.className = 'level-card locked';
  locked.disabled = true;
  locked.innerHTML = '<span class="level-number">?</span><span class="level-name">Coming soon</span>';
  levelList.appendChild(locked);

  // Proposal banner
  if (!proposal) {
    hide(proposalEl);
    levelsStatus.textContent = otherQuit ? 'The other player went back to the level selection' : 'Tap a level to propose it to the other player';
  } else if (mineProposal) {
    proposalText.textContent = `You proposed ${levelLabel(proposal.levelId)}`;
    hide(proposalAccept);
    show(proposalCancel);
    show(proposalEl);
    levelsStatus.textContent = 'Waiting for the other player to confirm…';
  } else {
    proposalText.textContent = `The other player proposes ${levelLabel(proposal.levelId)}`;
    show(proposalAccept);
    hide(proposalCancel);
    show(proposalEl);
    levelsStatus.textContent = 'Tap Play to start, or choose another level';
  }

  // Preview the proposed level behind the menu
  if (proposal && levels[proposal.levelId]) useLevel(levels[proposal.levelId]);
}

proposalAccept.addEventListener('click', () => {
  if (phase === 'levels') socket.emit('level:accept');
});

proposalCancel.addEventListener('click', () => {
  if (phase === 'levels') socket.emit('level:cancel');
});

// "Home" on the level screen: leave the room (with confirmation, the other player stays alone).
$('levels-back').addEventListener('click', () => {
  if (phase !== 'levels') return;
  openConfirm('home');
});

// ---------------------------------------------------------------------------
// Confirmation dialog
//   'level': leave the current level (both players go back to the level selection)
//   'home':  leave the room (from the level selection)
// ---------------------------------------------------------------------------

let confirmAction = null;

function openConfirm(action) {
  confirmAction = action;
  if (action === 'level') {
    quitTitle.textContent = 'Leave the level?';
    quitText.textContent = 'You will both go back to the level selection.';
    quitCancel.textContent = 'Keep playing';
    quitLeave.textContent = 'Leave';
  } else {
    quitTitle.textContent = 'Leave the room?';
    quitText.textContent = 'The other player will wait in the room for someone to join.';
    quitCancel.textContent = 'Stay';
    quitLeave.textContent = 'Leave';
  }
  input.reset(); // release any held button
  show(quitEl);
}

quitCancel.addEventListener('click', () => hide(quitEl));

quitLeave.addEventListener('click', () => {
  hide(quitEl);
  if (confirmAction === 'level') {
    socket.emit('level:quit'); // the server sends room:update: both go back to the levels
  } else if (confirmAction === 'home') {
    leaveRoom();
    goTo('home');
  }
});

// In-game menu button
$('game-menu-btn').addEventListener('click', () => {
  if (GAME_PHASES.has(phase)) openConfirm('level');
});

// ---------------------------------------------------------------------------
// Level complete: Play again / Next level need both players; Levels goes back for both
// ---------------------------------------------------------------------------

function showVotes(votes = {}) {
  const mine = votes[socket.id];
  const theirs = Object.entries(votes).find(([id]) => id !== socket.id)?.[1];
  const names = { replay: 'play again', next: 'go to the next level' };

  completeReplay.disabled = mine === 'replay';
  completeNext.disabled = mine === 'next';

  if (mine && theirs && mine !== theirs) {
    completeStatus.textContent = `The other player wants to ${names[theirs]}`;
  } else if (mine) {
    completeStatus.textContent = 'Waiting for the other player…';
  } else if (theirs) {
    completeStatus.textContent = `The other player wants to ${names[theirs]}`;
  } else {
    completeStatus.textContent = '';
  }
}

completeReplay.addEventListener('click', () => {
  if (phase === 'complete') socket.emit('level:vote', 'replay');
});

completeNext.addEventListener('click', () => {
  if (phase === 'complete') socket.emit('level:vote', 'next');
});

$('complete-levels').addEventListener('click', () => {
  if (phase === 'complete') socket.emit('level:quit');
});

// ---------------------------------------------------------------------------
// Socket events
// ---------------------------------------------------------------------------

let otherQuit = false; // the other player left the last level (shown on the level screen)

socket.on('room:error', ({ message }) => {
  if (phase === 'menu') {
    roomCode = null; // could not join: stay on the menu
    setMenuStatus(message, true);
  } else {
    setSelectStatus(message, true);
  }
});

socket.on('room:update', (update) => {
  room = update;
  if (!me()) return;
  myCharacter = me().character;

  // While playing, the game events (game:start, level:complete…) drive the screen.
  if (GAME_PHASES.has(update.status)) return;

  // Back to a lobby screen (after joining, a level quit, or the other player leaving).
  if (GAME_PHASES.has(phase)) exitGameView();
  hide(messageEl);
  showLobby();
});

socket.on('level:quit', () => {
  otherQuit = true; // shown on the level screen until the next proposal
});

socket.on('game:start', async ({ levelId, world: startWorld, players }) => {
  useLevel(await loadLevel(levelId));

  myCharacter = players.find((p) => p.id === socket.id)?.character ?? myCharacter;
  const otherCharacter = myCharacter === CHARACTER.FIRE ? CHARACTER.WATER : CHARACTER.FIRE;
  localPlayer = createPlayer(myCharacter, level);
  remote = { character: otherCharacter, snapshots: [] };
  world = startWorld;
  elevatorOffsets = createElevatorState(level);
  otherLeft = false;
  otherQuit = false;

  input.reset();
  showScreen(null); // hide every menu screen
  hide(quitEl);
  hide(completeEl);
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

socket.on('level:complete', ({ levelId, nextLevelId }) => {
  phase = 'complete';
  markCompleted(levelId);

  input.reset();
  hide(controlsEl);
  hide(quitEl);
  hide(messageEl);
  completeLevel.textContent = levelLabel(levelId);
  completeNext.classList.toggle('hidden', !nextLevelId); // last level: no "Next level"
  showVotes({});
  show(completeEl);
});

socket.on('level:votes', (votes) => {
  if (phase === 'complete') showVotes(votes);
});

// The server follows this with a room:update, which brings back the character screen.
socket.on('player:disconnected', () => {
  otherLeft = true;
});

socket.on('disconnect', () => {
  if (MENU_PHASES.has(phase)) return;
  hide(controlsEl);
  showMessage('Connection lost', 'Reconnecting…');
});

// After a reconnection the server sees a new player: join the same room again.
socket.on('connect', () => {
  if (roomCode && !MENU_PHASES.has(phase)) {
    exitGameView();
    showScreen(null);
    showMessage('Reconnected', `Rejoining room ${roomCode}…`);
    phase = 'select';
    socket.emit('room:join', { code: roomCode });
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

  // Elevators move towards their target (top while their button is pressed), then the player
  const elevatorMoves = stepElevators(level, world.elevators ?? {}, elevatorOffsets, dt);
  const { died } = stepPlayer(localPlayer, input.state, level, world.doors, dt, elevatorMoves);
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
    renderer.draw({ time: now / 1000, players, world, camera, localCharacter: myCharacter, elevatorOffsets });
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

  // The screen always shows WORLD_WIDTH × WORLD_HEIGHT world pixels at zoom 1;
  // a level can be bigger than that, and the camera stays inside the level.
  const viewW = WORLD_WIDTH / camera.zoom;
  const viewH = WORLD_HEIGHT / camera.zoom;
  const levelW = level ? level.cols * TILE_SIZE : WORLD_WIDTH;
  const levelH = level ? level.rows * TILE_SIZE : WORLD_HEIGHT;
  const maxX = Math.max(0, levelW - viewW);
  const maxY = Math.max(0, levelH - viewH);

  // Point to keep in the center: the local player, or in the menus the bottom of the
  // level (where the players start; for one-screen levels this is the whole level)
  const focusX = localPlayer ? localPlayer.x + PLAYER_WIDTH / 2 : levelW / 2;
  const focusY = localPlayer ? localPlayer.y + PLAYER_HEIGHT / 2 : levelH - viewH / 2;

  const targetX = clamp(focusX - viewW / 2, 0, maxX);
  const targetY = clamp(focusY - viewH / 2, 0, maxY);

  const follow = Math.min(1, dt * CAMERA_FOLLOW_SPEED);
  camera.x = clamp(camera.x + (targetX - camera.x) * follow, 0, maxX);
  camera.y = clamp(camera.y + (targetY - camera.y) * follow, 0, maxY);
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