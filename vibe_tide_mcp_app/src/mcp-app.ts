import {
  App,
  applyDocumentTheme,
  applyHostFonts,
  applyHostStyleVariables,
  type McpUiHostContext,
} from "@modelcontextprotocol/ext-apps";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import "./styles.css";

type LevelData = {
  tiles: number[][];
  width: number;
  height: number;
  name?: string;
  description?: string;
  maxEnemies?: number;
  enemySpawnChance?: number;
  coinSpawnChance?: number;
  encodedLevel?: string;
};

type TileDef = {
  id: number;
  name: string;
  label: string;
  color: string;
  border?: string;
};

const TILE_DEFS: TileDef[] = [
  { id: 0, name: "Empty", label: "", color: "#1a2a35", border: "#0d1a24" },
  { id: 1, name: "Grass", label: "G", color: "#22c55e" },
  { id: 2, name: "Rock", label: "R", color: "#64748b" },
  { id: 3, name: "Yellow", label: "Y", color: "#eab308" },
  { id: 4, name: "Ice", label: "I", color: "#06b6d4" },
  { id: 5, name: "Fire", label: "F", color: "#ef4444" },
  { id: 6, name: "Spikes", label: "S", color: "#a855f7" },
  { id: 7, name: "Water", label: "W", color: "#3b82f6" },
];

// Auto-detect game server port
let PLAYER_BASE_URL = "http://localhost:3001";
let gameServerReady: Promise<string>;

async function findGameServerPort(): Promise<string> {
  for (let port = 3001; port <= 3010; port++) {
    try {
      const response = await fetch(`http://localhost:${port}/index.html`, {
        method: "GET",
        signal: AbortSignal.timeout(1000)
      });
      if (response.ok) {
        return `http://localhost:${port}`;
      }
    } catch {
      // Port not available, try next
    }
  }
  return "http://localhost:3001"; // fallback
}

// Initialize on load - store promise so functions can await it
gameServerReady = findGameServerPort().then((url) => {
  PLAYER_BASE_URL = url;
  console.log(`[MCP App] Game server detected at: ${url}`);
  return url;
});

const app = new App({ name: "Vibe Tide Editor", version: "0.1.2" });

// DOM Elements
const appRoot = document.getElementById("app-root") as HTMLElement;
const paletteEl = document.getElementById("palette") as HTMLDivElement;

// Tab elements
const tabNav = document.getElementById("tab-nav") as HTMLElement;
const tabEditBtn = document.getElementById("tab-edit") as HTMLButtonElement;
const tabPlayBtn = document.getElementById("tab-play") as HTMLButtonElement;
const tabIndicator = document.getElementById("tab-indicator") as HTMLDivElement;
const panelEdit = document.getElementById("panel-edit") as HTMLDivElement;
const panelPlay = document.getElementById("panel-play") as HTMLDivElement;
const playerOverlay = document.getElementById("player-overlay") as HTMLDivElement;
const canvasSizeEl = document.getElementById("canvas-size") as HTMLElement;

// Editor elements
const gridEl = document.getElementById("edit-grid") as HTMLDivElement;
const levelWidthInput = document.getElementById("level-width") as HTMLInputElement;
const levelHeightInput = document.getElementById("level-height") as HTMLInputElement;
const resizeBtn = document.getElementById("resize-btn") as HTMLButtonElement;
const newLevelBtn = document.getElementById("new-level-btn") as HTMLButtonElement;
const encodedInput = document.getElementById("encoded-input") as HTMLInputElement;
const loadEncodedBtn = document.getElementById("load-encoded-btn") as HTMLButtonElement;
const copyEncodedBtn = document.getElementById("copy-encoded-btn") as HTMLButtonElement;
const sendModelBtn = document.getElementById("send-model-btn") as HTMLButtonElement;
const playBtn = document.getElementById("play-btn") as HTMLButtonElement;
const openTabBtn = document.getElementById("open-new-tab-btn") as HTMLButtonElement;
const unityFrame = document.getElementById("unity-frame") as HTMLIFrameElement;
const encodedPreview = document.getElementById("encoded-preview") as HTMLElement;
const statusText = document.getElementById("status-text") as HTMLElement;
const levelNameInput = document.getElementById("level-name") as HTMLInputElement;
const levelDescriptionInput = document.getElementById("level-description") as HTMLInputElement;
const maxEnemiesInput = document.getElementById("max-enemies") as HTMLInputElement;
const enemySpawnInput = document.getElementById("enemy-spawn") as HTMLInputElement;
const coinSpawnInput = document.getElementById("coin-spawn") as HTMLInputElement;
const loadingOverlay = document.getElementById("loading-overlay") as HTMLDivElement;

let selectedTile = TILE_DEFS[1];
let painting = false;
let activeTab: "edit" | "play" = "edit";

let currentLevel: LevelData = createEmptyLevel(50, 22);

// Tab switching functions
function switchTab(tab: "edit" | "play") {
  if (tab === activeTab) return;

  activeTab = tab;

  // Update tab buttons
  tabEditBtn.classList.toggle("active", tab === "edit");
  tabPlayBtn.classList.toggle("active", tab === "play");

  // Update tab indicator
  tabIndicator.classList.toggle("play-active", tab === "play");

  // Update panels
  panelEdit.classList.toggle("active", tab === "edit");
  panelPlay.classList.toggle("active", tab === "play");

  // Auto-load level when switching to play tab
  if (tab === "play") {
    syncLevelFromInputs();
    refreshEncoded();
    updatePlayerFrame();
  } else {
    statusText.textContent = "Editing";
  }
}

function updateCanvasSize() {
  if (canvasSizeEl) {
    canvasSizeEl.textContent = `${currentLevel.width} × ${currentLevel.height}`;
  }
}

class LevelEncoder {
  private tileChars: Record<number, string> = {
    0: ".",
    1: "G",
    2: "R",
    3: "Y",
    4: "I",
    5: "F",
    6: "S",
    7: "W",
  };
  private charTiles: Record<string, number> = {
    ".": 0,
    G: 1,
    R: 2,
    Y: 3,
    I: 4,
    F: 5,
    S: 6,
    W: 7,
  };

  encode(level: LevelData): string {
    const { tiles } = level;
    const height = tiles.length;
    const width = tiles[0]?.length ?? 0;
    let tileString = "";
    for (const row of tiles) {
      for (const tile of row) {
        tileString += this.tileChars[tile] ?? ".";
      }
    }
    tileString = this.runLengthEncode(tileString);
    let encoded = `${width}x${height}:${tileString}`;
    const params: Record<string, number> = {};
    if (Number.isFinite(level.maxEnemies)) params.maxEnemies = level.maxEnemies as number;
    if (Number.isFinite(level.enemySpawnChance)) params.enemySpawnChance = level.enemySpawnChance as number;
    if (Number.isFinite(level.coinSpawnChance)) params.coinSpawnChance = level.coinSpawnChance as number;
    if (Object.keys(params).length > 0) {
      encoded += `|${this.base64urlEncode(JSON.stringify(params))}`;
    }
    return this.base64urlEncode(encoded);
  }

  decode(encodedLevel: string): LevelData {
    const decoded = this.base64urlDecode(encodedLevel);
    let mainData = decoded;
    let params: Record<string, number> = {};
    if (decoded.includes("|")) {
      const [levelData, paramsData] = decoded.split("|");
      mainData = levelData;
      try {
        params = JSON.parse(this.base64urlDecode(paramsData));
      } catch {
        params = {};
      }
    }
    const [dimensions, tileData] = mainData.split(":");
    if (!dimensions || !tileData) {
      throw new Error("Invalid encoded level");
    }
    const [widthStr, heightStr] = dimensions.split("x");
    const width = Number(widthStr);
    const height = Number(heightStr);
    const tileString = this.runLengthDecode(tileData);
    const tiles: number[][] = [];
    let index = 0;
    for (let y = 0; y < height; y += 1) {
      const row: number[] = [];
      for (let x = 0; x < width; x += 1) {
        const char = tileString[index] ?? ".";
        row.push(this.charTiles[char] ?? 0);
        index += 1;
      }
      tiles.push(row);
    }
    return {
      tiles,
      width,
      height,
      maxEnemies: params.maxEnemies,
      enemySpawnChance: params.enemySpawnChance,
      coinSpawnChance: params.coinSpawnChance,
      encodedLevel,
    };
  }

  private runLengthEncode(input: string): string {
    if (!input) return input;
    let result = "";
    let count = 1;
    let current = input[0];
    for (let i = 1; i < input.length; i += 1) {
      if (input[i] === current && current === ".") {
        count += 1;
      } else {
        if (current === "." && count > 2) {
          result += `.${count}`;
        } else {
          result += current.repeat(count);
        }
        current = input[i];
        count = 1;
      }
    }
    if (current === "." && count > 2) {
      result += `.${count}`;
    } else {
      result += current.repeat(count);
    }
    return result;
  }

  private runLengthDecode(input: string): string {
    let result = "";
    let i = 0;
    while (i < input.length) {
      const char = input[i];
      if (char === "." && i + 1 < input.length && /\d/.test(input[i + 1])) {
        let numStr = "";
        let j = i + 1;
        while (j < input.length && /\d/.test(input[j])) {
          numStr += input[j];
          j += 1;
        }
        const count = Number(numStr);
        result += ".".repeat(count);
        i = j;
      } else {
        result += char;
        i += 1;
      }
    }
    return result;
  }

  private base64urlEncode(input: string): string {
    const encoded = btoa(input);
    return encoded.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  }

  private base64urlDecode(input: string): string {
    const padded = input + "=".repeat((4 - (input.length % 4)) % 4);
    const base64 = padded.replace(/-/g, "+").replace(/_/g, "/");
    return atob(base64);
  }
}

const levelEncoder = new LevelEncoder();

function createEmptyLevel(width: number, height: number): LevelData {
  const tiles = Array.from({ length: height }, () => Array.from({ length: width }, () => 0));
  return { tiles, width, height, name: "Untitled Level", description: "" };
}

function updateHostContext(ctx: McpUiHostContext) {
  if (ctx.theme) {
    applyDocumentTheme(ctx.theme);
  }
  if (ctx.styles?.variables) {
    applyHostStyleVariables(ctx.styles.variables);
  }
  if (ctx.styles?.css?.fonts) {
    applyHostFonts(ctx.styles.css.fonts);
  }
  if (ctx.safeAreaInsets) {
    const { top, right, bottom, left } = ctx.safeAreaInsets;
    appRoot.style.padding = `${top}px ${right}px ${bottom}px ${left}px`;
  }
}

function buildPalette() {
  paletteEl.innerHTML = "";
  for (const tile of TILE_DEFS) {
    const button = document.createElement("button");
    button.className = "palette-tile";
    button.dataset.tile = tile.id.toString();
    button.innerHTML = `
      <span class="tile-swatch" style="background:${tile.color};${
        tile.border ? `border-color:${tile.border};` : ""
      }">
        ${tile.label}
      </span>
      <span>${tile.name}</span>
    `;
    button.addEventListener("click", () => selectTile(tile.id));
    paletteEl.appendChild(button);
  }
  updatePaletteSelection();
}

function updatePaletteSelection() {
  const buttons = paletteEl.querySelectorAll<HTMLButtonElement>(".palette-tile");
  buttons.forEach((button) => {
    const tileId = Number(button.dataset.tile);
    button.classList.toggle("selected", tileId === selectedTile.id);
  });
}

function selectTile(tileId: number) {
  const tile = TILE_DEFS.find((item) => item.id === tileId) ?? TILE_DEFS[0];
  selectedTile = tile;
  updatePaletteSelection();
}

function renderGrid() {
  gridEl.innerHTML = "";
  const fragment = document.createDocumentFragment();
  currentLevel.tiles.forEach((row, y) => {
    const rowEl = document.createElement("div");
    rowEl.className = "tile-row";
    row.forEach((tileId, x) => {
      const tileEl = document.createElement("div");
      tileEl.className = "tile";
      tileEl.dataset.row = y.toString();
      tileEl.dataset.col = x.toString();
      applyTileStyle(tileEl, tileId);
      rowEl.appendChild(tileEl);
    });
    fragment.appendChild(rowEl);
  });
  gridEl.appendChild(fragment);
}

function applyTileStyle(tileEl: HTMLElement, tileId: number) {
  const def = TILE_DEFS.find((item) => item.id === tileId) ?? TILE_DEFS[0];
  tileEl.textContent = def.label;
  tileEl.style.background = def.color;
  tileEl.style.borderColor = def.border ?? "transparent";
  tileEl.style.color = tileId === 3 ? "#2d2d2d" : "#ffffff";
}

function paintTile(tileEl: HTMLElement) {
  const row = Number(tileEl.dataset.row);
  const col = Number(tileEl.dataset.col);
  if (!Number.isFinite(row) || !Number.isFinite(col)) return;
  currentLevel.tiles[row][col] = selectedTile.id;
  applyTileStyle(tileEl, selectedTile.id);
  refreshEncoded();
}

function refreshEncoded() {
  const encoded = levelEncoder.encode(currentLevel);
  currentLevel.encodedLevel = encoded;
  encodedPreview.textContent = encoded.length > 0 ? encoded : "(empty)";
}

function syncInputsFromLevel() {
  levelWidthInput.value = currentLevel.width.toString();
  levelHeightInput.value = currentLevel.height.toString();
  levelNameInput.value = currentLevel.name ?? "";
  levelDescriptionInput.value = currentLevel.description ?? "";
  maxEnemiesInput.value = (currentLevel.maxEnemies ?? 5).toString();
  enemySpawnInput.value = (currentLevel.enemySpawnChance ?? 10).toString();
  coinSpawnInput.value = (currentLevel.coinSpawnChance ?? 15).toString();
  updateCanvasSize();
  refreshEncoded();
}

function syncLevelFromInputs() {
  currentLevel.name = levelNameInput.value.trim() || "Untitled Level";
  currentLevel.description = levelDescriptionInput.value.trim();
  currentLevel.maxEnemies = Number(maxEnemiesInput.value);
  currentLevel.enemySpawnChance = Number(enemySpawnInput.value);
  currentLevel.coinSpawnChance = Number(coinSpawnInput.value);
}

function resizeLevel(width: number, height: number) {
  const newTiles = Array.from({ length: height }, (_, y) =>
    Array.from({ length: width }, (_, x) => currentLevel.tiles[y]?.[x] ?? 0),
  );
  currentLevel = {
    ...currentLevel,
    width,
    height,
    tiles: newTiles,
  };
  renderGrid();
  syncInputsFromLevel();
}

function loadLevel(level: LevelData) {
  currentLevel = {
    ...level,
    width: level.width ?? level.tiles[0]?.length ?? 0,
    height: level.height ?? level.tiles.length,
  };
  renderGrid();
  syncInputsFromLevel();
  statusText.textContent = "Loaded";
  // Update model context with new level info
  updateModelContextWithLevel();
}

function loadEncoded(encoded: string) {
  try {
    const decoded = levelEncoder.decode(encoded);
    decoded.name = currentLevel.name ?? decoded.name;
    decoded.description = currentLevel.description ?? "";
    loadLevel(decoded);
    statusText.textContent = "Decoded";
  } catch (error) {
    console.error(error);
    statusText.textContent = "Invalid encoded level";
  }
}

// Cache for the blob URL so we can revoke it
let currentBlobUrl: string | null = null;

async function updatePlayerFrame() {
  if (!currentLevel.encodedLevel) {
    refreshEncoded();
  }
  const encoded = currentLevel.encodedLevel ?? "";
  if (encoded.length === 0) {
    statusText.textContent = "Missing encoded level";
    return;
  }

  statusText.textContent = "Loading game...";

  try {
    // Ensure game server port is detected
    await gameServerReady;

    // Fetch the Unity game HTML
    const response = await fetch(`${PLAYER_BASE_URL}/index.html`);
    if (!response.ok) {
      throw new Error(`Failed to fetch game: ${response.status}`);
    }
    let html = await response.text();

    // Rewrite all relative URLs to absolute (can't use <base> due to CSP base-uri restriction)
    // Rewrite href="..." and src="..." attributes
    html = html.replace(
      /(href|src)="(?!https?:\/\/|data:|blob:|#)([^"]+)"/g,
      `$1="${PLAYER_BASE_URL}/$2"`
    );
    // Also rewrite url() in inline styles
    html = html.replace(
      /url\(["']?(?!https?:\/\/|data:|blob:)([^"')]+)["']?\)/g,
      `url("${PLAYER_BASE_URL}/$1")`
    );
    // Rewrite the JavaScript buildUrl and other path references
    html = html.replace(
      /var buildUrl = "Build"/,
      `var buildUrl = "${PLAYER_BASE_URL}/Build"`
    );
    html = html.replace(
      /streamingAssetsUrl: "StreamingAssets"/,
      `streamingAssetsUrl: "${PLAYER_BASE_URL}/StreamingAssets"`
    );
    // Replace alert() with console.error() since sandbox blocks modals
    html = html.replace(/\balert\s*\(/g, `console.error("[Unity]", `);

    // Inject stubs for blocked APIs and the level data
    const injectedScript = `
      // Injected by MCP App for blob URL mode
      window.VIBE_TIDE_LEVEL = "${encoded}";

      // Stub navigator.getGamepads to prevent SecurityError spam (use try/catch for strict mode)
      try {
        Object.defineProperty(navigator, 'getGamepads', {
          value: function() { return []; },
          writable: true,
          configurable: true
        });
      } catch(e) {
        try { navigator.getGamepads = function() { return []; }; } catch(e2) {}
      }

      // Also suppress window.alert in case our regex missed any
      window.alert = function() { console.error('[Unity Alert]', arguments[0]); };

      // Override URLSearchParams to return our level data (since blob URLs have no query string)
      var OriginalURLSearchParams = URLSearchParams;
      window.URLSearchParams = function(init) {
        var params = new OriginalURLSearchParams(init);
        var originalGet = params.get.bind(params);
        params.get = function(name) {
          if (name === 'level') {
            return window.VIBE_TIDE_LEVEL || originalGet(name);
          }
          return originalGet(name);
        };
        return params;
      };

      // Decode base64url to get tiles array
      function base64urlDecode(str) {
        var base64 = str.replace(/-/g, '+').replace(/_/g, '/');
        while (base64.length % 4) base64 += '=';
        return atob(base64);
      }

      // Convert tile character to tile type number (matches C# CharToTile)
      function charToTile(c) {
        switch(c) {
          case '.': return 0; // Empty
          case 'G': return 1; // Grass
          case 'R': return 2; // Rock
          case 'Y': return 3; // Yellow
          case 'I': return 4; // Ice
          case 'F': return 5; // Fire/Red
          case 'S': return 6; // Spikes
          case 'W': return 7; // Water
          default: return 0;
        }
      }

      // Run-length decode (matches C# RunLengthDecode)
      function runLengthDecode(input) {
        var result = '';
        var i = 0;
        while (i < input.length) {
          var c = input[i];
          if (c === '.' && i + 1 < input.length && /[0-9]/.test(input[i + 1])) {
            var numStr = '';
            var j = i + 1;
            while (j < input.length && /[0-9]/.test(input[j])) {
              numStr += input[j];
              j++;
            }
            var count = parseInt(numStr) || 0;
            for (var k = 0; k < count; k++) result += '.';
            i = j;
          } else {
            result += c;
            i++;
          }
        }
        return result;
      }

      // Decode level and return tiles + game params
      function decodeFullLevel(encodedLevel) {
        var result = { tiles: null, maxEnemies: 5, enemySpawnChance: 10, coinSpawnChance: 15 };
        try {
          var decoded = base64urlDecode(encodedLevel);
          console.log('[Vibe Tide] Base64 decoded:', decoded.substring(0, 100) + '...');
          var mainData = decoded;

          // Extract game parameters if present (after |)
          if (decoded.includes('|')) {
            var parts = decoded.split('|');
            mainData = parts[0];
            try {
              var paramsJson = base64urlDecode(parts[1]);
              console.log('[Vibe Tide] Game params JSON:', paramsJson);
              var params = JSON.parse(paramsJson);
              if (params.maxEnemies !== undefined) result.maxEnemies = params.maxEnemies;
              if (params.enemySpawnChance !== undefined) result.enemySpawnChance = params.enemySpawnChance;
              if (params.coinSpawnChance !== undefined) result.coinSpawnChance = params.coinSpawnChance;
            } catch (pe) {
              console.warn('[Vibe Tide] Failed to parse params:', pe);
            }
          }

          var match = mainData.match(/^([0-9]+)x([0-9]+):(.*)$/);
          if (!match) {
            console.error('[Vibe Tide] Failed to match format, mainData:', mainData.substring(0, 50));
            return result;
          }
          var width = parseInt(match[1]);
          var height = parseInt(match[2]);
          var tileData = match[3];
          // Decode run-length encoding
          var tileString = runLengthDecode(tileData);
          console.log('[Vibe Tide] Dimensions:', width, 'x', height, ', tileString length:', tileString.length);
          var tiles = [];
          var idx = 0;
          for (var y = 0; y < height; y++) {
            var row = [];
            for (var x = 0; x < width; x++) {
              var c = idx < tileString.length ? tileString[idx] : '.';
              row.push(charToTile(c));
              idx++;
            }
            tiles.push(row);
          }
          console.log('[Vibe Tide] First row sample:', tiles[0] ? tiles[0].slice(0, 10) : 'empty');
          result.tiles = tiles;
          console.log('[Vibe Tide] Game params: maxEnemies=' + result.maxEnemies + ', enemySpawn=' + result.enemySpawnChance + ', coinSpawn=' + result.coinSpawnChance);
          return result;
        } catch (e) {
          console.error('[Vibe Tide] Failed to decode level:', e);
          return result;
        }
      }

      // Helper function to build mock level response
      function buildMockLevelResponse() {
        var levelData = decodeFullLevel(window.VIBE_TIDE_LEVEL);
        console.log('[Vibe Tide] Decoded tiles:', levelData.tiles ? levelData.tiles.length + ' rows' : 'null');

        // Ensure params have valid values (never 0 for maxEnemies)
        var maxEnemies = Math.max(1, parseInt(levelData.maxEnemies) || 5);
        var enemySpawnChance = parseFloat(levelData.enemySpawnChance) || 10.0;
        var coinSpawnChance = parseFloat(levelData.coinSpawnChance) || 0.15;

        console.log('[Vibe Tide] FINAL params being sent to Unity:');
        console.log('  maxEnemies:', maxEnemies, '(type:', typeof maxEnemies, ')');
        console.log('  enemySpawnChance:', enemySpawnChance, '(type:', typeof enemySpawnChance, ')');
        console.log('  coinSpawnChance:', coinSpawnChance, '(type:', typeof coinSpawnChance, ')');

        // Build response matching exact Lambda structure
        var responseBody = {
          level: {
            'level-id': 'embedded-level',
            'name': 'Embedded Level',
            'encoded_level': window.VIBE_TIDE_LEVEL,
            'tiles': levelData.tiles,
            'width': levelData.tiles && levelData.tiles[0] ? levelData.tiles[0].length : 30,
            'height': levelData.tiles ? levelData.tiles.length : 30,
            'maxEnemies': maxEnemies,
            'enemySpawnChance': enemySpawnChance,
            'coinSpawnChance': coinSpawnChance
          }
        };

        console.log('[Vibe Tide] Full response body:', JSON.stringify(responseBody).substring(0, 500));
        return JSON.stringify(responseBody);
      }

      // Intercept XMLHttpRequest (used by Unity WebGL's UnityWebRequest)
      var OriginalXHR = window.XMLHttpRequest;
      window.XMLHttpRequest = function() {
        var xhr = new OriginalXHR();
        var originalOpen = xhr.open;
        var originalSend = xhr.send;
        var interceptUrl = null;

        xhr.open = function(method, url) {
          var urlStr = typeof url === 'string' ? url : url.toString();
          if (urlStr.includes('vibe-get-level') || urlStr.includes('execute-api')) {
            console.log('[Vibe Tide] XHR intercepting:', urlStr);
            interceptUrl = urlStr;
          }
          return originalOpen.apply(this, arguments);
        };

        xhr.send = function(data) {
          if (interceptUrl) {
            console.log('[Vibe Tide] XHR returning mock response for:', interceptUrl);
            var self = this;
            // Simulate async response
            setTimeout(function() {
              Object.defineProperty(self, 'readyState', { writable: true, value: 4 });
              Object.defineProperty(self, 'status', { writable: true, value: 200 });
              Object.defineProperty(self, 'statusText', { writable: true, value: 'OK' });
              Object.defineProperty(self, 'responseText', { writable: true, value: buildMockLevelResponse() });
              Object.defineProperty(self, 'response', { writable: true, value: buildMockLevelResponse() });
              if (self.onreadystatechange) self.onreadystatechange();
              if (self.onload) self.onload();
            }, 10);
            return;
          }
          return originalSend.apply(this, arguments);
        };

        return xhr;
      };
      // Preserve prototype chain for instanceof checks
      window.XMLHttpRequest.prototype = OriginalXHR.prototype;

      // Also intercept fetch calls (for completeness)
      var originalFetch = window.fetch;
      window.fetch = function(url, options) {
        var urlStr = typeof url === 'string' ? url : url.toString();
        if (urlStr.includes('vibe-get-level') || urlStr.includes('execute-api')) {
          console.log('[Vibe Tide] Fetch intercepting API call, returning injected level');
          return Promise.resolve(new Response(buildMockLevelResponse(), {
            status: 200,
            headers: { 'Content-Type': 'application/json' }
          }));
        }
        return originalFetch.apply(this, arguments);
      };
    `;
    // Inject our script right after the opening <script> tag (before Unity code runs)
    html = html.replace(
      /<script>\s*window\.addEventListener/,
      `<script>\n${injectedScript}\n      window.addEventListener`
    );

    // Revoke previous blob URL to free memory
    if (currentBlobUrl) {
      URL.revokeObjectURL(currentBlobUrl);
    }

    // Create blob and set as iframe src
    const blob = new Blob([html], { type: "text/html" });
    currentBlobUrl = URL.createObjectURL(blob);

    console.log("[MCP App] Loading blob URL for game");
    unityFrame.src = currentBlobUrl;

    // Add load/error handlers for debugging
    unityFrame.onload = () => {
      console.log("[MCP App] Blob iframe loaded successfully");
      statusText.textContent = "Playing";
    };
    unityFrame.onerror = (e) => console.error("[MCP App] Iframe error:", e);

    // Hide the overlay when playing
    if (playerOverlay) {
      playerOverlay.classList.add("hidden");
    }
  } catch (error) {
    console.error("[MCP App] Failed to load game:", error);
    statusText.textContent = "Failed to load game";
    // Fallback: try direct URL (will fail due to CSP, but shows the attempt)
    const url = `${PLAYER_BASE_URL}?level=${encodeURIComponent(encoded)}`;
    unityFrame.src = url;
  }
}

async function sendLevelToModel() {
  syncLevelFromInputs();
  refreshEncoded();
  const payload = {
    name: currentLevel.name,
    description: currentLevel.description,
    width: currentLevel.width,
    height: currentLevel.height,
    tiles: currentLevel.tiles,
    encodedLevel: currentLevel.encodedLevel,
    maxEnemies: currentLevel.maxEnemies,
    enemySpawnChance: currentLevel.enemySpawnChance,
    coinSpawnChance: currentLevel.coinSpawnChance,
  };
  await app.sendMessage({
    role: "user",
    content: [{ type: "text", text: JSON.stringify(payload) }],
  });
  statusText.textContent = "Sent to model";
}

gridEl.addEventListener("pointerdown", (event) => {
  const target = event.target as HTMLElement;
  if (!target.classList.contains("tile")) return;
  painting = true;
  paintTile(target);
});

gridEl.addEventListener("pointerover", (event) => {
  if (!painting) return;
  const target = event.target as HTMLElement;
  if (!target.classList.contains("tile")) return;
  paintTile(target);
});

window.addEventListener("pointerup", () => {
  painting = false;
});

resizeBtn.addEventListener("click", () => {
  const width = Number(levelWidthInput.value);
  const height = Number(levelHeightInput.value);
  if (width >= 10 && height >= 10) {
    resizeLevel(width, height);
  }
});

newLevelBtn.addEventListener("click", () => {
  currentLevel = createEmptyLevel(50, 22);
  renderGrid();
  syncInputsFromLevel();
  statusText.textContent = "New level";
});

loadEncodedBtn.addEventListener("click", () => {
  const encoded = encodedInput.value.trim();
  if (encoded.length > 0) {
    loadEncoded(encoded);
  }
});

copyEncodedBtn.addEventListener("click", async () => {
  refreshEncoded();
  if (currentLevel.encodedLevel) {
    await navigator.clipboard.writeText(currentLevel.encodedLevel);
    statusText.textContent = "Copied encoded level";
  }
});

sendModelBtn.addEventListener("click", () => {
  sendLevelToModel().catch(console.error);
});

playBtn.addEventListener("click", () => {
  syncLevelFromInputs();
  refreshEncoded();
  updatePlayerFrame();
});

openTabBtn.addEventListener("click", async () => {
  await gameServerReady;
  refreshEncoded();
  const encoded = currentLevel.encodedLevel ?? "";
  if (encoded.length === 0) return;
  const url = `${PLAYER_BASE_URL}?level=${encodeURIComponent(encoded)}`;
  app.openLink({ url }).catch(console.error);
});

levelNameInput.addEventListener("change", () => {
  syncLevelFromInputs();
  refreshEncoded();
});
levelDescriptionInput.addEventListener("change", () => {
  syncLevelFromInputs();
  refreshEncoded();
});
maxEnemiesInput.addEventListener("change", () => {
  syncLevelFromInputs();
  refreshEncoded();
});
enemySpawnInput.addEventListener("change", () => {
  syncLevelFromInputs();
  refreshEncoded();
});
coinSpawnInput.addEventListener("change", () => {
  syncLevelFromInputs();
  refreshEncoded();
});

function showLoading(message = "Generating level...") {
  const loadingText = loadingOverlay.querySelector("p");
  if (loadingText) loadingText.textContent = message;
  loadingOverlay.classList.add("active");
  statusText.textContent = "Processing";
}

function hideLoading() {
  loadingOverlay.classList.remove("active");
  statusText.textContent = "Ready";
}

// Show loading as soon as streaming starts (partial input)
app.ontoolinputpartial = (params) => {
  console.log("[MCP App] ontoolinputpartial called:", params.name);
  const toolName = params.name ?? "";
  let loadingMessage = "Generating...";
  if (toolName.includes("create")) {
    loadingMessage = "Generating level...";
  } else if (toolName.includes("edit")) {
    loadingMessage = "Updating level...";
  }
  showLoading(loadingMessage);
};

app.ontoolinput = (params) => {
  console.log("[MCP App] ontoolinput called:", params.name);
  // Show context-aware loading message based on tool name
  const toolName = params.name ?? "";
  let loadingMessage = "Processing...";
  if (toolName.includes("create")) {
    loadingMessage = "Generating level...";
  } else if (toolName.includes("edit_entire")) {
    loadingMessage = "Updating level...";
  } else if (toolName.includes("edit_level_row")) {
    loadingMessage = "Editing row...";
  } else if (toolName.includes("edit_level_tile")) {
    loadingMessage = "Editing tile...";
  } else if (toolName.includes("edit_level_metadata")) {
    loadingMessage = "Updating metadata...";
  } else if (toolName.includes("encode") || toolName.includes("decode")) {
    loadingMessage = "Processing level data...";
  }
  showLoading(loadingMessage);

  const args = params.arguments as Partial<LevelData> & {
    encoded_level?: string;
    level_name?: string;
    enemy_spawn_chance?: number;
    coin_spawn_chance?: number;
    max_enemies?: number;
  };
  if (!args) return;

  const encoded = args.encodedLevel ?? args.encoded_level;
  if (encoded && !args.tiles) {
    loadEncoded(encoded);
    return;
  }
  if (args.tiles) {
    loadLevel({
      tiles: args.tiles,
      width: args.width ?? args.tiles[0]?.length ?? 0,
      height: args.height ?? args.tiles.length,
      name: args.name ?? args.level_name,
      description: args.description,
      maxEnemies: args.maxEnemies ?? args.max_enemies,
      enemySpawnChance: args.enemySpawnChance ?? args.enemy_spawn_chance,
      coinSpawnChance: args.coinSpawnChance ?? args.coin_spawn_chance,
      encodedLevel: encoded,
    });
  }
};

app.ontoolresult = (result: CallToolResult) => {
  console.log("[MCP App] ontoolresult called");
  hideLoading();
  const data = result.structuredContent as
    | (Partial<LevelData> & {
        level_data?: Partial<LevelData>;
        encoded_level?: string;
        level_name?: string;
        enemy_spawn_chance?: number;
        coin_spawn_chance?: number;
        max_enemies?: number;
      })
    | undefined;
  if (!data) return;

  const levelData = data.level_data ?? data;
  const encoded = levelData.encodedLevel ?? data.encoded_level ?? data.encodedLevel;

  if (encoded && !levelData.tiles) {
    loadEncoded(encoded);
    return;
  }

  if (levelData.tiles) {
    loadLevel({
      tiles: levelData.tiles,
      width: levelData.width ?? levelData.tiles[0]?.length ?? 0,
      height: levelData.height ?? levelData.tiles.length,
      name: levelData.name ?? data.level_name,
      description: levelData.description,
      maxEnemies: levelData.maxEnemies ?? data.max_enemies,
      enemySpawnChance: levelData.enemySpawnChance ?? data.enemy_spawn_chance,
      coinSpawnChance: levelData.coinSpawnChance ?? data.coin_spawn_chance,
      encodedLevel: encoded,
    });
  }
};

app.ontoolcancelled = (params) => {
  hideLoading();
  statusText.textContent = params.reason ?? "Cancelled";
};

app.onhostcontextchanged = updateHostContext;
app.onerror = console.error;

app.onteardown = async () => {
  unityFrame.src = "";
  return {};
};

buildPalette();
renderGrid();
syncInputsFromLevel();

// Update model context with current level state
// This helps the model understand what the user sees in the UI
function updateModelContextWithLevel() {
  const levelInfo = currentLevel.name ?? "Untitled Level";
  const dimensions = `${currentLevel.width}×${currentLevel.height}`;
  const tileCount = currentLevel.tiles.flat().filter((t) => t !== 0).length;
  const totalTiles = currentLevel.width * currentLevel.height;
  const fillPercentage = Math.round((tileCount / totalTiles) * 100);

  // Build a summary of tile distribution
  const tileDistribution: Record<string, number> = {};
  currentLevel.tiles.flat().forEach((t) => {
    const def = TILE_DEFS.find((d) => d.id === t);
    if (def && t !== 0) {
      tileDistribution[def.name] = (tileDistribution[def.name] ?? 0) + 1;
    }
  });

  const tileBreakdown = Object.entries(tileDistribution)
    .sort((a, b) => b[1] - a[1])
    .map(([name, count]) => `${name}: ${count}`)
    .join(", ");

  const contextText = `---
UI: Vibe Tide Level Editor
capabilities:
  - Users can view and edit the level visually in a grid editor
  - Users can play the level directly in the embedded Unity game (Play tab)
  - Users can manually paint tiles, resize levels, and adjust game parameters
  - NO external URLs needed - game runs inside the UI
---

Current Level: "${levelInfo}"
Dimensions: ${dimensions} (${fillPercentage}% filled)
Game params: maxEnemies=${currentLevel.maxEnemies ?? 5}, enemySpawn=${currentLevel.enemySpawnChance ?? 10}%, coinSpawn=${currentLevel.coinSpawnChance ?? 15}%
Tile breakdown: ${tileBreakdown || "Empty level"}
Encoded: ${currentLevel.encodedLevel ?? "(not encoded)"}

The user is viewing this level in the interactive editor. They can:
- Edit tiles by clicking/dragging on the grid
- Switch to Play tab to test the level immediately
- No need to provide URLs - the game is embedded in the UI`;

  app.updateModelContext({
    content: [{ type: "text", text: contextText }],
  }).catch(console.error);
}

app.connect().then(() => {
  const ctx = app.getHostContext();
  if (ctx) {
    updateHostContext(ctx);
  }
  // Send initial context to model about UI capabilities
  updateModelContextWithLevel();
});

// Tab switching - use event delegation on container for better click handling
tabNav.addEventListener("click", (e) => {
  const target = e.target as HTMLElement;
  const btn = target.closest(".tab-btn") as HTMLElement | null;
  if (btn) {
    const tab = btn.dataset.tab as "edit" | "play";
    if (tab) switchTab(tab);
  }
});

// Fullscreen toggles
// Initialize canvas size display
updateCanvasSize();
