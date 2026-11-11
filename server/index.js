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

// ---------------------------------------------------------------------------
// Levels: every level listed in levels/index.json is loaded at startup
// ---------------------------------------------------------------------------

const readJson = (...parts) => JSON.parse(fs.readFileSync(path.join(ROOT, ...parts), 'utf8'));

const levelIndex = readJson('levels', 'index.json').levels;
const levels = new Map(levelIndex.map(({ id }) => [id, readJson('levels', `${id}.json`)]));

console.log(`Loaded ${levels.size} level(s): ${[...levels.keys()].join(', ')}`);

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
 * A room lasts for the whole session of a pair of players:
 * join once with the PIN, choose the characters, then play as many levels as you like.
 *
 * code -> {
 *   code: string,
 *   players: Map<socketId, { id, character, snapshot }>,
 *   status: 'select'    // characters not chosen yet (or only one player in the room)
 *         | 'levels'    // both ready: choosing the level together
 *         | 'playing' | 'dead' | 'complete',
 *   levelId: string | null,          // level being played (or the last one)
 *   proposal: { levelId, by } | null, // level proposed on the level screen, waiting for the other player
 *   votes: Map<socketId, 'replay' | 'next'>, // choices on the "Level complete" screen
 *   world: { buttons, doors },
 *   timer: Timeout | null
 * }
 */
const rooms = new Map();

const IN_GAME = new Set(['playing', 'dead', 'complete']);

function createRoom(code) {
  const room = {
    code,
    players: new Map(),
    status: 'select',
    levelId: null,
    proposal: null,
    votes: new Map(),
    world: { buttons: {}, doors: {} },
    timer: null,
  };
  rooms.set(code, room);
  return room;
}

const roomLevel = (room) => levels.get(room.levelId);

// Level after the given one in levels/index.json (null if it is the last one).
function nextLevelId(levelId) {
  const i = levelIndex.findIndex((l) => l.id === levelId);
  return i >= 0 && i + 1 < levelIndex.length ? levelIndex[i + 1].id : null;
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

// Two players with two different characters: they can choose and play levels.
function bothReady(room) {
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

// Room info sent to the clients on every change.
function roomUpdate(room) {
  return {
    code: room.code,
    status: room.status,
    levelId: room.levelId,
    proposal: room.proposal,
    players: publicPlayers(room),
  };
}

function broadcastRoom(room) {
  io.to(room.code).emit('room:update', roomUpdate(room));
}

// Outside a game, the room is on the character screen until both are ready, then on the level screen.
function backToLobby(room) {
  clearRoomTimer(room);
  room.status = bothReady(room) ? 'levels' : 'select';
  room.proposal = null;
  room.votes.clear();
  for (const player of room.players.values()) player.snapshot = null;
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

// Starts (or restarts) a level for both players.
function startLevel(room, levelId) {
  clearRoomTimer(room);
  room.levelId = levelId;
  room.proposal = null;
  room.votes.clear();
  for (const player of room.players.values()) player.snapshot = null;
  room.world = computeWorldState(roomLevel(room), []);
  room.status = 'playing';
  io.to(room.code).emit('game:start', {
    levelId: room.levelId,
    world: room.world,
    players: publicPlayers(room),
  });
  console.log(`[${room.code}] start ${room.levelId}`);
}

function handleDeath(room, character) {
  room.status = 'dead';
  io.to(room.code).emit('player:died', { character });
  room.timer = setTimeout(() => startLevel(room, room.levelId), RESPAWN_DELAY);
}

// After a win the game waits: each player chooses Play again, Next level or Levels.
function handleLevelComplete(room) {
  room.status = 'complete';
  room.votes.clear();
  io.to(room.code).emit('level:complete', { levelId: room.levelId, nextLevelId: nextLevelId(room.levelId) });
}

// Recomputes buttons and doors, and notifies both players only if something changed.
function updateWorld(room) {
  // Previous door states: an open door stays open while someone is inside the doorway.
  const world = computeWorldState(roomLevel(room), activePlayers(room), room.world.doors);
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

  // Payload: { code }. The room is created by the first player who uses that PIN.
  socket.on('room:join', (data) => {
    if (room) return; // already in a room

    const code = normalizeCode(data?.code);
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
    backToLobby(room);

    broadcastRoom(room);
    console.log(`[${code}] player joined (${room.players.size}/2)`);
  });

  // Character selection: fire or water, never the same as the other player.
  // Choosing again switches character (if the other one is free).
  socket.on('player:choose', (character) => {
    if (!room || room.status !== 'select') return;
    const player = room.players.get(socket.id);
    if (!player || !VALID_CHARACTERS.has(character)) return;

    if (isTaken(room, character, socket.id)) {
      socket.emit('room:error', { message: 'The other player already chose this character.' });
      return;
    }

    player.character = character;
    backToLobby(room); // moves the room to the level screen once both are ready
    broadcastRoom(room);
    console.log(`[${room.code}] player chose ${character}`);
  });

  // Level screen: one player proposes a level, the other confirms it.
  // Proposing the level the other player already proposed counts as confirming it.
  socket.on('level:propose', (levelId) => {
    if (!room || room.status !== 'levels' || !levels.has(levelId)) return;

    if (room.proposal && room.proposal.by !== socket.id && room.proposal.levelId === levelId) {
      startLevel(room, levelId);
      return;
    }

    room.proposal = { levelId, by: socket.id };
    broadcastRoom(room);
  });

  socket.on('level:accept', () => {
    if (!room || room.status !== 'levels' || !room.proposal) return;
    if (room.proposal.by === socket.id) return; // you can't confirm your own proposal
    startLevel(room, room.proposal.levelId);
  });

  socket.on('level:cancel', () => {
    if (!room || room.status !== 'levels' || room.proposal?.by !== socket.id) return;
    room.proposal = null;
    broadcastRoom(room);
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

    if (isLevelComplete(roomLevel(room), activePlayers(room))) {
      handleLevelComplete(room);
    }
  });

  // "Level complete" screen: Play again / Next level happen when both players chose the same.
  socket.on('level:vote', (choice) => {
    if (!room || room.status !== 'complete') return;
    if (choice !== 'replay' && choice !== 'next') return;
    if (choice === 'next' && !nextLevelId(room.levelId)) return;

    room.votes.set(socket.id, choice);
    const choices = [...room.players.keys()].map((id) => room.votes.get(id));

    if (room.players.size === 2 && choices.every((c) => c === choice)) {
      startLevel(room, choice === 'next' ? nextLevelId(room.levelId) : room.levelId);
    } else {
      io.to(room.code).emit('level:votes', Object.fromEntries(room.votes));
    }
  });

  // Leave the current level (in-game menu, or "Levels" after a win): both players
  // go back to the level screen, still in the same room.
  socket.on('level:quit', () => {
    if (!room || !IN_GAME.has(room.status)) return;
    backToLobby(room);
    socket.to(room.code).emit('level:quit', { byOther: true });
    broadcastRoom(room);
  });

  // Removes this player from its room (Back to home, or disconnection).
  function leaveRoom() {
    if (!room) return;
    const left = room;
    const player = left.players.get(socket.id);
    left.players.delete(socket.id);
    socket.leave(left.code);
    room = null;

    console.log(`[${left.code}] ${player?.character ?? 'player'} left`);

    if (left.players.size === 0) {
      clearRoomTimer(left);
      rooms.delete(left.code);
      return;
    }

    // The player who stays keeps the room and their character, and waits for someone to join.
    backToLobby(left);
    io.to(left.code).emit('player:disconnected', { character: player?.character });
    broadcastRoom(left);
  }

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