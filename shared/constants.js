// Shared constants used by both the server (Node) and the client (browser).
// Keep this file free of any Node-only or browser-only code.

// ---------------------------------------------------------------------------
// World / screen
// ---------------------------------------------------------------------------

// Fixed logical resolution (16:9): what the screen shows at zoom 1. The canvas is scaled
// to fit the phone screen. Levels are at least this big, and can be bigger (the camera follows).
export const WORLD_WIDTH = 960;
export const WORLD_HEIGHT = 540;

// Size of one tile in logical pixels. 960 / 30 = 32 columns, 540 / 30 = 18 rows.
export const TILE_SIZE = 30;
export const GRID_COLS = WORLD_WIDTH / TILE_SIZE; // 32
export const GRID_ROWS = WORLD_HEIGHT / TILE_SIZE; // 18

// ---------------------------------------------------------------------------
// Tiles
// ---------------------------------------------------------------------------

// Numeric tile ids used in the level JSON grid.
export const TILE = Object.freeze({
  EMPTY: 0,
  WALL: 1,
  LAVA: 2, // deadly for the water character
  WATER: 3, // deadly for the fire character
  POISON: 4, // deadly for both
});

// Liquid tiles behave like solid floor: players stand on top of them.
// Whether standing on one kills you depends on your character (see LIQUID_KILLS).
export const SOLID_TILES = new Set([TILE.WALL, TILE.LAVA, TILE.WATER, TILE.POISON]);
export const LIQUID_TILES = new Set([TILE.LAVA, TILE.WATER, TILE.POISON]);

// ---------------------------------------------------------------------------
// Characters
// ---------------------------------------------------------------------------

export const CHARACTER = Object.freeze({
  FIRE: 'fire', // red, first player to join
  WATER: 'water', // blue, second player to join
});

// Which liquids kill which character.
export const LIQUID_KILLS = Object.freeze({
  [CHARACTER.FIRE]: new Set([TILE.WATER, TILE.POISON]),
  [CHARACTER.WATER]: new Set([TILE.LAVA, TILE.POISON]),
});

// Player hitbox in logical pixels (a bit smaller than a tile, so it fits through 1-tile gaps).
export const PLAYER_WIDTH = 22;
export const PLAYER_HEIGHT = 28;

// Gems: red only for fire, blue only for water, purple for both (placed where teamwork is needed).
export const GEM = Object.freeze({
  RED: 'red',
  BLUE: 'blue',
  PURPLE: 'purple',
});

export const GEM_OWNER = Object.freeze({
  [GEM.RED]: CHARACTER.FIRE,
  [GEM.BLUE]: CHARACTER.WATER,
  [GEM.PURPLE]: null, // anyone
});

// Size of the gem pickup area, centered in its tile.
export const GEM_SIZE = 16;

// Animation states, derived from physics and sent over the network.
export const PLAYER_STATE = Object.freeze({
  IDLE: 'idle',
  RUN: 'run',
  JUMP: 'jump',
  FALL: 'fall',
  DEAD: 'dead',
});

// ---------------------------------------------------------------------------
// Physics (units: logical pixels and seconds)
// ---------------------------------------------------------------------------

export const GRAVITY = 1800; // px/s² downward acceleration
export const MOVE_SPEED = 200; // px/s horizontal speed
export const JUMP_VELOCITY = 600; // px/s initial upward speed when jumping
export const MAX_FALL_SPEED = 900; // px/s terminal velocity

// Small grace periods that make platformer controls feel fair on touch screens.
export const COYOTE_TIME = 0.08; // s you can still jump after walking off a ledge
export const JUMP_BUFFER = 0.1; // s a jump press is remembered before landing

// Fixed simulation step: physics always advances in 1/60 s increments.
export const FIXED_DT = 1 / 60;

// ---------------------------------------------------------------------------
// Networking
// ---------------------------------------------------------------------------

// How often each client sends its own player state to the server (per second).
export const CLIENT_SEND_RATE = 20;

// Delay used when interpolating the other player's position (ms).
// Rendering the remote player slightly in the past keeps movement smooth.
export const INTERPOLATION_DELAY = 100;

// Time before restarting the level after a death (ms).
export const RESPAWN_DELAY = 1000;