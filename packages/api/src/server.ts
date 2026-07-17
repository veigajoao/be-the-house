// Public API: fixtures, live quotes (per-house eff odds), proof relays, SSE.
import Fastify from "fastify";
import { PublicKey } from "@solana/web3.js";
import { BthClient, math } from "@bethehouse/sdk";
import {
  MARKET_1X2,
  STABLE_PRICE_BOOKMAKER_ID,
  TxLineClient,
  type OddsRecord,
} from "@bethehouse/txline";
import { env } from "./env.js";

export async function buildServer(client: BthClient, txline: TxLineClient) {
  const app = Fastify({ logger: false });

  // the browser app calls this API cross-origin (3123 -> 8787)
  app.addHook("onSend", async (_req, reply, payload) => {
    reply.header("access-control-allow-origin", "*");
    return payload;
  });
  app.options("/*", async (_req, reply) =>
    reply
      .header("access-control-allow-origin", "*")
      .header("access-control-allow-methods", "GET, POST, OPTIONS")
      .header("access-control-allow-headers", "content-type")
      .send(),
  );

  // -- fixtures (cached 60s) --
  let fixturesCache: { at: number; data: unknown } | null = null;
  app.get("/fixtures", async () => {
    if (!fixturesCache || Date.now() - fixturesCache.at > 60_000) {
      fixturesCache = {
        at: Date.now(),
        data: await txline.fixtures({ competitionId: env.competitionId }),
      };
    }
    return fixturesCache.data;
  });

  // -- quotes: latest StablePrice print + every house's eff odds, best-first --
  app.get<{ Params: { fixtureId: string } }>("/quotes/:fixtureId", async (req, reply) => {
    const fixtureId = Number(req.params.fixtureId);
    const snapshot = await txline.oddsSnapshot(fixtureId);
    const print = snapshot.find(
      (r: OddsRecord) =>
        r.SuperOddsType === MARKET_1X2 &&
        r.BookmakerId === STABLE_PRICE_BOOKMAKER_ID &&
        !r.MarketPeriod &&
        !r.InRunning,
    );
    if (!print) return reply.code(404).send({ error: "no live 1X2 StablePrice print" });

    const houses = await (client.program.account as any).house.all();
    const quotes = [];
    for (const { publicKey, account } of houses) {
      if (account.paused) continue;
      let liability: [bigint, bigint, bigint] = [0n, 0n, 0n];
      try {
        const exp = await (client.program.account as any).fixtureExposure.fetch(
          client.pdas.exposure(publicKey, BigInt(fixtureId)),
        );
        liability = exp.liability.map((l: any) => BigInt(l.toString())) as typeof liability;
      } catch {
        /* no exposure yet */
      }
      const maxRisk = BigInt(account.maxRiskPerFixture.toString());
      const effOdds = [0, 1, 2].map((o) => {
        const skew = math.skewBps(account.skewCoeffBps, liability, o as 0 | 1 | 2, maxRisk);
        return Math.min(
          math.effOdds(print.Prices[o], account.spreadBps, skew),
          account.oddsCap,
        );
      });
      quotes.push({
        house: publicKey.toBase58(),
        owner: account.owner.toBase58(),
        houseId: account.houseId,
        spreadBps: account.spreadBps,
        oddsCap: account.oddsCap,
        effOdds, // x1000, ceiling shown to the bettor ("up to X")
      });
    }
    // best quote per outcome first
    const best = [0, 1, 2].map((o) =>
      [...quotes].sort((a, b) => b.effOdds[o] - a.effOdds[o]).map((q) => q.house),
    );
    return { fixtureId, print: { ts: print.Ts, prices: print.Prices }, quotes, best };
  });

  // -- proof relays (third-party keepers use these) --
  app.get<{ Querystring: { messageId: string; ts: string } }>(
    "/proofs/odds",
    async (req) => txline.oddsValidation(req.query.messageId, Number(req.query.ts)),
  );
  app.get<{ Querystring: { fixtureId: string; seq: string; statKeys?: string } }>(
    "/proofs/scores",
    async (req) =>
      txline.statValidation(
        Number(req.query.fixtureId),
        Number(req.query.seq),
        (req.query.statKeys ?? "1,2").split(",").map(Number),
      ),
  );

  // -- SSE odds relay (browser EventSource can't set auth headers) --
  app.get<{ Querystring: { fixtureId?: string } }>("/stream/odds", async (req, reply) => {
    const url = new URL(`${txline.apiBase}/api/odds/stream`);
    if (req.query.fixtureId) url.searchParams.set("fixtureId", req.query.fixtureId);
    const upstream = await fetch(url, {
      headers: { ...txline.headers(), Accept: "text/event-stream" },
    });
    if (!upstream.ok || !upstream.body) {
      return reply.code(502).send({ error: `upstream ${upstream.status}` });
    }
    reply.raw.writeHead(200, {
      "content-type": "text/event-stream",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
    });
    const reader = upstream.body.getReader();
    req.raw.on("close", () => reader.cancel().catch(() => {}));
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      reply.raw.write(value);
    }
    reply.raw.end();
  });

  app.get("/health", async () => ({ ok: true, program: client.program.programId.toBase58() }));

  return app;
}
