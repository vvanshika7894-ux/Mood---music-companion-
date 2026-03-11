const db = require("./database");

// Save transition
function saveTransition(userId, currentMood, desiredMood) {
  const stmt = db.prepare(`
    INSERT INTO transitions (user_id, current_mood, desired_mood)
    VALUES (?, ?, ?)
  `);

  const info = stmt.run(userId, currentMood, desiredMood);
  return info.lastInsertRowid;
}

// Get last 3 transitions (include id)
function getLastTransitions(userId) {
  const stmt = db.prepare(`
    SELECT id, current_mood, desired_mood, created_at
    FROM transitions
    WHERE user_id = ?
    ORDER BY created_at DESC
    LIMIT 3
  `);

  return stmt.all(userId);
}

// Save tracks for a transition
function saveTransitionTracks(transitionId, tracks) {
  const insert = db.prepare(`
    INSERT INTO transition_tracks (transition_id, idx, source, name, artist_name, audio)
    VALUES (?, ?, ?, ?, ?, ?)
  `);

  const del = db.prepare(`DELETE FROM transition_tracks WHERE transition_id = ?`);

  const tx = db.transaction(() => {
    del.run(transitionId);
    (tracks || []).forEach((t, i) => {
      if (!t?.audio) return;
      insert.run(
        transitionId,
        i,
        t.source || "",
        t.name || "",
        t.artist_name || "",
        t.audio
      );
    });
  });

  tx();
  return true;
}

// Load tracks for a transition
function getTransitionTracks(transitionId) {
  const stmt = db.prepare(`
    SELECT idx, source, name, artist_name, audio
    FROM transition_tracks
    WHERE transition_id = ?
    ORDER BY idx ASC
  `);

  return stmt.all(transitionId);
}
module.exports = {
  saveTransition,
  getLastTransitions,
  saveTransitionTracks,
  getTransitionTracks,
};
