// Shared physics and level helpers, used by both the server (Node) and the client (browser).
// Pure functions only: no DOM, no sockets, no timers.

import {
  TILE,
  TILE_SIZE,
  SOLID_TILES,
  LIQUID_KILLS,
  PLAYER_WIDTH,
  PLAYER_HEIGHT,
  PLAYER_STATE,
  GRAVITY,
  MOVE_SPEED,
  JUMP_VELOCITY,
  MAX_FALL_SPEED,
  COYOTE_TIME,
  JUMP_BUFFER,
  FIXED_DT,
} from './constants.js';

// When the jump button is released early, upward speed is capped to this value.
// This gives short hops on a quick tap and full jumps when holding the button.
const JUMP_RELEASE_VELOCITY = 250;

// Height of the active area of a pressure button (bottom part of its tile).
const BUTTON_HEIGHT = 8;

// ---------------------------------------------------------------------------
// Geometry helpers
// ---------------------------------------------------------------------------

export function rectsOverlap(a, b) {
  return a.x < b.x + b.w && a.x + a.w > b.x && a.y < b.y + b.h && a.y + a.h > b.y;
}

// Converts a level entity (col, row, width, height in tiles) into a pixel rectangle.
export function entityRect(entity) {
  return {
    x: entity.col * TILE_SIZE,
    y: entity.row * TILE_SIZE,
    w: (entity.width ?? 1) * TILE_SIZE,
    h: (entity.height ?? 1) * TILE_SIZE,
  };
}

export function playerRect(player) {
  return { x: player.x, y: player.y, w: PLAYER_WIDTH, h: PLAYER_HEIGHT };
}

// Returns the tile id at a grid position. Outside the grid counts as wall.
export function tileAt(level, col, row) {
  if (row < 0 || row >= level.rows || col < 0 || col >= level.cols) return TILE.WALL;
  return level.grid[row][col];
}

// ---------------------------------------------------------------------------
// Collision
// ---------------------------------------------------------------------------

// Returns every solid rectangle (solid tiles + closed doors) overlapping the given rect.
function getObstacles(level, doorStates, rect) {
  const obstacles = [];

  const colStart = Math.floor(rect.x / TILE_SIZE);
  const colEnd = Math.floor((rect.x + rect.w - 0.001) / TILE_SIZE);
  const rowStart = Math.floor(rect.y / TILE_SIZE);
  const rowEnd = Math.floor((rect.y + rect.h - 0.001) / TILE_SIZE);

  for (let row = rowStart; row <= rowEnd; row++) {
    for (let col = colStart; col <= colEnd; col++) {
      if (SOLID_TILES.has(tileAt(level, col, row))) {
        obstacles.push({ x: col * TILE_SIZE, y: row * TILE_SIZE, w: TILE_SIZE, h: TILE_SIZE });
      }
    }
  }

  for (const door of level.doors ?? []) {
    const isOpen = doorStates[door.id] === true;
    if (!isOpen) {
      const doorRect = entityRect(door);
      if (rectsOverlap(rect, doorRect)) obstacles.push(doorRect);
    }
  }

  return obstacles;
}

// ---------------------------------------------------------------------------
// Player
// ---------------------------------------------------------------------------

// Creates a player standing on its spawn tile, horizontally centered.
export function createPlayer(character, level) {
  const spawn = level.spawns[character];
  return {
    character,
    x: spawn.col * TILE_SIZE + (TILE_SIZE - PLAYER_WIDTH) / 2,
    y: (spawn.row + 1) * TILE_SIZE - PLAYER_HEIGHT,
    vx: 0,
    vy: 0,
    facing: 1, // 1 = right, -1 = left
    onGround: false,
    alive: true,
    state: PLAYER_STATE.IDLE,
    coyoteTimer: 0,
    jumpBufferTimer: 0,
    jumpHeld: false,
  };
}

/**
 * Advances one player by one fixed step.
 *
 * @param player      player object created by createPlayer (mutated in place)
 * @param input       { left: boolean, right: boolean, jump: boolean }
 * @param level       parsed level JSON
 * @param doorStates  { [doorId]: true if open }
 * @param dt          time step in seconds (defaults to FIXED_DT)
 * @returns           { died: boolean }
 */
export function stepPlayer(player, input, level, doorStates = {}, dt = FIXED_DT) {
  if (!player.alive) return { died: false };

  // --- Horizontal input ---
  const dir = (input.right ? 1 : 0) - (input.left ? 1 : 0);
  player.vx = dir * MOVE_SPEED;
  if (dir !== 0) player.facing = dir;

  // --- Jump input (with jump buffer and coyote time) ---
  const jumpPressed = input.jump && !player.jumpHeld;
  player.jumpHeld = input.jump;

  player.jumpBufferTimer = jumpPressed ? JUMP_BUFFER : Math.max(0, player.jumpBufferTimer - dt);
  player.coyoteTimer = player.onGround ? COYOTE_TIME : Math.max(0, player.coyoteTimer - dt);

  if (player.jumpBufferTimer > 0 && player.coyoteTimer > 0) {
    player.vy = -JUMP_VELOCITY;
    player.jumpBufferTimer = 0;
    player.coyoteTimer = 0;
    player.onGround = false;
  }

  // Short hop when the jump button is released while still going up.
  if (!input.jump && player.vy < -JUMP_RELEASE_VELOCITY) {
    player.vy = -JUMP_RELEASE_VELOCITY;
  }

  // --- Gravity ---
  player.vy = Math.min(player.vy + GRAVITY * dt, MAX_FALL_SPEED);

  // --- Move on X, then resolve collisions ---
  player.x += player.vx * dt;
  let obstacles = getObstacles(level, doorStates, playerRect(player));
  if (obstacles.length > 0) {
    if (player.vx > 0) {
      player.x = Math.min(...obstacles.map((o) => o.x)) - PLAYER_WIDTH;
    } else if (player.vx < 0) {
      player.x = Math.max(...obstacles.map((o) => o.x + o.w));
    }
    player.vx = 0;
  }

  // --- Move on Y, then resolve collisions ---
  player.y += player.vy * dt;
  player.onGround = false;
  obstacles = getObstacles(level, doorStates, playerRect(player));
  if (obstacles.length > 0) {
    if (player.vy > 0) {
      player.y = Math.min(...obstacles.map((o) => o.y)) - PLAYER_HEIGHT;
      player.onGround = true;
    } else if (player.vy < 0) {
      player.y = Math.max(...obstacles.map((o) => o.y + o.h));
    }
    player.vy = 0;
  }

  // --- Deadly liquids: check the tile under the center of the feet ---
  if (player.onGround) {
    const footCol = Math.floor((player.x + PLAYER_WIDTH / 2) / TILE_SIZE);
    const footRow = Math.floor((player.y + PLAYER_HEIGHT) / TILE_SIZE);
    const tileBelow = tileAt(level, footCol, footRow);
    if (LIQUID_KILLS[player.character].has(tileBelow)) {
      killPlayer(player);
      return { died: true };
    }
  }

  player.state = deriveState(player);
  return { died: false };
}

export function killPlayer(player) {
  player.alive = false;
  player.vx = 0;
  player.vy = 0;
  player.state = PLAYER_STATE.DEAD;
}

function deriveState(player) {
  if (!player.alive) return PLAYER_STATE.DEAD;
  if (!player.onGround) return player.vy < 0 ? PLAYER_STATE.JUMP : PLAYER_STATE.FALL;
  if (player.vx !== 0) return PLAYER_STATE.RUN;
  return PLAYER_STATE.IDLE;
}

// The part of a player that is sent over the network.
export function playerSnapshot(player) {
  return {
    x: player.x,
    y: player.y,
    vx: player.vx,
    vy: player.vy,
    facing: player.facing,
    state: player.state,
    alive: player.alive,
  };
}

// ---------------------------------------------------------------------------
// World logic (buttons, doors, exits)
// Used by the server to decide the world state, and by the client to draw it.
// `players` is an array of objects with at least { x, y, character, alive }.
// ---------------------------------------------------------------------------

export function isOnButton(player, button) {
  if (!player.alive) return false;
  const area = {
    x: button.col * TILE_SIZE,
    y: (button.row + 1) * TILE_SIZE - BUTTON_HEIGHT,
    w: TILE_SIZE,
    h: BUTTON_HEIGHT,
  };
  return rectsOverlap(playerRect(player), area);
}

// Returns which buttons are pressed and which doors are open.
// A door is open while at least one of the buttons targeting it is pressed.
export function computeWorldState(level, players) {
  const buttons = {};
  const doors = {};

  for (const door of level.doors ?? []) doors[door.id] = false;

  for (const button of level.buttons ?? []) {
    const pressed = players.some((p) => isOnButton(p, button));
    buttons[button.id] = pressed;
    if (pressed) {
      for (const targetId of button.targets) doors[targetId] = true;
    }
  }

  return { buttons, doors };
}

// True if the player's center is inside the exit meant for its character.
export function isInExit(player, exit) {
  if (!player.alive || exit.character !== player.character) return false;
  const rect = entityRect(exit);
  const cx = player.x + PLAYER_WIDTH / 2;
  const cy = player.y + PLAYER_HEIGHT / 2;
  return cx >= rect.x && cx <= rect.x + rect.w && cy >= rect.y && cy <= rect.y + rect.h;
}

// The level is complete when every exit has its own player inside.
export function isLevelComplete(level, players) {
  return (level.exits ?? []).every((exit) => players.some((p) => isInExit(p, exit)));
}