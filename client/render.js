// Rendering: draws the dungeon, liquids, buttons, doors, exits and players on the canvas.
// For the prototype everything is drawn in code (no images).
//
// Usage:
//   const renderer = createRenderer(canvas, level);
//   renderer.draw({ time, players, world, camera, localCharacter });   // once per frame
//
//   time           -> seconds since start (drives animations)
//   players        -> [{ character, x, y, facing, state, alive }]
//   world          -> { buttons: { id: pressed }, doors: { id: open }, elevators, gems: [taken gem ids] }
//   camera         -> { x, y, zoom }: top-left corner of the visible area (world px) and zoom
//                     (zoom 1 = whole level visible)
//   localCharacter -> this phone's character: an arrow points to the OTHER player when off-screen
//
// The canvas can have any pixel size (e.g. screen size × devicePixelRatio for sharp drawing):
// everything is drawn in world coordinates and scaled to fit.

import {
  WORLD_WIDTH,
  WORLD_HEIGHT,
  TILE_SIZE,
  TILE,
  CHARACTER,
  PLAYER_WIDTH,
  PLAYER_HEIGHT,
  PLAYER_STATE,
} from '/shared/constants.js';
import { tileAt, entityRect, gemRect } from '/shared/physics.js';

// ---------------------------------------------------------------------------
// Palette
// ---------------------------------------------------------------------------

const COLORS = {
  background: '#1d1a24',
  backgroundBrick: '#24202d',
  wall: '#4a4456',
  wallDark: '#3a3545',
  wallLight: '#625b70',
  wallEdge: '#7a7289',

  lava: '#ff6a2b',
  lavaLight: '#ffb347',
  water: '#2f8bff',
  waterLight: '#8cc8ff',
  poison: '#4fd14f',
  poisonLight: '#b6f27a',

  button: '#f2c12e',
  buttonPressed: '#b8901c',
  buttonBase: '#5a5366',

  elevator: '#8d93a6',
  elevatorDark: '#5d6273',
  elevatorRail: '#3a3646',
  elevatorOn: '#4ade80',
  elevatorOff: '#e2564b',

  door: '#8a6d4a',
  doorDark: '#5e4a32',
  doorBar: '#c9a46b',

  fire: '#ff5a3c',
  fireLight: '#ffb08a',
  fireDark: '#c23a22',
  waterChar: '#3c9dff',
  waterCharLight: '#a6d4ff',
  waterCharDark: '#1f66c2',

  eyeWhite: '#ffffff',
  pupil: '#1a1a22',
};

// Gem colors: main, light (highlight), dark (shadow side)
const GEM_COLORS = {
  red: ['#ff4d5e', '#ffb3ba', '#b3202f'],
  blue: ['#3fa9ff', '#b8e0ff', '#1662b3'],
  purple: ['#b06cff', '#e2c8ff', '#6a2fb3'],
};

const LIQUID_COLORS = {
  [TILE.LAVA]: { main: COLORS.lava, light: COLORS.lavaLight },
  [TILE.WATER]: { main: COLORS.water, light: COLORS.waterLight },
  [TILE.POISON]: { main: COLORS.poison, light: COLORS.poisonLight },
};

const CHARACTER_COLORS = {
  [CHARACTER.FIRE]: { main: COLORS.fire, light: COLORS.fireLight, dark: COLORS.fireDark },
  [CHARACTER.WATER]: { main: COLORS.waterChar, light: COLORS.waterCharLight, dark: COLORS.waterCharDark },
};

// Depth of the liquid surface inside a pool tile (px from the top of the tile).
const LIQUID_DEPTH = 14;

// How fast doors slide open / closed (fraction per second).
const DOOR_SPEED = 4;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function roundRect(ctx, x, y, w, h, r) {
  const radius = Math.min(r, w / 2, h / 2);
  ctx.beginPath();
  ctx.moveTo(x + radius, y);
  ctx.arcTo(x + w, y, x + w, y + h, radius);
  ctx.arcTo(x + w, y + h, x, y + h, radius);
  ctx.arcTo(x, y + h, x, y, radius);
  ctx.arcTo(x, y, x + w, y, radius);
  ctx.closePath();
}

// Deterministic pseudo-random number in [0, 1) for a tile, so the stone pattern
// looks the same on both phones and does not flicker between frames.
function hash(col, row, salt = 0) {
  const n = Math.sin(col * 127.1 + row * 311.7 + salt * 74.7) * 43758.5453;
  return n - Math.floor(n);
}

const isLiquid = (tile) => tile === TILE.LAVA || tile === TILE.WATER || tile === TILE.POISON;
const isSolid = (tile) => tile !== TILE.EMPTY;

// ---------------------------------------------------------------------------
// Renderer
// ---------------------------------------------------------------------------

// The static layer is drawn at a higher resolution, so it stays sharp when zoomed in.
// Bigger levels get a slightly lower resolution, to keep memory use reasonable on phones.
const STATIC_SCALE = 3;
const STATIC_MAX_PIXELS = 9_000_000;

// `sprites` (optional) is client/sprites/sprites.json plus the loaded images:
// { frameSize, scale, anchorX, anchorY, headY, animations, images: { fire: Image, water: Image } }.
// Without sprites, characters are drawn with shapes.
export function createRenderer(canvas, level, sprites = null) {
  const ctx = canvas.getContext('2d');

  // Static layer (background + walls) is drawn once into an offscreen canvas.
  // Levels can be bigger than one screen (the camera follows the player).
  const levelWidth = level.cols * TILE_SIZE;
  const levelHeight = level.rows * TILE_SIZE;
  const staticScale = Math.min(STATIC_SCALE, Math.sqrt(STATIC_MAX_PIXELS / (levelWidth * levelHeight)));
  const staticLayer = document.createElement('canvas');
  staticLayer.width = Math.round(levelWidth * staticScale);
  staticLayer.height = Math.round(levelHeight * staticScale);
  const staticCtx = staticLayer.getContext('2d');
  staticCtx.scale(staticScale, staticScale);
  drawStaticLayer(staticCtx, level);

  // Door openness: 0 = closed, 1 = open. Animated towards the server state.
  const doorOpenness = {};
  for (const door of level.doors ?? []) doorOpenness[door.id] = 0;

  let lastTime = null;

  function draw({
    time,
    players = [],
    world = { buttons: {}, doors: {} },
    camera = { x: 0, y: 0, zoom: 1 },
    localCharacter = null,
    elevatorOffsets = {},
  }) {
    const dt = lastTime === null ? 0 : Math.min(time - lastTime, 0.1);
    lastTime = time;

    // Canvas pixels per world pixel: the visible area (WORLD_WIDTH / zoom) fills the canvas width.
    const scale = (canvas.width * camera.zoom) / WORLD_WIDTH;

    // Clear in screen space
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.fillStyle = COLORS.background;
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    // World space: everything below is drawn in world coordinates
    ctx.setTransform(scale, 0, 0, scale, -camera.x * scale, -camera.y * scale);

    ctx.drawImage(staticLayer, 0, 0, levelWidth, levelHeight);
    drawLiquids(ctx, level, time);
    drawExits(ctx, level, time);
    drawButtons(ctx, level, world.buttons ?? {});
    drawDoors(ctx, level, world.doors ?? {}, doorOpenness, dt);
    drawElevators(ctx, level, elevatorOffsets, world.elevators ?? {}, time);
    drawGems(ctx, level, world.gems ?? [], time);
    for (const player of players) {
      if (sprites?.images?.[player.character]) drawSpritePlayer(ctx, player, time, sprites);
      else drawPlayer(ctx, player, time);
    }

    // Screen space: arrows towards players outside the visible area
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    for (const player of players) {
      if (player.character !== localCharacter) {
        drawOffscreenIndicator(ctx, canvas, player, camera, scale, time);
      }
    }
  }

  return { draw };
}

// ---------------------------------------------------------------------------
// Off-screen indicator: a circle with an arrow on the screen edge, pointing to the other player
// ---------------------------------------------------------------------------

function drawOffscreenIndicator(ctx, canvas, player, camera, scale, time) {
  const W = canvas.width;
  const H = canvas.height;

  // Player center in screen pixels
  const sx = (player.x + PLAYER_WIDTH / 2 - camera.x) * scale;
  const sy = (player.y + PLAYER_HEIGHT / 2 - camera.y) * scale;

  const margin = H * 0.02;
  const visible = sx > -margin && sx < W + margin && sy > -margin && sy < H + margin;
  if (visible) return;

  // Move from the screen center towards the player until we hit an inner border
  const size = H * 0.045; // indicator radius
  const inset = size * 1.8;
  const cx = W / 2;
  const cy = H / 2;
  const dx = sx - cx;
  const dy = sy - cy;
  const t = Math.min(
    dx !== 0 ? (W / 2 - inset) / Math.abs(dx) : Infinity,
    dy !== 0 ? (H / 2 - inset) / Math.abs(dy) : Infinity,
  );
  const ix = cx + dx * t;
  const iy = cy + dy * t;
  const angle = Math.atan2(dy, dx);
  const colors = CHARACTER_COLORS[player.character];

  ctx.save();
  ctx.globalAlpha = 0.85 + Math.sin(time * 5) * 0.15;

  // Arrow tip pointing towards the player
  ctx.translate(ix, iy);
  ctx.rotate(angle);
  ctx.fillStyle = colors.main;
  ctx.beginPath();
  ctx.moveTo(size * 1.7, 0);
  ctx.lineTo(size * 0.8, -size * 0.6);
  ctx.lineTo(size * 0.8, size * 0.6);
  ctx.closePath();
  ctx.fill();
  ctx.rotate(-angle);

  // Circle with two small eyes, so it reads as "the other character"
  ctx.beginPath();
  ctx.arc(0, 0, size, 0, Math.PI * 2);
  ctx.fill();
  ctx.lineWidth = size * 0.15;
  ctx.strokeStyle = colors.light;
  ctx.stroke();

  for (const side of [-1, 1]) {
    ctx.fillStyle = COLORS.eyeWhite;
    ctx.beginPath();
    ctx.arc(side * size * 0.35, -size * 0.1, size * 0.25, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = COLORS.pupil;
    ctx.beginPath();
    ctx.arc(side * size * 0.35 + Math.cos(angle) * size * 0.1, -size * 0.1 + Math.sin(angle) * size * 0.1, size * 0.12, 0, Math.PI * 2);
    ctx.fill();
  }

  ctx.restore();
}

// ---------------------------------------------------------------------------
// Static layer: background bricks + stone walls
// ---------------------------------------------------------------------------

function drawStaticLayer(ctx, level) {
  // Background: dark brick wall
  const width = level.cols * TILE_SIZE;
  const height = level.rows * TILE_SIZE;
  ctx.fillStyle = COLORS.background;
  ctx.fillRect(0, 0, width, height);

  ctx.strokeStyle = COLORS.backgroundBrick;
  ctx.lineWidth = 1;
  const brickH = 15;
  const brickW = 30;
  for (let y = 0; y < height; y += brickH) {
    const offset = (y / brickH) % 2 === 0 ? 0 : brickW / 2;
    ctx.beginPath();
    ctx.moveTo(0, y + 0.5);
    ctx.lineTo(width, y + 0.5);
    ctx.stroke();
    for (let x = -offset; x < width; x += brickW) {
      ctx.beginPath();
      ctx.moveTo(x + 0.5, y);
      ctx.lineTo(x + 0.5, y + brickH);
      ctx.stroke();
    }
  }

  // Walls and the stone part of liquid tiles
  for (let row = 0; row < level.rows; row++) {
    for (let col = 0; col < level.cols; col++) {
      const tile = tileAt(level, col, row);
      if (isSolid(tile)) drawStoneTile(ctx, level, col, row);
    }
  }
}

function drawStoneTile(ctx, level, col, row) {
  const x = col * TILE_SIZE;
  const y = row * TILE_SIZE;

  // Base color with slight per-tile variation
  const shade = hash(col, row);
  ctx.fillStyle = shade < 0.33 ? COLORS.wallDark : shade < 0.8 ? COLORS.wall : COLORS.wallLight;
  ctx.fillRect(x, y, TILE_SIZE, TILE_SIZE);

  // Stone block lines
  ctx.strokeStyle = COLORS.wallDark;
  ctx.lineWidth = 1;
  ctx.strokeRect(x + 0.5, y + 0.5, TILE_SIZE - 1, TILE_SIZE - 1);
  if (hash(col, row, 1) > 0.5) {
    ctx.beginPath();
    ctx.moveTo(x, y + TILE_SIZE / 2 + 0.5);
    ctx.lineTo(x + TILE_SIZE, y + TILE_SIZE / 2 + 0.5);
    ctx.stroke();
  }

  // Light edge on top of walkable surfaces (empty tile above)
  if (!isSolid(tileAt(level, col, row - 1))) {
    ctx.fillStyle = COLORS.wallEdge;
    ctx.fillRect(x, y, TILE_SIZE, 3);
  }
}

// ---------------------------------------------------------------------------
// Liquids: animated surface + bubbles
// ---------------------------------------------------------------------------

function drawLiquids(ctx, level, time) {
  for (let row = 0; row < level.rows; row++) {
    for (let col = 0; col < level.cols; col++) {
      const tile = tileAt(level, col, row);
      if (isLiquid(tile)) drawLiquidTile(ctx, col, row, tile, time);
    }
  }
}

function drawLiquidTile(ctx, col, row, tile, time) {
  const { main, light } = LIQUID_COLORS[tile];
  const x = col * TILE_SIZE;
  const y = row * TILE_SIZE;

  // Pool body with a wavy surface. The wave is continuous across neighbouring tiles.
  ctx.fillStyle = main;
  ctx.beginPath();
  ctx.moveTo(x, y + LIQUID_DEPTH);
  for (let i = 0; i <= TILE_SIZE; i += 3) {
    const wave = Math.sin((x + i) * 0.25 + time * 4) * 1.5;
    ctx.lineTo(x + i, y + 2 + wave);
  }
  ctx.lineTo(x + TILE_SIZE, y + LIQUID_DEPTH);
  ctx.closePath();
  ctx.fill();

  // Highlight line on the surface
  ctx.strokeStyle = light;
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  for (let i = 0; i <= TILE_SIZE; i += 3) {
    const wave = Math.sin((x + i) * 0.25 + time * 4) * 1.5;
    if (i === 0) ctx.moveTo(x + i, y + 2 + wave);
    else ctx.lineTo(x + i, y + 2 + wave);
  }
  ctx.stroke();

  // Two bubbles / particles rising and fading, with a different rhythm per tile
  for (let b = 0; b < 2; b++) {
    const period = 1.2 + hash(col, row, b + 2);
    const phase = ((time + hash(col, row, b + 5) * period) % period) / period; // 0 -> 1
    const bx = x + 6 + hash(col, row, b + 8) * (TILE_SIZE - 12);
    const by = y + LIQUID_DEPTH - phase * (LIQUID_DEPTH + 10);
    ctx.globalAlpha = 1 - phase;
    ctx.fillStyle = light;
    ctx.beginPath();
    ctx.arc(bx, by, 1.5 + (1 - phase) * 1.5, 0, Math.PI * 2);
    ctx.fill();
  }
  ctx.globalAlpha = 1;
}

// ---------------------------------------------------------------------------
// Buttons (pressure plates)
// ---------------------------------------------------------------------------

function drawButtons(ctx, level, buttonStates) {
  for (const button of level.buttons ?? []) {
    const pressed = buttonStates[button.id] === true;
    const floorY = (button.row + 1) * TILE_SIZE;
    const cx = button.col * TILE_SIZE + TILE_SIZE / 2;

    // Base
    ctx.fillStyle = COLORS.buttonBase;
    roundRect(ctx, cx - 13, floorY - 3, 26, 3, 1);
    ctx.fill();

    // Plate: sinks when pressed
    const plateH = pressed ? 2 : 6;
    ctx.fillStyle = pressed ? COLORS.buttonPressed : COLORS.button;
    roundRect(ctx, cx - 10, floorY - 3 - plateH, 20, plateH, 2);
    ctx.fill();
  }
}

// ---------------------------------------------------------------------------
// Doors: slide up into the ceiling when open
// ---------------------------------------------------------------------------

function drawDoors(ctx, level, doorStates, doorOpenness, dt) {
  for (const door of level.doors ?? []) {
    const target = doorStates[door.id] ? 1 : 0;
    const current = doorOpenness[door.id] ?? 0;
    const step = DOOR_SPEED * dt;
    doorOpenness[door.id] = target > current ? Math.min(target, current + step) : Math.max(target, current - step);

    const rect = entityRect(door);
    const visibleH = rect.h * (1 - doorOpenness[door.id]);
    if (visibleH < 1) continue;

    // Door panel (bottom edge moves up as it opens)
    ctx.fillStyle = COLORS.door;
    ctx.fillRect(rect.x + 3, rect.y, rect.w - 6, visibleH);

    // Vertical bars
    ctx.fillStyle = COLORS.doorBar;
    for (let i = 1; i <= 2; i++) {
      const bx = rect.x + 3 + ((rect.w - 6) * i) / 3 - 1;
      ctx.fillRect(bx, rect.y, 2, visibleH);
    }

    // Bottom edge
    ctx.fillStyle = COLORS.doorDark;
    ctx.fillRect(rect.x + 3, rect.y + visibleH - 3, rect.w - 6, 3);
  }
}

// ---------------------------------------------------------------------------
// Elevators: metal platform on two rails that show the whole path
// ---------------------------------------------------------------------------

function drawElevators(ctx, level, offsets, activeStates, time) {
  for (const elevator of level.elevators ?? []) {
    const start = entityRect(elevator);
    const travel = elevator.travel * TILE_SIZE;
    const offset = offsets[elevator.id] ?? 0;
    const top = Math.min(start.y, start.y - travel);
    const bottom = Math.max(start.y, start.y - travel) + start.h;

    // Rails along the path
    ctx.fillStyle = COLORS.elevatorRail;
    ctx.fillRect(start.x + 4, top, 2, bottom - top);
    ctx.fillRect(start.x + start.w - 6, top, 2, bottom - top);

    // Platform
    const y = start.y - offset;
    ctx.fillStyle = COLORS.elevator;
    roundRect(ctx, start.x, y, start.w, start.h, 4);
    ctx.fill();
    ctx.fillStyle = COLORS.elevatorDark;
    ctx.fillRect(start.x + 2, y + start.h - 6, start.w - 4, 4);

    // Warning stripes on the top edge
    ctx.save();
    ctx.beginPath();
    ctx.rect(start.x + 2, y + 2, start.w - 4, 5);
    ctx.clip();
    for (let sx = start.x - 10; sx < start.x + start.w + 10; sx += 10) {
      ctx.fillStyle = COLORS.button;
      ctx.beginPath();
      ctx.moveTo(sx, y + 7);
      ctx.lineTo(sx + 5, y + 2);
      ctx.lineTo(sx + 10, y + 2);
      ctx.lineTo(sx + 5, y + 7);
      ctx.closePath();
      ctx.fill();
    }
    ctx.restore();

    // Small light: green while moving / active
    const moving = activeStates[elevator.id] ? offset !== travel : offset !== 0;
    ctx.fillStyle = activeStates[elevator.id] || moving ? COLORS.elevatorOn : COLORS.elevatorOff;
    ctx.globalAlpha = moving ? 0.6 + Math.sin(time * 12) * 0.4 : 1;
    ctx.beginPath();
    ctx.arc(start.x + start.w / 2, y + start.h - 11, 2.5, 0, Math.PI * 2);
    ctx.fill();
    ctx.globalAlpha = 1;
  }
}

// ---------------------------------------------------------------------------
// Gems: floating diamonds with a soft glow; taken gems are not drawn
// ---------------------------------------------------------------------------

function drawGems(ctx, level, taken, time) {
  const takenSet = new Set(taken);
  for (const gem of level.gems ?? []) {
    if (takenSet.has(gem.id)) continue;
    const [main, light, dark] = GEM_COLORS[gem.color] ?? GEM_COLORS.purple;
    const r = gemRect(gem);
    const cx = r.x + r.w / 2;
    const cy = r.y + r.h / 2 + Math.sin(time * 3 + gem.col) * 2; // gentle float
    const w = 8;
    const h = 10;

    // Glow
    ctx.globalAlpha = 0.25 + Math.sin(time * 4 + gem.row) * 0.1;
    ctx.fillStyle = main;
    ctx.beginPath();
    ctx.arc(cx, cy, 11, 0, Math.PI * 2);
    ctx.fill();
    ctx.globalAlpha = 1;

    // Diamond: dark right half, main left half, light top facet
    ctx.fillStyle = dark;
    ctx.beginPath();
    ctx.moveTo(cx, cy - h);
    ctx.lineTo(cx + w, cy - 2);
    ctx.lineTo(cx, cy + h);
    ctx.closePath();
    ctx.fill();

    ctx.fillStyle = main;
    ctx.beginPath();
    ctx.moveTo(cx, cy - h);
    ctx.lineTo(cx - w, cy - 2);
    ctx.lineTo(cx, cy + h);
    ctx.closePath();
    ctx.fill();

    ctx.fillStyle = light;
    ctx.beginPath();
    ctx.moveTo(cx, cy - h);
    ctx.lineTo(cx - w * 0.55, cy - 3);
    ctx.lineTo(cx + w * 0.55, cy - 3);
    ctx.closePath();
    ctx.fill();

    // Sparkle
    const sparkle = (time * 1.3 + gem.col * 0.37) % 2;
    if (sparkle < 0.25) {
      ctx.globalAlpha = 1 - sparkle * 4;
      ctx.fillStyle = '#ffffff';
      ctx.fillRect(cx - 4, cy - 6, 2, 2);
      ctx.globalAlpha = 1;
    }
  }
}

// ---------------------------------------------------------------------------
// Exits: arched doorway in the character's color, with its element symbol
// ---------------------------------------------------------------------------

function drawExits(ctx, level, time) {
  for (const exit of level.exits ?? []) {
    const rect = entityRect(exit);
    const colors = CHARACTER_COLORS[exit.character];
    const archR = rect.w / 2 - 2;
    const left = rect.x + 2;
    const right = rect.x + rect.w - 2;
    const bottom = rect.y + rect.h;
    const archY = rect.y + archR + 2;

    // Doorway shape: rectangle with a rounded top
    ctx.beginPath();
    ctx.moveTo(left, bottom);
    ctx.lineTo(left, archY);
    ctx.arc(rect.x + rect.w / 2, archY, archR, Math.PI, 0);
    ctx.lineTo(right, bottom);
    ctx.closePath();

    ctx.globalAlpha = 0.25 + Math.sin(time * 3) * 0.08;
    ctx.fillStyle = colors.main;
    ctx.fill();
    ctx.globalAlpha = 1;
    ctx.strokeStyle = colors.main;
    ctx.lineWidth = 2;
    ctx.stroke();

    // Element symbol in the middle
    const cx = rect.x + rect.w / 2;
    const cy = rect.y + rect.h / 2 + 4;
    ctx.fillStyle = colors.light;
    if (exit.character === CHARACTER.FIRE) drawFlameIcon(ctx, cx, cy, 6);
    else drawDropIcon(ctx, cx, cy, 6);
  }
}

function drawFlameIcon(ctx, cx, cy, s) {
  ctx.beginPath();
  ctx.moveTo(cx, cy - s * 1.4);
  ctx.quadraticCurveTo(cx + s, cy - s * 0.2, cx + s * 0.7, cy + s * 0.6);
  ctx.quadraticCurveTo(cx, cy + s * 1.2, cx - s * 0.7, cy + s * 0.6);
  ctx.quadraticCurveTo(cx - s, cy - s * 0.2, cx, cy - s * 1.4);
  ctx.fill();
}

function drawDropIcon(ctx, cx, cy, s) {
  ctx.beginPath();
  ctx.moveTo(cx, cy - s * 1.4);
  ctx.quadraticCurveTo(cx + s, cy, cx + s * 0.7, cy + s * 0.5);
  ctx.arc(cx, cy + s * 0.4, s * 0.72, 0.1, Math.PI - 0.1);
  ctx.quadraticCurveTo(cx - s, cy, cx, cy - s * 1.4);
  ctx.fill();
}

// ---------------------------------------------------------------------------
// Players drawn from a sprite sheet
// The sprite's feet (anchorX, anchorY in the frame) are placed at the bottom-center of the
// hitbox. A small flame / droplet above the head shows which element the player is.
// ---------------------------------------------------------------------------

function drawSpritePlayer(ctx, player, time, sprites) {
  const image = sprites.images[player.character];
  const dead = !player.alive || player.state === PLAYER_STATE.DEAD;
  const anim = sprites.animations[dead ? PLAYER_STATE.DEAD : player.state] ?? sprites.animations.idle;

  const row = anim.row ?? (player.facing < 0 ? anim.left : anim.right);
  const frame = anim.frames[Math.floor(time * (anim.fps ?? 8)) % anim.frames.length];

  const size = sprites.frameSize;
  const scale = sprites.scale;
  const feetX = player.x + PLAYER_WIDTH / 2;
  const feetY = player.y + PLAYER_HEIGHT;

  ctx.save();
  if (dead) ctx.globalAlpha = 0.6;
  ctx.imageSmoothingEnabled = false; // keep pixel art sharp
  ctx.drawImage(
    image,
    frame * size,
    row * size,
    size,
    size,
    feetX - sprites.anchorX * scale,
    feetY - sprites.anchorY * scale,
    size * scale,
    size * scale,
  );

  // Element marker above the head
  if (!dead) {
    const colors = CHARACTER_COLORS[player.character];
    const headY = feetY - (sprites.anchorY - sprites.headY) * scale;
    const bob = Math.sin(time * 4) * 1;
    ctx.fillStyle = colors.main;
    if (player.character === CHARACTER.FIRE) drawFlameIcon(ctx, feetX, headY - 7 + bob, 3.5);
    else drawDropIcon(ctx, feetX, headY - 7 + bob, 3.5);
  }

  ctx.restore();
}

// ---------------------------------------------------------------------------
// Players drawn with shapes (used when no sprite is available):
// rounded body, element crest on the head, eyes that follow the movement
// ---------------------------------------------------------------------------

function drawPlayer(ctx, player, time) {
  const colors = CHARACTER_COLORS[player.character];
  const dead = !player.alive || player.state === PLAYER_STATE.DEAD;

  // Squash and stretch depending on the state
  let scaleX = 1;
  let scaleY = 1;
  let bob = 0;
  switch (player.state) {
    case PLAYER_STATE.JUMP:
      scaleX = 0.9;
      scaleY = 1.1;
      break;
    case PLAYER_STATE.FALL:
      scaleX = 1.05;
      scaleY = 0.95;
      break;
    case PLAYER_STATE.RUN:
      bob = Math.abs(Math.sin(time * 14)) * -2;
      break;
    case PLAYER_STATE.IDLE:
      scaleY = 1 + Math.sin(time * 3) * 0.02; // gentle breathing
      break;
  }

  const w = PLAYER_WIDTH * scaleX;
  const h = PLAYER_HEIGHT * scaleY;
  const x = player.x + (PLAYER_WIDTH - w) / 2;
  const y = player.y + PLAYER_HEIGHT - h + bob; // keep feet on the ground

  ctx.save();
  if (dead) ctx.globalAlpha = 0.4;

  // Element crest on top of the head (flickering flame or droplet)
  const crestX = x + w / 2;
  const crestY = y + 1;
  ctx.fillStyle = colors.light;
  if (player.character === CHARACTER.FIRE) {
    const flicker = dead ? 0 : Math.sin(time * 18) * 1.5;
    drawFlameIcon(ctx, crestX, crestY - 2 + flicker * 0.3, 5 + flicker * 0.4);
  } else {
    drawDropIcon(ctx, crestX, crestY - 2, 5);
  }

  // Body
  ctx.fillStyle = colors.main;
  roundRect(ctx, x, y, w, h, 8);
  ctx.fill();

  // Darker bottom shading
  ctx.fillStyle = colors.dark;
  roundRect(ctx, x, y + h * 0.7, w, h * 0.3, 6);
  ctx.fill();

  // Eyes
  const eyeY = y + h * 0.38;
  const eyeOffsetX = w * 0.22;
  const look = dead ? 0 : player.facing * 1.8;
  for (const side of [-1, 1]) {
    const ex = x + w / 2 + side * eyeOffsetX + player.facing * 1.5;
    if (dead) {
      // X-shaped eyes
      ctx.strokeStyle = COLORS.pupil;
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(ex - 2.5, eyeY - 2.5);
      ctx.lineTo(ex + 2.5, eyeY + 2.5);
      ctx.moveTo(ex + 2.5, eyeY - 2.5);
      ctx.lineTo(ex - 2.5, eyeY + 2.5);
      ctx.stroke();
    } else {
      ctx.fillStyle = COLORS.eyeWhite;
      ctx.beginPath();
      ctx.arc(ex, eyeY, 4, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = COLORS.pupil;
      ctx.beginPath();
      ctx.arc(ex + look, eyeY + (player.state === PLAYER_STATE.FALL ? 1 : 0), 2, 0, Math.PI * 2);
      ctx.fill();
    }
  }

  ctx.restore();
}