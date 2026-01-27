import { registerAppResource, registerAppTool, RESOURCE_MIME_TYPE } from "@modelcontextprotocol/ext-apps/server";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import type { CallToolResult, ReadResourceResult } from "@modelcontextprotocol/sdk/types.js";
import express from "express";
import { createServer as createHttpServer } from "node:http";
import fs from "node:fs/promises";
import path from "node:path";
import { z } from "zod/v4-mini";

const DIST_DIR = import.meta.filename.endsWith(".ts")
  ? path.join(import.meta.dirname, "dist")
  : import.meta.dirname;

type LevelPayload = {
  tiles?: number[][];
  width?: number;
  height?: number;
  name?: string;
  description?: string;
  encodedLevel?: string;
  encoded_level?: string;
  maxEnemies?: number;
  enemySpawnChance?: number;
  coinSpawnChance?: number;
};

const tileChars: Record<number, string> = {
  0: ".",
  1: "G",
  2: "R",
  3: "Y",
  4: "I",
  5: "F",
  6: "S",
  7: "W",
};

const charTiles: Record<string, number> = {
  ".": 0,
  G: 1,
  R: 2,
  Y: 3,
  I: 4,
  F: 5,
  S: 6,
  W: 7,
};

const tileTypes: Record<number, { name: string; symbol: string; description: string }> = {
  0: { name: "Empty", symbol: "⬜", description: "Walkable air space" },
  1: { name: "Grass", symbol: "🌱", description: "Standard ground platform" },
  2: { name: "Rock", symbol: "🗿", description: "Solid stone platform" },
  3: { name: "Yellow", symbol: "⭐", description: "Special yellow platform" },
  4: { name: "Ice", symbol: "❄️", description: "Slippery ice platform" },
  5: { name: "Red", symbol: "🔥", description: "Dangerous red platform" },
  6: { name: "Spikes", symbol: "⚠️", description: "Hazardous spikes" },
  7: { name: "Water", symbol: "💧", description: "Water tiles" },
};

const tileColors: Record<number, string> = {
  0: "#f9fafb",
  1: "#4ade80",
  2: "#6b7280",
  3: "#facc15",
  4: "#38bdf8",
  5: "#ef4444",
  6: "#8b5cf6",
  7: "#06b6d4",
};

const tileBorderColors: Record<number, string> = {
  0: "#e5e7eb",
  1: "#22c55e",
  2: "#4b5563",
  3: "#d9ab03",
  4: "#0284c7",
  5: "#dc2626",
  6: "#7c3aed",
  7: "#0891b2",
};

const tilesSchema = z.array(z.array(z.number()));
const encodedLevelSchema = z.object({ encoded_level: z.string() });
const editLevelTileSchema = z.object({
  encoded_level: z.string(),
  row: z.number(),
  col: z.number(),
  new_tile_type: z.number(),
});
const editLevelRowSchema = z.object({
  encoded_level: z.string(),
  row: z.number(),
  new_row_tiles: z.array(z.number()),
});
const editEntireLevelSchema = z.object({
  new_tiles: tilesSchema,
  new_name: z.optional(z.string()),
  new_description: z.optional(z.string()),
  max_enemies: z.optional(z.number()),
  enemy_spawn_chance: z.optional(z.number()),
  coin_spawn_chance: z.optional(z.number()),
});
const editMetadataSchema = z.object({
  encoded_level: z.string(),
  new_name: z.optional(z.string()),
  new_description: z.optional(z.string()),
  max_enemies: z.optional(z.number()),
  enemy_spawn_chance: z.optional(z.number()),
  coin_spawn_chance: z.optional(z.number()),
});
const createLevelSchema = z.object({
  level_name: z.string(),
  description: z.string(),
  tiles: tilesSchema,
  width: z.optional(z.number()),
  height: z.optional(z.number()),
  maxEnemies: z.optional(z.number()),
  enemySpawnChance: z.optional(z.number()),
  coinSpawnChance: z.optional(z.number()),
});

function runLengthEncode(input: string): string {
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

function runLengthDecode(input: string): string {
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
      result += ".".repeat(Number(numStr));
      i = j;
    } else {
      result += char;
      i += 1;
    }
  }
  return result;
}

function base64urlEncode(input: string): string {
  const encoded = Buffer.from(input, "utf-8").toString("base64");
  return encoded.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function base64urlDecode(input: string): string {
  const padded = input + "=".repeat((4 - (input.length % 4)) % 4);
  const base64 = padded.replace(/-/g, "+").replace(/_/g, "/");
  return Buffer.from(base64, "base64").toString("utf-8");
}

function encodeLevel(payload: LevelPayload): string {
  const tiles = payload.tiles ?? [];
  const height = tiles.length;
  const width = tiles[0]?.length ?? 0;
  let tileString = "";
  for (const row of tiles) {
    for (const tile of row) {
      tileString += tileChars[tile] ?? ".";
    }
  }
  tileString = runLengthEncode(tileString);
  let encoded = `${width}x${height}:${tileString}`;
  const params: Record<string, number> = {};
  if (Number.isFinite(payload.maxEnemies)) params.maxEnemies = payload.maxEnemies as number;
  if (Number.isFinite(payload.enemySpawnChance)) params.enemySpawnChance = payload.enemySpawnChance as number;
  if (Number.isFinite(payload.coinSpawnChance)) params.coinSpawnChance = payload.coinSpawnChance as number;
  if (Object.keys(params).length > 0) {
    encoded += `|${base64urlEncode(JSON.stringify(params))}`;
  }
  return base64urlEncode(encoded);
}

function decodeLevel(encodedLevel: string): LevelPayload {
  const decoded = base64urlDecode(encodedLevel);
  let mainData = decoded;
  let params: Record<string, number> = {};
  if (decoded.includes("|")) {
    const [levelData, paramsData] = decoded.split("|");
    mainData = levelData;
    try {
      params = JSON.parse(base64urlDecode(paramsData));
    } catch {
      params = {};
    }
  }
  const [dimensions, tileData] = mainData.split(":");
  const [widthStr, heightStr] = dimensions.split("x");
  const width = Number(widthStr);
  const height = Number(heightStr);
  const tileString = runLengthDecode(tileData);
  const tiles: number[][] = [];
  let index = 0;
  for (let y = 0; y < height; y += 1) {
    const row: number[] = [];
    for (let x = 0; x < width; x += 1) {
      const char = tileString[index] ?? ".";
      row.push(charTiles[char] ?? 0);
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
  };
}

function normalizePayload(payload: LevelPayload): LevelPayload {
  let normalized: LevelPayload = { ...payload };
  if (!normalized.encodedLevel && normalized.encoded_level) {
    normalized.encodedLevel = normalized.encoded_level;
  }
  if (!normalized.tiles && typeof normalized.encodedLevel === "string") {
    normalized = { ...normalized, ...decodeLevel(normalized.encodedLevel) };
  }
  if (normalized.tiles && !normalized.encodedLevel) {
    normalized.encodedLevel = encodeLevel(normalized);
  }
  return normalized;
}

function generateLevelSvg(level: LevelPayload, tileSize = 16, maxWidth = 1200): string {
  const tiles = level.tiles ?? [];
  if (!tiles.length) {
    return `<svg xmlns="http://www.w3.org/2000/svg" width="200" height="100"><rect width="100%" height="100%" fill="#ffffff"/><text x="10" y="50" fill="#111">Empty Level</text></svg>`;
  }
  const height = tiles.length;
  const width = tiles[0]?.length ?? 0;
  const actualTileSize = Math.max(4, Math.min(tileSize, Math.floor(maxWidth / width)));
  const svgWidth = width * actualTileSize;
  const svgHeight = height * actualTileSize;
  let rects = "";
  for (let y = 0; y < height; y += 1) {
    for (let x = 0; x < width; x += 1) {
      const tile = tiles[y][x];
      const fill = tileColors[tile] ?? "#808080";
      const stroke = tileBorderColors[tile] ?? "#000000";
      const left = x * actualTileSize;
      const top = y * actualTileSize;
      rects += `<rect x="${left}" y="${top}" width="${actualTileSize}" height="${actualTileSize}" fill="${fill}" stroke="${stroke}" stroke-width="1"/>`;
    }
  }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${svgWidth}" height="${svgHeight}" viewBox="0 0 ${svgWidth} ${svgHeight}">${rects}</svg>`;
}

export function createServer(): McpServer {
  const server = new McpServer({
    name: "Vibe Tide MCP App",
    version: "0.2.0",
  });

  const resourceUri = "ui://vibe-tide/mcp-app.html";

  registerAppTool(
    server,
    "decode_level_from_url",
    {
      title: "Decode Vibe Tide Level",
      description: "Decode an encoded level string to tiles and metadata.",
      inputSchema: encodedLevelSchema,
      _meta: { ui: { resourceUri } },
    },
    async (args): Promise<CallToolResult> => {
      const encoded = args.encoded_level as string;
      if (!encoded) {
        return { content: [{ type: "text", text: "Error: encoded_level is required." }] };
      }
      try {
        const levelData = normalizePayload({ encodedLevel: encoded });
        return {
          content: [{ type: "text", text: `Decoded level: ${levelData.width}x${levelData.height}\nEncoded: ${levelData.encodedLevel}` }],
          structuredContent: {
            ...levelData,
            encoded_level: levelData.encodedLevel,
                      },
        };
      } catch (error) {
        return { content: [{ type: "text", text: `Error decoding level: ${error instanceof Error ? error.message : String(error)}` }] };
      }
    },
  );

  registerAppTool(
    server,
    "edit_level_tile",
    {
      title: "Edit Level Tile",
      description: "Edit a single tile in a Vibe Tide level. Changes are shown immediately in the visual editor UI.",
      inputSchema: editLevelTileSchema,
      _meta: { ui: { resourceUri } },
    },
    async (args): Promise<CallToolResult> => {
      const encoded = args.encoded_level as string;
      if (!encoded) {
        return { content: [{ type: "text", text: "Error: encoded_level is required." }] };
      }
      const row = Number(args.row);
      const col = Number(args.col);
      const newTile = Number(args.new_tile_type);
      try {
        const levelData = normalizePayload({ encodedLevel: encoded });
        const tiles = levelData.tiles ?? [];
        if (!tiles.length) {
          return { content: [{ type: "text", text: "Error: Invalid tiles array after decoding." }] };
        }
        if (row < 0 || row >= tiles.length) {
          return { content: [{ type: "text", text: `Error: Invalid row ${row}. Level has ${tiles.length} rows (0-${tiles.length - 1}).` }] };
        }
        if (col < 0 || col >= tiles[0].length) {
          return { content: [{ type: "text", text: `Error: Invalid column ${col}. Level has ${tiles[0].length} columns (0-${tiles[0].length - 1}).` }] };
        }
        if (newTile < 0 || newTile > 7) {
          return { content: [{ type: "text", text: `Error: Invalid tile type ${newTile}. Valid types are 0-7.` }] };
        }
        tiles[row][col] = newTile;
        const updated = normalizePayload({ ...levelData, tiles });
        return {
          content: [{ type: "text", text: `Tile updated at row ${row}, col ${col} to type ${newTile}.\nEncoded: ${updated.encodedLevel}` }],
          structuredContent: {
            ...updated,
            encoded_level: updated.encodedLevel,
                      },
        };
      } catch (error) {
        return { content: [{ type: "text", text: `Error processing level: ${error instanceof Error ? error.message : String(error)}` }] };
      }
    },
  );

  registerAppTool(
    server,
    "edit_level_row",
    {
      title: "Edit Level Row",
      description: "Replace a full row in a Vibe Tide level. Changes are shown immediately in the visual editor UI.",
      inputSchema: editLevelRowSchema,
      _meta: { ui: { resourceUri } },
    },
    async (args): Promise<CallToolResult> => {
      const encoded = args.encoded_level as string;
      if (!encoded) {
        return { content: [{ type: "text", text: "Error: encoded_level is required." }] };
      }
      const row = Number(args.row);
      const newRow = args.new_row_tiles as number[];
      try {
        const levelData = normalizePayload({ encodedLevel: encoded });
        const tiles = levelData.tiles ?? [];
        if (!tiles.length) {
          return { content: [{ type: "text", text: "Error: Invalid tiles array after decoding." }] };
        }
        if (row < 0 || row >= tiles.length) {
          return { content: [{ type: "text", text: `Error: Invalid row ${row}. Level has ${tiles.length} rows (0-${tiles.length - 1}).` }] };
        }
        if (!Array.isArray(newRow) || newRow.length !== tiles[0].length) {
          return { content: [{ type: "text", text: `Error: Row length mismatch. Expected ${tiles[0].length} tiles, got ${newRow?.length ?? 0}.` }] };
        }
        const updatedTiles = tiles.map((r, idx) => (idx === row ? [...newRow] : [...r]));
        const updated = normalizePayload({ ...levelData, tiles: updatedTiles });
        return {
          content: [{ type: "text", text: `Row ${row} updated.\nEncoded: ${updated.encodedLevel}` }],
          structuredContent: {
            ...updated,
            encoded_level: updated.encodedLevel,
                      },
        };
      } catch (error) {
        return { content: [{ type: "text", text: `Error processing level: ${error instanceof Error ? error.message : String(error)}` }] };
      }
    },
  );

  registerAppTool(
    server,
    "edit_entire_level",
    {
      title: "Edit Entire Level",
      description: "Replace the full tile layout and optional metadata. Changes are shown immediately in the visual editor UI.",
      inputSchema: editEntireLevelSchema,
      _meta: { ui: { resourceUri } },
    },
    async (args): Promise<CallToolResult> => {
      const newTiles = args.new_tiles as number[][];
      const updated: LevelPayload = {
        tiles: newTiles,
        width: newTiles[0]?.length ?? 0,
        height: newTiles.length,
        name: args.new_name as string | undefined,
        description: args.new_description as string | undefined,
        maxEnemies: args.max_enemies as number | undefined,
        enemySpawnChance: args.enemy_spawn_chance as number | undefined,
        coinSpawnChance: args.coin_spawn_chance as number | undefined,
      };
      const normalized = normalizePayload(updated);
      return {
        content: [{ type: "text", text: `Level updated (${normalized.width}x${normalized.height}).\nEncoded: ${normalized.encodedLevel}` }],
        structuredContent: {
          ...normalized,
          encoded_level: normalized.encodedLevel,
                  },
      };
    },
  );

  registerAppTool(
    server,
    "edit_level_metadata",
    {
      title: "Edit Level Metadata",
      description: "Update name/description and gameplay parameters. Changes are reflected in the visual editor UI.",
      inputSchema: editMetadataSchema,
      _meta: { ui: { resourceUri } },
    },
    async (args): Promise<CallToolResult> => {
      const encoded = args.encoded_level as string;
      if (!encoded) {
        return { content: [{ type: "text", text: "Error: encoded_level is required." }] };
      }
      try {
        const levelData = normalizePayload({ encodedLevel: encoded });
        const updated: LevelPayload = {
          ...levelData,
          name: (args.new_name as string | undefined) ?? levelData.name,
          description:
            (args.new_description as string | undefined) ?? levelData.description,
          maxEnemies:
            (args.max_enemies as number | undefined) ?? levelData.maxEnemies,
          enemySpawnChance:
            (args.enemy_spawn_chance as number | undefined) ?? levelData.enemySpawnChance,
          coinSpawnChance:
            (args.coin_spawn_chance as number | undefined) ?? levelData.coinSpawnChance,
        };
        const normalized = normalizePayload(updated);
        return {
          content: [{ type: "text", text: `Metadata updated.\nEncoded: ${normalized.encodedLevel}` }],
          structuredContent: {
            ...normalized,
            encoded_level: normalized.encodedLevel,
                      },
        };
      } catch (error) {
        return { content: [{ type: "text", text: `Error processing level: ${error instanceof Error ? error.message : String(error)}` }] };
      }
    },
  );

  registerAppTool(
    server,
    "create_level",
    {
      title: "Create Level",
      description:
        "Create a complete Vibe Tide level. The level will be displayed in an interactive visual editor where users can view, edit, and play it directly - no external URLs needed. Design rules: left-to-right platformer, leave jump space above start, max 3-4 tile gaps, bottom half for platforms, top half mostly empty. Provide tiles explicitly.",
      inputSchema: createLevelSchema,
      _meta: { ui: { resourceUri } },
    },
    async (args): Promise<CallToolResult> => {
      const tiles = args.tiles as number[][];
      const levelData: LevelPayload = {
        tiles,
        width: args.width as number | undefined,
        height: args.height as number | undefined,
        name: args.level_name as string | undefined,
        description: args.description as string | undefined,
        maxEnemies: args.maxEnemies as number | undefined,
        enemySpawnChance: args.enemySpawnChance as number | undefined,
        coinSpawnChance: args.coinSpawnChance as number | undefined,
      };
      const normalized = normalizePayload(levelData);
      return {
        content: [{ type: "text", text: `Created level '${normalized.name ?? "Untitled"}' (${normalized.width}x${normalized.height}).\nEncoded: ${normalized.encodedLevel}` }],
        structuredContent: {
          ...normalized,
          encoded_level: normalized.encodedLevel,
                  },
      };
    },
  );

  // Silent tool - no UI rendering (uses standard SDK registration without resourceUri)
  server.tool(
    "get_tile_reference",
    "Get the tile type legend and usage notes for creating levels.",
    {},
    async () => {
      const referenceText = Object.entries(tileTypes)
        .map(([id, info]) => `${id}: ${tileChars[Number(id)]} (${info.symbol}) = ${info.name} - ${info.description}`)
        .join("\n");
      return {
        content: [
          {
            type: "text",
            text: `Tile Reference:\n${referenceText}\n\nUsage Notes:\n- Tile types are represented by integers 0-7\n- Use these numbers when editing levels\n- Empty tiles (0) represent walkable air space\n- Platform tiles (1-3) are solid ground\n- Special tiles (4-7) have unique properties`,
          },
        ],
      };
    },
  );

  registerAppResource(
    server,
    resourceUri,
    resourceUri,
    {
      mimeType: RESOURCE_MIME_TYPE,
      _meta: {
        ui: {
          csp: {
            frameDomains: ["http://localhost:3001"],
            connectDomains: ["http://localhost:3001"],
            resourceDomains: [
              "http://localhost:3001",
              "https://fonts.googleapis.com",
              "https://fonts.gstatic.com",
            ],
          },
        },
      },
    },
    async (): Promise<ReadResourceResult> => {
      const html = await fs.readFile(path.join(DIST_DIR, "mcp-app.html"), "utf-8");
      return {
        contents: [
          {
            uri: resourceUri,
            mimeType: RESOURCE_MIME_TYPE,
            text: html,
            _meta: {
              ui: {
                csp: {
                  frameDomains: ["http://localhost:3001"],
                  connectDomains: ["http://localhost:3001"],
                  resourceDomains: [
                    "http://localhost:3001",
                    "https://fonts.googleapis.com",
                    "https://fonts.gstatic.com",
                  ],
                },
              },
            },
          },
        ],
      };
    },
  );

  return server;
}

// Start HTTP server for Unity game (runs alongside stdio MCP)
const GAME_PORT = 3001;
const GAME_PATH = path.join(import.meta.dirname, "VibeTideMin");

const gameApp = express();

// Enable CORS for all origins (needed for MCP app in sandboxed origin to fetch game files)
gameApp.use((req, res, next) => {
  res.header("Access-Control-Allow-Origin", "*");
  res.header("Access-Control-Allow-Methods", "GET, OPTIONS");
  res.header("Access-Control-Allow-Headers", "Content-Type");
  if (req.method === "OPTIONS") {
    return res.sendStatus(200);
  }
  next();
});

gameApp.use(express.static(GAME_PATH));
createHttpServer(gameApp).listen(GAME_PORT, () => {
  console.error(`[Vibe Tide] Game server: http://localhost:${GAME_PORT}`);
});

async function main() {
  await createServer().connect(new StdioServerTransport());
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
