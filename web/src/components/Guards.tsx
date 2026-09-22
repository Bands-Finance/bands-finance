import type { CSSProperties, ReactNode } from "react";
import { useReveal } from "../hooks/useReveal";
import type { AgentRecord } from "../model";
import type { RiskLimits } from "../types";
import "./ToolCatalog.css";

const ri = (n: number) => ({ "--ri": n }) as CSSProperties;

/** A glossed term: dotted underline, the plain-words definition on hover or focus. */
const T = ({ t, children }: { t: string; children: ReactNode }) => (
  <span className="term" title={t} tabIndex={0}>
    {children}
  </span>
);

export interface GuardsProps {
  limits: RiskLimits | null;
  record: AgentRecord | null;
  maxActivePools?: number;
}

type Kind = "cap" | "reserve" | "forced" | "refusal" | "switch";
const KIND_WORD: Record<Kind, string> = { cap: "cap", reserve: "kept back", forced: "forced exit", refusal: "refused", switch: "off switch" };
const KIND_CLASS: Record<Kind, string> = { cap: "", reserve: "", forced: " tools__tag--soon", refusal: " tools__tag--soon", switch: " tools__tag--soon" };

interface Rule {
  name: string;
  value: string;
  body: ReactNode;
  kind: Kind;
  wide?: boolean;
}

interface Family {
  name: string;
  blurb: string;
  rules: Rule[];
}

const NA = "n/a";
const n = (v: number | undefined, unit = "") => (v === undefined ? NA : `${v}${unit}`);

// The rules are plain code around whatever proposes his moves: caps, reserves, a stop-loss, a
// cooldown, an off switch. Grouped by what they govern so the ten of them read
// as a rulebook, not a settings dump. The numbers come from /api/limits; the
// sentences are what each number means.
function familiesOf(l: RiskLimits | null, maxActivePools: number): Family[] {
  const L = l ?? undefined;
  const minutesApart = L ? Math.round(L.minSecondsBetweenActions / 60) : undefined;
  return [
    {
      name: "How much",
      blurb: "the money he may put out",
      rules: [
        {
          name: "Max per band",
          value: n(L?.maxPositionSol, " SOL"),
          body: (
            <>
              the most he can put in one{" "}
              <T t="A band is a slice of price he puts SOL into. Every trade that crosses it pays him a fee.">band</T>
            </>
          ),
          kind: "cap",
        },
        { name: "Max out at once", value: n(L?.maxTotalExposureSol, " SOL"), body: <>across every band in every pool</>, kind: "cap" },
        {
          name: "Gas reserve",
          value: n(L?.gasReserveSol, " SOL"),
          body: (
            <>
              must stay in the wallet for{" "}
              <T t="Fees: what Solana charges per transaction. Rent: a deposit Solana holds while a band exists; it comes back when the band is closed.">fees and rent</T>
            </>
          ),
          kind: "reserve",
        },
      ],
    },
    {
      name: "How wide, how often, how many",
      blurb: "the shape of a band, the pace of a day",
      rules: [
        {
          name: "Max band width",
          value: n(L?.maxBinWidth, " bins"),
          body: (
            <>
              <T t="Pools on Meteora cut price into small steps called bins. A band is a run of bins.">bins</T> are the price steps a band is made of
            </>
          ),
          kind: "cap",
        },
        { name: "Actions per day", value: n(L?.maxTxPerDay), body: <>at least {minutesApart ?? NA} minutes apart</>, kind: "cap" },
        { name: "Pools at once", value: `${maxActivePools}`, body: <>new pools are refused past this</>, kind: "cap" },
      ],
    },
    {
      name: "What gets refused or forced",
      blurb: "checks that override him",
      rules: [
        {
          name: "Deposit slippage",
          value: n(L?.maxSlippagePct, "%"),
          body: (
            <>
              a{" "}
              <T t="A fill is the price a deposit goes in at; slippage is the gap from the price expected.">fill</T>{" "}
              worse than this is refused
            </>
          ),
          kind: "refusal",
        },
        {
          name: "Price sanity",
          value: L ? `> ${L.maxPriceMovePctPerCycle}% in one cycle` : NA,
          body: (
            <>
              no new bands after a jump that big (a{" "}
              <T t="A cycle is one look at the pool, every 5 minutes.">cycle</T> is one 5-minute look)
            </>
          ),
          kind: "refusal",
        },
        { name: "Stop-loss", value: L ? `−${L.stopLossPct}%` : NA, body: <>a band this far below what went in is closed</>, kind: "forced" },
      ],
    },
    {
      name: "The off switch",
      blurb: "no vote, no delay",
      rules: [{ name: "Kill switch", value: "a file named STOP", body: <>blocks every new band the moment it exists</>, kind: "switch", wide: true }],
    },
  ];
}

const plural = (count: number, one: string, many = `${one}s`) => `${count} ${count === 1 ? one : many}`;

/**
 * The rules he can't break: enforced in code, outside his proposals. Rendered in the
 * same card grammar as the ported catalog so it sits natively between the
 * explainer and the journal.
 */
export function Guards({ limits, record, maxActivePools = 6 }: GuardsProps) {
  const ref = useReveal<HTMLElement>();
  const families = familiesOf(limits, maxActivePools);
  let idx = 0;
  const counts = record?.counts ?? null;

  return (
    <section className="tools reveal" id="guards" ref={ref} aria-label="The rules he can't break">
      <div className="tools__head r-item" style={ri(idx++)}>
        <span className="eyebrow">The guards</span>
        <h2 className="tools__title">The rules he can't break</h2>
        <p className="tools__sub">
          He sees them; he cannot change them.
          {!limits && <> No limits loaded yet.</>}
        </p>
      </div>

      {families.map((f) => (
        <div className="tools__family" key={f.name}>
          <div className="tools__family-head r-item" style={ri(idx++)}>
            <h3 className="tools__family-name">{f.name}</h3>
            <span className="tools__family-blurb">{f.blurb}</span>
          </div>
          <div className="tools__grid">
            {f.rules.map((r) => (
              <article className="tools__card r-item" style={{ ...ri(idx++), ...(r.wide ? { gridColumn: "1 / -1" } : null) }} key={r.name}>
                <div className="tools__card-head">
                  <h3 className="tools__name">{r.name}</h3>
                  <span className={`tools__tag${KIND_CLASS[r.kind]}`}>{KIND_WORD[r.kind]}</span>
                </div>
                <span className="tools__price" style={{ marginBottom: 8 }}>{r.value}</span>
                <p className="tools__body">{r.body}</p>
              </article>
            ))}
          </div>
        </div>
      ))}

      <div className="tools__family-head r-item" style={ri(idx++)}>
        {counts ? (
          <span className="tools__family-blurb">
            <b>{plural(counts.vetoed, "proposal")}</b> vetoed · <b>{plural(counts.overrides, "override")}</b> · <b>{counts.holds}</b> holds of {counts.decisions} decisions
          </span>
        ) : (
          <span className="tools__family-blurb">No decisions on file yet.</span>
        )}
      </div>
      <p className="tools__sub r-item" style={ri(idx++)}>
        Every veto and override is printed in the journal.
      </p>
    </section>
  );
}
