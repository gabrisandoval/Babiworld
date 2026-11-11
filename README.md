# Babiworld

**Babiworld** is a cooperative platformer for **2 players in real time on two separate phones**, inspired by games like Fireboy & Watergirl. Each player controls a character tied to an element (fire or water), and the two must work together to clear the level and reach their own exits.

> Status: **prototype** — a single level to test controls, physics and synchronization.

---

## Platform

- Runs in the **phone browser, landscape, fullscreen**
- **Touch controls overlaid on the game, semi-transparent**, with multitouch
- Android: Fullscreen API + orientation lock
- iPhone: installed as a **PWA** ("Add to Home Screen") with landscape orientation in the manifest
- **Fixed logical resolution of 960×540 (16:9)**, scaled to fill the screen, so the level looks the same on every device

## Stack

| Part   | Technology                                  |
|--------|---------------------------------------------|
| Server | Node.js, Express, Socket.IO                 |
| Client | HTML5 Canvas, plain JavaScript (ES modules) |
| Shared | JS module used by both server and client    |

The project starts in **JavaScript**; migrating to TypeScript is planned later, one file at a time (TS is a superset of JS, so no rewrite is needed).

## Architecture

```
 Player A  <──WebSocket──>  Node server  <──WebSocket──>  Player B
     \                           |                           /
      └──────────── Shared module (physics, levels, constants)
```

The **shared module** contains physics, constants and level loading, so client and server compute the same results.

### Network model: hybrid

- Each **client simulates its own character** (responsive movement, no perceived delay) and sends its position and state to the server
- The **server is authoritative over the shared world**: buttons, levers, doors, moving platforms, gems, death, victory
- The client **interpolates** the other player's position for smooth movement

Later on, the game can move to a fully authoritative server with client-side prediction.

## Folder structure

```
/shared    physics, constants, level loading
/server    Express + Socket.IO, room management, world logic
/client    Canvas rendering, touch controls, interpolation
/levels    levels in JSON format
```

## Levels

Each level is a **JSON** file containing:

- a **tile grid** (wall, empty, lava, water, poison)
- a list of **entities with ids and links** (e.g. `button_1` opens `door_1`)

In the future, levels can be designed with the **Tiled** editor and exported to JSON.

## Message protocol (Socket.IO)

**Client → server**

| Event             | Payload                                   |
|-------------------|-------------------------------------------|
| `room:join`       | room code                                 |
| `player:state`    | position, velocity, direction, animation  |
| `player:interact` | interaction with an object                |

**Server → client**

| Event                 | Payload                                  |
|-----------------------|------------------------------------------|
| `room:update`         | players in the room and assigned character |
| `room:error`          | invalid room code or room full           |
| `game:start`          | game start, level                        |
| `player:state`        | the other player's state                 |
| `world:update`        | state of doors, buttons, platforms       |
| `player:died`         | who died, level restart                  |
| `level:complete`      | level cleared                            |
| `player:disconnected` | the other player disconnected            |

(`room:create`, `player:ready` and character selection will come with the full lobby.)

---

## Prototype — test level

### Content

- **Two characters**: red (fire) and blue (water)
- Dungeon **walls and platforms**
- **Pools**:
  - lava → deadly for blue
  - water → deadly for red
  - green poison → deadly for both
- **A button that opens a door** (tests co-op mechanics and synchronization)
- **Two exits**, one per color: the level is cleared when both players stand on their own exit
- **Death**: both players restart from the spawn point

### Controls

- Bottom left: **left / right arrows**
- Bottom right: **jump** (large button)
- All semi-transparent, multitouch (run and jump at the same time)
- **Fullscreen** button
- **"Rotate your phone"** notice when the device is in portrait

### Minimal lobby

Both players enter the **same room code**: the first to join is red, the second is blue.

### Graphics

For the prototype, graphics are **drawn in code** on the Canvas:

- characters: rounded rectangles with eyes that look in the direction of movement
- colored pools with small animated particles
- grey stone dungeon

### Animations

Each character has a **state** (idle, run, jump, fall, dead) derived from physics. The state is sent in the `player:state` message, so both phones show the same animation.

---

## Roadmap

1. **Prototype**: one level, touch controls, physics, synchronization ← *in progress*
2. **Full lobby**: create room with code, character selection, ready, level selection
3. **More levels**: levers, moving platforms, gems, timer
4. **Graphics**: sprite sheets (free packs from Kenney / itch.io, or custom pixel art with Piskel / Aseprite) drawn with `drawImage` instead of shapes
5. **PWA**: manifest, icon, installation on phone
6. **TypeScript migration**
7. Disconnect and reconnect handling

## Getting started

Requirements: **Node.js 20+**.

```bash
npm install
npm run dev     # restarts automatically when a file changes
# or
npm start
```

The server prints a local and a network address, for example:

```
Babiworld server running on port 3000
  Local:   http://localhost:3000
  Network: http://192.168.1.20:3000
```

To play on two phones:

1. Connect the computer and both phones to the **same Wi-Fi network**
2. Open the **Network** address in the browser on both phones
3. Enter the **same room code** on both phones and tap **Join**
4. The first player is **Fire (red)**, the second is **Water (blue)**

On a PC you can test with two browser windows: arrows / WASD to move, W / space to jump.

> If the phones cannot connect, allow Node.js through the computer's firewall for private networks.