const transitions = require("./db/transitions");
const {
  app,
  BrowserWindow,
  ipcMain,
  Tray,
  Menu,
  nativeImage,
  net, 
} = require("electron");

const path = require("path");
const fs = require("fs");
const os = require("os");
const { spawn } = require("child_process");

require("./db/database");
const auth = require("./db/auth");

let currentUser = null;
let win = null;
let tray = null;
let isQuitting = false;

// ================= WINDOW =================
function createWindow() {
  win = new BrowserWindow({
    width: 900,
    height: 560,
    minWidth: 900,
    minHeight: 560,

    frame: false,
    resizable: false,
    alwaysOnTop: true,
    show: false,
    transparent: true,
    backgroundColor: "#00000000",
    hasShadow: true,

    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
    },
  });

  win.loadFile("index.html");

  win.once("ready-to-show", () => {
    showWindow();
  });

  win.on("close", (e) => {
    if (!isQuitting) {
      e.preventDefault();
      win.hide();
    }
  });
}

// ================= TRAY =================
function getTrayIcon() {
  if (process.platform === "darwin") {
    const dataUrl =
      "data:image/png;base64," +
      "iVBORw0KGgoAAAANSUhEUgAAABYAAAAWCAQAAABuvaSwAAAAJ0lEQVR4AWP4z8Dwn4GJgYGBkYHhP4j4j4HhPwAA6e8F6lq1mKQAAAAASUVORK5CYII=";

    const img = nativeImage.createFromDataURL(dataUrl);
    img.setTemplateImage(true);
    return img;
  }

  const iconPath = path.join(__dirname, "assets", "tray.png");
  if (!fs.existsSync(iconPath)) return nativeImage.createEmpty();
  return nativeImage.createFromPath(iconPath);
}

function createTray() {
  tray = new Tray(getTrayIcon());

  if (process.platform === "darwin") tray.setTitle("🎧");
  tray.setToolTip("Mood Music Companion");

  const menu = Menu.buildFromTemplate([
    { label: "Open", click: showWindow },
    { type: "separator" },
    {
      label: "Quit",
      click: () => {
        isQuitting = true;
        app.quit();
      },
    },
  ]);

  tray.setContextMenu(menu);
  tray.on("click", toggleWindow);
}

function toggleWindow() {
  if (!win) return;
  if (win.isVisible()) win.hide();
  else showWindow();
}

// ================= POSITION WINDOW =================
function showWindow() {
  if (!win) return;

  if (tray) {
    const trayBounds = tray.getBounds();
    const windowBounds = win.getBounds();

    let x = Math.round(trayBounds.x + trayBounds.width / 2 - windowBounds.width / 2);

    let y =
      process.platform === "darwin"
        ? trayBounds.y + trayBounds.height + 6
        : trayBounds.y - windowBounds.height - 6;

    win.setPosition(x, y, false);
  } else {
    win.center();
  }

  win.show();
  win.focus();
}

// ================= APP =================
app.whenReady().then(() => {
  createWindow();
  createTray();
});

app.on("before-quit", () => {
  isQuitting = true;
});

app.on("activate", () => {
  if (win) showWindow();
});

// ================= IPC =================
ipcMain.on("close-app", () => {
  if (win) win.hide();
});

// ✅ renderer auto-resize
ipcMain.on("resize-window", (_e, { width, height }) => {
  if (!win) return;
  const w = Math.max(600, Math.min(1400, Number(width) || 900));
  const h = Math.max(360, Math.min(1000, Number(height) || 560));
  try {
    win.setSize(w, h, false);
  } catch {}
});

ipcMain.handle("http-request", async (_e, { url, method = "GET", headers = {}, timeoutMs = 4500 }) => {
  return new Promise((resolve) => {
    try {
      const request = net.request({ method: method || "GET", url });

      for (const [k, v] of Object.entries(headers || {})) {
        try {
          request.setHeader(k, v);
        } catch {}
      }

      const timer = setTimeout(() => {
        try { request.abort(); } catch {}
        resolve({ error: `Timeout after ${timeoutMs}ms` });
      }, Math.max(500, timeoutMs || 4500));

      request.on("response", (response) => {
        const chunks = [];
        response.on("data", (chunk) => chunks.push(chunk));
        response.on("end", () => {
          clearTimeout(timer);

          const body = Buffer.concat(chunks);
          const bodyBase64 = body.toString("base64");

          const resHeaders = {};
          try {
            for (const [k, v] of Object.entries(response.headers || {})) {
              resHeaders[k] = Array.isArray(v) ? v.join(", ") : String(v);
            }
          } catch {}

          resolve({
            ok: (response.statusCode || 0) >= 200 && (response.statusCode || 0) < 300,
            status: response.statusCode || 0,
            headers: resHeaders,
            bodyBase64,
          });
        });
      });

      request.on("error", (err) => {
        try { clearTimeout(timer); } catch {}
        resolve({ error: String(err?.message || err) });
      });

      request.end();
    } catch (e) {
      resolve({ error: String(e) });
    }
  });
});

// ================= AUTH =================
ipcMain.handle("register", async (_e, { username, password }) => {
  try {
    const user = auth.register(username, password);
    currentUser = user;
    return { success: true, user };
  } catch (err) {
    return { error: err.message };
  }
});

ipcMain.handle("login", async (_e, { username, password }) => {
  try {
    const user = auth.login(username, password);
    currentUser = user;
    return { success: true, user };
  } catch (err) {
    return { error: err.message };
  }
});

ipcMain.handle("get-current-user", () => currentUser);

// ================= TRANSITIONS =================
ipcMain.handle("save-transition", (_e, { currentMood, desiredMood }) => {
  if (!currentUser) return { error: "Not logged in" };

  try {
    const id = transitions.saveTransition(currentUser.id, currentMood, desiredMood);
    return { success: true, id };
  } catch (err) {
    return { error: err.message };
  }
});

ipcMain.handle("get-last-transitions", () => {
  if (!currentUser) return [];
  try {
    return transitions.getLastTransitions(currentUser.id);
  } catch {
    return [];
  }
});

ipcMain.handle("save-transition-tracks", (_e, { transitionId, tracks }) => {
  if (!currentUser) return { error: "Not logged in" };
  try {
    transitions.saveTransitionTracks(transitionId, tracks || []);
    return { success: true };
  } catch (err) {
    return { error: err.message };
  }
});

ipcMain.handle("get-transition-tracks", (_e, { transitionId }) => {
  if (!currentUser) return [];
  try {
    return transitions.getTransitionTracks(transitionId);
  } catch {
    return [];
  }
});

// ================= AI =================
function getPythonCommand() {
  if (app.isPackaged) {
    return path.join(
      process.resourcesPath,
      "app.asar.unpacked",
      ".venv",
      "bin",
      "python"
    );
  } else {
    return path.join(__dirname, ".venv", "bin", "python");
  }
}
function getPythonScriptPath() {
  if (app.isPackaged) {
    return path.join(
      process.resourcesPath,
      "app.asar.unpacked",
      "ai",
      "analyze_mood.py"
    );
  } else {
    return path.join(__dirname, "ai", "analyze_mood.py");
  }
}

function extractJsonFromStdout(out) {
  const s = String(out || "");
  const first = s.indexOf("{");
  const last = s.lastIndexOf("}");
  if (first === -1 || last === -1 || last <= first) return null;
  const candidate = s.slice(first, last + 1);
  return JSON.parse(candidate);
}

ipcMain.handle("analyze-mood", async (_event, { text, bytes, ext }) => {
  try {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mmc-"));
    let audioPath = "";

    if (bytes?.length) {
      audioPath = path.join(tmpDir, `input.${ext || "webm"}`);
      fs.writeFileSync(audioPath, Buffer.from(bytes));
    }

    const py = getPythonCommand();
    const script = getPythonScriptPath();

    const payload = JSON.stringify({
      text: text || "",
      audio: audioPath,
      frame: "",
    });

    const result = await new Promise((resolve) => {
      const p = spawn(py, [script, payload]);

      let stdout = "";
      let stderr = "";

      p.stdout.on("data", (d) => (stdout += d));
      p.stderr.on("data", (d) => {
        const s = String(d || "");
        if (s.includes("Device set to use mps")) return;
        stderr += s;
      });

      p.on("close", () => {
        try {
          const json = extractJsonFromStdout(stdout);
          if (json) return resolve(json);

          const msg = (stderr || stdout || "AI failed").toString();
          return resolve({ error: msg.slice(-500) });
        } catch (e) {
          const msg = (stderr || stdout || `AI failed: ${e}`).toString();
          return resolve({ error: msg.slice(-500) });
        }
      });

      p.on("error", (err) => {
        resolve({ error: String(err?.message || err) });
      });
    });

    try {
      fs.rmSync(tmpDir, { recursive: true });
    } catch {}

    return result;
  } catch (e) {
    return { error: String(e) };
  }
});