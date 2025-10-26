
import React, { useEffect, useMemo, useRef, useState } from "react";

/**
 * WAFFLES — A tiny crypto market simulator you can interact with.
 *
 * - 1 real second == 1 simulated minute. Candles are 1-minute.
 * - Continuous double-auction with simple price-time priority per level (FIFO).
 * - Makers continuously place/cancel random limit orders around mid.
 * - You can place market/limit buy/sell; positions tracked with PnL.
 * - Order book shown aggregated by price level (0.01 tick).
 * - Simple SVG candlestick chart with ~200 bars history.
 */

type Side = "buy" | "sell";

type Order = {
  id: string;
  userId: string | "sim";
  side: Side;
  price: number;
  size: number;
  time: number;
  kind: "limit" | "market";
};

type Trade = {
  time: number;
  price: number;
  size: number;
  takerSide: Side;
};

type Candle = {
  t: number;
  o: number;
  h: number;
  l: number;
  c: number;
  v: number;
};

const rnd = (min: number, max: number) => Math.random() * (max - min) + min;
const clamp = (x: number, a: number, b: number) => Math.max(a, Math.min(b, x));
const fmt = (n: number) => n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const fmt4 = (n: number) => n.toLocaleString(undefined, { minimumFractionDigits: 4, maximumFractionDigits: 4 });
const genId = () => Math.random().toString(36).slice(2, 10);

const TICK = 0.01;
const roundTick = (p: number) => Math.round(p / TICK) * TICK;

class OrderBook {
  bids: Map<number, Order[]> = new Map();
  asks: Map<number, Order[]> = new Map();

  add(order: Order) {
    const book = order.side === "buy" ? this.bids : this.asks;
    const px = roundTick(order.price);
    const q = book.get(px) || [];
    q.push({ ...order, price: px });
    book.set(px, q);
  }

  bestBid(): number | null {
    if (this.bids.size === 0) return null;
    return Math.max(...this.bids.keys());
  }
  bestAsk(): number | null {
    if (this.asks.size === 0) return null;
    return Math.min(...this.asks.keys());
  }

  executeMarket(side: Side, size: number, now: number): { trades: Trade[]; avgPrice: number; filled: number } {
    const trades: Trade[] = [];
    let remain = size;
    let notional = 0;

    const book = side === "buy" ? this.asks : this.bids;
    const priceOrder = side === "buy"
      ? (a: number, b: number) => a - b
      : (a: number, b: number) => b - a;

    const levels = [...book.keys()].sort(priceOrder);
    for (const px of levels) {
      if (remain <= 0) break;
      const queue = book.get(px)!;
      while (queue.length && remain > 0) {
        const head = queue[0];
        const tradeSize = Math.min(remain, head.size);
        head.size -= tradeSize;
        remain -= tradeSize;
        notional += tradeSize * px;
        trades.push({ time: now, price: px, size: tradeSize, takerSide: side });
        if (head.size <= 1e-7) queue.shift();
      }
      if (queue.length === 0) book.delete(px);
    }

    const filled = size - remain;
    const avgPrice = filled > 0 ? notional / filled : 0;
    return { trades, avgPrice, filled };
  }

  placeAndMatch(order: Order, now: number): { trades: Trade[]; remaining?: Order } {
    const trades: Trade[] = [];

    if (order.kind === "market") {
      const res = this.executeMarket(order.side, order.size, now);
      trades.push(...res.trades);
      return { trades };
    }

    const bestOpp = order.side === "buy" ? this.bestAsk() : this.bestBid();
    if (
      bestOpp !== null &&
      ((order.side === "buy" && order.price >= bestOpp) || (order.side === "sell" && order.price <= bestOpp))
    ) {
      const res = this.executeMarket(order.side, order.size, now);
      trades.push(...res.trades);
      const remainingSize = order.size - res.filled;
      if (remainingSize > 1e-8) {
        const leftover = { ...order, size: remainingSize };
        this.add(leftover);
        return { trades, remaining: leftover };
      }
      return { trades };
    } else {
      this.add(order);
      return { trades, remaining: order };
    }
  }

  seedAround(mid: number, depth: number, maxQty: number) {
    for (let i = 1; i <= depth; i++) {
      const bidPx = roundTick(mid - i * TICK);
      const askPx = roundTick(mid + i * TICK);
      if (!this.bids.has(bidPx)) this.bids.set(bidPx, []);
      if (!this.asks.has(askPx)) this.asks.set(askPx, []);
      const bidQ = this.bids.get(bidPx)!;
      const askQ = this.asks.get(askPx)!;
      if (bidQ.length < 3) bidQ.push({ id: genId(), userId: "sim", side: "buy", price: bidPx, size: rnd(1, 20), time: Date.now(), kind: "limit" });
      if (askQ.length < 3) askQ.push({ id: genId(), userId: "sim", side: "sell", price: askPx, size: rnd(1, 20), time: Date.now(), kind: "limit" });
    }
  }

  snapshot(depth: number) {
    const sortedBids = [...this.bids.entries()].sort((a, b) => b[0] - a[0]).slice(0, depth);
    const sortedAsks = [...this.asks.entries()].sort((a, b) => a[0] - b[0]).slice(0, depth);
    const agg = (q: Order[]) => q.reduce((s, o) => s + o.size, 0);
    return {
      bids: sortedBids.map(([price, q]) => ({ price, size: agg(q) })),
      asks: sortedAsks.map(([price, q]) => ({ price, size: agg(q) })),
    };
  }
}

export default function WafflesSimulator() {
  const [running, setRunning] = useState(true);
  const [speed, setSpeed] = useState(1);
  const [cash, setCash] = useState(10000);
  const [position, setPosition] = useState(0);
  const [avgPrice, setAvgPrice] = useState(0);
  const [realized, setRealized] = useState(0);

  const [candles, setCandles] = useState<Candle[]>(() => {
    const start = Date.now() - 200 * 1000;
    const seed: Candle[] = [];
    let p = 1.0;
    for (let i = 0; i < 120; i++) {
      const t = start + i * 1000;
      const o = p;
      const delta = rnd(-0.01, 0.01);
      const c = roundTick(clamp(o + delta, 0.2, 5));
      const h = Math.max(o, c) + rnd(0, 0.01);
      const l = Math.min(o, c) - rnd(0, 0.01);
      const v = rnd(5, 25);
      p = c;
      seed.push({ t, o, h, l, c, v });
    }
    return seed;
  });

  const [book] = useState(() => new OrderBook());
  const [trades, setTrades] = useState<Trade[]>([]);
  const nowRef = useRef(Date.now());

  useEffect(() => {
    const mid = candles[candles.length - 1].c;
    book.seedAround(mid, 25, 20);
  }, []);

  useEffect(() => {
    if (!running) return;
    const id = setInterval(() => step(), 1000 / speed);
    return () => clearInterval(id);
  }, [running, speed]);

  const mark = candles[candles.length - 1]?.c ?? 1.0;
  const unrealized = position * (mark - avgPrice);
  const equity = cash + realized + unrealized;

  function step() {
    const now = Date.now();
    nowRef.current = now;

    if (Math.random() < 0.7) {
      const side: Side = Math.random() < 0.5 ? "buy" : "sell";
      const size = rnd(0.5, 12);
      const res = book.executeMarket(side, size, now);
      if (res.trades.length) setTrades((t) => [...t.slice(-100), ...res.trades]);
    }

    const mid = mark;
    book.seedAround(mid, 30, 20);

    let px = mark;
    if (trades.length) px = trades[trades.length - 1].price;
    else {
      const bb = book.bestBid();
      const ba = book.bestAsk();
      if (bb && ba) px = roundTick((bb + ba) / 2);
    }

    setCandles((cs) => {
      const last = cs[cs.length - 1];
      if (!last || now - last.t >= 1000 - 1) {
        const o = last?.c ?? px;
        const c = px;
        const h = Math.max(o, c) + rnd(0, 0.01);
        const l = Math.min(o, c) - rnd(0, 0.01);
        const v = rnd(5, 25);
        const bar: Candle = { t: now, o, h, l, c, v };
        return [...cs.slice(-199), bar];
      } else {
        last.h = Math.max(last.h, px);
        last.l = Math.min(last.l, px);
        last.c = px;
        last.v += rnd(0, 3);
        return [...cs.slice(0, -1), { ...last }];
      }
    });
  }

  function submitOrder(side: Side, kind: "market" | "limit", size: number, price?: number) {
    const now = nowRef.current;
    const id = genId();
    if (kind === "market") {
      const res = book.executeMarket(side, size, now);
      fillPosition(side, res.trades);
      if (res.trades.length) setTrades((t) => [...t.slice(-100), ...res.trades]);
    } else {
      const px = roundTick(price ?? mark);
      const order: Order = { id, userId: "you", side, price: px, size, time: now, kind: "limit" };
      const res = book.placeAndMatch(order, now);
      fillPosition(side, res.trades);
      if (res.trades.length) setTrades((t) => [...t.slice(-100), ...res.trades]);
    }
  }

  function fillPosition(side: Side, fills: Trade[]) {
    if (!fills.length) return;
    let newCash = cash;
    let newPos = position;
    let newAvg = avgPrice;
    let newReal = realized;

    for (const f of fills) {
      if (side === "buy") {
        if (newPos >= 0) {
          const totalCost = newAvg * newPos + f.price * f.size;
          newPos += f.size;
          newAvg = newPos > 0 ? totalCost / newPos : 0;
          newCash -= f.price * f.size;
        } else {
          const closeSize = Math.min(f.size, -newPos);
          newCash -= f.price * closeSize;
          newReal += (newAvg - f.price) * closeSize;
          newPos += closeSize;
          const leftover = f.size - closeSize;
          if (leftover > 0) {
            const totalCost = f.price * leftover;
            newPos += leftover;
            newAvg = totalCost / newPos;
            newCash -= f.price * leftover;
          }
        }
      } else {
        if (newPos <= 0) {
          if (newPos < 0) {
            const totalProceeds = -newAvg * newPos + f.price * f.size;
            newPos -= f.size;
            newAvg = newPos < 0 ? -totalProceeds / newPos : 0;
          } else {
            newPos -= f.size;
            newAvg = -newAvg;
          }
          newCash += f.price * f.size;
        } else {
          const closeSize = Math.min(f.size, newPos);
          newCash += f.price * closeSize;
          newReal += (f.price - newAvg) * closeSize;
          newPos -= closeSize;
          const leftover = f.size - closeSize;
          if (leftover > 0) {
            newPos -= leftover;
            newAvg = f.price;
            newCash += f.price * leftover;
          }
        }
      }
    }

    if (Math.abs(newPos) < 1e-8) {
      newPos = 0;
      newAvg = 0;
    }

    setCash(newCash);
    setPosition(newPos);
    setAvgPrice(newAvg);
    setRealized(newReal);
  }

  function flatten() {
    if (position === 0) return;
    submitOrder(position > 0 ? "sell" : "buy", "market", Math.abs(position));
  }

  function resetSim() {
    setRunning(false);
    setTimeout(() => {
      setCash(10000);
      setPosition(0);
      setAvgPrice(0);
      setRealized(0);
      setTrades([]);
      (book as any).bids = new Map();
      (book as any).asks = new Map();
      const start = Date.now() - 200 * 1000;
      const seed: Candle[] = [];
      let p = 1.0;
      for (let i = 0; i < 120; i++) {
        const t = start + i * 1000;
        const o = p;
        const delta = rnd(-0.01, 0.01);
        const c = roundTick(clamp(o + delta, 0.2, 5));
        const h = Math.max(o, c) + rnd(0, 0.01);
        const l = Math.min(o, c) - rnd(0, 0.01);
        const v = rnd(5, 25);
        p = c;
        seed.push({ t, o, h, l, c, v });
      }
      setCandles(seed);
      book.seedAround(1.0, 25, 20);
      setRunning(true);
    }, 50);
  }

  const snapshot = useMemo(() => book.snapshot(15), [candles]);
  const bestBid = book.bestBid();
  const bestAsk = book.bestAsk();
  const spread = bestBid && bestAsk ? bestAsk - bestBid : 0;

  const mark = candles[candles.length - 1]?.c ?? 1.0;
  const unrealized = position * (mark - avgPrice);
  const equity = cash + realized + unrealized;

  return (
    <div className="w-full min-h-[680px] grid grid-cols-12 gap-4 p-4 bg-neutral-950 text-neutral-100">
      <div className="col-span-7 flex flex-col gap-4">
        <div className="bg-neutral-900 rounded-2xl p-3 shadow-xl">
          <div className="flex items-center justify-between mb-2">
            <h2 className="text-xl font-semibold">WAFFLES/USD — 1m</h2>
            <div className="text-sm opacity-90">Last: <span className="font-mono">${fmt(mark)}</span> · Spread: <span className="font-mono">{fmt4(spread)}</span></div>
          </div>
          <CandleChart candles={candles} />
        </div>
        <div className="bg-neutral-900 rounded-2xl p-3 shadow-xl">
          <div className="flex items-center justify-between mb-2">
            <h3 className="font-semibold">Recent Trades</h3>
            <div className="text-sm">{trades.length} shown</div>
          </div>
          <TradeTape trades={trades.slice(-50)} />
        </div>
      </div>

      <div className="col-span-3 flex flex-col gap-4">
        <div className="bg-neutral-900 rounded-2xl p-4 shadow-xl">
          <h3 className="font-semibold mb-3">Order Entry</h3>
          <OrderEntry
            bestBid={bestBid ?? undefined}
            bestAsk={bestAsk ?? undefined}
            onSubmit={submitOrder}
          />
          <div className="mt-4 flex items-center gap-2">
            <button className="px-3 py-2 rounded-xl bg-neutral-800 hover:bg-neutral-700" onClick={() => setRunning((r) => !r)}>{running ? "Pause" : "Resume"}</button>
            <button className="px-3 py-2 rounded-xl bg-neutral-800 hover:bg-neutral-700" onClick={flatten}>Flatten</button>
            <button className="px-3 py-2 rounded-xl bg-neutral-800 hover:bg-neutral-700" onClick={resetSim}>Reset</button>
          </div>
          <div className="mt-3 flex items-center gap-3">
            <label className="text-sm opacity-80">Speed</label>
            <input type="range" min={0.25} max={4} step={0.25} value={speed} onChange={(e) => setSpeed(parseFloat(e.target.value))} />
            <span className="text-sm font-mono">{speed.toFixed(2)}×</span>
          </div>
        </div>

        <div className="bg-neutral-900 rounded-2xl p-4 shadow-xl">
          <h3 className="font-semibold mb-3">Account</h3>
          <div className="grid grid-cols-2 gap-2 text-sm">
            <span className="opacity-70">Cash</span><span className="text-right font-mono">${fmt(cash)}</span>
            <span className="opacity-70">Position</span><span className="text-right font-mono">{fmt4(position)} WAFL</span>
            <span className="opacity-70">Avg Price</span><span className="text-right font-mono">{avgPrice ? fmt(avgPrice) : "—"}</span>
            <span className="opacity-70">Unrealized</span><span className={`text-right font-mono ${unrealized>=0?"text-green-400":"text-red-400"}`}>${fmt(unrealized)}</span>
            <span className="opacity-70">Realized</span><span className={`text-right font-mono ${realized>=0?"text-green-400":"text-red-400"}`}>${fmt(realized)}</span>
            <span className="opacity-70">Equity</span><span className="text-right font-mono">${fmt(equity)}</span>
          </div>
        </div>
      </div>

      <div className="col-span-2 flex flex-col gap-4">
        <div className="bg-neutral-900 rounded-2xl p-3 shadow-xl">
          <h3 className="font-semibold mb-2">Order Book (Top 15)</h3>
          <OrderBookView bids={snapshot.bids} asks={snapshot.asks} />
        </div>
      </div>
    </div>
  );
}

function OrderEntry({ bestBid, bestAsk, onSubmit }: { bestBid?: number; bestAsk?: number; onSubmit: (side: Side, kind: "market" | "limit", size: number, price?: number) => void }) {
  const [side, setSide] = useState<Side>("buy");
  const [kind, setKind] = useState<"market" | "limit">("market");
  const [size, setSize] = useState(1);
  const [price, setPrice] = useState<number | "">("");

  return (
    <div className="space-y-3">
      <div className="flex gap-2">
        <button onClick={() => setSide("buy")} className={`px-3 py-2 rounded-xl ${side === "buy" ? "bg-green-700" : "bg-neutral-800 hover:bg-neutral-700"}`}>Buy</button>
        <button onClick={() => setSide("sell")} className={`px-3 py-2 rounded-xl ${side === "sell" ? "bg-red-700" : "bg-neutral-800 hover:bg-neutral-700"}`}>Sell</button>
        <button onClick={() => setKind("market")} className={`ml-4 px-3 py-2 rounded-xl ${kind === "market" ? "bg-blue-700" : "bg-neutral-800 hover:bg-neutral-700"}`}>Market</button>
        <button onClick={() => setKind("limit")} className={`px-3 py-2 rounded-xl ${kind === "limit" ? "bg-blue-700" : "bg-neutral-800 hover:bg-neutral-700"}`}>Limit</button>
      </div>
      <div className="grid grid-cols-3 gap-2 items-center text-sm">
        <label className="opacity-80">Size</label>
        <input type="number" min={0.01} step={0.01} value={size} onChange={(e) => setSize(Math.max(0.01, parseFloat(e.target.value)))} className="col-span-2 px-2 py-1 bg-neutral-800 rounded" />
        {kind === "limit" && (
          <>
            <label className="opacity-80">Price</label>
            <input type="number" step={0.01} value={price as any} onChange={(e) => setPrice(e.target.value === "" ? "" : parseFloat(e.target.value))} className="col-span-2 px-2 py-1 bg-neutral-800 rounded" />
          </>
        )}
      </div>
      <div className="flex items-center gap-2 text-xs opacity-80">
        <span>Best Bid: {bestBid ? fmt(bestBid) : "—"}</span>
        <span>·</span>
        <span>Best Ask: {bestAsk ? fmt(bestAsk) : "—"}</span>
      </div>
      <button
        className="w-full py-2 rounded-xl bg-indigo-600 hover:bg-indigo-500"
        onClick={() => {
          const px = kind === "limit" ? (price === "" ? undefined : Number(price)) : undefined;
          onSubmit(side, kind, size, px);
        }}
      >
        Submit {side.toUpperCase()} {kind.toUpperCase()}
      </button>
    </div>
  );
}

function OrderBookView({ bids, asks }: { bids: { price: number; size: number }[]; asks: { price: number; size: number }[] }) {
  const max = Math.max(1, ...bids.map((b) => b.size), ...asks.map((a) => a.size));
  return (
    <div className="grid grid-cols-1 gap-1 text-sm font-mono">
      {[...asks].reverse().map((l) => (
        <div key={`ask-${l.price}`} className="relative">
          <div className="absolute inset-y-0 right-0 bg-red-900/40" style={{ width: `${(l.size / max) * 100}%` }} />
          <div className="relative z-10 flex justify-between px-2 py-0.5">
            <span className="text-red-400">{fmt4(l.price)}</span>
            <span className="opacity-80">{fmt4(l.size)}</span>
          </div>
        </div>
      ))}
      <div className="text-center text-xs opacity-60 py-1">— Mid —</div>
      {bids.map((l) => (
        <div key={`bid-${l.price}`} className="relative">
          <div className="absolute inset-y-0 left-0 bg-green-900/40" style={{ width: `${(l.size / max) * 100}%` }} />
          <div className="relative z-10 flex justify-between px-2 py-0.5">
            <span className="text-green-400">{fmt4(l.price)}</span>
            <span className="opacity-80">{fmt4(l.size)}</span>
          </div>
        </div>
      ))}
    </div>
  );
}

function TradeTape({ trades }: { trades: Trade[] }) {
  return (
    <div className="max-h-56 overflow-auto divide-y divide-neutral-800 rounded-md border border-neutral-800">
      {trades.slice().reverse().map((t, i) => (
        <div className="flex justify-between px-2 py-1 text-sm font-mono" key={i}>
          <span className={t.takerSide === "buy" ? "text-green-400" : "text-red-400"}>{t.takerSide.toUpperCase()}</span>
          <span>{fmt(t.price)}</span>
          <span className="opacity-80">{fmt4(t.size)}</span>
        </div>
      ))}
      {!trades.length && <div className="p-3 text-sm opacity-70">No trades yet</div>}
    </div>
  );
}

function CandleChart({ candles }: { candles: Candle[] }) {
  const ref = React.useRef<SVGSVGElement | null>(null);
  const w = 800;
  const h = 320;
  const padL = 40, padR = 10, padT = 10, padB = 20;
  const viewW = w - padL - padR;
  const viewH = h - padT - padB;

  const data = candles.slice(-200);
  const highs = data.map((d) => d.h);
  const lows = data.map((d) => d.l);
  const yMax = Math.max(...highs);
  const yMin = Math.min(...lows);

  const xScale = (i: number) => padL + (i / Math.max(1, data.length - 1)) * viewW;
  const yScale = (p: number) => padT + (1 - (p - yMin) / Math.max(1e-6, yMax - yMin)) * viewH;

  const barW = Math.max(2, (viewW / Math.max(5, data.length)) * 0.6);

  return (
    <svg ref={ref} width="100%" viewBox={`0 0 ${w} ${h}`}>
      <line x1={padL} y1={padT} x2={padL} y2={h - padB} stroke="#444" />
      <line x1={padL} y1={h - padB} x2={w - padR} y2={h - padB} stroke="#444" />
      {Array.from({ length: 5 }).map((_, i) => {
        const y = padT + (i / 4) * viewH;
        const p = yMax - (i / 4) * (yMax - yMin);
        return (
          <g key={i}>
            <line x1={padL} x2={w - padR} y1={y} y2={y} stroke="#222" />
            <text x={5} y={y + 4} fontSize={10} fill="#aaa" className="font-mono">{fmt(p)}</text>
          </g>
        );
      })}
      {data.map((d, i) => {
        const x = xScale(i);
        const yO = yScale(d.o);
        const yC = yScale(d.c);
        const yH = yScale(d.h);
        const yL = yScale(d.l);
        const up = d.c >= d.o;
        const color = up ? "#16a34a" : "#dc2626";
        const bodyTop = Math.min(yO, yC);
        const bodyH = Math.max(2, Math.abs(yC - yO));
        return (
          <g key={d.t}>
            <line x1={x} x2={x} y1={yH} y2={yL} stroke={color} />
            <rect x={x - barW / 2} y={bodyTop} width={barW} height={bodyH} fill={color} />
          </g>
        );
      })}
    </svg>
  );
}
