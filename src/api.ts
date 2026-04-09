/**
 * Venum API client — SSE streams + REST polling
 */

const DEFAULT_API = "https://api.venum.dev";
const USER_AGENT = "solana-venum-terminal/0.1.0";
const LOG_PREFIX = "[venum-terminal]";
const DEBUG_LOGS = Bun.env.VENUM_DEBUG === "1";

function log(...parts: Array<string | number>) {
  if (!DEBUG_LOGS) return;
  process.stderr.write(`${LOG_PREFIX} ${parts.join(" ")}\n`);
}

export interface PriceEvent {
  token: string;
  priceUsd: number;
  bestBid: number;
  bestAsk: number;
  bestBidDex: string;
  bestAskDex: string;
  bestBidFeeBps: number;
  bestAskFeeBps: number;
  poolCount: number;
  confidence: string;
  change24h?: number;
  timestamp: number;
}

export interface PoolEvent {
  address: string;
  dex: string;
  mintA: string;
  mintB: string;
  symbolA?: string;
  symbolB?: string;
  discoveredAt: number;
}

export interface Pool {
  address: string;
  dex: string;
  symbolA: string;
  symbolB: string;
  feeBps: number;
  tvlUsd: number | null;
  volume24hUsd: number | null;
  price: number | null;
  cacheAgeMs: number;
}

export interface HealthResponse {
  status: string;
  pools: number;
}

export interface PoolsResponse {
  pools: Pool[];
  count: number;
  total: number;
}

export type PriceHandler = (price: PriceEvent) => void;
export type PoolHandler = (pool: PoolEvent) => void;
export type HeartbeatHandler = (ts: number) => void;
export type ErrorHandler = (error: string) => void;

export class VenumAPI {
  private baseUrl: string;
  private apiKey: string | undefined;
  private abortControllers: AbortController[] = [];

  /** Whether SSE streams are available (requires API key). */
  get hasStreaming(): boolean { return !!this.apiKey; }

  constructor(baseUrl?: string, apiKey?: string) {
    this.baseUrl = baseUrl || DEFAULT_API;
    this.apiKey = apiKey;
  }

  private headers(): Record<string, string> {
    const h: Record<string, string> = {
      Accept: "text/event-stream",
      "User-Agent": USER_AGENT,
    };
    if (this.apiKey) h["X-API-Key"] = this.apiKey;
    return h;
  }

  private restHeaders(): Record<string, string> {
    const h: Record<string, string> = {
      "User-Agent": USER_AGENT,
    };
    if (this.apiKey) h["X-API-Key"] = this.apiKey;
    return h;
  }

  /** Connect to price SSE stream. Reconnects automatically on disconnect. */
  streamPrices(
    tokens: string[] = [],
    onPrice: PriceHandler,
    onHeartbeat?: HeartbeatHandler,
    onError?: ErrorHandler
  ): void {
    const params = new URLSearchParams();
    if (tokens.length > 0) params.set("tokens", tokens.join(","));
    params.set("includeOptimistic", "true");
    const query = params.toString() ? `?${params.toString()}` : "";
    const url = `${this.baseUrl}/v1/stream/prices${query}`;
    log("streamPrices", tokens.length > 0 ? `${tokens.length} tokens` : "ALL tokens");
    this.connectSSE(url, {
      price: (data: string) => {
        try { onPrice(JSON.parse(data)); } catch {}
      },
      heartbeat: (data: string) => {
        try {
          if (onHeartbeat) onHeartbeat(JSON.parse(data).ts);
        } catch {}
      },
    }, onError);
  }

  /** Connect to new pools SSE stream. */
  streamPools(
    onPool: PoolHandler,
    onError?: ErrorHandler
  ): void {
    const url = `${this.baseUrl}/v1/stream/pools`;
    log("streamPools subscribe");
    this.connectSSE(url, {
      "new-pool": (data: string) => {
        try { onPool(JSON.parse(data)); } catch {}
      },
    }, onError);
  }

  /** Fetch top pools by token. */
  async fetchPools(token: string, limit = 10): Promise<PoolsResponse> {
    const res = await fetch(
      `${this.baseUrl}/v1/pools?token=${token}&limit=${limit}`,
      { headers: this.restHeaders() }
    );
    if (!res.ok) throw new Error(`pools: ${res.status}`);
    return res.json() as Promise<PoolsResponse>;
  }

  /** Fetch prices via REST (free-tier fallback when no API key). */
  async fetchPrices(tokens: string[]): Promise<Record<string, PriceEvent>> {
    const res = await fetch(
      `${this.baseUrl}/v1/prices?tokens=${tokens.join(",")}`,
      { headers: this.restHeaders() }
    );
    if (!res.ok) throw new Error(`prices: ${res.status}`);
    const data = await res.json() as { prices: Record<string, PriceEvent> };
    return data.prices;
  }

  /** Health check. */
  async fetchHealth(): Promise<HealthResponse> {
    const res = await fetch(`${this.baseUrl}/health`, {
      headers: { "User-Agent": USER_AGENT },
    });
    if (!res.ok) throw new Error(`health: ${res.status}`);
    return res.json() as Promise<HealthResponse>;
  }

  /** Disconnect all streams. */
  disconnect(): void {
    for (const ac of this.abortControllers) ac.abort();
    this.abortControllers = [];
  }

  private async connectSSE(
    url: string,
    handlers: Record<string, (data: string) => void>,
    onError?: ErrorHandler
  ): Promise<void> {
    const ac = new AbortController();
    this.abortControllers.push(ac);

    const connect = async () => {
      try {
        log("SSE connect", url);
        const res = await fetch(url, {
          headers: this.headers(),
          signal: ac.signal,
        });

        if (!res.ok || !res.body) {
          onError?.(`HTTP ${res.status}`);
          log("SSE HTTP", res.status, url);
          if (!ac.signal.aborted) setTimeout(connect, 5000);
          return;
        }

        log("SSE connected", url);
        const decoder = new TextDecoder();
        const reader = res.body.getReader();
        let buffer = "";
        let eventType = "";

        while (true) {
          const { done, value } = await reader.read();
          if (done) break;

          buffer += decoder.decode(value, { stream: true });
          const lines = buffer.split("\n");
          buffer = lines.pop() || "";

          for (const line of lines) {
            if (line.startsWith("event: ")) {
              eventType = line.slice(7).trim();
            } else if (line.startsWith("data: ") && eventType) {
              const handler = handlers[eventType];
              if (handler) handler(line.slice(6));
              eventType = "";
            } else if (line === "") {
              eventType = "";
            }
          }
        }
        log("SSE closed", url);
      } catch (e: any) {
        if (ac.signal.aborted) return;
        log("SSE error", e?.message || e, url);
        onError?.(e.message);
      }

      // Reconnect unless aborted
      if (!ac.signal.aborted) {
        log("SSE reconnect", url);
        setTimeout(connect, 3000);
      }
    };

    connect();
  }
}
