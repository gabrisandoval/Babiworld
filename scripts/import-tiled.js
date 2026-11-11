// Converts maps made with the Tiled editor (https://www.mapeditor.org) into Babiworld levels.
//
// Usage:
//   npm run import-level                      -> imports every .tmj file in maps/
//   npm run import-level -- maps/level2.tmj   -> imports one map
//
// For each map it writes levels/<file name>.json and adds the level to levels/index.json
// (if it isn't there yet). The "story" of an existing level is kept, because it is not part
// of the Tiled map.
//
// What the Tiled map must contain (see maps/level1.tmj):
//
//   Map size: 32 × 18 tiles.
//   Map property  "name" (string)  -> level name shown in the game (optional).
//
//   Tile layer "tiles": walls and pools. Each tile of the tileset has a custom property
//     "type" = wall | lava | water | poison. Empty cells are empty space.
//
//   Object layer "objects": rectangles snapped to the grid, with a class/type and a name:
//     spawn   property "character" = fire | water     (one per character, 1×1)
//     button   property "targets"  = door / elevator names, comma separated, e.g. "door_1"
//     door     any size (e.g. 1×3)                    name = its id, e.g. "door_1"
//     elevator platform (e.g. 3×1) at its starting position, name = its id, e.g. "elevator_1"
//              property "travel" (int) = tiles it moves while its button is pressed (positive = up)
//              property "speed" (float, optional) = tiles per second (default 3)
//     exit     property "character" = fire | water    (one per character, e.g. 1×2)

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { TILE, CHARACTER, GRID_COLS, GRID_ROWS } from '../shared/constants.js';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.join(__dirname, '..');
const MAPS_DIR = path.join(ROOT, 'maps');
const LEVELS_DIR = path.join(ROOT, 'levels');
const INDEX_FILE = path.join(LEVELS_DIR, 'index.json');

// Tile "type" property -> tile id used in the level grid
const TILE_TYPES = {
  wall: TILE.WALL,
  lava: TILE.LAVA,
  water: TILE.WATER,
  poison: TILE.POISON,
};

const CHARACTERS = Object.values(CHARACTER);

// Tiled stores flip/rotation flags in the 3 highest bits of a tile id: remove them.
const GID_MASK = 0x1fffffff;

const readJson = (file) => JSON.parse(fs.readFileSync(file, 'utf8'));

// Tiled properties are an array [{ name, type, value }]: turn them into { name: value }.
function props(item) {
  return Object.fromEntries((item?.properties ?? []).map((p) => [p.name, p.value]));
}

// ---------------------------------------------------------------------------
// Tilesets: build a map gid -> tile id (wall / lava / water / poison)
// ---------------------------------------------------------------------------

function loadTileTypes(map, mapFile) {
  const gidToTile = new Map();

  for (const ref of map.tilesets ?? []) {
    // Tilesets can be embedded in the map or saved as a separate .tsj file.
    let tileset = ref;
    if (ref.source) {
      const tilesetFile = path.join(path.dirname(mapFile), ref.source);
      if (!tilesetFile.endsWith('.tsj') && !tilesetFile.endsWith('.json')) {
        throw new Error(`Tileset "${ref.source}" must be saved as JSON (.tsj), not XML (.tsx).`);
      }
      tileset = readJson(tilesetFile);
    }

    for (const tile of tileset.tiles ?? []) {
      const type = props(tile).type ?? tile.type ?? tile.class;
      if (!type) continue;
      if (!(type in TILE_TYPES)) {
        throw new Error(`Tileset "${tileset.name}": tile ${tile.id} has unknown type "${type}".`);
      }
      gidToTile.set(ref.firstgid + tile.id, TILE_TYPES[type]);
    }
  }

  return gidToTile;
}

// ---------------------------------------------------------------------------
// Conversion
// ---------------------------------------------------------------------------

function convertMap(mapFile) {
  const map = readJson(mapFile);
  const errors = [];
  const tileW = map.tilewidth;
  const tileH = map.tileheight;

  if (map.infinite) errors.push('The map must not be "infinite" (Map > Map Properties).');
  if (map.width !== GRID_COLS || map.height !== GRID_ROWS) {
    errors.push(`The map must be ${GRID_COLS} × ${GRID_ROWS} tiles, this one is ${map.width} × ${map.height}.`);
  }

  // --- Tiles ---
  const gidToTile = loadTileTypes(map, mapFile);
  const tileLayer = map.layers.find((l) => l.type === 'tilelayer' && l.name === 'tiles');
  if (!tileLayer) errors.push('Missing tile layer named "tiles".');

  const grid = [];
  if (tileLayer) {
    if (!Array.isArray(tileLayer.data)) {
      errors.push('Tile layer data must be saved as CSV (Map > Map Properties > Tile Layer Format).');
    } else {
      for (let row = 0; row < map.height; row++) {
        const line = [];
        for (let col = 0; col < map.width; col++) {
          const gid = tileLayer.data[row * map.width + col] & GID_MASK;
          if (gid === 0) {
            line.push(TILE.EMPTY);
          } else if (gidToTile.has(gid)) {
            line.push(gidToTile.get(gid));
          } else {
            errors.push(`Tile at column ${col}, row ${row} has no "type" property in its tileset.`);
            line.push(TILE.EMPTY);
          }
        }
        grid.push(line);
      }
    }
  }

  // --- Objects ---
  const objectLayer = map.layers.find((l) => l.type === 'objectgroup' && l.name === 'objects');
  if (!objectLayer) errors.push('Missing object layer named "objects".');

  const spawns = {};
  const buttons = [];
  const doors = [];
  const elevators = [];
  const exits = [];

  for (const obj of objectLayer?.objects ?? []) {
    const kind = obj.type || obj.class;
    const p = props(obj);
    const label = `${kind || 'object'} "${obj.name || obj.id}"`;

    // Pixel rectangle -> grid position and size in tiles
    const col = Math.round(obj.x / tileW);
    const row = Math.round(obj.y / tileH);
    const width = Math.max(1, Math.round(obj.width / tileW));
    const height = Math.max(1, Math.round(obj.height / tileH));

    if (obj.x % tileW !== 0 || obj.y % tileH !== 0) {
      console.warn(`  ! ${label} is not aligned to the grid, snapped to column ${col}, row ${row}.`);
    }

    switch (kind) {
      case 'spawn':
        if (!CHARACTERS.includes(p.character)) {
          errors.push(`${label}: property "character" must be fire or water.`);
        } else if (spawns[p.character]) {
          errors.push(`More than one spawn for ${p.character}.`);
        } else {
          spawns[p.character] = { col, row };
        }
        break;

      case 'button': {
        const targets = String(p.targets ?? '')
          .split(',')
          .map((t) => t.trim())
          .filter(Boolean);
        if (!obj.name) errors.push(`Button ${obj.id} has no name (used as its id).`);
        if (targets.length === 0) errors.push(`${label}: property "targets" is empty.`);
        buttons.push({ id: obj.name, col, row, targets });
        break;
      }

      case 'door':
        if (!obj.name) errors.push(`Door ${obj.id} has no name (used as its id).`);
        doors.push({ id: obj.name, col, row, width, height });
        break;

      case 'elevator': {
        const travel = Number(p.travel);
        if (!obj.name) errors.push(`Elevator ${obj.id} has no name (used as its id).`);
        if (!Number.isInteger(travel) || travel === 0) {
          errors.push(`${label}: property "travel" must be a whole number of tiles, not 0 (positive = up).`);
        }
        const elevator = { id: obj.name, col, row, width, height, travel };
        if (p.speed !== undefined) elevator.speed = Number(p.speed);
        elevators.push(elevator);
        break;
      }

      case 'exit':
        if (!CHARACTERS.includes(p.character)) {
          errors.push(`${label}: property "character" must be fire or water.`);
        } else {
          exits.push({ id: obj.name || `exit_${p.character}`, character: p.character, col, row, width, height });
        }
        break;

      default:
        errors.push(`Object ${obj.id} has unknown class "${kind}" (use spawn, button, door, elevator or exit).`);
    }
  }

  // --- Checks between objects ---
  for (const c of CHARACTERS) {
    if (!spawns[c]) errors.push(`Missing spawn for ${c}.`);
    if (exits.filter((e) => e.character === c).length !== 1) errors.push(`There must be exactly one exit for ${c}.`);
  }

  const ids = [...buttons, ...doors, ...elevators, ...exits].map((o) => o.id);
  const duplicates = ids.filter((id, i) => id && ids.indexOf(id) !== i);
  if (duplicates.length) errors.push(`Duplicate object names: ${[...new Set(duplicates)].join(', ')}.`);

  const targetIds = new Set([...doors, ...elevators].map((o) => o.id));
  for (const button of buttons) {
    for (const target of button.targets) {
      if (!targetIds.has(target)) errors.push(`Button "${button.id}" targets "${target}", but there is no door or elevator with that name.`);
    }
  }

  if (errors.length) {
    throw new Error(errors.map((e) => `    - ${e}`).join('\n'));
  }

  const id = path.basename(mapFile, path.extname(mapFile));
  return {
    id,
    name: props(map).name || id,
    cols: map.width,
    rows: map.height,
    grid,
    spawns,
    buttons,
    doors,
    elevators,
    exits,
  };
}

// ---------------------------------------------------------------------------
// Writing the level files
// ---------------------------------------------------------------------------

// One object on a single line: { "id": "door_1", "col": 7, "targets": ["a", "b"] }
function inline(obj) {
  const value = (v) => (Array.isArray(v) ? `[${v.map((x) => JSON.stringify(x)).join(', ')}]` : JSON.stringify(v));
  return `{ ${Object.entries(obj)
    .map(([k, v]) => `${JSON.stringify(k)}: ${value(v)}`)
    .join(', ')} }`;
}

// Indents every line after the first (for nested JSON blocks).
const indent = (text, spaces) => text.replace(/\n/g, `\n${' '.repeat(spaces)}`);

// Same compact layout as the hand-written levels: one grid row per line, one object per line.
function formatLevel(level) {
  const list = (items) => `[\n${items.map((o) => `    ${inline(o)}`).join(',\n')}\n  ]`;
  const fields = [
    `"id": ${JSON.stringify(level.id)}`,
    `"name": ${JSON.stringify(level.name)}`,
    `"cols": ${level.cols}`,
    `"rows": ${level.rows}`,
    `"grid": [\n${level.grid.map((row) => `    [${row.join(',')}]`).join(',\n')}\n  ]`,
    `"spawns": {\n${Object.entries(level.spawns)
      .map(([c, s]) => `    ${JSON.stringify(c)}: ${inline(s)}`)
      .join(',\n')}\n  }`,
    `"buttons": ${list(level.buttons)}`,
    `"doors": ${list(level.doors)}`,
    ...(level.elevators?.length ? [`"elevators": ${list(level.elevators)}`] : []),
    `"exits": ${list(level.exits)}`,
  ];
  if (level.story) fields.push(`"story": ${indent(JSON.stringify(level.story, null, 2), 2)}`);
  return `{\n  ${fields.join(',\n  ')}\n}\n`;
}

function formatIndex(index) {
  return `{\n  "levels": [\n${index.levels.map((l) => `    ${inline(l)}`).join(',\n')}\n  ]\n}\n`;
}

function saveLevel(level) {
  const levelFile = path.join(LEVELS_DIR, `${level.id}.json`);

  // Keep the story (and any other field the map doesn't have) from the existing level file.
  if (fs.existsSync(levelFile)) {
    const existing = readJson(levelFile);
    if (existing.story) level.story = existing.story;
  }

  // Same field order as the hand-written level files
  const ordered = {
    id: level.id,
    name: level.name,
    cols: level.cols,
    rows: level.rows,
    grid: level.grid,
    spawns: level.spawns,
    buttons: level.buttons,
    doors: level.doors,
    elevators: level.elevators,
    exits: level.exits,
    ...(level.story ? { story: level.story } : {}),
  };
  fs.writeFileSync(levelFile, formatLevel(ordered));

  // Add to the index (or update the name)
  const index = fs.existsSync(INDEX_FILE) ? readJson(INDEX_FILE) : { levels: [] };
  const entry = index.levels.find((l) => l.id === level.id);
  if (entry) entry.name = level.name;
  else index.levels.push({ id: level.id, name: level.name });
  fs.writeFileSync(INDEX_FILE, formatIndex(index));

  return levelFile;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const args = process.argv.slice(2);
const files = args.length
  ? args.map((f) => path.resolve(f))
  : fs
      .readdirSync(MAPS_DIR)
      .filter((f) => f.endsWith('.tmj'))
      .map((f) => path.join(MAPS_DIR, f));

if (files.length === 0) {
  console.log('No .tmj maps found in maps/.');
  process.exit(0);
}

let failed = 0;
for (const file of files) {
  console.log(`Importing ${path.relative(ROOT, file)}`);
  try {
    const level = convertMap(file);
    const out = saveLevel(level);
    console.log(`  ✓ ${level.name} -> ${path.relative(ROOT, out)}`);
  } catch (error) {
    failed++;
    console.error(`  ✗ Not imported:\n${error.message}`);
  }
}

if (failed) process.exit(1);