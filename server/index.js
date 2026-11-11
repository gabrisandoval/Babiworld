// Babiworld server: serves the client files and manages rooms and the shared world state.
//
// Hybrid network model:
// - each client simulates its own character and sends its state here
// - the server forwards that state to the other player
// - the server is authoritative over the world: buttons, doors, death, victory

import express from 'express';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Server } from 'socket.io';

import { CHARACTER, RESPAWN_DELAY } from '../shared/constants.js';
import { computeWorldState, isLevelComplete } from '../shared/physics.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');

const PORT = process.env.PORT || 3000;
const LEVEL_ID = 'level1';
const LEVEL_COMPLETE_DELAY = 3000; // ms before restarting after a win (prototype only)

const level = JSON.parse(fs.readFileSync(path.join(ROOT, 'levels', `${LEVEL_ID}.json`), 'utf8'));

// ---------------------------------------------------------------------------
// HTTP: static files
// ---------------------------------------------------------------------------

const app = express();
app.use(express.static(path.join(ROOT, 'client')));
app.use('/shared', express.static(path.join(ROOT, 'shared')));
app.use('/levels', express.static(path.join(ROOT, 'levels')));

const server = http.createServer(app);
const io = new Server(server);

// ---------------------------------------------------------------------------
// Rooms
// ---------------------------------------------------------------------------

/**
 * code -> {
 *   code: string,
 *   players: Map<socketId, { id, character, snapshot }>,
 *   status: 'waiting' | 'playing' | 'dead' | 'complete',
 *   world: { buttons, doors },
 *   timer: Timeout | null
 * }
 */
const rooms = new Map();

function createRoom(code) {
  const room = {
    code,
    players: new Map(),
    status: 'waiting',
    world: computeWorldState(level, []),
    timer: null,
  };
  rooms.set(code, room);
  return room;
}

// Room codes: 3 to 8 letters or digits, case-insensitive.
function normalizeCode(code) {
  if (typeof code !== 'string') return null;
  const clean = code.trim().toUpperCase();
  return /^[A-Z0-9]{3,8}$/.test(clean) ? clean : null;
}

const VALID_CHARACTERS = new Set(Object.values(CHARACTER));

// True if another player in the room already chose this character.
function isTaken(room, character, exceptId) {
  return [...room.players.values()].some((p) => p.id !== exceptId && p.character === character);
}

// The game starts when there are 2 players and both chose a (different) character.
function canStart(room) {
  const players = [...room.players.values()];
  return (
    players.length === 2 &&
    players.every((p) => p.character) &&
    players[0].character !== players[1].character
  );
}

function publicPlayers(room) {
  return [...room.players.values()].map((p) => ({ id: p.id, character: p.character }));
}

// Players with a known position, in the shape expected by the shared world logic.
function activePlayers(room) {
  return [...room.players.values()]
    .filter((p) => p.snapshot)
    .map((p) => ({ ...p.snapshot, character: p.character }));
}

function clearRoomTimer(room) {
  if (room.timer) {
    clearTimeout(room.timer);
    room.timer = null;
  }
}

// Starts (or restarts) the level for both players.
function startLevel(room) {
  clearRoomTimer(room);
  for (const player of room.players.values()) player.snapshot = null;
  room.world = computeWorldState(level, []);
  room.status = 'playing';
  io.to(room.code).emit('game:start', {
    levelId: LEVEL_ID,
    world: room.world,
    players: publicPlayers(room),
  });
}

function handleDeath(room, character) {
  room.status = 'dead';
  io.to(room.code).emit('player:died', { character });
  room.timer = setTimeout(() => startLevel(room), RESPAWN_DELAY);
}

function handleLevelComplete(room) {
  room.status = 'complete';
  io.to(room.code).emit('level:complete', { levelId: LEVEL_ID });
  room.timer = setTimeout(() => startLevel(room), LEVEL_COMPLETE_DELAY);
}

// Recomputes buttons and doors, and notifies both players only if something changed.
function updateWorld(room) {
  const world = computeWorldState(level, activePlayers(room));
  if (JSON.stringify(world) !== JSON.stringify(room.world)) {
    room.world = world;
    io.to(room.code).emit('world:update', world);
  }
}

// Accepts only the expected fields with valid values.
function sanitizeSnapshot(data) {
  if (!data || typeof data !== 'object') return null;
  const numbers = ['x', 'y', 'vx', 'vy'];
  if (!numbers.every((key) => Number.isFinite(data[key]))) return null;
  return {
    x: data.x,
    y: data.y,
    vx: data.vx,
    vy: data.vy,
    facing: data.facing === -1 ? -1 : 1,
    state: typeof data.state === 'string' ? data.state : 'idle',
    alive: data.alive !== false,
  };
}

// ---------------------------------------------------------------------------
// Socket events
// ---------------------------------------------------------------------------

io.on('connection', (socket) => {
  let room = null;

  socket.on('room:join', (rawCode) => {
    if (room) return; // already in a room

    const code = normalizeCode(rawCode);
    if (!code) {
      socket.emit('room:error', { message: 'Room code must be 3-8 letters or digits.' });
      return;
    }

    const target = rooms.get(code) ?? createRoom(code);
    if (target.players.size >= 2) {
      socket.emit('room:error', { message: 'This room is full.' });
      return;
    }

    // The character is chosen afterwards, on the selection screen.
    room = target;
    room.players.set(socket.id, { id: socket.id, character: null, snapshot: null });
    socket.join(code);

    io.to(code).emit('room:update', { code, players: publicPlayers(room) });
    console.log(`[${code}] player joined (${room.players.size}/2)`);
  });

  // Character selection: fire or water, never the same as the other player.
  // Choosing again switches character (if the other one is free).
  socket.on('player:choose', (character) => {
    if (!room || room.status !== 'waiting') return;
    const player = room.players.get(socket.id);
    if (!player || !VALID_CHARACTERS.has(character)) return;

    if (isTaken(room, character, socket.id)) {
      socket.emit('room:error', { message: 'The other player already chose this character.' });
      return;
    }

    player.character = character;
    io.to(room.code).emit('room:update', { code: room.code, players: publicPlayers(room) });
    console.log(`[${room.code}] player chose ${character}`);

    if (canStart(room)) startLevel(room);
  });

  socket.on('player:state', (data) => {
    if (!room || room.status !== 'playing') return;
    const player = room.players.get(socket.id);
    const snapshot = sanitizeSnapshot(data);
    if (!player || !snapshot) return;

    player.snapshot = snapshot;
    socket.to(room.code).emit('player:state', { character: player.character, ...snapshot });

    if (!snapshot.alive) {
      handleDeath(room, player.character);
      return;
    }

    updateWorld(room);

    if (isLevelComplete(level, activePlayers(room))) {
      handleLevelComplete(room);
    }
  });

  // Removes this player from its room (used by "Back" and by disconnection).
  function leaveRoom() {
    if (!room) return;
    const left = room;
    const player = left.players.get(socket.id);
    left.players.delete(socket.id);
    socket.leave(left.code);
    clearRoomTimer(left);
    room = null;

    console.log(`[${left.code}] ${player?.character ?? 'player'} left`);

    if (left.players.size === 0) {
      rooms.delete(left.code);
      return;
    }

    left.status = 'waiting';
    io.to(left.code).emit('player:disconnected', { character: player?.character });
    io.to(left.code).emit('room:update', { code: left.code, players: publicPlayers(left) });
  }

  // "Back" button on the selection screen: leave the room and go back to the menu.
  socket.on('room:leave', leaveRoom);

  socket.on('disconnect', leaveRoom);
});

// ---------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------

// Listen on all network interfaces, so phones on the same Wi-Fi can connect.
server.listen(PORT, '0.0.0.0', () => {
  console.log(`Babiworld server running on port ${PORT}`);
  console.log(`  Local:   http://localhost:${PORT}`);
  for (const addresses of Object.values(os.networkInterfaces())) {
    for (const address of addresses ?? []) {
      if (address.family === 'IPv4' && !address.internal) {
        console.log(`  Network: http://${address.address}:${PORT}`);
      }
    }
  }
});