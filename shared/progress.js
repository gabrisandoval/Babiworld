// Story progress: completed levels and collected gems.
// Used by the client (saved on each phone) and by the server (to merge the progress
// of the two players in a room and decide which lands and levels are unlocked).
// Pure functions only.
//
// progress = { completed: [levelId], gems: { levelId: [gemId] } }
//
// index = levels/index.json = {
//   lands: [{ id, name, levels: [levelId], requiredGemsPercent? }],
//   levels: [{ id, name }]
// }

const MAX_ITEMS = 500; // sanity limit for data coming from the network

const uniqueStrings = (list) =>
  [...new Set((Array.isArray(list) ? list : []).filter((x) => typeof x === 'string'))].slice(0, MAX_ITEMS);

export function emptyProgress() {
  return { completed: [], gems: {} };
}

// Accepts anything (e.g. data from localStorage or from the network) and returns valid progress.
export function normalizeProgress(data) {
  const progress = emptyProgress();
  if (!data || typeof data !== 'object') return progress;
  progress.completed = uniqueStrings(data.completed);
  if (data.gems && typeof data.gems === 'object') {
    for (const [levelId, ids] of Object.entries(data.gems).slice(0, MAX_ITEMS)) {
      const clean = uniqueStrings(ids);
      if (clean.length) progress.gems[levelId] = clean;
    }
  }
  return progress;
}

// Union of several progress objects (the room plays with everything either player has unlocked).
export function mergeProgress(...list) {
  const merged = emptyProgress();
  for (const item of list) {
    const p = normalizeProgress(item);
    merged.completed = uniqueStrings([...merged.completed, ...p.completed]);
    for (const [levelId, ids] of Object.entries(p.gems)) {
      merged.gems[levelId] = uniqueStrings([...(merged.gems[levelId] ?? []), ...ids]);
    }
  }
  return merged;
}

// Records a completed level and the gems taken in that run (gems add up across runs).
export function addLevelResult(progress, levelId, gemIds) {
  return mergeProgress(progress, { completed: [levelId], gems: { [levelId]: gemIds } });
}

export function isCompleted(progress, levelId) {
  return (progress?.completed ?? []).includes(levelId);
}

// ---------------------------------------------------------------------------
// View: lands and levels with their unlocked state and gem counts
// ---------------------------------------------------------------------------

/**
 * @param index        levels/index.json
 * @param levelsById   { levelId: level JSON } (needs the "gems" of every level)
 * @param progress     merged progress
 * @returns {
 *   totalGems, collectedGems,
 *   lands: [{ id, name, unlocked, comingSoon, requiredGems, lockReason,
 *             gems: { collected, total },
 *             levels: [{ id, name, number, unlocked, completed, gems: { collected, total } }] }]
 * }
 */
export function computeProgressView(index, levelsById, progress) {
  const names = Object.fromEntries((index.levels ?? []).map((l) => [l.id, l.name]));
  const lands = index.lands ?? [];

  const levelGems = (levelId) => {
    const all = (levelsById[levelId]?.gems ?? []).map((g) => g.id);
    const taken = new Set(progress.gems?.[levelId] ?? []);
    return { collected: all.filter((id) => taken.has(id)).length, total: all.length };
  };

  // Gems needed for lands with requiredGemsPercent are counted on the other lands only.
  let totalGems = 0;
  let collectedGems = 0;
  for (const land of lands) {
    if (land.requiredGemsPercent) continue;
    for (const levelId of land.levels ?? []) {
      const g = levelGems(levelId);
      totalGems += g.total;
      collectedGems += g.collected;
    }
  }

  const view = { totalGems, collectedGems, lands: [] };
  let previousComplete = true;
  let previousName = null;

  lands.forEach((land, i) => {
    const levelIds = land.levels ?? [];
    let unlocked;
    let requiredGems = null;
    let lockReason = null;

    if (land.requiredGemsPercent) {
      requiredGems = Math.ceil((totalGems * land.requiredGemsPercent) / 100);
      unlocked = totalGems > 0 && collectedGems >= requiredGems;
      if (!unlocked) lockReason = `Collect ${requiredGems} gems`;
    } else {
      unlocked = i === 0 || previousComplete;
      if (!unlocked) lockReason = `Complete ${previousName}`;
    }

    const levels = levelIds.map((levelId, j) => {
      const completed = isCompleted(progress, levelId);
      const previousDone = j === 0 || isCompleted(progress, levelIds[j - 1]);
      return {
        id: levelId,
        name: names[levelId] ?? levelsById[levelId]?.name ?? levelId,
        number: j + 1,
        completed,
        unlocked: unlocked && (previousDone || completed),
        gems: levelGems(levelId),
      };
    });

    const gems = levels.reduce(
      (sum, l) => ({ collected: sum.collected + l.gems.collected, total: sum.total + l.gems.total }),
      { collected: 0, total: 0 },
    );

    view.lands.push({
      id: land.id,
      name: land.name,
      unlocked,
      comingSoon: levelIds.length === 0,
      requiredGems,
      lockReason,
      gems,
      levels,
    });

    if (!land.requiredGemsPercent) {
      previousComplete = levels.length > 0 && levels.every((l) => l.completed);
      previousName = land.name;
    }
  });

  return view;
}

export function findLevel(view, levelId) {
  for (const land of view.lands) {
    const level = land.levels.find((l) => l.id === levelId);
    if (level) return { land, level };
  }
  return null;
}

export function isLevelUnlocked(view, levelId) {
  return findLevel(view, levelId)?.level.unlocked === true;
}

// The level to play after this one: the next one in the same land, or the first one
// of the next land. Null if it doesn't exist or is still locked.
export function nextLevelId(view, levelId) {
  const flat = view.lands.flatMap((land) => land.levels);
  const i = flat.findIndex((l) => l.id === levelId);
  const next = i >= 0 ? flat[i + 1] : null;
  return next?.unlocked ? next.id : null;
}