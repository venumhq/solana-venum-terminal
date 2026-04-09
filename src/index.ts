#!/usr/bin/env bun
/**
 * solana-venum-terminal — Real-time Solana DEX dashboard
 *
 * Streams live prices, pool discoveries, and top pools from the Venum API
 * rendered in a native terminal UI via OpenTUI.
 *
 * Usage:
 *   bun start                                     # prompts for API key
 *   VENUM_API_KEY=xxx bun start                   # skip prompt
 *   bun run src/index.ts https://localhost:3000   # custom API URL
 */

import {
  BoxRenderable,
  TextRenderable,
  TextTableRenderable,
  ScrollBoxRenderable,
  SelectRenderable,
  InputRenderable,
  createCliRenderer,
  t,
  bold,
  fg,
  bg,
  underline,
  type CliRenderer,
  type KeyEvent,
  type TextTableContent,
  type SelectOption,
  StyledText,
} from "@opentui/core";

import { join } from "node:path";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";

import { VenumAPI, type PriceEvent, type PoolEvent, type Pool } from "./api.js";

// ── config persistence ──────────────────────────────────────────────────────
const LOCAL_CONFIG_DIR = join(process.cwd(), "config", "venum-terminal");
const GLOBAL_CONFIG_DIR = join(Bun.env.XDG_CONFIG_HOME || join(Bun.env.HOME || "~", ".config"), "venum");
const LOCAL_CONFIG_FILE = join(LOCAL_CONFIG_DIR, "config.json");
const GLOBAL_CONFIG_FILE = join(GLOBAL_CONFIG_DIR, "config.json");

interface Config {
  apiKey?: string;
  apiUrl?: string;
}

function loadConfig(): Config {
  for (const file of [LOCAL_CONFIG_FILE, GLOBAL_CONFIG_FILE]) {
    try {
      if (existsSync(file)) {
        return JSON.parse(readFileSync(file, "utf-8"));
      }
    } catch {}
  }
  return {};
}

function saveConfig(config: Config): void {
  try {
    const targetDir = existsSync(LOCAL_CONFIG_DIR) ? LOCAL_CONFIG_DIR : GLOBAL_CONFIG_DIR;
    const targetFile = existsSync(LOCAL_CONFIG_DIR) ? LOCAL_CONFIG_FILE : GLOBAL_CONFIG_FILE;
    mkdirSync(targetDir, { recursive: true });
    writeFileSync(targetFile, JSON.stringify(config, null, 2) + "\n", { mode: 0o600 });
  } catch {}
}

// ── config ──────────────────────────────────────────────────────────────────
const savedConfig = loadConfig();
const API_URL = process.argv[2] || Bun.env.VENUM_API_URL || savedConfig.apiUrl || "https://api.venum.dev";
let apiKey = Bun.env.VENUM_API_KEY || savedConfig.apiKey;

// ── palette ─────────────────────────────────────────────────────────────────
const C = {
  bg:       "#0a0a0f",
  panel:    "#101018",
  border:   "#334466",
  text:     "#c8c8d4",
  muted:    "#555566",
  heading:  "#00d4aa",
  green:    "#00ff88",
  red:      "#ff4466",
  yellow:   "#ffcc00",
  cyan:     "#00ccff",
  orange:   "#ff9944",
  purple:   "#b388ff",
} as const;

// ── state ───────────────────────────────────────────────────────────────────
const latestPrices    = new Map<string, PriceEvent>();  // confirmed only (for price table)
const prevPrices      = new Map<string, number>();      // previous price (for ticker delta)
const flashState      = new Map<string, { dir: "up" | "down"; at: number }>();  // row flash

const FLASH_DURATION_MS = 800;
const STARTUP_FETCH_TIMEOUT_MS = 3_000;
const TOKEN_POOL_CACHE_TTL_MS = 60_000;
const TICK_LINE_WIDTH = 72;
interface TickerEntry { token: string; dex: string; line: StyledText; }
interface PoolFeedEntry { ts: string; dex: string; token: string; pair: string; address: string; }
const tickerFeed:  TickerEntry[] = [];
const poolFeed:    PoolFeedEntry[] = [];
let topPools: Pool[] = [];
let totalPoolCount = 0;
let totalEvents = 0;
let eventsPerMin = 0;
const eventTimestamps: number[] = [];
let connected = false;

// Detail view state
let selectedToken: string | null = null;
let tokenPools: Pool[] = [];
let selectedPool: Pool | null = null;

const TICKER_MAX = 200;
const POOL_FEED_MAX = 100;
const DEFAULT_TOKENS = ["SOL", "JUP", "BONK", "WIF", "JTO", "PYTH", "RENDER", "HNT", "RAY", "ORCA", "USDC", "USDT", "jitoSOL", "mSOL", "bSOL", "jupSOL", "WBTC", "WETH"];

// Dirty flags — only rebuild UI when data changes
let dirtyPrices = false;
let dirtyTicker = false;
let dirtyPools  = false;
let dirtyFeed   = false;

// ── helpers ─────────────────────────────────────────────────────────────────
function fmtUsd(n: number): string {
  if (n >= 1_000_000) return `$${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `$${(n / 1_000).toFixed(1)}K`;
  if (n >= 1) return `$${n.toFixed(2)}`;
  if (n >= 0.0001) return `$${n.toFixed(6)}`;
  return `$${n.toExponential(2)}`;
}

function fmtPrice(n: number): string {
  if (n >= 1) return n.toFixed(4);
  if (n >= 0.0001) return n.toFixed(8);
  return n.toExponential(4);
}

function dexShort(dex: string): string {
  const map: Record<string, string> = {
    "orca-whirlpool": "Orca",
    "raydium-clmm": "Ray CLMM",
    "raydium-cpmm": "Ray CPMM",
    "raydium-amm": "Ray AMM",
    "meteora-dlmm": "DLMM",
    "meteora-pools": "Meteora",
    "pumpswap": "Pump",
    "lifinity-v2": "Lifinity",
  };
  return map[dex] || dex;
}

function shortAddr(addr: string): string {
  return addr.slice(0, 4) + ".." + addr.slice(-4);
}

function poolHeadlineToken(pool: PoolEvent): string {
  const quoteSymbols = new Set(["SOL", "USDC", "USDT", "jitoSOL", "mSOL", "bSOL", "jupSOL", "WBTC", "WETH"]);
  const symbolA = pool.symbolA || shortAddr(pool.mintA);
  const symbolB = pool.symbolB || shortAddr(pool.mintB);
  if (quoteSymbols.has(symbolA) && !quoteSymbols.has(symbolB)) return symbolB;
  if (quoteSymbols.has(symbolB) && !quoteSymbols.has(symbolA)) return symbolA;
  return symbolA;
}

function chunk(text: string) {
  return [{ __isChunk: true as const, text }];
}

function padLeft(text: string, width: number): string {
  return text.padStart(width, " ");
}

function padRight(text: string, width: number): string {
  return text.padEnd(width, " ");
}

const TOKEN_GLYPH_PALETTE = ["#7CCF44", "#60a5fa", "#facc15", "#c084fc", "#f78c6c", "#82aaff", "#28c840"] as const;

function tokenColor(symbol: string): string {
  let hash = 0;
  for (let i = 0; i < symbol.length; i++) {
    hash = (hash * 31 + symbol.charCodeAt(i)) >>> 0;
  }
  return TOKEN_GLYPH_PALETTE[hash % TOKEN_GLYPH_PALETTE.length] as string;
}

function tokenGlyph(symbol: string): StyledText {
  const letter = symbol.charAt(0)?.toUpperCase() || "?";
  const color = tokenColor(symbol);
  return bg(color)(fg(C.bg)(` ${letter} `));
}

function tokenLabel(symbol: string, opts: { muted?: boolean; rowBg?: string } = {}): StyledText {
  const { muted = false, rowBg } = opts;
  const glyph = tokenGlyph(symbol);
  const label = muted
    ? fg(C.muted)(` ${symbol}`)
    : bold(fg(C.cyan)(` ${symbol}`));
  return rowBg ? t`${glyph}${bg(rowBg)(label)}` : t`${glyph}${label}`;
}

function tokenKey(symbol: string): string {
  return symbol.toUpperCase();
}

function isPreConfirmationConfidence(confidence: string | undefined): boolean {
  const value = (confidence || "").toLowerCase();
  return value.includes("optimistic")
    || value.includes("pre")
    || value.includes("shred")
    || value.includes("touch")
    || value.includes("pending")
    || value.includes("unconfirm");
}

function timeStr(): string {
  const d = new Date();
  return `${d.getHours().toString().padStart(2, "0")}:${d.getMinutes().toString().padStart(2, "0")}:${d.getSeconds().toString().padStart(2, "0")}.${d.getMilliseconds().toString().padStart(3, "0")}`;
}

// ── welcome screen ──────────────────────────────────────────────────────────
async function showWelcome(renderer: CliRenderer): Promise<string | undefined> {
  return new Promise((resolve) => {
    const container = new BoxRenderable(renderer, {
      id: "welcome",
      width: "100%",
      height: "100%",
      flexDirection: "column",
      justifyContent: "center",
      alignItems: "center",
      gap: 1,
    });
    renderer.root.add(container);

    const card = new BoxRenderable(renderer, {
      id: "welcome-card",
      width: 60,
      flexDirection: "column",
      border: true,
      borderStyle: "rounded",
      borderColor: C.heading,
      backgroundColor: C.panel,
      padding: 2,
      gap: 1,
    });
    container.add(card);

    card.add(new TextRenderable(renderer, {
      id: "welcome-title",
      content: t`${bold(fg(C.heading)("VENUM"))} ${fg(C.text)("Solana DEX Terminal")}`,
      selectable: false,
    }));

    card.add(new TextRenderable(renderer, {
      id: "welcome-desc",
      content: t`${fg(C.muted)("Enter your API key for real-time SSE streams (free keys available).")}
${fg(C.muted)("Press")} ${bold(fg(C.text)("Enter"))} ${fg(C.muted)("to skip (anonymous tier, REST polling).")}
${fg(C.muted)("Get a free key at")} ${underline(fg(C.cyan)("venum.dev"))}`,
      wrapMode: "word",
      selectable: false,
    }));

    card.add(new TextRenderable(renderer, {
      id: "welcome-label",
      content: t`${fg(C.text)("API Key:")}`,
      selectable: false,
    }));

    const input = new InputRenderable(renderer, {
      id: "welcome-input",
      width: "100%",
      placeholder: "paste key or press Enter to skip",
      border: true,
      borderStyle: "single",
      borderColor: C.border,
      fg: C.text,
      backgroundColor: C.bg,
    });
    card.add(input);

    card.add(new TextRenderable(renderer, {
      id: "welcome-hint",
      content: t`${fg(C.muted)("Your key will be saved to ~/.config/venum-terminal/")}`,
      selectable: false,
    }));

    input.focus();
    input.on("enter", () => {
      const val = input.value.trim();
      renderer.root.remove("welcome");
      container.destroyRecursively();
      resolve(val || undefined);
    });

    renderer.requestRender();
  });
}

// ── dashboard ───────────────────────────────────────────────────────────────
async function startDashboard(renderer: CliRenderer, resolvedKey: string | undefined) {
  const api = new VenumAPI(API_URL, resolvedKey);
  const priceStreamApi = api.hasStreaming ? new VenumAPI(API_URL, resolvedKey) : api;
  const poolStreamApi = api.hasStreaming ? new VenumAPI(API_URL, resolvedKey) : api;
  const mode = api.hasStreaming ? "SSE" : "ANON";
  const tokenPoolsCache = new Map<string, { expiresAt: number; pools: Pool[] }>();
  const tokenPoolsRequests = new Map<string, Promise<Pool[]>>();

  function requestUiRefresh() {
    renderer.requestRender();
  }

  function sameTokens(a: string[], b: string[]) {
    return a.length === b.length && a.every((token, index) => token === b[index]);
  }

  const STREAM_TOKEN_LIMIT = 40;
  let allTokens: string[] = [...DEFAULT_TOKENS];
  let streamTokens: string[] = api.hasStreaming ? [...allTokens] : allTokens.slice(0, STREAM_TOKEN_LIMIT);

  // Filter state — applied to price table and ticker
  let filterQuery = "";
  let filterActive = false;

  // ── layout ──────────────────────────────────────────────────────────────
  const root = new BoxRenderable(renderer, {
    id: "root",
    width: "100%",
    height: "100%",
    flexDirection: "column",
    padding: 0,
    gap: 0,
  });
  renderer.root.add(root);

  const topBar = new BoxRenderable(renderer, {
    id: "top-bar",
    width: "100%",
    height: 3,
    flexGrow: 0,
    flexShrink: 0,
    flexDirection: "column",
    backgroundColor: C.panel,
    padding: 0,
  });
  root.add(topBar);

  const contentArea = new BoxRenderable(renderer, {
    id: "content-area",
    width: "100%",
    flexGrow: 1,
    flexShrink: 1,
    flexDirection: "column",
    padding: 1,
    gap: 1,
  });
  root.add(contentArea);

  function headerContent() {
    return t`${bold(fg(C.heading)("VENUM"))} ${fg(C.muted)("—")} ${fg(C.text)("Solana DEX Terminal")}`;
  }

  function headerMetaContent() {
    return resolvedKey
      ? t`${fg(C.cyan)(API_URL)} ${fg(C.muted)("│")} ${fg(C.muted)(`${allTokens.length} TOKENS / ${streamTokens.length} STREAMING`)}`
      : t`${fg(C.cyan)("api.venum.dev")} ${fg(C.muted)("│")} ${fg(C.yellow)("GET API KEY")}: ${underline(fg(C.cyan)("www.venum.dev"))}`;
  }

  // Header
  const header = new TextRenderable(renderer, {
    id: "header",
    content: headerContent(),
    selectable: false,
  });
  topBar.add(header);

  const headerMeta = new TextRenderable(renderer, {
    id: "header-meta",
    content: headerMetaContent(),
    selectable: false,
  });
  topBar.add(headerMeta);

  // ── filter bar ──────────────────────────────────────────────────────
  const filterRow = new BoxRenderable(renderer, {
    id: "filter-row",
    width: "100%",
    flexGrow: 0,
    flexShrink: 0,
    flexDirection: "row",
    gap: 1,
    alignItems: "center",
  });
  topBar.add(filterRow);

  const filterLabel = new TextRenderable(renderer, {
    id: "filter-label",
    content: t`${fg(C.orange)("CMD>")}`,
    selectable: false,
  });
  filterRow.add(filterLabel);

  const filterInput = new InputRenderable(renderer, {
    id: "filter-input",
    width: "100%",
    placeholder: "type /TOKEN, DEX, PAIR",
    border: true,
    borderStyle: "single",
    borderColor: C.border,
    fg: C.text,
    backgroundColor: C.panel,
  });
  filterRow.add(filterInput);

  const filterStatus = new TextRenderable(renderer, {
    id: "filter-status",
    content: t`${fg(C.muted)("")}`,
    selectable: false,
  });
  filterRow.add(filterStatus);

  filterInput.on("input", () => {
    filterQuery = filterInput.value.trim().replace(/^\/+/, "").toUpperCase();
    filterActive = filterQuery.length > 0;
    dirtyPrices = true;
    dirtyTicker = true;
    if (filterActive) {
      const matchCount = allTokens.filter(t => matchesFilter(t)).length;
      filterStatus.content = t`${fg(C.cyan)(`${matchCount}`)}${fg(C.muted)(` / ${allTokens.length} tokens`)}`;
    } else {
      filterStatus.content = t`${fg(C.muted)("")}`;
    }
    requestUiRefresh();
  });

  filterInput.on("enter", () => {
    filterInput.blur();
  });

  function connectPriceStream() {
    priceStreamApi.disconnect();
    priceStreamApi.streamPrices(
      streamTokens,
      handlePriceEvent,
      () => {
        connected = true;
        requestUiRefresh();
      },
      () => {
        connected = false;
        requestUiRefresh();
      }
    );
  }

  void (async () => {
    const ac = new AbortController();
    const timeout = setTimeout(() => ac.abort(), STARTUP_FETCH_TIMEOUT_MS);
    try {
      const res = await fetch(`${API_URL}/v1/tokens`, {
        headers: { "User-Agent": "solana-venum-terminal/0.1.0", ...(resolvedKey ? { "X-API-Key": resolvedKey } : {}) },
        signal: ac.signal,
      });
      if (!res.ok) return;
      const data = await res.json() as { tokens: { symbol: string }[] };
      const tokens = data.tokens.map(t => t.symbol);
      if (tokens.length === 0) return;

      allTokens = tokens;
      const nextStreamTokens = api.hasStreaming ? [...allTokens] : allTokens.slice(0, STREAM_TOKEN_LIMIT);
      if (api.hasStreaming) {
        if (!sameTokens(streamTokens, nextStreamTokens)) {
          streamTokens = nextStreamTokens;
          connectPriceStream();
        }
      } else {
        streamTokens = nextStreamTokens;
      }

      header.content = headerContent();
      headerMeta.content = headerMetaContent();
      if (filterActive) {
        const matchCount = allTokens.filter(t => matchesFilter(t)).length;
        filterStatus.content = t`${fg(C.cyan)(`${matchCount}`)}${fg(C.muted)(` / ${allTokens.length} tokens`)}`;
      }
      dirtyPrices = true;
      requestUiRefresh();
    } catch {} finally {
      clearTimeout(timeout);
    }
  })();

  function matchesFilter(token: string): boolean {
    if (!filterActive) return true;
    // Match against token symbol
    if (token.toUpperCase().includes(filterQuery)) return true;
    // Match against best bid/ask DEX
    const p = latestPrices.get(tokenKey(token));
    if (p) {
      if (p.bestBidDex && dexShort(p.bestBidDex).toUpperCase().includes(filterQuery)) return true;
      if (p.bestAskDex && dexShort(p.bestAskDex).toUpperCase().includes(filterQuery)) return true;
    }
    return false;
  }

  // ── top row: price table + live ticker ────────────────────────────────
  const topRow = new BoxRenderable(renderer, {
    id: "top-row",
    width: "100%",
    flexGrow: 3,
    flexShrink: 1,
    flexDirection: "row",
    gap: 1,
  });
  contentArea.add(topRow);

  // Price table
  const pricePanel = new BoxRenderable(renderer, {
    id: "price-panel",
    flexGrow: 4,
    flexShrink: 1,
    border: true,
    borderStyle: "single",
    borderColor: C.border,
    title: "PRICES",
    titleAlignment: "left",
    backgroundColor: C.panel,
    flexDirection: "column",
  });
  topRow.add(pricePanel);

  const priceScroll = new ScrollBoxRenderable(renderer, {
    id: "price-scroll",
    width: "100%",
    flexGrow: 1,
    scrollY: true,
    scrollX: false,
    border: false,
    backgroundColor: "transparent",
    contentOptions: { flexDirection: "column", gap: 0 },
  });
  priceScroll.verticalScrollbarOptions = { visible: false };
  pricePanel.add(priceScroll);

  const priceTable = new TextTableRenderable(renderer, {
    id: "price-table",
    width: "100%",
    wrapMode: "none",
    columnWidthMode: "full",
    columnFitter: "balanced",
    cellPadding: 0,
    border: true,
    outerBorder: false,
    borderStyle: "single",
    borderColor: C.border,
    fg: C.text,
    content: [],
  });
  priceScroll.add(priceTable);

  // Live ticker
  const tickerPanel = new BoxRenderable(renderer, {
    id: "ticker-panel",
    flexGrow: 2,
    flexShrink: 1,
    border: true,
    borderStyle: "single",
    borderColor: C.border,
    title: "TICKS",
    titleAlignment: "left",
    backgroundColor: C.panel,
    flexDirection: "column",
    padding: 1,
  });
  topRow.add(tickerPanel);

  const tickerLegendRow = new BoxRenderable(renderer, {
    id: "ticker-legend-row",
    width: "100%",
    height: 1,
    flexGrow: 0,
    flexShrink: 0,
    flexDirection: "row",
  });
  tickerPanel.add(tickerLegendRow);

  const tickerLegend = new TextRenderable(renderer, {
    id: "ticker-legend",
    content: t`${bg("#0a2a1a")(fg(C.green)(" confirmed "))} ${bg("#2a2a0a")(fg(C.yellow)(" pre-confirmation "))}`,
    selectable: false,
  });
  tickerLegendRow.add(tickerLegend);

  const tickerScroll = new ScrollBoxRenderable(renderer, {
    id: "ticker-scroll",
    width: "100%",
    flexGrow: 1,
    scrollY: true,
    scrollX: false,
    border: false,
    backgroundColor: "transparent",
    contentOptions: { flexDirection: "column", gap: 0 },
  });
  tickerScroll.verticalScrollbarOptions = { visible: false };
  tickerPanel.add(tickerScroll);

  const tickerText = new TextRenderable(renderer, {
    id: "ticker-text",
    width: "100%",
    content: t`${fg(C.muted)("Waiting for price events...")}`,
    fg: C.text,
    wrapMode: "none",
    selectable: false,
  });
  tickerScroll.add(tickerText);

  // ── bottom row: pools table + feeds/detail ────────────────────────────
  const bottomRow = new BoxRenderable(renderer, {
    id: "bottom-row",
    width: "100%",
    flexGrow: 2,
    flexShrink: 1,
    flexDirection: "row",
    gap: 1,
  });
  contentArea.add(bottomRow);

  // Top pools table
  const poolsPanel = new BoxRenderable(renderer, {
    id: "pools-panel",
    width: "50%",
    flexGrow: 0,
    flexShrink: 0,
    border: true,
    borderStyle: "single",
    borderColor: C.border,
    title: "TOP SOL POOLS",
    titleAlignment: "left",
    backgroundColor: C.panel,
    padding: 0,
    flexDirection: "column",
  });
  bottomRow.add(poolsPanel);

  const poolsScroll = new ScrollBoxRenderable(renderer, {
    id: "pools-scroll",
    width: "100%",
    flexGrow: 1,
    scrollY: true,
    scrollX: false,
    border: false,
    backgroundColor: "transparent",
    contentOptions: { flexDirection: "column", gap: 0 },
  });
  poolsScroll.verticalScrollbarOptions = { visible: false };
  poolsPanel.add(poolsScroll);

  const poolsTable = new TextTableRenderable(renderer, {
    id: "pools-table",
    width: "100%",
    wrapMode: "none",
    columnWidthMode: "full",
    columnFitter: "balanced",
    cellPadding: 0,
    border: true,
    outerBorder: false,
    borderStyle: "single",
    borderColor: C.border,
    fg: C.text,
    content: [],
  });
  poolsScroll.add(poolsTable);

  // Right column: feeds + detail view
  const rightCol = new BoxRenderable(renderer, {
    id: "right-col",
    width: "50%",
    flexGrow: 0,
    flexShrink: 0,
    flexDirection: "column",
    gap: 1,
  });
  bottomRow.add(rightCol);

  // New pool feed
  const feedPanel = new BoxRenderable(renderer, {
    id: "feed-panel",
    width: "100%",
    flexGrow: 1,
    border: true,
    borderStyle: "single",
    borderColor: C.border,
    title: "NEW POOLS",
    titleAlignment: "left",
    backgroundColor: C.panel,
    flexDirection: "column",
    padding: 0,
  });
  rightCol.add(feedPanel);

  const feedScroll = new ScrollBoxRenderable(renderer, {
    id: "feed-scroll",
    width: "100%",
    flexGrow: 1,
    scrollY: true,
    scrollX: false,
    border: false,
    backgroundColor: "transparent",
    contentOptions: { flexDirection: "column", gap: 0 },
  });
  feedScroll.verticalScrollbarOptions = { visible: false };
  feedPanel.add(feedScroll);

  const feedTable = new TextTableRenderable(renderer, {
    id: "feed-table",
    width: "100%",
    wrapMode: "none",
    columnWidthMode: "full",
    columnFitter: "balanced",
    cellPadding: 0,
    border: false,
    outerBorder: false,
    fg: C.text,
    content: [[[fg(C.muted)("Waiting for new pools...")], null, null, null, null]],
  });
  feedTable.verticalGridLineColor = "transparent";
  feedTable.horizontalGridLineColor = "transparent";
  const feedText = new TextRenderable(renderer, {
    id: "feed-text-placeholder",
    content: t`${fg(C.muted)("")}`,
    fg: C.text,
    wrapMode: "none",
    selectable: false,
  });
  feedScroll.add(feedTable);

  // Render once immediately so placeholders show up before data arrives
  dirtyPrices = true;
  dirtyPools = true;
  dirtyTicker = true;
  dirtyFeed = true;
  requestUiRefresh();

  // ── detail overlay (token drill-down) ─────────────────────────────────
  let detailContainer: BoxRenderable | null = null;
  let tokenSelect: SelectRenderable | null = null;
  let poolSelect: SelectRenderable | null = null;
  let detailText: TextRenderable | null = null;
  let detailView: "hidden" | "token-select" | "pool-select" | "pool-detail" = "hidden";

  function showTokenSelect() {
    hideDetail();
    detailView = "token-select";

    detailContainer = new BoxRenderable(renderer, {
      id: "detail-overlay",
      width: "100%",
      height: "100%",
      position: "absolute",
      left: 0,
      top: 0,
      flexDirection: "column",
      justifyContent: "center",
      alignItems: "center",
      backgroundColor: "#0a0a0f",
      zIndex: 100,
    });
    renderer.root.add(detailContainer);

    const card = new BoxRenderable(renderer, {
      id: "detail-card",
      width: 50,
      height: 24,
      border: true,
      borderStyle: "rounded",
      borderColor: C.heading,
      backgroundColor: C.panel,
      padding: 1,
      flexDirection: "column",
      gap: 1,
    });
    detailContainer.add(card);

    card.add(new TextRenderable(renderer, {
      id: "detail-title",
      content: t`${bold(fg(C.heading)("Select Token"))}  ${fg(C.muted)("Type to search  ↑↓ navigate  Enter select  Esc back")}`,
      selectable: false,
    }));

    // Search input
    const tokenSearch = new InputRenderable(renderer, {
      id: "token-search",
      width: "100%",
      placeholder: "Search token...",
      border: true,
      borderStyle: "single",
      borderColor: C.border,
      fg: C.text,
      backgroundColor: C.bg,
    });
    card.add(tokenSearch);

    // Build all options
    function buildTokenOptions(filter: string): SelectOption[] {
      const q = filter.toUpperCase();
      const opts: SelectOption[] = [];
      for (const token of allTokens) {
        if (q && !token.toUpperCase().includes(q)) continue;
        const p = latestPrices.get(tokenKey(token));
        const priceStr = p ? fmtUsd(p.priceUsd) : "--";
        const chStr = p?.change24h !== undefined
          ? (p.change24h > 0 ? `+${p.change24h.toFixed(1)}%` : `${p.change24h.toFixed(1)}%`)
          : "";
        opts.push({
          name: token,
          description: `${priceStr}  ${chStr}  ${p ? p.poolCount + " pools" : ""}`,
        });
      }
      return opts;
    }

    const allOptions = buildTokenOptions("");

    tokenSelect = new SelectRenderable(renderer, {
      id: "token-select",
      width: "100%",
      flexGrow: 1,
      options: allOptions,
      backgroundColor: C.panel,
      textColor: C.text,
      focusedBackgroundColor: "#1a2a3a",
      focusedTextColor: C.heading,
      descriptionColor: C.muted,
      selectedDescriptionColor: C.text,
      showDescription: true,
      wrapSelection: true,
      showScrollIndicator: true,
      borderStyle: "single",
    });
    card.add(tokenSelect);

    // Filter on every keystroke
    tokenSearch.on("input", () => {
      const filtered = buildTokenOptions(tokenSearch.value);
      if (tokenSelect) tokenSelect.options = filtered;
    });

    // Enter on search → select first match; Enter on list → select focused
    tokenSearch.on("enter", async () => {
      const opt = tokenSelect?.getSelectedOption();
      if (!opt) return;
      selectedToken = opt.name;
      await loadTokenPools(opt.name);
      showPoolSelect();
    });

    // Defer focus to search input
    setTimeout(() => tokenSearch?.focus(), 50);

    // Arrow keys in search should navigate the list
    renderer.keyInput.on("keypress", function tokenKeyHandler(key: KeyEvent) {
      if (detailView !== "token-select") {
        renderer.keyInput.off("keypress", tokenKeyHandler);
        return;
      }
      if (key.name === "up" || key.name === "arrowup") {
        tokenSelect?.moveUp();
      } else if (key.name === "down" || key.name === "arrowdown") {
        tokenSelect?.moveDown();
      }
    });

    tokenSelect.on("itemSelected", async () => {
      const opt = tokenSelect?.getSelectedOption();
      if (!opt) return;
      selectedToken = opt.name;
      await loadTokenPools(opt.name);
      showPoolSelect();
    });

    renderer.requestRender();
  }

  async function loadTokenPools(token: string) {
    const now = Date.now();
    const cached = tokenPoolsCache.get(token);
    if (cached && cached.expiresAt > now) {
      tokenPools = cached.pools;
      return;
    }

    const inFlight = tokenPoolsRequests.get(token);
    if (inFlight) {
      try {
        tokenPools = await inFlight;
        return;
      } catch {
        tokenPools = [];
        return;
      }
    }

    const request = api.fetchPools(token, 20)
      .then((data) => {
        tokenPoolsCache.set(token, {
          expiresAt: Date.now() + TOKEN_POOL_CACHE_TTL_MS,
          pools: data.pools,
        });
        return data.pools;
      })
      .finally(() => {
        tokenPoolsRequests.delete(token);
      });

    tokenPoolsRequests.set(token, request);

    try {
      tokenPools = await request;
    } catch {
      tokenPools = [];
    }
  }

  function showPoolSelect() {
    hideDetail();
    detailView = "pool-select";

    detailContainer = new BoxRenderable(renderer, {
      id: "detail-overlay",
      width: "100%",
      height: "100%",
      position: "absolute",
      left: 0,
      top: 0,
      flexDirection: "column",
      justifyContent: "center",
      alignItems: "center",
      backgroundColor: "#0a0a0f",
      zIndex: 100,
    });
    renderer.root.add(detailContainer);

    const card = new BoxRenderable(renderer, {
      id: "detail-card",
      width: 70,
      height: 26,
      border: true,
      borderStyle: "rounded",
      borderColor: C.cyan,
      backgroundColor: C.panel,
      padding: 1,
      flexDirection: "column",
      gap: 1,
    });
    detailContainer.add(card);

    card.add(new TextRenderable(renderer, {
      id: "detail-title",
      content: t`${bold(fg(C.cyan)(selectedToken!))} ${fg(C.text)("Pools")}  ${fg(C.muted)(`(${tokenPools.length})`)}  ${fg(C.muted)("Type to search  ↑↓ navigate  Enter detail  Esc back")}`,
      selectable: false,
    }));

    // Search input
    const poolSearch = new InputRenderable(renderer, {
      id: "pool-search",
      width: "100%",
      placeholder: "Search by pair or DEX...",
      border: true,
      borderStyle: "single",
      borderColor: C.border,
      fg: C.text,
      backgroundColor: C.bg,
    });
    card.add(poolSearch);

    function buildPoolOptions(filter: string): SelectOption[] {
      const q = filter.toUpperCase();
      const opts: SelectOption[] = [];
      for (const p of tokenPools) {
        const label = `${p.symbolA}/${p.symbolB}  ${dexShort(p.dex)}`;
        if (q && !label.toUpperCase().includes(q) && !p.address.includes(filter)) continue;
        opts.push({
          name: label,
          description: `TVL: ${p.tvlUsd ? fmtUsd(p.tvlUsd) : "--"}  Vol: ${p.volume24hUsd ? fmtUsd(p.volume24hUsd) : "--"}  Fee: ${p.feeBps}bp  ${shortAddr(p.address)}`,
          value: p,
        });
      }
      if (opts.length === 0) opts.push({ name: "No pools found", description: "" });
      return opts;
    }

    const allPoolOpts = buildPoolOptions("");

    poolSelect = new SelectRenderable(renderer, {
      id: "pool-select",
      width: "100%",
      flexGrow: 1,
      options: allPoolOpts,
      backgroundColor: C.panel,
      textColor: C.text,
      focusedBackgroundColor: "#1a2a3a",
      focusedTextColor: C.cyan,
      descriptionColor: C.muted,
      selectedDescriptionColor: C.text,
      showDescription: true,
      wrapSelection: true,
      showScrollIndicator: true,
    });
    card.add(poolSelect);

    poolSearch.on("input", () => {
      const filtered = buildPoolOptions(poolSearch.value);
      if (poolSelect) poolSelect.options = filtered;
    });

    poolSearch.on("enter", () => {
      const opt = poolSelect?.getSelectedOption();
      if (!opt?.value) return;
      selectedPool = opt.value;
      showPoolDetail();
    });

    setTimeout(() => poolSearch?.focus(), 50);

    renderer.keyInput.on("keypress", function poolKeyHandler(key: KeyEvent) {
      if (detailView !== "pool-select") {
        renderer.keyInput.off("keypress", poolKeyHandler);
        return;
      }
      if (key.name === "up" || key.name === "arrowup") {
        poolSelect?.moveUp();
      } else if (key.name === "down" || key.name === "arrowdown") {
        poolSelect?.moveDown();
      }
    });

    poolSelect.on("itemSelected", () => {
      const opt = poolSelect?.getSelectedOption();
      if (!opt?.value) return;
      selectedPool = opt.value;
      showPoolDetail();
    });

    renderer.requestRender();
  }

  function showPoolDetail() {
    hideDetail();
    if (!selectedPool) return;
    detailView = "pool-detail";

    const p = selectedPool;

    detailContainer = new BoxRenderable(renderer, {
      id: "detail-overlay",
      width: "100%",
      height: "100%",
      position: "absolute",
      left: 0,
      top: 0,
      flexDirection: "column",
      justifyContent: "center",
      alignItems: "center",
      backgroundColor: "#0a0a0f",
      zIndex: 100,
    });
    renderer.root.add(detailContainer);

    const card = new BoxRenderable(renderer, {
      id: "detail-card",
      width: 60,
      border: true,
      borderStyle: "rounded",
      borderColor: C.purple,
      backgroundColor: C.panel,
      padding: 2,
      flexDirection: "column",
      gap: 1,
    });
    detailContainer.add(card);

    card.add(new TextRenderable(renderer, {
      id: "detail-title",
      content: t`${bold(fg(C.purple)("Pool Detail"))}  ${fg(C.muted)("Esc = back")}`,
      selectable: false,
    }));

    const content = t`${bold(fg(C.heading)("Pair:"))}      ${fg(C.text)(`${p.symbolA} / ${p.symbolB}`)}
${bold(fg(C.heading)("DEX:"))}       ${fg(C.text)(dexShort(p.dex))}
${bold(fg(C.heading)("Address:"))}   ${fg(C.cyan)(p.address)}
${bold(fg(C.heading)("Fee:"))}       ${fg(C.text)(`${p.feeBps} bps (${(p.feeBps / 100).toFixed(2)}%)`)}
${bold(fg(C.heading)("Price:"))}     ${fg(C.text)(p.price ? fmtUsd(p.price) : "--")}
${bold(fg(C.heading)("TVL:"))}       ${fg(p.tvlUsd ? C.green : C.muted)(p.tvlUsd ? fmtUsd(p.tvlUsd) : "--")}
${bold(fg(C.heading)("Vol 24h:"))}   ${fg(p.volume24hUsd ? C.green : C.muted)(p.volume24hUsd ? fmtUsd(p.volume24hUsd) : "--")}
${bold(fg(C.heading)("Cache:"))}     ${fg(C.muted)(`${p.cacheAgeMs}ms ago`)}`;

    detailText = new TextRenderable(renderer, {
      id: "detail-text",
      content,
      wrapMode: "word",
      selectable: true,
    });
    card.add(detailText);

    renderer.requestRender();
  }

  function hideDetail() {
    if (detailContainer) {
      renderer.root.remove("detail-overlay");
      detailContainer.destroyRecursively();
      detailContainer = null;
      tokenSelect = null;
      poolSelect = null;
      detailText = null;
    }
    detailView = "hidden";
  }

  // ── table builders ────────────────────────────────────────────────────
  function buildPriceTableContent(): TextTableContent {
    const headerRow = [
      [bold(fg(C.heading)("Token"))],
      [bold(fg(C.heading)(padLeft("PX", 10)))],
      [bold(fg(C.heading)(padLeft("BID", 10)))],
      [bold(fg(C.heading)(padLeft("ASK", 10)))],
      [bold(fg(C.heading)(padLeft("SPR", 8)))],
      [bold(fg(C.heading)(padLeft("24H", 7)))],
      [bold(fg(C.heading)(padLeft("PL", 5)))],
    ];

    const rows: TextTableContent = [headerRow];

    for (const token of allTokens) {
      if (!matchesFilter(token)) continue;
      const p = latestPrices.get(tokenKey(token));
      if (!p) {
        rows.push([
          tokenLabel(token, { muted: true }).chunks,
          [fg(C.muted)(padLeft("--", 10))],
          [fg(C.muted)(padLeft("--", 10))],
          [fg(C.muted)(padLeft("--", 10))],
          [fg(C.muted)(padLeft("--", 8))],
          [fg(C.muted)(padLeft("--", 7))],
          [fg(C.muted)(padLeft("--", 5))],
        ]);
        continue;
      }

      const spread = p.bestAsk > 0 && p.bestBid > 0
        ? ((p.bestAsk - p.bestBid) / p.bestBid * 100).toFixed(3) + "%"
        : "--";

      const ch = p.change24h;
      const changeText = ch === undefined ? "--" : ch > 0 ? `+${ch.toFixed(1)}%` : `${ch.toFixed(1)}%`;
      const changeColor = ch === undefined ? C.muted : ch > 0 ? C.green : ch < 0 ? C.red : C.text;

      // Flash row on price change
      const flash = flashState.get(tokenKey(token));
      const now = Date.now();
      let rowBg: string | undefined;
      if (flash && now - flash.at < FLASH_DURATION_MS) {
        rowBg = flash.dir === "up" ? "#0a2a1a" : "#2a0a1a";
      } else if (flash) {
        flashState.delete(tokenKey(token));
      }

      const cell = (text: string, width: number) =>
        rowBg ? [bg(rowBg)(fg(C.text)(text))] : chunk(text);

      const tokenCell = tokenLabel(token, { rowBg });

      rows.push([
        tokenCell.chunks,
        cell(padLeft(fmtUsd(p.priceUsd), 10), 10),
        cell(padLeft(fmtUsd(p.bestBid), 10), 10),
        cell(padLeft(fmtUsd(p.bestAsk), 10), 10),
        rowBg ? [bg(rowBg)(fg(C.orange)(padLeft(spread, 8)))] : [fg(C.orange)(padLeft(spread, 8))],
        rowBg ? [bg(rowBg)(fg(changeColor)(padLeft(changeText, 7)))] : [fg(changeColor)(padLeft(changeText, 7))],
        cell(padLeft(String(p.poolCount), 5), 5),
      ]);
    }

    return rows;
  }

  function buildPoolsTableContent(): TextTableContent {
    const headerRow = [
      [bold(fg(C.heading)("Pair"))],
      [bold(fg(C.heading)("DEX"))],
      [bold(fg(C.heading)(padLeft("FEE", 6)))],
      [bold(fg(C.heading)(padLeft("TVL", 10)))],
      [bold(fg(C.heading)(padLeft("VOL", 10)))],
      [bold(fg(C.heading)(padLeft("PX", 10)))],
    ];

    const rows: TextTableContent = [headerRow];
    for (const p of topPools) {
      const symbolA = p.symbolA || "?";
      const symbolB = p.symbolB || shortAddr(p.address);
      rows.push([
        [bold(fg(C.purple)(`${symbolA}/${symbolB}`))],
        chunk(dexShort(p.dex)),
        chunk(padLeft(`${p.feeBps}bp`, 6)),
        [fg(p.tvlUsd ? C.text : C.muted)(padLeft(p.tvlUsd ? fmtUsd(p.tvlUsd) : "--", 10))],
        [fg(p.volume24hUsd ? C.text : C.muted)(padLeft(p.volume24hUsd ? fmtUsd(p.volume24hUsd) : "--", 10))],
        chunk(padLeft(p.price ? fmtUsd(p.price) : "--", 10)),
      ]);
    }
    if (topPools.length === 0) {
      rows.push([[fg(C.muted)("Loading...")], null, null, null, null, null]);
    }
    return rows;
  }

  function buildFeedTableContent(): TextTableContent {
    if (poolFeed.length === 0) {
      return [[[fg(C.muted)("Waiting for new pools...")], null, null, null, null]];
    }

    return poolFeed.map((entry) => ([
      chunk(entry.ts),
      chunk(padRight(entry.dex, 12)),
      [bold(fg(C.cyan)(padRight(entry.token, 12)))],
      chunk(padRight(entry.pair, 24)),
      chunk(padLeft(entry.address, 12)),
    ]));
  }

  // ── price event handler ───────────────────────────────────────────────
  function handlePriceEvent(price: PriceEvent) {
    totalEvents++;
    eventTimestamps.push(Date.now());
    connected = true;

    const key = tokenKey(price.token);
    const prev = prevPrices.get(key);
    prevPrices.set(key, price.priceUsd);

    const isPreConfirmation = isPreConfirmationConfidence(price.confidence);

    // Prefer confirmed prices, but show pre-confirmation prices until a confirmed one arrives.
    const prevDisplayed = latestPrices.get(key);
    if (!isPreConfirmation) {
      if (prevDisplayed && prevDisplayed.priceUsd !== price.priceUsd) {
        flashState.set(key, {
          dir: price.priceUsd > prevDisplayed.priceUsd ? "up" : "down",
          at: Date.now(),
        });
      }
      latestPrices.set(key, price);
      dirtyPrices = true;
    } else if (!prevDisplayed) {
      latestPrices.set(key, price);
      dirtyPrices = true;
    }

    const ts = timeStr();
    const token = price.token.padEnd(8);
    const priceStr = `$${fmtPrice(price.priceUsd)}`;

    let arrow = " ";
    let deltaStr = "";
    if (prev !== undefined && prev > 0) {
      const deltaPct = ((price.priceUsd - prev) / prev) * 100;
      if (Math.abs(deltaPct) > 0.0001) {
        arrow = deltaPct > 0 ? "▲" : "▼";
        const sign = deltaPct > 0 ? "+" : "";
        deltaStr = `${sign}${deltaPct.toFixed(4)}%`;
      }
    }

    const dexStr = price.bestBidDex ? dexShort(price.bestBidDex) : "";
    const lineTxt = padRight(`${ts}  ${token} ${priceStr.padStart(14)}  ${arrow} ${deltaStr.padStart(10)}  ${dexStr.padEnd(9)}`, TICK_LINE_WIDTH);

    // Background color by confidence level
    const bgColor = isPreConfirmation ? "#2a2a0a" : "#0a2a1a";
    const glyph = tokenGlyph(price.token);
    const styledLine = t`${glyph} ${bg(bgColor)(lineTxt)}`;

    tickerFeed.unshift({ token: price.token, dex: dexStr, line: styledLine });
    if (tickerFeed.length > TICKER_MAX) tickerFeed.length = TICKER_MAX;
    dirtyTicker = true;
    requestUiRefresh();
  }

  // ── update loop (only rebuild when data changes) ─────────────────────
  let lastStatusEvt = -1;
  let lastStatusConn = connected;

  renderer.setFrameCallback(async () => {
    // Expire flash states — mark prices dirty if any flash expired
    const now = Date.now();
    for (const [token, flash] of flashState) {
      if (now - flash.at >= FLASH_DURATION_MS) {
        flashState.delete(token);
        dirtyPrices = true;
      }
    }

    if (dirtyPrices) {
      priceTable.content = buildPriceTableContent();
      dirtyPrices = false;
    }

    if (dirtyPools) {
      poolsTable.content = buildPoolsTableContent();
      dirtyPools = false;
    }

    if (dirtyTicker && tickerFeed.length > 0) {
      const allChunks: any[] = [];
      let count = 0;
      for (const entry of tickerFeed) {
        if (filterActive) {
          const q = filterQuery;
          if (!entry.token.toUpperCase().includes(q) &&
              !entry.dex.toUpperCase().includes(q)) continue;
        }
        if (count > 0) allChunks.push({ __isChunk: true, text: "\n" });
        allChunks.push(...entry.line.chunks);
        count++;
      }
      if (count > 0) {
        tickerText.content = new StyledText(allChunks);
      } else {
        tickerText.content = t`${fg(C.muted)("No matching events...")}`;
      }
      dirtyTicker = false;
    }

    if (dirtyFeed) {
      feedTable.content = buildFeedTableContent();
      dirtyFeed = false;
    }

    // Status bar — only rebuild when values change
    if (eventsPerMin !== lastStatusEvt || connected !== lastStatusConn) {
      lastStatusEvt = eventsPerMin;
      lastStatusConn = connected;
      const connIcon = connected ? fg(C.green)("●") : fg(C.red)("●");
      const connLabel = connected ? fg(C.green)("CONNECTED") : fg(C.red)("DISCONNECTED");
      const modeLabel = mode === "SSE" ? fg(C.green)("SSE") : fg(C.yellow)("ANON");
      statusBar.content = t`${bg(C.panel)(fg(C.text)(" "))}${bg(C.panel)(connIcon)}${bg(C.panel)(fg(C.text)(" LIVE "))}${bg(C.panel)(fg(C.muted)("│"))}${bg(C.panel)(fg(C.text)(" MODE "))}${bg(C.panel)(modeLabel)}${bg(C.panel)(fg(C.muted)("│"))}${bg(C.panel)(fg(C.text)(" POOLS "))}${bg(C.panel)(fg(C.cyan)(String(totalPoolCount)))}${bg(C.panel)(fg(C.muted)("│"))}${bg(C.panel)(fg(C.text)(" EVT/MIN "))}${bg(C.panel)(fg(C.cyan)(String(eventsPerMin)))}${bg(C.panel)(fg(C.muted)("│"))}${bg(C.panel)(fg(C.orange)(" / FILTER "))}${bg(C.panel)(fg(C.muted)("│"))}${bg(C.panel)(fg(C.orange)(" ENTER BROWSE "))}${bg(C.panel)(fg(C.muted)("│"))}${bg(C.panel)(fg(C.orange)(" Q QUIT "))}`;
    }
  });

  // Status bar
  const statusBar = new TextRenderable(renderer, {
    id: "status",
    content: t`${bg(C.panel)(fg(C.muted)(" CONNECTING... "))}`,
    selectable: false,
  });
  root.add(statusBar);

  // Events/sec counter
  setInterval(() => {
    const cutoff = Date.now() - 60_000;
    while (eventTimestamps.length > 0 && eventTimestamps[0] < cutoff) {
      eventTimestamps.shift();
    }
    eventsPerMin = eventTimestamps.length;
    requestUiRefresh();
  }, 1000);

  // ── keyboard ──────────────────────────────────────────────────────────
  renderer.keyInput.on("keypress", (key: KeyEvent) => {
    if (key.name === "q" && detailView === "hidden" && !filterInput.value) {
      api.disconnect();
      priceStreamApi.disconnect();
      poolStreamApi.disconnect();
      process.exit(0);
    }

    // / to focus filter, Escape to blur + clear
    if (key.name === "/" && detailView === "hidden") {
      filterInput.focus();
      return;
    }

    if (key.name === "escape") {
      if (detailView === "pool-detail") {
        showPoolSelect();
      } else if (detailView === "pool-select") {
        showTokenSelect();
      } else if (detailView === "token-select") {
        hideDetail();
      } else if (filterActive) {
        filterInput.value = "";
        filterQuery = "";
        filterActive = false;
        filterInput.blur();
        filterStatus.content = t`${fg(C.muted)("")}`;
        dirtyPrices = true;
        dirtyTicker = true;
        requestUiRefresh();
      }
    }

    if (key.name === "return" && detailView === "hidden") {
      showTokenSelect();
    }
  });

  // ── API connections ─────────────────────────────────────────────────────
  if (api.hasStreaming) {
    connectPriceStream();
    const checkConnected = setInterval(() => {
      if (totalEvents > 0) {
        connected = true;
        requestUiRefresh();
        clearInterval(checkConnected);
      }
    }, 500);

    poolStreamApi.streamPools(
      (pool) => {
        const token = poolHeadlineToken(pool);
        const pair = pool.symbolA && pool.symbolB
          ? `${pool.symbolA}/${pool.symbolB}`
          : `${shortAddr(pool.mintA)}/${shortAddr(pool.mintB)}`;
        poolFeed.unshift({
          ts: timeStr(),
          dex: dexShort(pool.dex),
          token,
          pair,
          address: shortAddr(pool.address),
        });
        if (poolFeed.length > POOL_FEED_MAX) poolFeed.length = POOL_FEED_MAX;
        dirtyFeed = true;
        requestUiRefresh();
      },
      () => {}
    );
  } else {
    const pollPrices = async () => {
      try {
        const tokensToFetch = streamTokens.length > 0 ? streamTokens : allTokens;
        const prices = await api.fetchPrices(tokensToFetch);
        for (const [, price] of Object.entries(prices)) {
          if (price?.priceUsd) handlePriceEvent(price);
        }
        connected = true;
        requestUiRefresh();
      } catch {
        connected = false;
        requestUiRefresh();
      }
    };
    pollPrices();
    setInterval(pollPrices, 3_000);
  }

  // Poll top pools
  const pollPools = async () => {
    try {
      const data = await api.fetchPools("SOL", 12);
      totalPoolCount = data.total;
      topPools = [...data.pools].sort((a, b) => (b.tvlUsd || 0) - (a.tvlUsd || 0)).slice(0, 12);
      dirtyPools = true;
      requestUiRefresh();
    } catch {}
  };
  pollPools();
  setInterval(pollPools, 30_000);

  renderer.requestRender();
}

// ── entry point ─────────────────────────────────────────────────────────────
async function main() {
  const renderer = await createCliRenderer({ exitOnCtrlC: true, targetFps: 30 });
  renderer.start();
  renderer.setBackgroundColor(C.bg);

  if (!apiKey) {
    apiKey = await showWelcome(renderer);
    if (apiKey) {
      saveConfig({ ...savedConfig, apiKey });
    }
  }
  await startDashboard(renderer, apiKey);
}

main().catch((err) => { console.error("Fatal:", err); process.exit(1); });
