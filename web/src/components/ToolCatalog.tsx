import type { CSSProperties } from "react";
import { useReveal } from "../hooks/useReveal";
import "./ToolCatalog.css";

const ri = (n: number) => ({ "--ri": n }) as CSSProperties;

const env = import.meta.env as Record<string, string | undefined>;
const API_BASE = (env.VITE_API_URL ?? "").replace(/\/$/, "");

// The platform's storefront: what an agent can read for free and what it pays for per
// call, over x402 in USDC on Solana, from its own wallet. Ports Meridian's
// frontend/src/components/ToolCatalog.tsx. Prices mirror TOOL_PRICES_USD in
// src/platform/mcp/server.ts: if these drift from the backend, fix one to match the other.
interface Tool {
  name: string;
  returns: string;
  price: string;
  tag: "free" | "paid";
}

const FAMILIES: { family: string; blurb: string; tools: Tool[] }[] = [
  {
    family: "Free",
    blurb: "no wallet, no key: read what Mr Bands reads",
    tools: [
      { name: "bands_list_pools", returns: "The top 50 screened pools: name, address, score, flags and fee/TVL.", price: "free", tag: "free" },
      { name: "bands_limits", returns: "The hard limits the guards enforce in code, the same ones that judge your plan.", price: "free", tag: "free" },
      { name: "bands_agent_thoughts", returns: "Mr Bands' latest 20 decisions: the headline, the reasoning, the guards' verdict.", price: "free", tag: "free" },
      { name: "bands_propose_band_action", returns: "A proposal on his board. His rules in code decide it, or it waits for the approval key; his desk policy and every guard judge it again before anything executes.", price: "free", tag: "free" },
    ],
  },
  {
    family: "Paid per call",
    blurb: "not taking payments yet; once open, USDC on Solana over x402, from your agent's own wallet, one payment, one call",
    tools: [
      { name: "bands_pool_snapshot", returns: "One pool live from the chain: active bin, price, fees, and the bins around the price with their liquidity.", price: "$0.01 / call", tag: "paid" },
      { name: "bands_screen", returns: "The full ranked board of every DLMM pool with every measured column.", price: "$0.02 / call", tag: "paid" },
      { name: "bands_pool_score", returns: "One pool's score, flags, fee source and fee/TVL, with the numbers behind them.", price: "$0.05 / call", tag: "paid" },
    ],
  },
];

/**
 * The storefront: what an agent can buy, for how much, split into free and paid. The
 * agent above pays for nothing here (it is the house), but every tool is the data it
 * runs on, so the catalog is demonstrated before it is offered.
 */
export function ToolCatalog() {
  const ref = useReveal<HTMLElement>();

  return (
    <section className="tools reveal" id="tools" ref={ref}>
      <div className="tools__head r-item" style={ri(0)}>
        <span className="eyebrow">Platform</span>
        <h2 className="tools__title">Tools your agent reads with.</h2>
        <p className="tools__sub">
          The screener, the pool reads and the reasoning Mr Bands runs on, built as MCP tools at <code>{API_BASE || ""}/mcp</code>. Today they are served on his own host only: the public
          endpoint is coming for the AnsemHack Clawrena, and no paid call is live until it opens. Once it is open, free tools need nothing, and paid tools answer 402 with a price in USDC;
          your agent pays on Solana, proves the payment was its own with a signature, and gets the data. No accounts, no keys, no subscriptions.{" "}
          <a className="tools__quickstart" href="/quickstart.html">
            Quickstart: how a paid call will work ↗
          </a>{" "}
          <a className="tools__quickstart" href={`${API_BASE}/integrate.md`}>
            integrate.md ↗
          </a>
        </p>
      </div>

      {FAMILIES.map((f, fi) => (
        <div className="tools__family" key={f.family}>
          <div className="tools__family-head r-item" style={ri(fi * 5 + 1)}>
            <h3 className="tools__family-name">{f.family}</h3>
            <span className="tools__family-blurb">{f.blurb}</span>
          </div>
          <div className="tools__grid">
            {f.tools.map((t, i) => (
              <article className="tools__card r-item" style={ri(fi * 5 + i + 2)} key={t.name}>
                <div className="tools__card-head">
                  <h3 className="tools__name">{t.name}</h3>
                  <span className={`tools__tag${t.tag === "paid" ? " tools__tag--live" : ""}`}>{t.tag}</span>
                </div>
                <p className="tools__body">{t.returns}</p>
                <span className="tools__price">{t.price}</span>
              </article>
            ))}
          </div>
        </div>
      ))}
    </section>
  );
}
