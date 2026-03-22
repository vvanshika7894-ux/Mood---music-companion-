// renderer.js 

window.addEventListener("DOMContentLoaded", () => {
  const loader = document.getElementById("modalLoader");
  if (loader) loader.style.display = "none";
});

const { ipcRenderer } = require("electron");

/* ======================= DEFAULT API CONFIG ======================= */
const DEFAULT_JAMENDO_CLIENT_ID = "d288130c";
const DEFAULT_AUDIUS_DISCOVERIES = [
  "https://discoveryprovider.audius.co",
  "https://discoveryprovider2.audius.co",
  "https://discoveryprovider3.audius.co",
];

const JAMENDO_API = "https://api.jamendo.com/v3.0/tracks";

/* ======================= SETTINGS (localStorage) ======================= */
const SETTINGS_KEY = "mmc_settings_v2";

function getDefaultSettings() {
  return {
    useJamendo: true,
    useAudius: true,
    usePersonal: false,
    jamendoClientId: "",
    audiusDiscoveries: "",
  };
}

function loadSettings() {
  try {
    const raw = localStorage.getItem(SETTINGS_KEY);
    if (!raw) return getDefaultSettings();
    const parsed = JSON.parse(raw);
    return { ...getDefaultSettings(), ...parsed };
  } catch {
    return getDefaultSettings();
  }
}

function saveSettings(s) {
  localStorage.setItem(SETTINGS_KEY, JSON.stringify(s));
}

const apiConfig = {
  useJamendo: true,
  useAudius: true,
  jamendoClientId: DEFAULT_JAMENDO_CLIENT_ID,
  audiusDiscoveries: DEFAULT_AUDIUS_DISCOVERIES.slice(),
  sourceLabel: "Built-in APIs",
};

function parseDiscoveryList(text) {
  const lines = String(text || "")
    .split(/[\n,]/g)
    .map((x) => x.trim())
    .filter(Boolean);

  const out = [];
  for (const u of lines) {
    if (!/^https?:\/\//i.test(u)) out.push("https://" + u);
    else out.push(u);
  }
  return [...new Set(out)];
}

function applySettingsToApiConfig() {
  const s = loadSettings();

  apiConfig.useJamendo = !!s.useJamendo;
  apiConfig.useAudius = !!s.useAudius;

  if (!s.usePersonal) {
    apiConfig.jamendoClientId = DEFAULT_JAMENDO_CLIENT_ID;
    apiConfig.audiusDiscoveries = DEFAULT_AUDIUS_DISCOVERIES.slice();
    apiConfig.sourceLabel = "Built-in APIs";
    return;
  }

  const personalJam = (s.jamendoClientId || "").trim();
  apiConfig.jamendoClientId = personalJam || DEFAULT_JAMENDO_CLIENT_ID;

  const list = parseDiscoveryList(s.audiusDiscoveries);
  apiConfig.audiusDiscoveries = list.length ? list : DEFAULT_AUDIUS_DISCOVERIES.slice();

  apiConfig.sourceLabel = "Personal APIs";
}

applySettingsToApiConfig();

/* ======================= PLAYER CONFIG ======================= */
const PREVIEW_SECONDS = 60;
const ASK_AFTER_SONGS = 5;
const STEPS_TO_GOAL = 16;
const CROSSFADE_MS = 1200;

const QUEUE_REFILL_TO = 12;
const MAX_PLAYLIST_ITEMS = 40;

const FETCH_TIMEOUT_MS = 4500;
const BUILD_TIMEOUT_MS = 22000;
const AUDIO_START_TIMEOUT_MS = 6000;

/* ======================= AUDIO (CROSSFADE) ======================= */
const audioA = new Audio();
const audioB = new Audio();
[audioA, audioB].forEach((a) => {
  a.preload = "auto";
  a.volume = 1.0;
  a.crossOrigin = "anonymous";
});

let currentAudio = audioA;
let nextAudio = audioB;

function swapAudios() {
  const tmp = currentAudio;
  currentAudio = nextAudio;
  nextAudio = tmp;
}

function hardStopAudio() {
  try { currentAudio.pause(); } catch {}
  try { nextAudio.pause(); } catch {}
  try { currentAudio.currentTime = 0; } catch {}
  try { nextAudio.currentTime = 0; } catch {}

  currentAudio.src = "";
  nextAudio.src = "";

  try { currentAudio.load(); } catch {}
  try { nextAudio.load(); } catch {}

  currentAudio.volume = 1.0;
  nextAudio.volume = 1.0;
}

/* ======================= CACHES ======================= */
const jamendoCache = new Map();
const audiusCache = new Map();

function clearProviderCaches() {
  jamendoCache.clear();
  audiusCache.clear();
}

/* ======================= UNIQUE (NO REPEATS) ======================= */
function trackKey(track) {
  const s = (track?.source || "").toLowerCase().trim();
  const n = (track?.name || "").toLowerCase().trim();
  const a = (track?.artist_name || "").toLowerCase().trim();
  return `${s}::${n}::${a}`;
}

/* ======================= STATE ======================= */
let currentUser = null;
const state = {
  active: false,

  currentMoodText: "",
  desiredMoodText: "",

  currentVA: null,
  desiredVA: null,
  currentEmotion: null,
  desiredEmotion: null,

  progress: 0,
  stepsToGoal: STEPS_TO_GOAL,

  playedCount: 0,
  playedSinceAsk: 0,

  nowPlaying: null,
  isSwitching: false,

  previewTimer: null,
  previewDeadlineMs: 0,
  previewRemainingMs: 0,

  queue: [],
  playlist: [],
  playedUrls: new Set(),
  playedTrackKeys: new Set(),

  history: [],

  songStyle: {
    preferVocals: true,
    avoidAmbientPiano: true,
    varietyBoost: 0,
    genres: [],
  },

  sessionToken: 0,
};

/* ======================= SESSION TOKEN HELPERS ======================= */
function bumpSessionToken() {
  state.sessionToken += 1;
  return state.sessionToken;
}
function isTokenLive(token) {
  return token === state.sessionToken;
}

/* ======================= MAIN-PROCESS HTTP (NO CORS) ======================= */
async function httpRequest(url, { method = "GET", headers = {}, timeoutMs = FETCH_TIMEOUT_MS } = {}) {
  const res = await ipcRenderer.invoke("http-request", { url, method, headers, timeoutMs });
  if (!res) throw new Error("No response");
  if (res.error) throw new Error(res.error);

  const bodyBuf = res.bodyBase64 ? Buffer.from(res.bodyBase64, "base64") : Buffer.from("");
  return {
    ok: !!res.ok,
    status: res.status || 0,
    headers: res.headers || {},
    text: () => bodyBuf.toString("utf8"),
    json: () => JSON.parse(bodyBuf.toString("utf8") || "{}"),
  };
}

/* ======================= UI HELPERS ======================= */
let _resizeRaf = null;
function resizeToWidget() {
  if (_resizeRaf) cancelAnimationFrame(_resizeRaf);
  _resizeRaf = requestAnimationFrame(() => {
    const widget = document.getElementById("widget");
    if (!widget) return;
    ipcRenderer.send("resize-window", {
      width: Math.ceil(widget.offsetWidth),
      height: Math.ceil(widget.offsetHeight),
    });
  });
}

function setStatus(text) {
  const el = document.getElementById("status");
  if (el) el.textContent = text;
  resizeToWidget();
}

function setProgressVisible(on) {
  const wrap = document.getElementById("progressWrap");
  if (wrap) wrap.style.display = on ? "block" : "none";
  resizeToWidget();
}

function setProgress(pct) {
  const bar = document.getElementById("progressBar");
  if (bar) bar.style.width = `${Math.max(0, Math.min(100, pct))}%`;
}

function updateBackBtn() {
  const btn = document.getElementById("backBtn");
  if (!btn) return;
  btn.disabled = !state.active || state.history.length === 0;
}

function setNowPlayingText(extra = "") {
  const el = document.getElementById("nowPlaying");
  if (!el) return;

  if (!state.nowPlaying) {
    el.textContent = "";
    resizeToWidget();
    updateBackBtn();
    return;
  }

  const base =
    `Now playing: ${state.nowPlaying.name || "Unknown"} — ${state.nowPlaying.artist_name || "Unknown"}` +
    `${state.nowPlaying.source ? ` (${state.nowPlaying.source})` : ""} • first ${PREVIEW_SECONDS}s`;

  el.textContent = extra ? `${base} • ${extra}` : base;
  resizeToWidget();
  updateBackBtn();
}

function escapeHtml(s) {
  return String(s)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

/* ======================= PLAYLIST RENDER ======================= */
function renderPlaylist() {
  const list = document.getElementById("playlistList");
  const meta = document.getElementById("playlistMeta");
  if (!list || !meta) return;

  if (!state.active || state.playlist.length === 0) {
    meta.textContent = "No songs in the queue";
    list.innerHTML = `
      <div id="playlistEmpty">
        No songs in the queue.<br/>
        Start a session and choose Text / Voice / Video to generate a playlist.
      </div>
    `;
    resizeToWidget();
    updateBackBtn();
    return;
  }

  meta.textContent = `${state.playlist.length} tracks`;
  list.innerHTML = "";

  state.playlist.forEach((t, idx) => {
    const item = document.createElement("div");
    item.className = "playItem";

    if (state.nowPlaying && t.audio === state.nowPlaying.audio) item.classList.add("current");
    else if (state.playedUrls.has(t.audio)) item.classList.add("played");

    const title = (t.name || "Unknown").trim();
    const artist = (t.artist_name || "Unknown").trim();

    item.innerHTML = `
      <div class="t1">${idx + 1}. ${escapeHtml(title)}</div>
      <div class="t2">${escapeHtml(artist)}${t.source ? ` • ${escapeHtml(t.source)}` : ""}</div>
    `;

    item.onclick = async () => {
      if (!state.active) return;
      if (state.nowPlaying && t.audio === state.nowPlaying.audio) return;

      const clickedIndex = state.playlist.findIndex((x) => x.audio === t.audio);
      if (clickedIndex === -1) return;

      const remaining = state.playlist.slice(clickedIndex);
      state.queue = remaining.slice(0);

      renderPlaylist();

      clearPreviewTimer();
      try { currentAudio.pause(); } catch {}
      await playNextFromQueue(state.sessionToken);
    };

    list.appendChild(item);
  });

  resizeToWidget();
  updateBackBtn();
}

/* ======================= MODAL HELPERS ======================= */
function openModal(title, html) {
  const modal = document.getElementById("modal");
  document.getElementById("modalLoader").style.display = "none";
  document.getElementById("modalTitle").textContent = title;
  document.getElementById("modalContent").innerHTML = html;
  modal.style.display = "block";
  resizeToWidget();
}

function closeModal() {
  document.getElementById("modal").style.display = "none";
  document.getElementById("modalTitle").textContent = "";
  document.getElementById("modalContent").innerHTML = "";
  stopStream();
  resizeToWidget();
}

function setModalLoading(on, msg = "Please wait…") {
  const loader = document.getElementById("modalLoader");
  const m = document.getElementById("modalLoaderMsg");
  if (!loader) return;
  loader.style.display = on ? "flex" : "none";
  if (m) m.textContent = msg;

  document.querySelectorAll("#modalContent button, #modalContent input, #modalContent textarea").forEach((x) => {
    x.disabled = on;
    x.style.opacity = on ? "0.7" : "1";
  });
  resizeToWidget();
}

/* ======================= SETTINGS MODAL ======================= */
function openSettingsModal() {
  const s = loadSettings();

  openModal(
    "Settings",
    `
      <div style="font-size:12px;opacity:0.9;margin-bottom:10px;">
        Select which providers to use.
      </div>

      <div class="settingsRow" style="display:flex;gap:10px;align-items:center;">
        <label style="display:flex;align-items:center;gap:8px;flex:1;">
          <input type="checkbox" id="useJamendo" ${s.useJamendo ? "checked" : ""}/>
          Use Jamendo
        </label>
        <label style="display:flex;align-items:center;gap:8px;flex:1;">
          <input type="checkbox" id="useAudius" ${s.useAudius ? "checked" : ""}/>
          Use Audius
        </label>
      </div>

      <div style="height:10px;"></div>

      <div class="settingsRow">
        <label style="display:flex;align-items:center;gap:8px;">
          <input type="radio" name="apiMode" id="apiBuiltIn" ${s.usePersonal ? "" : "checked"} />
          Use built-in APIs (default)
        </label>
      </div>

      <div class="settingsRow">
        <label style="display:flex;align-items:center;gap:8px;">
          <input type="radio" name="apiMode" id="apiPersonal" ${s.usePersonal ? "checked" : ""} />
          Use personal APIs
        </label>
      </div>

      <div id="personalBlock" style="margin-top:10px; ${s.usePersonal ? "" : "display:none;"}">
        <div style="font-size:12px;opacity:0.8;line-height:1.35;">
          Jamendo needs a <b>client_id</b>. Audius usually doesn’t need a key, but you can set discovery URLs.
        </div>

        <div style="margin-top:10px;font-size:12px;font-weight:700;">Jamendo client_id</div>
        <input id="jamendoIdInput" placeholder="e.g. abcd1234" value="${escapeHtml(s.jamendoClientId || "")}"/>

        <div style="margin-top:10px;font-size:12px;font-weight:700;">Audius discovery URLs (optional)</div>
        <textarea id="audiusUrlsInput" placeholder="One per line or comma separated&#10;example: https://discoveryprovider.audius.co">${escapeHtml(s.audiusDiscoveries || "")}</textarea>
      </div>

      <div id="setErr" style="color:#ffb3b3;font-size:12px;min-height:16px;margin-top:10px;"></div>

      <div style="display:flex;gap:10px;margin-top:12px;">
        <button id="setCancel" style="flex:1;">Cancel</button>
        <button id="setSave" style="flex:1;">Save</button>
      </div>
    `
  );

  const builtIn = document.getElementById("apiBuiltIn");
  const personal = document.getElementById("apiPersonal");
  const block = document.getElementById("personalBlock");
  const err = document.getElementById("setErr");

  function syncBlock() {
    block.style.display = personal.checked ? "block" : "none";
    resizeToWidget();
  }
  builtIn.onchange = syncBlock;
  personal.onchange = syncBlock;

  document.getElementById("setCancel").onclick = () => closeModal();

  document.getElementById("setSave").onclick = () => {
    err.textContent = "";

    const useJamendo = !!document.getElementById("useJamendo").checked;
    const useAudius = !!document.getElementById("useAudius").checked;

    if (!useJamendo && !useAudius) {
      err.textContent = "Select at least one provider (Jamendo or Audius).";
      return;
    }

    const usePersonal = personal.checked;
    const jamendoId = (document.getElementById("jamendoIdInput")?.value || "").trim();
    const audiusUrls = (document.getElementById("audiusUrlsInput")?.value || "").trim();

    if (usePersonal && useJamendo && !jamendoId) {
      err.textContent = "Jamendo client_id is required if Jamendo is enabled in Personal mode.";
      return;
    }

    const next = {
      useJamendo,
      useAudius,
      usePersonal,
      jamendoClientId: usePersonal ? jamendoId : "",
      audiusDiscoveries: usePersonal ? audiusUrls : "",
    };

    saveSettings(next);
    applySettingsToApiConfig();

    bumpSessionToken();
    state.active = false;
    clearPreviewTimer();
    hardStopAudio();
    clearProviderCaches();

    state.queue = [];
    state.playlist = [];
    state.nowPlaying = null;
    state.playedUrls = new Set();
    state.playedTrackKeys = new Set();
    state.history = [];
    renderPlaylist();
    setNowPlayingText();
    setProgress(0);
    setProgressVisible(false);

    setStatus(
      `Saved. Using: ${apiConfig.sourceLabel} • Providers: ` +
      `${apiConfig.useAudius ? "Audius" : ""}${apiConfig.useAudius && apiConfig.useJamendo ? " + " : ""}${apiConfig.useJamendo ? "Jamendo" : ""}`
    );
    closeModal();
  };
}

/* ======================= GENRE PICKER ======================= */
function openGenreModal() {
  return new Promise((resolve) => {
    const GENRES = [
      "Any","Lo-fi","Indie","Folk","Country","Americana","Acoustic","Pop","Rock",
      "Electronic","Chill","Jazz","Blues","Soul","R&B","Hip-Hop","Reggae","Classical","Ambient",
    ];

    let selected = new Set(["Any"]);

    function renderChips() {
      return GENRES.map((g) => {
        const on = selected.has(g);
        return `
          <button class="chipBtn genreChip" data-genre="${escapeHtml(g)}"
            style="flex:0 0 auto;padding:8px 10px;border-radius:999px;
              border:1px solid rgba(255,255,255,0.16);
              background:${on ? "rgba(255,255,255,0.18)" : "rgba(255,255,255,0.08)"};">
            ${escapeHtml(g)}
          </button>
        `;
      }).join("");
    }

    openModal(
      "Choose Genre",
      `
        <div style="font-size:12px;opacity:0.85;margin-bottom:10px;">
          Pick one or more genres (or keep <b>Any</b>).
        </div>

        <div id="genreGrid" style="display:flex;flex-wrap:wrap;gap:8px;max-width:100%;">
          ${renderChips()}
        </div>

        <div style="display:flex;gap:10px;margin-top:12px;">
          <button id="genreSkip" style="flex:1;">Skip</button>
          <button id="genreOk" style="flex:1;">Continue</button>
        </div>
      `
    );

    const grid = document.getElementById("genreGrid");

    function normalizeSelected() {
      if (selected.size > 1 && selected.has("Any")) selected.delete("Any");
      if (selected.size === 0) selected.add("Any");
    }

    grid.onclick = (e) => {
      const btn = e.target.closest(".genreChip");
      if (!btn) return;
      const g = btn.getAttribute("data-genre");
      if (!g) return;

      if (selected.has(g)) selected.delete(g);
      else selected.add(g);

      if (g === "Any" && selected.has("Any")) selected = new Set(["Any"]);
      else normalizeSelected();

      grid.innerHTML = renderChips();
      resizeToWidget();
    };

    document.getElementById("genreSkip").onclick = () => {
      closeModal();
      resolve([]);
    };

    document.getElementById("genreOk").onclick = () => {
      normalizeSelected();
      const out = Array.from(selected);
      closeModal();
      if (out.length === 1 && out[0] === "Any") resolve([]);
      else resolve(out.map((x) => x.toLowerCase()));
    };
  });
}

/* ======================= MEDIA RECORDING ======================= */
let stream = null;
let mediaRecorder = null;
let recordedChunks = [];
let lastBlob = null;

function stopStream() {
  if (stream) {
    stream.getTracks().forEach((t) => t.stop());
    stream = null;
  }
  mediaRecorder = null;
  recordedChunks = [];
}

/* ======================= HELPERS ======================= */
function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }
function lerp(a, b, t) { return a + (b - a) * t; }
function clamp01(x) { return Math.max(0, Math.min(1, x)); }

function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

/* ======================= PREVIEW TIMER ======================= */
function clearPreviewTimer() {
  if (state.previewTimer) {
    clearTimeout(state.previewTimer);
    state.previewTimer = null;
  }
  state.previewDeadlineMs = 0;
  state.previewRemainingMs = 0;
}

function startPreviewTimer(ms, token) {
  clearPreviewTimer();
  if (!state.active || !isTokenLive(token)) return;

  state.previewRemainingMs = ms;
  state.previewDeadlineMs = Date.now() + ms;

  state.previewTimer = setTimeout(async () => {
    state.previewTimer = null;
    if (!state.active || !isTokenLive(token)) return;
    await handleTrackFinished("preview", token);
  }, ms);
}

function pausePreviewTimer() {
  if (!state.previewTimer) return;
  const remaining = Math.max(0, state.previewDeadlineMs - Date.now());
  clearPreviewTimer();
  state.previewRemainingMs = remaining;
}

function resumePreviewTimer(token) {
  if (!state.active || !isTokenLive(token)) return;
  if (!currentAudio.src) return;
  if (currentAudio.paused) return;

  const ms = state.previewRemainingMs > 0 ? state.previewRemainingMs : PREVIEW_SECONDS * 1000;
  startPreviewTimer(ms, token);
}

/* ======================= MOOD → QUERY ======================= */
function topKEmotions(emotionMap, k = 2) {
  if (!emotionMap) return [];
  return Object.entries(emotionMap)
    .sort((a, b) => (b[1] || 0) - (a[1] || 0))
    .slice(0, k)
    .map(([label]) => label.toLowerCase());
}

function blendEmotionMaps(a, b, t) {
  const out = {};
  const keys = new Set([...(a ? Object.keys(a) : []), ...(b ? Object.keys(b) : [])]);
  for (const k of keys) {
    const av = a?.[k] ?? 0;
    const bv = b?.[k] ?? 0;
    out[k] = av + (bv - av) * t;
  }
  return out;
}

const EMO_SYNONYMS = {
  joy: ["happy","uplifting","bright"],
  sadness: ["sad","melancholy","moody"],
  anger: ["angry","hard","rage"],
  fear: ["anxious","tense","nervous"],
  surprise: ["upbeat","bright"],
  disgust: ["dark","gritty"],
  neutral: ["chill","smooth","easy"],
  calm: ["calm","relax","peaceful"],
};

function emoKeywords(labels) {
  const words = [];
  for (const l of labels) {
    words.push(l);
    const syn = EMO_SYNONYMS[l];
    if (syn) words.push(...syn);
  }
  return [...new Set(words)].slice(0, 5);
}

function energyKeywordsFromArousal(a) {
  if (a <= -0.3) return ["soft","slow","gentle"];
  if (a <= 0.1) return ["chill","smooth","laid back"];
  if (a <= 0.45) return ["upbeat","groove","warm"];
  return ["energetic","dance","fast"];
}

function valenceKeywordsFromValence(v) {
  if (v <= -0.35) return ["sad","moody","dark"];
  if (v <= 0.05) return ["mellow","reflective","emotional"];
  if (v <= 0.45) return ["warm","hopeful","positive"];
  return ["happy","feelgood","bright"];
}

function cleanTag(s) {
  return String(s || "")
    .toLowerCase()
    .replace(/&/g, "and")
    .replace(/[^a-z0-9\s-]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}

function explodeTags(list) {
  const out = [];
  for (const item of (list || [])) {
    const t = cleanTag(item);
    if (!t) continue;
    if (t === "lo-fi" || t === "lo fi" || t === "lofi") out.push("lofi");
    else if (t === "r and b" || t === "randb") out.push("rnb");
    else out.push(...t.split(" "));
  }
  return [...new Set(out)].filter(Boolean);
}

function genreAugment(genresLower) {
  const w = [];
  const tags = [];
  const add = (wordList, tagList) => { w.push(...wordList); tags.push(...tagList); };

  for (const g of (genresLower || [])) {
    const gg = cleanTag(g);

    if (gg === "lofi" || gg === "lo-fi" || gg === "lo fi") {
      add(["lofi","lo-fi","chill"], ["lofi","chillout","lounge","downtempo"]);
    } else if (gg === "indie") {
      add(["indie","indie pop"], ["indie","alternative","pop"]);
    } else if (gg === "folk") {
      add(["folk","acoustic","singer songwriter"], ["folk","acoustic","singersongwriter"]);
    } else if (gg === "country") {
      add(["country","americana","acoustic"], ["country","americana","acoustic"]);
    } else if (gg === "americana") {
      add(["americana","folk","country"], ["americana","folk","country"]);
    } else if (gg === "acoustic") {
      add(["acoustic","guitar","soft"], ["acoustic"]);
    } else if (gg === "chill") {
      add(["chill","smooth"], ["chillout","lounge","downtempo"]);
    } else if (gg === "electronic") {
      add(["electronic"], ["electronic","dance","downtempo"]);
    } else if (gg === "pop") {
      add(["pop"], ["pop"]);
    } else if (gg === "rock") {
      add(["rock"], ["rock"]);
    } else if (gg === "jazz") {
      add(["jazz"], ["jazz"]);
    } else if (gg === "ambient") {
      add(["ambient"], ["ambient","chillout"]);
    } else if (gg) {
      add([gg],[gg]);
    }
  }

  return { w, tags: explodeTags(tags) };
}

function applySongStyleBias(words, tags) {
  const w = [...words];
  const t = [...tags];

  if (state.songStyle.preferVocals) w.unshift("vocal","song");

  if (state.songStyle.avoidAmbientPiano) {
    const bad = new Set(["piano","instrumental"]);
    for (let i = w.length - 1; i >= 0; i--) if (bad.has(w[i])) w.splice(i, 1);
    for (let i = t.length - 1; i >= 0; i--) if (bad.has(t[i])) t.splice(i, 1);
  }

  if (Array.isArray(state.songStyle.genres) && state.songStyle.genres.length) {
    const aug = genreAugment(state.songStyle.genres);
    w.push(...aug.w);
    t.push(...aug.tags);
  }

  return { words: [...new Set(w)].slice(0, 10), tags: [...new Set(t)].slice(0, 10) };
}

function queryPack(v, a, blendedEmotion, stageT, widen = 0) {
  const emos = topKEmotions(blendedEmotion, 2);
  const emoWords = emoKeywords(emos);
  const energy = energyKeywordsFromArousal(a);
  const valWords = valenceKeywordsFromValence(v);

  let words = [...valWords, ...energy, ...emoWords];
  let tags = [...valWords, ...energy];

  if (stageT < 0.33) { words.unshift("smooth"); tags.push("chillout","lounge"); }
  else if (stageT < 0.66) { words.unshift("warm"); tags.push("indie","pop"); }
  else { words.unshift("bright"); tags.push("pop","dance"); }

  if (widen >= 1) { words.push("music"); tags.push("pop"); }
  if (widen >= 2) { words.push("indie"); tags.push("indie"); }

  const biased = applySongStyleBias(words, tags);
  const safeTags = explodeTags(biased.tags).slice(0, 8);

  return {
    audiusQuery: biased.words.slice(0, 8).join(" "),
    jamendoTags: safeTags,
  };
}

/* ======================= PROVIDERS ======================= */
async function fetchJamendoTracks(tags) {
  const clientId = apiConfig.jamendoClientId || DEFAULT_JAMENDO_CLIENT_ID;
  const tagQuery = encodeURIComponent(tags.join("+"));

  const url =
    `${JAMENDO_API}?client_id=${encodeURIComponent(clientId)}` +
    `&format=json&limit=25&audioformat=mp32&tags=${tagQuery}`;

  const res = await httpRequest(url, {}, FETCH_TIMEOUT_MS);
  const data = await res.json();
  return data?.results || [];
}

async function getJamendoTrackForTags(tags) {
  const clientId = apiConfig.jamendoClientId || DEFAULT_JAMENDO_CLIENT_ID;
  const key = `jamendo:${clientId}:${tags.join("|")}`;
  const cached = jamendoCache.get(key);

  if (cached && cached.idx < cached.tracks.length) {
    const t = cached.tracks[cached.idx];
    cached.idx += 1;
    return t;
  }

  let results = await fetchJamendoTracks(tags);

  if (state.songStyle.avoidAmbientPiano) {
    results = results.filter((r) => {
      const name = (r.name || "").toLowerCase();
      return !name.includes("piano") && !name.includes("instrumental");
    });
  }

  results = shuffle(results);
  jamendoCache.set(key, { tracks: results, idx: 0 });

  const first = results[0];
  jamendoCache.get(key).idx = first ? 1 : 0;
  return first || null;
}

function audiusStreamUrl(base, trackId) {
  return `${base}/v1/tracks/${encodeURIComponent(trackId)}/stream`;
}

async function fetchAudiusTracks(query) {
  const resNode = await httpRequest("https://api.audius.co");
  const nodeJson = await resNode.json();
  const base = nodeJson.data?.[0];
  if (!base) throw new Error("No Audius node");

  const searchUrl = `${base}/v1/tracks/search?query=${encodeURIComponent(query)}&limit=20`;
  const res = await httpRequest(searchUrl);
  const json = await res.json();

  return { base, tracks: json.data || [] };
}

async function getAudiusTrackForQuery(query) {
  const key = `audius:${query}`;
  const cached = audiusCache.get(key);

  if (cached && cached.idx < cached.tracks.length) {
    const t = cached.tracks[cached.idx];
    cached.idx += 1;
    return { base: cached.base, track: t };
  }

  const { base, tracks } = await fetchAudiusTracks(query);
  if (!tracks || tracks.length === 0) return { base: null, track: null };

  const shuffled = shuffle(tracks);

  audiusCache.set(key, { base, tracks: shuffled, idx: 1 });
  return { base, track: shuffled[0] };
}

/* ======================= ROBUST FETCH (TRY BOTH) ======================= */
async function getTrackRobustForStage(v, a, blendedEmotion, stageTValue, token) {
  for (let widen = 0; widen <= 2; widen++) {
    if (!state.active || !isTokenLive(token)) return null;

    const pack = queryPack(v, a, blendedEmotion, stageTValue, widen);
    const primary = pack.audiusQuery.split(" ")[0];

    const aq = [primary, "chill", "lofi", "indie", "pop", "electronic"].filter(Boolean);

    if (apiConfig.useAudius) {
      for (const q of aq) {
        if (!state.active || !isTokenLive(token)) return null;
        try {
          const { base, track } = await getAudiusTrackForQuery(q);
          if (track && track.id) {
            const url = audiusStreamUrl(base, track.id);
            return {
              source: "audius",
              name: track.title || "Unknown",
              artist_name: track.user?.name || "Unknown",
              audio: url,
            };
          }
        } catch {}
      }
    }

    if (apiConfig.useJamendo) {
      const tries = [
        pack.jamendoTags,
        pack.jamendoTags.slice(0, 6),
        pack.jamendoTags.slice(0, 4),
        pack.jamendoTags.slice(0, 3),
        ["pop"],
        ["indie"],
        ["rock"],
        ["electronic"],
        ["chillout"],
      ];

      for (const tags of tries) {
        if (!state.active || !isTokenLive(token)) return null;
        try {
          const j = await getJamendoTrackForTags(tags);
          if (j && j.audio) {
            return {
              source: "jamendo",
              name: j.name || "Unknown",
              artist_name: j.artist_name || "Unknown",
              audio: j.audio,
            };
          }
        } catch {}
      }
    }
  }

  return null;
}

/* ======================= AI ======================= */
async function analyzeMood({ text = "", blob = null, ext = "webm" }) {
  let bytes = null;
  if (blob) {
    const ab = await blob.arrayBuffer();
    bytes = Array.from(new Uint8Array(ab));
  }
  const res = await ipcRenderer.invoke("analyze-mood", { text, bytes, ext });
  if (!res) throw new Error("No response from AI");
  if (res.error) throw new Error(res.error);
  return res;
}

function splitTranscriptToMoods(transcript) {
  const t = (transcript || "").trim();
  if (!t) return { current: "", desired: "" };

  const patterns = [
    /\b(i\s+want\s+to\s+feel)\b/i,
    /\b(i\s+want\s+to)\b/i,
    /\b(i\s+wanna\s+feel)\b/i,
    /\b(i\s+wanna)\b/i,
    /\b(want\s+to\s+feel)\b/i,
    /\b(would\s+like\s+to\s+feel)\b/i,
    /\b(would\s+like\s+to)\b/i,
  ];

  let idx = -1;
  for (const p of patterns) {
    const m = t.match(p);
    if (m && m.index != null) { idx = m.index; break; }
  }

  if (idx === -1) return { current: t, desired: "" };

  const current = t.slice(0, idx).trim().replace(/[,;:\-]+$/g, "").trim();
  const desiredRaw = t.slice(idx).trim();

  const desired = desiredRaw
    .replace(/^i\s+want\s+to\s+feel\s+/i, "")
    .replace(/^i\s+want\s+to\s+/i, "")
    .replace(/^i\s+wanna\s+feel\s+/i, "")
    .replace(/^i\s+wanna\s+/i, "")
    .replace(/^want\s+to\s+feel\s+/i, "")
    .replace(/^would\s+like\s+to\s+feel\s+/i, "")
    .replace(/^would\s+like\s+to\s+/i, "")
    .trim();

  return { current: current || t, desired: desired || "" };
}

/* ======================= STAGE ORDERED QUEUE ======================= */
function stageT(stageIndex) {
  if (state.stepsToGoal <= 1) return 1;
  return clamp01(stageIndex / (state.stepsToGoal - 1));
}

function nextStageIndexForQueue() {
  const idx = state.playedCount + state.queue.length;
  return Math.min(state.stepsToGoal - 1, Math.max(0, idx));
}

function advanceProgressOneTrack() {
  state.playedCount = Math.min(state.stepsToGoal, state.playedCount + 1);
  const step = 1 / Math.max(1, state.stepsToGoal);
  state.progress = Math.min(1, state.progress + step);
}

async function buildOneTrackForStage(stageIndex, token) {
  if (!state.active || !isTokenLive(token)) return null;

  const t = stageT(stageIndex);
  const v = lerp(state.currentVA.v, state.desiredVA.v, t);
  const a = lerp(state.currentVA.a, state.desiredVA.a, t);
  const blendedEmotion = blendEmotionMaps(state.currentEmotion, state.desiredEmotion, t);

  const tr = await getTrackRobustForStage(v, a, blendedEmotion, t, token);
  if (!tr) return null;

  const key = trackKey(tr);

  if (state.playedTrackKeys.has(key)) return null;
  if (state.queue.some((q) => trackKey(q) === key)) return null;
  if (state.playlist.some((p) => trackKey(p) === key)) return null;
  if (state.playedUrls.has(tr.audio)) return null;

  tr._t = t;
  tr._stage = stageIndex;
  tr._key = key;
  return tr;
}

async function ensureQueueAndPlaylist(token) {
  if (!state.active || !isTokenLive(token)) return;
  if (!state.currentVA || !state.desiredVA) return;

  let safety = 0;
  const buildStart = Date.now();

  while (state.queue.length < QUEUE_REFILL_TO && safety < 80) {
    safety++;
    if (!state.active || !isTokenLive(token)) return;

    if (Date.now() - buildStart > BUILD_TIMEOUT_MS) {
      if (state.queue.length === 0) {
        setStatus("Couldn’t find playable tracks. Try again or change Settings.");
      } else {
        setStatus("Playlist partially built. Starting anyway…");
      }
      break;
    }

    setStatus(
      `Searching for tracks… (${state.queue.length}/${QUEUE_REFILL_TO}) • ${apiConfig.sourceLabel} • ` +
      `${apiConfig.useAudius ? "Audius" : ""}${apiConfig.useAudius && apiConfig.useJamendo ? " + " : ""}${apiConfig.useJamendo ? "Jamendo" : ""}`
    );

    const idx = nextStageIndexForQueue();
    const tr = await buildOneTrackForStage(idx, token);

    if (!state.active || !isTokenLive(token)) return;

    if (tr) {
      state.queue.push(tr);
      state.playlist.push(tr);

      if (state.playlist.length > MAX_PLAYLIST_ITEMS) {
        state.playlist = state.playlist.slice(state.playlist.length - MAX_PLAYLIST_ITEMS);
      }
      continue;
    }

    state.songStyle.varietyBoost = Math.min(3, (state.songStyle.varietyBoost || 0) + 0.25);
    if (state.queue.length >= 4) break;
  }

  renderPlaylist();
}

async function playNextFromQueue(token) {
  if (!state.active || !isTokenLive(token)) return;

  if (state.queue.length === 0) {
    await ensureQueueAndPlaylist(token);
  }
  if (!state.active || !isTokenLive(token)) return;

  const nxt = state.queue.shift();
  if (!nxt) {
    setStatus("No tracks found. Try changing genre or Settings.");
    return;
  }

  if (state.nowPlaying && state.nowPlaying.audio !== nxt.audio) {
    state.history.push(state.nowPlaying);
  }

  state.playedUrls.add(nxt.audio);
  state.playedTrackKeys.add(trackKey(nxt));
  state.nowPlaying = nxt;

  const extra = (typeof nxt._t === "number") ? `transition ${(nxt._t * 100).toFixed(0)}%` : "";
  setNowPlayingText(extra);

  renderPlaylist();
  updateBackBtn();

  setStatus(`Starting your mood transition… (loading ${nxt.source}) • ${apiConfig.sourceLabel}`);
  await playTrack(nxt, token);

  // background refill only when using providers
  if (state.queue.length < 3) {
    await ensureQueueAndPlaylist(token);
  }
}

/* ======================= WATCHDOG ======================= */
async function waitForAudioToStart(token, ms = AUDIO_START_TIMEOUT_MS) {
  const start = Date.now();
  while (Date.now() - start < ms) {
    if (!state.active || !isTokenLive(token)) return false;
    if (currentAudio && !currentAudio.paused && currentAudio.currentTime > 0) return true;
    await sleep(150);
  }
  return false;
}

/* ======================= CROSSFADE PLAYBACK ======================= */
async function crossfadeTo(url, token) {
  if (!state.active || !isTokenLive(token)) return;

  nextAudio.src = url;
  nextAudio.currentTime = 0;
  nextAudio.volume = 0;

  await nextAudio.play();

  const steps = 14;
  const dt = CROSSFADE_MS / steps;

  for (let i = 1; i <= steps; i++) {
    if (!state.active || !isTokenLive(token)) return;
    const p = i / steps;
    nextAudio.volume = p;
    currentAudio.volume = 1 - p;
    await sleep(dt);
  }

  currentAudio.pause();
  currentAudio.src = "";
  currentAudio.volume = 1.0;

  swapAudios();
}

async function playTrack(track, token) {
  if (!track || !track.audio) {
    setStatus("No playable track found. Try again.");
    return;
  }
  if (!state.active || !isTokenLive(token)) return;
  if (state.isSwitching) return;

  state.isSwitching = true;

  clearPreviewTimer();
  setProgress(state.progress * 100);

  try {
    if (!currentAudio.src) {
      currentAudio.src = track.audio;
      currentAudio.currentTime = 0;
      currentAudio.volume = 1.0;
      await currentAudio.play();
    } else {
      await crossfadeTo(track.audio, token);
    }

    const ok = await waitForAudioToStart(token, AUDIO_START_TIMEOUT_MS);
    if (!ok) {
      setStatus("Track didn’t start (dead stream). Skipping…");
      try { currentAudio.pause(); } catch {}
      state.isSwitching = false;
      await playNextFromQueue(token);
      return;
    }

    setStatus(`Playing… • ${apiConfig.sourceLabel}`);
    startPreviewTimer(PREVIEW_SECONDS * 1000, token);
  } catch (e) {
    setStatus(`Audio play failed: ${e?.message || e}`);
    state.isSwitching = false;
    await sleep(200);
    await playNextFromQueue(token);
    return;
  } finally {
    state.isSwitching = false;
  }
}

/* ======================= TRACK FINISH ======================= */
async function handleTrackFinished(_reason, token) {
  if (!state.active || !isTokenLive(token)) return;

  clearPreviewTimer();

  advanceProgressOneTrack();
  setProgress(state.progress * 100);

  state.playedSinceAsk += 1;

  if (state.playedSinceAsk >= ASK_AFTER_SONGS) {
    try { currentAudio.pause(); } catch {}
    await askContinueOrStop(token);
    return;
  }

  await playNextFromQueue(token);
}

audioA.addEventListener("ended", () => handleTrackFinished("ended", state.sessionToken));
audioB.addEventListener("ended", () => handleTrackFinished("ended", state.sessionToken));

/* ======================= ASK AFTER 5 SONGS ======================= */
async function askContinueOrStop(token) {
  if (!state.active || !isTokenLive(token)) return;

  openModal(
    "Continue?",
    `
      <div style="font-size:12px;opacity:0.85;margin-bottom:10px;">
        Played ${ASK_AFTER_SONGS} songs. Continue?
      </div>

      <div style="display:flex;gap:10px;">
        <button id="contBtn" style="flex:1;">Continue</button>
        <button id="stopBtn" style="flex:1;">Stop</button>
      </div>
    `
  );

  document.getElementById("contBtn").onclick = async () => {
    if (!state.active || !isTokenLive(token)) return;
    closeModal();
    state.playedSinceAsk = 0;
    await playNextFromQueue(token);
  };

  document.getElementById("stopBtn").onclick = () => {
    closeModal();
    stopSessionUI();
  };
}

/* ======================= EXACT PLAYBACK (FROM SAVED TRACKS) ======================= */
async function startPlaybackFromExactTracks(curText, desText, tracks) {
  const token = state.sessionToken;

  setStatus("Analyzing mood…");
  const curOut = await analyzeMood({ text: curText });
  const desOut = await analyzeMood({ text: desText });
  if (!isTokenLive(token)) return;

  state.currentMoodText = curText;
  state.desiredMoodText = desText;

  state.currentEmotion = curOut.emotion || null;
  state.desiredEmotion = desOut.emotion || null;

  state.currentVA = { v: curOut.valence, a: curOut.arousal };
  state.desiredVA = { v: desOut.valence, a: desOut.arousal };

  state.progress = 0;
  state.playedCount = 0;
  state.playedSinceAsk = 0;

  state.queue = (tracks || []).map((t, i) => ({
    source: t.source || "",
    name: t.name || "Unknown",
    artist_name: t.artist_name || "Unknown",
    audio: t.audio,
    _stage: i,
    _t: state.stepsToGoal <= 1 ? 1 : Math.min(1, i / (state.stepsToGoal - 1)),
  }));

  state.playlist = state.queue.slice();
  state.playedUrls = new Set();
  state.playedTrackKeys = new Set();
  state.nowPlaying = null;
  state.history = [];
  state.isSwitching = false;

  setProgress(0);
  setProgressVisible(true);
  setNowPlayingText();
  renderPlaylist();
  updateBackBtn();

  state.active = true;
  document.getElementById("playPauseBtn").disabled = false;
  document.getElementById("nextBtn").disabled = false;

  setStatus("Replaying saved transition…");
  await playNextFromQueue(token);
}

/* ======================= MOOD FLOW (NEW) ======================= */
async function startNewPlaybackFlowAfterMood(curOut, desOut, curText, desText) {
  let transitionId = null;

  if (currentUser) {
    const resp = await ipcRenderer.invoke("save-transition", {
      currentMood: curText,
      desiredMood: desText,
    });
    if (resp && resp.success && resp.id) transitionId = resp.id;
  }

  const token = state.sessionToken;

  state.currentMoodText = curText;
  state.desiredMoodText = desText;

  state.currentEmotion = curOut.emotion || null;
  state.desiredEmotion = desOut.emotion || null;

  state.currentVA = { v: curOut.valence, a: curOut.arousal };
  state.desiredVA = { v: desOut.valence, a: desOut.arousal };

  state.progress = 0;
  state.playedCount = 0;
  state.playedSinceAsk = 0;

  state.queue = [];
  state.playlist = [];
  state.playedUrls = new Set();
  state.playedTrackKeys = new Set();
  state.nowPlaying = null;
  state.history = [];
  state.isSwitching = false;

  setProgress(0);
  setProgressVisible(true);
  setNowPlayingText();
  renderPlaylist();
  updateBackBtn();

  const genres = await openGenreModal();
  if (!isTokenLive(token)) return;
  state.songStyle.genres = genres || [];

  state.active = true;
  document.getElementById("playPauseBtn").disabled = false;
  document.getElementById("nextBtn").disabled = false;

  const gText = (genres && genres.length) ? `Genre: ${genres.join(", ")}. ` : "";
  setStatus(`${gText}Building your playlist… • ${apiConfig.sourceLabel}`);

  await ensureQueueAndPlaylist(token);
  if (!state.active || !isTokenLive(token)) return;

  if (currentUser && transitionId) {
    const tracksToSave = state.playlist.slice(0, 20).map((t) => ({
      source: t.source,
      name: t.name,
      artist_name: t.artist_name,
      audio: t.audio,
    }));

    await ipcRenderer.invoke("save-transition-tracks", {
      transitionId,
      tracks: tracksToSave,
    });

    loadPastTransitions();
  }

  setStatus(`Starting your mood transition… • ${apiConfig.sourceLabel}`);
  await playNextFromQueue(token);
}

/* ======================= PAST TRANSITIONS (UI) ======================= */
async function loadPastTransitions() {
  const row = document.getElementById("pastRow");
  if (!row) return;

  row.innerHTML = "";

  if (!currentUser) {
    resizeToWidget();
    return;
  }

  let items = [];
  try {
    items = await ipcRenderer.invoke("get-last-transitions");
  } catch {
    items = [];
  }

  if (!items || items.length === 0) {
    row.innerHTML = `
      <div style="font-size:12px;opacity:0.6;padding:6px 2px;">
        No past transitions yet.
      </div>
    `;
    resizeToWidget();
    return;
  }

  items.forEach((t) => {
    const cur = (t.current_mood || "").trim();
    const des = (t.desired_mood || "").trim();
    const when = t.created_at ? new Date(t.created_at) : null;
    const whenText = when ? when.toLocaleString() : "";

    const card = document.createElement("div");
    card.className = "pastCard";

    card.innerHTML = `
      <div class="pastTitle">${escapeHtml(cur || "—")}</div>
      <div class="pastSub">→ ${escapeHtml(des || "—")}</div>
      <div class="pastSub" style="margin-top:8px;opacity:0.55;">
        ${escapeHtml(whenText)}
      </div>
    `;

    card.onclick = async () => {
      if (!currentUser) return;

      if (document.getElementById("startSessionBtn")?.disabled === false) {
        startSessionUI();
      }

      try {
        const token = bumpSessionToken();
        setStatus("Loading saved transition…");
        setProgressVisible(true);

        const tracks = await ipcRenderer.invoke("get-transition-tracks", { transitionId: t.id });

        if (!tracks || tracks.length === 0) {
          // fallback: rebuild if no saved tracks
          setStatus("No saved tracks found. Rebuilding…");
          const curOut = await analyzeMood({ text: cur });
          const desOut = await analyzeMood({ text: des });
          if (!isTokenLive(token)) return;
          await startNewPlaybackFlowAfterMood(curOut, desOut, cur, des);
          return;
        }

        if (!isTokenLive(token)) return;
        await startPlaybackFromExactTracks(cur, des, tracks);
      } catch (e) {
        setStatus(`Failed to load past transition: ${e?.message || e}`);
      }
    };

    row.appendChild(card);
  });

  resizeToWidget();
}

/* ======================= INPUT MODALS ======================= */
function openAuthModal(mode = "login") {
  function renderLogin() {
    openModal(
      "Login",
      `
        <input id="authUser" placeholder="Username" />
        <input id="authPass" type="password" placeholder="Password" />

        <div id="authErr"
             style="color:#ffb3b3;font-size:12px;min-height:16px;margin-top:6px;">
        </div>

        <button id="loginBtn" style="width:100%;margin-top:10px;">
          Login
        </button>

        <div style="margin-top:10px;font-size:12px;text-align:center;">
          No account?
          <span id="goRegister"
                style="color:#9ad;cursor:pointer;">Register</span>
        </div>
      `
    );

    const err = document.getElementById("authErr");

    document.getElementById("loginBtn").onclick = async () => {
      const username = document.getElementById("authUser").value.trim();
      const password = document.getElementById("authPass").value.trim();

      if (!username || !password) {
        err.textContent = "Enter username and password";
        return;
      }

      const res = await ipcRenderer.invoke("login", { username, password });

      if (res.error) {
        err.textContent = res.error;
        return;
      }

      currentUser = res.user;
      localStorage.setItem("user", JSON.stringify(res.user));

      closeModal();
      setStatus(`Welcome ${currentUser.username}!`);
      loadPastTransitions();
    };

    document.getElementById("goRegister").onclick = () => renderRegister();
  }

  function renderRegister() {
    openModal(
      "Register",
      `
        <input id="regUser" placeholder="Username" />
        <input id="regPass" type="password" placeholder="Password" />
        <input id="regPass2" type="password" placeholder="Retype Password" />

        <div id="authErr"
             style="color:#ffb3b3;font-size:12px;min-height:16px;margin-top:6px;">
        </div>

        <button id="registerBtn" style="width:100%;margin-top:10px;">
          Create Account
        </button>

        <div style="margin-top:10px;font-size:12px;text-align:center;">
          Already registered?
          <span id="goLogin"
                style="color:#9ad;cursor:pointer;">Login</span>
        </div>
      `
    );

    const err = document.getElementById("authErr");

    document.getElementById("registerBtn").onclick = async () => {
      const username = document.getElementById("regUser").value.trim();
      const pass = document.getElementById("regPass").value.trim();
      const pass2 = document.getElementById("regPass2").value.trim();

      if (!username || !pass || !pass2) {
        err.textContent = "Fill all fields";
        return;
      }

      if (pass.length < 4) {
        err.textContent = "Password must be at least 4 characters.";
        return;
      }

      if (pass !== pass2) {
        err.textContent = "Passwords do not match.";
        return;
      }

      const res = await ipcRenderer.invoke("register", { username, password: pass });

      if (res.error) {
        err.textContent = res.error;
        return;
      }

      openAuthModal("login");

      setTimeout(() => {
        setStatus("Account created! Please login.");
      }, 200);
    };

    document.getElementById("goLogin").onclick = () => renderLogin();
  }

  if (mode === "register") renderRegister();
  else renderLogin();
}

function openTextModal() {
  openModal(
    "Text Input",
  `
    <div style="font-size:13px;opacity:0.85;margin-bottom:14px;">
      Tell us your <b>current mood</b> and <b>desired mood</b>.
    </div>

    <div style="display:flex;flex-direction:column;gap:12px;">
      <input id="curMood"
        placeholder="Current mood"
        autocomplete="off"
        style="
          width:100%;
          padding:14px 16px;
          border-radius:14px;
          border:1px solid rgba(255,255,255,0.15);
          background:rgba(255,255,255,0.08);
          color:white;
          font-size:14px;
          outline:none;
        "
      />

      <input id="desMood"
        placeholder="Desired mood"
        autocomplete="off"
        style="
          width:100%;
          padding:14px 16px;
          border-radius:14px;
          border:1px solid rgba(255,255,255,0.15);
          background:rgba(255,255,255,0.08);
          color:white;
          font-size:14px;
          outline:none;
        "
      />
    </div>

    <div id="txtErr"
         style="color:#ffb3b3;font-size:12px;min-height:16px;margin-top:10px;">
    </div>

    <button id="txtGo"
      style="
        width:100%;
        margin-top:14px;
        padding:12px;
        border-radius:12px;
        border:none;
        background:rgba(255,255,255,0.18);
        color:white;
        font-weight:600;
        cursor:pointer;
      ">
      Start
    </button>
  `
  );

  document.getElementById("txtGo").onclick = async () => {
    const cur = document.getElementById("curMood").value.trim();
    const des = document.getElementById("desMood").value.trim();
    const err = document.getElementById("txtErr");
    err.textContent = "";

    if (!cur || !des) {
      err.textContent = "Please fill both current and desired mood.";
      return;
    }

    try {
      setModalLoading(true, "Analyzing mood…");
      const curOut = await analyzeMood({ text: cur });
      const desOut = await analyzeMood({ text: des });

      setModalLoading(false);
      closeModal();

      bumpSessionToken();
      await startNewPlaybackFlowAfterMood(curOut, desOut, cur, des);
    } catch (e) {
      setModalLoading(false);
      err.textContent = `AI failed: ${e?.message || e}`;
    }
  };
}

function openVoiceModal() {
  lastBlob = null;
  stopStream();

  openModal(
    "Voice Input",
    `
      <div style="font-size:12px;opacity:0.85;margin-bottom:8px;">
        Speak your mood + goal (e.g., “I feel stressed, I want to feel calm”).
      </div>
      <button id="recBtn" style="width:100%;margin-top:6px;">Start Recording</button>
      <audio id="prev" controls style="width:100%;display:none;margin-top:10px;"></audio>
      <div id="vErr" style="color:#ffb3b3;font-size:12px;min-height:16px;margin-top:6px;"></div>
      <button id="goBtn" style="width:100%;margin-top:10px;display:none;">Transcribe + Start</button>
    `
  );

  const recBtn = document.getElementById("recBtn");
  const prev = document.getElementById("prev");
  const goBtn = document.getElementById("goBtn");
  const vErr = document.getElementById("vErr");

  recBtn.onclick = async () => {
    vErr.textContent = "";

    if (!mediaRecorder) {
      try {
        stream = await navigator.mediaDevices.getUserMedia({ audio: true });
      } catch (e) {
        vErr.textContent = `Mic permission denied: ${e?.message || e}`;
        return;
      }

      recordedChunks = [];
      mediaRecorder = new MediaRecorder(stream);

      mediaRecorder.ondataavailable = (e) => {
        if (e.data && e.data.size > 0) recordedChunks.push(e.data);
      };

      mediaRecorder.onstop = () => {
        lastBlob = new Blob(recordedChunks, { type: "audio/webm" });
        prev.src = URL.createObjectURL(lastBlob);
        prev.style.display = "block";
        goBtn.style.display = "block";
        recBtn.textContent = "Start Recording";
        stopStream();
        resizeToWidget();
        mediaRecorder = null;
      };

      mediaRecorder.start();
      recBtn.textContent = "Stop Recording";
    } else {
      try { mediaRecorder.stop(); } catch {}
    }
  };

  goBtn.onclick = async () => {
    if (!lastBlob) return;

    try {
      setModalLoading(true, "Transcribing…");
      const out = await analyzeMood({ blob: lastBlob, ext: "webm" });

      const transcript = (out.transcript || "").trim();
      if (!transcript) throw new Error("Could not transcribe clearly. Try again.");

      const { current, desired } = splitTranscriptToMoods(transcript);
      const desiredText = desired || "calm";

      setModalLoading(true, "Analyzing mood…");
      const curOut = await analyzeMood({ text: current || transcript });
      const desOut = await analyzeMood({ text: desiredText });

      setModalLoading(false);
      closeModal();

      bumpSessionToken();
      await startNewPlaybackFlowAfterMood(curOut, desOut, current || transcript, desiredText);
    } catch (e) {
      setModalLoading(false);
      vErr.textContent = `Voice failed: ${e?.message || e}`;
    }
  };
}

function openVideoModal() {
  lastBlob = null;
  stopStream();

  const RECORD_MAX_MS = 10000;

  openModal(
  "Video Input",
`
<div style="font-size:13px;opacity:0.85;margin-bottom:12px;">
  You’ll see a live preview. Tap the red button to record.
</div>

<div style="
  position:relative;
  width:100%;
  max-height:320px;
  border-radius:16px;
  overflow:hidden;
  background:black;
">
  <video id="liveCam"
    autoplay
    playsinline
    muted
    style="
      width:100%;
      height:320px;
      object-fit:cover;
    ">
  </video>

  <button id="recCircle"
    style="
      position:absolute;
      bottom:16px;
      left:50%;
      transform:translateX(-50%);
      width:64px;
      height:64px;
      border-radius:50%;
      border:none;
      background:#ff3b30;
      box-shadow:0 0 20px rgba(255,0,0,0.6);
      cursor:pointer;
    ">
  </button>

  <div id="recTimer"
    style="
      position:absolute;
      top:10px;
      left:10px;
      background:rgba(0,0,0,0.6);
      color:white;
      font-size:12px;
      padding:4px 8px;
      border-radius:6px;
    ">
    00:00
  </div>

</div>

<div id="vidErr"
     style="color:#ffb3b3;font-size:12px;min-height:16px;margin-top:12px;">
</div>
`
);

  const liveCam = document.getElementById("liveCam");
  const recBtn = document.getElementById("recCircle");
  const timerEl = document.getElementById("recTimer");
  const err = document.getElementById("vidErr");

  let recordTimeout = null;
  let tickTimer = null;
  let startedAt = 0;

  function pickSupportedMime() {
    const cands = [
      "video/webm;codecs=vp9,opus",
      "video/webm;codecs=vp8,opus",
      "video/webm;codecs=vp9",
      "video/webm;codecs=vp8",
      "video/webm",
    ];
    for (const m of cands) {
      try {
        if (window.MediaRecorder && MediaRecorder.isTypeSupported && MediaRecorder.isTypeSupported(m)) return m;
      } catch {}
    }
    return "";
  }

  function fmt(ms) {
    const s = Math.max(0, Math.floor(ms / 1000));
    const mm = String(Math.floor(s / 60)).padStart(2, "0");
    const ss = String(s % 60).padStart(2, "0");
    return `${mm}:${ss}`;
  }

  function stopTimers() {
    if (recordTimeout) clearTimeout(recordTimeout);
    recordTimeout = null;
    if (tickTimer) clearInterval(tickTimer);
    tickTimer = null;
  }

  async function ensureCameraPreview() {
    if (stream) return;

    try {
      stream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
    } catch (e) {
      err.textContent = `Camera/Mic permission denied: ${e?.message || e}`;
      return;
    }

    try {
      liveCam.srcObject = stream;
      await liveCam.play().catch(() => {});
    } catch {}
  }

  async function startRecording() {
    err.textContent = "";
    await ensureCameraPreview();
    if (!stream) return;

    recordedChunks = [];

    try {
      const mt = pickSupportedMime();
      mediaRecorder = mt ? new MediaRecorder(stream, { mimeType: mt }) : new MediaRecorder(stream);
    } catch (e) {
      try {
        mediaRecorder = new MediaRecorder(stream, { mimeType: "video/webm" });
      } catch (e2) {
        err.textContent = `MediaRecorder not supported: ${e2?.message || e2}`;
        stopStream();
        return;
      }
    }

    mediaRecorder.ondataavailable = (e) => {
      if (e.data && e.data.size > 0) recordedChunks.push(e.data);
    };

    mediaRecorder.onstop = async () => {
      stopTimers();

      const type = (mediaRecorder && mediaRecorder.mimeType) ? mediaRecorder.mimeType : "video/webm";
      lastBlob = new Blob(recordedChunks, { type });

      recBtn.classList.remove("isRec");
      timerEl.textContent = "00:00";

      stopStream();

      try {
        setModalLoading(true, "Transcribing video…");
        const out = await analyzeMood({ blob: lastBlob, ext: "webm" });

        const transcript = (out.transcript || "").trim();
        if (!transcript) throw new Error("Could not transcribe clearly. Try again.");

        const { current, desired } = splitTranscriptToMoods(transcript);
        const desiredText = desired || "calm";

        setModalLoading(true, "Analyzing mood…");
        const curOut = await analyzeMood({ text: current || transcript });
        const desOut = await analyzeMood({ text: desiredText });

        setModalLoading(false);
        closeModal();

        bumpSessionToken();
        await startNewPlaybackFlowAfterMood(curOut, desOut, current || transcript, desiredText);
      } catch (e) {
        setModalLoading(false);
        err.textContent = `Video failed: ${e?.message || e}`;
      } finally {
        mediaRecorder = null;
      }
    };

    try {
      mediaRecorder.start();
    } catch (e) {
      err.textContent = `Failed to start recording: ${e?.message || e}`;
      stopStream();
      mediaRecorder = null;
      return;
    }

    recBtn.classList.add("isRec");
    startedAt = Date.now();
    timerEl.textContent = "00:00";

    tickTimer = setInterval(() => {
      timerEl.textContent = fmt(Date.now() - startedAt);
    }, 200);

    recordTimeout = setTimeout(() => {
      try { mediaRecorder && mediaRecorder.state === "recording" && mediaRecorder.stop(); } catch {}
    }, RECORD_MAX_MS);
  }

  function stopRecordingManual() {
    stopTimers();
    try {
      if (mediaRecorder && mediaRecorder.state === "recording") mediaRecorder.stop();
    } catch {}
  }

  recBtn.onclick = async () => {
    if (mediaRecorder && mediaRecorder.state === "recording") {
      stopRecordingManual();
      return;
    }
    await startRecording();
  };

  ensureCameraPreview();
}

/* ======================= CONTROLS ======================= */
function togglePlayPause() {
  const token = state.sessionToken;
  if (!state.active || !isTokenLive(token)) return;
  if (!currentAudio.src) return;

  if (currentAudio.paused) {
    currentAudio.play().then(() => resumePreviewTimer(token)).catch(() => {});
  } else {
    currentAudio.pause();
    pausePreviewTimer();
  }
}

async function playNextManual() {
  const token = state.sessionToken;
  if (!state.active || !isTokenLive(token)) return;
  clearPreviewTimer();
  try { currentAudio.pause(); } catch {}
  await playNextFromQueue(token);
}

async function playPreviousManual() {
  const token = state.sessionToken;
  if (!state.active || !isTokenLive(token)) return;
  if (state.isSwitching) return;
  if (state.history.length === 0) return;

  clearPreviewTimer();
  try { currentAudio.pause(); } catch {}

  const prev = state.history.pop();
  if (!prev) return;

  state.nowPlaying = prev;
  setNowPlayingText();
  renderPlaylist();
  updateBackBtn();

  await playTrack(prev, token);
}

/* ======================= SESSION UI ======================= */
function startSessionUI() {
  if (!currentUser) {
    openModal(
      "Login Required",
      `
        <div style="font-size:13px;margin-bottom:12px;text-align:center;">
          Please login or register to start a session.
        </div>

        <div style="display:flex;gap:10px;">
          <button id="goLoginNow" style="flex:1;">Login</button>
          <button id="goRegisterNow" style="flex:1;">Register</button>
        </div>
      `
    );

    document.getElementById("goLoginNow").onclick = () => openAuthModal("login");
    document.getElementById("goRegisterNow").onclick = () => openAuthModal("register");
    return;
  }

  bumpSessionToken();
  state.active = false;
  clearPreviewTimer();
  hardStopAudio();
  stopStream();
  state.isSwitching = false;

  setStatus(`Session started. Choose Text / Voice / Video. • ${apiConfig.sourceLabel}`);
  state.nowPlaying = null;
  setNowPlayingText();
  setProgress(0);
  setProgressVisible(true);

  state.queue = [];
  state.playlist = [];
  state.playedUrls = new Set();
  state.playedTrackKeys = new Set();
  state.history = [];
  state.progress = 0;
  state.playedCount = 0;
  state.playedSinceAsk = 0;
  state.songStyle.varietyBoost = 0;
  state.songStyle.genres = [];

  renderPlaylist();
  updateBackBtn();

  document.getElementById("startSessionBtn").disabled = true;
  document.getElementById("stopSessionBtn").disabled = false;
  document.getElementById("textBtn").disabled = false;
  document.getElementById("voiceBtn").disabled = false;
  document.getElementById("videoBtn").disabled = false;

  document.getElementById("backBtn").disabled = true;
  document.getElementById("playPauseBtn").disabled = false;
  document.getElementById("nextBtn").disabled = false;
}

function stopSessionUI() {
  bumpSessionToken();
  state.active = false;

  clearPreviewTimer();
  hardStopAudio();
  stopStream();

  state.queue = [];
  state.playlist = [];
  state.playedUrls = new Set();
  state.playedTrackKeys = new Set();
  state.history = [];
  state.nowPlaying = null;
  state.progress = 0;
  state.playedCount = 0;
  state.playedSinceAsk = 0;
  state.isSwitching = false;

  setNowPlayingText();
  renderPlaylist();
  setProgress(0);
  setProgressVisible(false);

  document.getElementById("startSessionBtn").disabled = false;
  document.getElementById("stopSessionBtn").disabled = true;

  document.getElementById("textBtn").disabled = true;
  document.getElementById("voiceBtn").disabled = true;
  document.getElementById("videoBtn").disabled = true;

  document.getElementById("playPauseBtn").disabled = true;
  document.getElementById("nextBtn").disabled = true;
  document.getElementById("backBtn").disabled = true;

  setStatus(`Click Start Session to begin. • ${apiConfig.sourceLabel}`);
}

/* ======================= UI WIRING ======================= */
window.addEventListener("DOMContentLoaded", () => {
  document.getElementById("closeBtn").onclick = () => ipcRenderer.send("close-app");
  document.getElementById("settingsBtn").onclick = () => openSettingsModal();
  document.getElementById("modalClose").onclick = () => closeModal();

  document.getElementById("startSessionBtn").onclick = () => startSessionUI();
  document.getElementById("stopSessionBtn").onclick = () => stopSessionUI();

  document.getElementById("textBtn").onclick = () => openTextModal();
  document.getElementById("voiceBtn").onclick = () => openVoiceModal();
  document.getElementById("videoBtn").onclick = () => openVideoModal();

  document.getElementById("backBtn").onclick = () => playPreviousManual();
  document.getElementById("playPauseBtn").onclick = () => togglePlayPause();
  document.getElementById("nextBtn").onclick = () => playNextManual();

  document.getElementById("startSessionBtn").disabled = false;
  document.getElementById("stopSessionBtn").disabled = true;
  document.getElementById("textBtn").disabled = true;
  document.getElementById("voiceBtn").disabled = true;
  document.getElementById("videoBtn").disabled = true;
  document.getElementById("playPauseBtn").disabled = true;
  document.getElementById("nextBtn").disabled = true;
  document.getElementById("backBtn").disabled = true;

  setStatus(`Click Start Session to begin. • ${apiConfig.sourceLabel}`);
  setNowPlayingText();
  renderPlaylist();
  setProgress(0);
  setProgressVisible(false);

  resizeToWidget();
  setTimeout(resizeToWidget, 80);

  const savedUser = localStorage.getItem("user");
  if (savedUser) {
    currentUser = JSON.parse(savedUser);
    setStatus(`Welcome back ${currentUser.username}!`);
    loadPastTransitions();
  }

  document.getElementById("logoutBtn").onclick = () => {
    localStorage.removeItem("user");
    currentUser = null;

    const row = document.getElementById("pastRow");
    if (row) row.innerHTML = "";

    stopSessionUI();
    openAuthModal();
  };
});