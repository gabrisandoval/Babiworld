# Babiworld — Story

## Premise

**Luigi** and **Marga** love exploring the old caves beyond the hill. One evening, deep inside a cave they had never seen before, they find a **stone arch** glowing red and blue. They step through it — and fall into **Babiworld**.

The arch goes dark behind them. Crossing it changed them: Luigi now carries the power of **fire**, Marga the power of **water**. On the stone, an inscription:

> *Only the light of the gems can open the way home.*

The gems are scattered across the four lands of Babiworld. To go home, Luigi and Marga must cross every land together, collect enough gems, and wake the **Return Portal**.

---

## Characters

| | Luigi | Marga |
|---|---|---|
| Element | Fire | Water |
| Look | glasses, dark hair, green shirt | long dark hair, purple shirt |
| Safe in | lava | water |
| Dies in | water, poison | lava, poison |
| Gems | red | blue |

In the code the characters are still called `fire` and `water`; the names shown in the game come from `client/sprites/sprites.json` (`"names"`).

---

## Gems

- **Red gems**: only Luigi can pick them up
- **Blue gems**: only Marga can pick them up
- **One purple gem per level**: hidden or hard to reach, it needs both players working together (either one can pick it up once they get there)
- Gems belong to the **pair**: a gem taken by one counts for both
- Each level remembers its **best result** (e.g. 5 / 6): replaying a level can recover the missing gems
- The **Return Portal** (final level) opens when the pair has **80% of all the gems** in the game. The total is calculated from the levels, so it updates by itself when new levels are added

---

## The lands

Each land has its own look, its own hazards and an intro scene. The tileset of each land can be drawn later; until then the levels use the placeholder stone graphics.

### 1 · The Portal Caves

- **Mood**: where it all begins. Grey and blue stone, glowing crystals, the dark arch in the background
- **Colors**: grey, deep blue, soft red and blue glows
- **Mechanics**: pressure plates and doors — learning to work together
- **Levels**: First Steps · Two Paths · Twin Towers

### 2 · The Ancient Factory

- **Mood**: huge rusty machines still running by themselves, gears, pipes, steam
- **Colors**: rust, copper, warm orange, dark brown
- **Mechanics**: elevators (later: levers, timed doors)
- **Levels**: Going Up · The Tower · *(new levels)*

### 3 · The Poison Swamp

- **Mood**: thick green fog, twisted roots, bubbling pools
- **Colors**: dark green, toxic green, purple
- **Mechanics**: poison everywhere — one wrong step and both restart
- **Levels**: Poison Run · *(new levels)*

### 4 · The Crystal Lake

- **Mood**: a silent underground lake, ice and crystals full of light
- **Colors**: ice blue, white, pale cyan
- **Mechanics**: water and ice (idea: slippery ice floor)
- **Levels**: *(new levels)*

### Finale · The Return Portal

- **Mood**: the arch from the beginning, now glowing red, blue and purple
- **Unlock**: 80% of all gems
- **Level**: one last level that mixes everything learned in the four lands

---

## Scenes

A scene is a sequence of illustrations, each shown for a few seconds with one line of text. Scenes play before the level starts. They can be skipped only if **both** players have already completed that level.

### Prologue (before level 1)

| # | Image | Text | What to draw |
|---|---|---|---|
| 1 | `prologue-1` | Luigi and Marga loved exploring the old caves beyond the hill. | The two at the entrance of a cave at sunset, one with a flashlight |
| 2 | `prologue-2` | Deep inside, they found a stone arch glowing red and blue. | A big stone arch in a dark cave, red light on one side, blue on the other; the two small in front of it |
| 3 | `prologue-3` | The moment they stepped through, the light swallowed them. | A bright flash, the two silhouettes disappearing into the light |
| 4 | `prologue-4` | They woke up in a strange world. The arch behind them was dark and silent. | The two on the ground in a glowing crystal cave, the arch behind them now grey |
| 5 | `prologue-5` | Luigi's hands burned like fire. Marga's flowed like water. | Close-up of the two looking at their hands: flames for Luigi, water for Marga |
| 6 | `prologue-6` | Carved in the stone: "Only the light of the gems can open the way home." | The inscription on the arch, with small red, blue and purple gem shapes carved around it |

### The Portal Caves

| Level | Image | Text | What to draw |
|---|---|---|---|
| First Steps | `caves-1` | The old doors only open for those who work together. | A heavy stone door with two pressure plates in front of it |
| Two Paths | `caves-2` | The cave split in two: one path of fire, one of water. | A fork in the cave: a lava path and a water path |
| Twin Towers | `caves-3` | Two towers, one room at the top. Each of them had to climb alone. | Two stone towers side by side, a lit room on top between them |

### The Ancient Factory

| When | Image | Text | What to draw |
|---|---|---|---|
| Land intro | `factory-intro` | Beyond the caves, the ground started to hum. An ancient factory, still running. | A giant hall of gears and pipes, steam, the two tiny at the entrance |
| Going Up | `factory-1` | Old machines that only move when someone holds the switch. | A metal elevator platform and a pressure plate, warning stripes |
| The Tower | `factory-2` | The tallest tower of the factory. Somewhere at the top, a purple light. | A very tall metal tower seen from below, a purple glow at the top |

### The Poison Swamp

| When | Image | Text | What to draw |
|---|---|---|---|
| Land intro | `swamp-intro` | The air turned green and heavy. Here, the poison spares no one. | A foggy swamp with glowing green pools and twisted roots |
| Poison Run | `swamp-1` | One wrong step, and both of them are back at the start. | A narrow path between poison pools, the two holding hands |

### The Crystal Lake

| When | Image | Text | What to draw |
|---|---|---|---|
| Land intro | `lake-intro` | A silent lake of crystal. The water here is cold enough to freeze. | An underground lake, ice and crystals reflecting blue light |

### Finale

| When | Image | Text | What to draw |
|---|---|---|---|
| Before the last level | `final-intro` | With the gems glowing in their hands, the arch began to wake. | The arch lighting up red, blue and purple, gems floating around it |
| Ending 1 | `ending-1` | The portal opened, and the way home was finally there. | The two in front of the open portal, light pouring out |
| Ending 2 | `ending-2` | Behind them, Babiworld kept glowing — waiting for their next adventure. | Back in the cave at night, the two looking back at the arch, still faintly glowing |

---

## Illustrations: technical notes

- Size **1920 × 1080**, landscape, JPG (or PNG)
- Keep the important parts **in the center**: on some phones the edges are cropped
- Leave the **bottom quarter** fairly simple: the text of the scene is shown there
- File names as in the tables above, in `client/story/` (e.g. `client/story/prologue-1.jpg`)
- Until an illustration is ready, the game shows a placeholder with the text

---

## Level order

| Land | Levels (file) |
|---|---|
| The Portal Caves | `level1` First Steps · `level2` Two Paths · `level3` Twin Towers |
| The Ancient Factory | `level5` Going Up · `level6` The Tower |
| The Poison Swamp | `level4` Poison Run |
| The Crystal Lake | — |
| Finale | — |

Inside a land, levels unlock one after the other; finishing a land unlocks the next one. The finale unlocks with the gems.

---

## Open ideas

- A small guide character (for example a little stone creature living near the arch) who comments in some scenes
- Who scattered the gems, and why does the poison keep spreading? A possible mystery for a second chapter
- New mechanics per land: levers and timed doors (Factory), moving roots (Swamp), slippery ice (Lake)