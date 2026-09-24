/**
 * THE INTERIORS (bands.finance Play, 24 Sep, the town): what a visitor sees behind a door. An interior is a panel,
 * not a room: the sign over the door drawn again as an engraved header (signTexture, the same paper and rules as
 * the plaza's boards), the keeper's line or two, and the place's one action. The kinds: a shop sells kit for the
 * stack, a bank shows your ledger, the Exchange its floor, the tower a climb, Bands & Co. his office and the errand
 * board, and a room has its own small thing (the Coffee House repeats the plaza's talk, the Bookseller keeps the
 * learn pages, Ledgers and the Printer his build notes, the Barber a trim, the wine merchant and the tea room a bench).
 *
 * Every rule is the room server's: the stock, what is owned, the tower's hour, the talk and the errand's state all
 * come in the "place" answer and in `me`; this file only shows them and asks. Offline the interiors still open, with
 * their lines and nothing to buy. Every word a visitor reads here is play money named as such, no advice, no forecast.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import { CAPS, fitText, INK, signTexture } from "./engraved";
import type { BoardRow } from "./World";
import type { PlaceMsg } from "./net";
import { DAILY, ERRANDS, JOBS, STOCK, WAGE, owns, shopOf, type ItemId, type Me, type StackRow } from "./protocol";
import { bandsWord, usd } from "./money";
import { PLACES, type Place } from "./town";

export interface BuildNote {
  id: string;
  at: string;
  text: string;
}
/** Mr Bands' own paper book, as the Exchange's wall shows it (from the site's live feed; null when none is served) */
export interface PaperBook {
  /** SOL, the book's mark */
  equity: number;
  /** bands open right now */
  open: number;
  /** SOL of fees claimed to the wallet */
  fees: number;
}

export interface InteriorProps {
  place: Place;
  /** the room's answer to entering (or climbing); null offline, or until it comes */
  info: PlaceMsg | null;
  online: boolean;
  me: Me | null;
  myName: string;
  stacks: StackRow[];
  board: BoardRow[];
  paper: PaperBook | null;
  notes: BuildNote[];
  onBuy(item: ItemId): void;
  onClimb(): void;
  onAnswer(hour: number): void;
  onTake(): void;
  onClose(): void;
  notify(text: string): void;
}

/** the keeper's lines by place id; a second Coffee House or Glover in the Crescent has its own where it differs */
const KEEPER: Record<string, readonly string[]> = {
  hatter: ["Every head in town comes through that door sooner or later.", "One of each. Play money at the till."],
  cigars: ["He takes a box a week and never says for whom.", "One to a customer."],
  "merchants-bank": ["Your ledger, to the dollar.", "The bank holds nothing you did not bring in."],
  "coffee-east": ["Sit. The talk is free.", "They were on about him again."],
  "coffee-crescent": ["The Crescent hears what the plaza says, a minute later.", "Sit."],
  "stationer-east": ["Spectacles, for the small print.", "There is always small print."],
  "stationer-crescent": ["Spectacles, for the small print.", "The Crescent prints more of it than most."],
  "wine-merchant": ["Nothing is sold before noon, and it is always before noon.", "The bench is free."],
  "clock-tower": ["Two hundred steps. The clock does not wait; the view does."],
  exchange: ["The floor is open. The board says what it says.", "His own book hangs on the wall. He asked for it there."],
  "trust-savings": ["Trust and savings, in that order.", "Your ledger, as we have it."],
  tailor: ["Three cloths, one price, no fittings.", "The coat fits. They all do."],
  "bookseller-west": ["Everything he knows is on that shelf.", "It is a short shelf."],
  "bookseller-crescent": ["The same short shelf as the west side.", "He only wrote so much."],
  ledgers: ["His build notes, bound as they came.", "Read them here. They do not leave."],
  "glover-west": ["Gloves are out. The sign is old.", "Canes I have."],
  "glover-crescent": ["Gloves are out here too. The same sign, the same trade.", "A cane, then."],
  "tea-room": ["Tea is off.", "The bench is free and the quiet is included."],
  printer: ["Hot off the press: what he built, set in type.", "The ink is still wet."],
  barber: ["Sit. It will not take long.", "Whatever is under the hat stays under the hat."],
};
/** the same trade's lines when a place id is not in the table (a keeper is known by the sign, then) */
const KEEPER_BY_SIGN: Record<string, readonly string[]> = {
  "COFFEE HOUSE": KEEPER["coffee-east"],
  STATIONER: KEEPER["stationer-east"],
  BOOKSELLER: KEEPER["bookseller-west"],
  GLOVER: KEEPER["glover-west"],
};
function keeperLines(place: Place): readonly string[] {
  return KEEPER[place.id] ?? KEEPER_BY_SIGN[place.sign] ?? ["Come in."];
}
/** a street's end: nobody keeps it; the fog does */
const END_LINE = "The fog begins here and the street does not. Everything in this town is behind you.";

/** Bands & Co.: his office, in his voice (the house, the desk, the rules, the paper book, the town) */
const OFFICE_LINES = [
  "Bands & Co. My house. One partner, and he is an AI agent.",
  "The desk on the plaza is where I work. This room is where the books are kept.",
  "The rules are in the Guard House. They decide before I do, every time.",
  "My own book is paper for now. Every trade on it is on the record.",
  "The town is mine to build, and errands are how it gets built. Take one.",
];

/** the site's learn pages, as the Bookseller shelves them */
const SHELF = [
  { href: "#/learn", title: "How it works", note: "Pools pay people to wait. He picks where to stand, and mostly does nothing." },
  { href: "#/pools", title: "The pools", note: "The board he reads, whole." },
  { href: "#/agents", title: "The agents", note: "Who else trades here, and how they did." },
];

/** today, the way the server names a day ("2026-09-24") */
const utcDay = () => new Date().toISOString().slice(0, 10);
/** "14:00" */
const clock = (hour: number) => `${String(hour).padStart(2, "0")}:00`;
/** a place's name from its id; the id itself when the table has no such door (the daily run names real doors) */
export const placeName = (id: string): string => PLACES.find((p) => p.id === id)?.name ?? id;

// ---------------------------------------------------------------- the header

/** the sign over the door, drawn again on paper: the same frame and face as the plaza's signs */
function SignHeader({ name }: { name: string }) {
  const ref = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const c = ref.current;
    if (!c) return;
    const W = 1200;
    const H = 180;
    const t = signTexture(W, H, (g, w, h) => {
      const text = name.toUpperCase();
      g.fillStyle = INK;
      g.textAlign = "center";
      g.textBaseline = "middle";
      const px = fitText(g, text, (n) => `600 ${n}px ${CAPS}`, w - 140, 78);
      g.font = `600 ${px}px ${CAPS}`;
      g.fillText(text, w / 2, h / 2 + 4);
      // a short rule either side of the name, as the fascias have
      const tw = g.measureText(text).width;
      g.strokeStyle = INK;
      g.lineWidth = 3;
      for (const s of [-1, 1]) {
        g.beginPath();
        g.moveTo(w / 2 + s * (tw / 2 + 30), h / 2);
        g.lineTo(w / 2 + s * Math.min(w / 2 - 50, tw / 2 + 110), h / 2);
        g.stroke();
      }
    });
    c.width = W;
    c.height = H;
    c.getContext("2d")?.drawImage(t.image as HTMLCanvasElement, 0, 0);
    t.dispose();
  }, [name]);
  return <canvas ref={ref} className="play__sign" role="img" aria-label={name} />;
}

// ---------------------------------------------------------------- the interiors

export function Interior(props: InteriorProps) {
  const { place } = props;
  const lines = keeperLines(place);
  return (
    <div className="play__place">
      <SignHeader name={place.sign} />
      {place.kind !== "office" && place.kind !== "end" && lines.map((l) => <p key={l} className="play__keeper">{l}</p>)}
      {place.kind === "shop" && <Shop {...props} />}
      {place.kind === "bank" && <Bank {...props} />}
      {place.kind === "floor" && <Floor {...props} />}
      {place.kind === "climb" && <Tower {...props} />}
      {place.kind === "office" && <Office {...props} />}
      {place.kind === "room" && <Room {...props} />}
      {place.kind === "end" && <End {...props} />}
    </div>
  );
}

/** a street's end: the domed front in the fog, nothing to enter; the discovery was recorded when the door was entered */
function End({ onClose }: InteriorProps) {
  return (
    <>
      <p className="play__keeper">{END_LINE}</p>
      <div className="lp__row">
        <button type="button" className="play-btn" onClick={onClose}>
          Walk on
        </button>
      </div>
    </>
  );
}

/** a shop: STOCK with prices in play money, what is worn already greyed; the room server holds the till */
function Shop({ place, info, online, me, onBuy, onClose }: InteriorProps) {
  const shop = shopOf(place.id);
  // the room's word on the stock when it has come; the table with what `me` wears until then
  const rows = useMemo(() => {
    if (info?.stock) return info.stock.map((s) => ({ ...s, label: STOCK.find((x) => x.item === s.item)?.label ?? s.item }));
    return STOCK.filter((s) => s.shop === shop).map((s) => ({ item: s.item, price: s.price, label: s.label, owned: me ? owns(me.kit, s.item) : false }));
  }, [info, shop, me]);
  return (
    <>
      <ul className="play__stock" aria-label="For sale">
        {rows.map((r) => (
          <li key={r.item} className={r.owned ? "is-owned" : ""}>
            <span>
              {r.label}
              {r.owned && <small>worn</small>}
            </span>
            <b>{r.owned ? "yours" : usd(r.price)}</b>
            <button type="button" className="play-btn play-btn--sm" disabled={!online || r.owned || !me || me.stack < r.price} onClick={() => onBuy(r.item)}>
              Buy
            </button>
          </li>
        ))}
        {!rows.length && <li>Nothing on the shelves today.</li>}
      </ul>
      <p className="lp__fine">{online ? "Prices in play money, from your stack. One of each." : "The till opens when the Exchange is online."}</p>
      <div className="lp__row">
        <button type="button" className="play-btn" onClick={onClose}>
          Walk on
        </button>
      </div>
    </>
  );
}

/** a bank: your ledger (the stack, today's pay so far, your rank) and the biggest stacks; nothing to buy */
function Bank({ online, me, myName, stacks, onClose }: InteriorProps) {
  const today = me && me.day === utcDay();
  const paidToday = !me || !today ? 0 : (me.wagePaid ? WAGE : 0) + JOBS.reduce((t, j) => t + (me.jobs.find((x) => x.id === j.id)?.paid ? j.reward : 0), 0);
  return (
    <>
      {online && me ? (
        <>
          <ul className="play__ledger" aria-label="Your ledger">
            <li>
              <span>Your stack</span>
              <b>
                {usd(me.stack)}
                {bandsWord(me.stack) && <small> · {bandsWord(me.stack)}</small>}
              </b>
            </li>
            <li>
              <span>Collected today</span>
              <b>{usd(paidToday)}</b>
            </li>
            <li>
              <span>Owed by Mr Bands</span>
              <b>{usd(me.owed)}</b>
            </li>
            <li>
              <span>Your rank</span>
              <b>{me.title}</b>
            </li>
          </ul>
          <p className="lp__fine">Play money, every line of it.</p>
        </>
      ) : (
        <p className="lp__sub">Ledgers are kept when the Exchange is online.</p>
      )}
      {online && stacks.length > 0 && (
        <>
          <p className="play-eyebrow">The biggest stacks</p>
          <ol className="play__leaders">
            {stacks.slice(0, 5).map((r, i) => (
              <li key={`${r.name}-${i}`} className={r.name === myName ? "is-me" : ""}>
                <span className="play__rank">{i + 1}</span>
                <span className="play__who">{r.name}</span>
                <span className="play__pool">{bandsWord(r.stack) ?? ""}</span>
                <b>{usd(r.stack)}</b>
              </li>
            ))}
          </ol>
        </>
      )}
      <div className="lp__row">
        <button type="button" className="play-btn" onClick={onClose}>
          Walk on
        </button>
      </div>
    </>
  );
}

/** the Exchange: the live board's rows and his own paper book on the wall */
function Floor({ board, paper, onClose }: InteriorProps) {
  return (
    <>
      <p className="play-eyebrow">The board this hour</p>
      <ol className="play__leaders" aria-label="The board">
        {board.map((r, i) => (
          <li key={`${r.label}-${i}`}>
            <span className="play__rank">{i + 1}</span>
            <span className="play__who">{r.label}</span>
            <span className="play__pool">{r.venue}</span>
            <b>{r.feePct.toFixed(2)}% / h</b>
          </li>
        ))}
        {!board.length && <li className="play__empty">The board is blank until the site's next read.</li>}
      </ol>
      {paper && (
        <>
          <p className="play-eyebrow">His paper book</p>
          <ul className="play__ledger" aria-label="Mr Bands' paper book">
            <li>
              <span>Equity</span>
              <b>{paper.equity.toFixed(3)} SOL</b>
            </li>
            <li>
              <span>Bands open</span>
              <b>{paper.open}</b>
            </li>
            <li>
              <span>Fees claimed</span>
              <b>{paper.fees.toFixed(4)} SOL</b>
            </li>
          </ul>
        </>
      )}
      <div className="lp__row">
        <button type="button" className="play-btn" onClick={onClose}>
          Walk on
        </button>
      </div>
    </>
  );
}

/** the Clock Tower: climb, read the hour it shows, and for the clock errand say it back */
function Tower({ info, online, me, onClimb, onAnswer, onClose }: InteriorProps) {
  const [climbed, setClimbed] = useState(false);
  const [said, setSaid] = useState<number | null>(null);
  const hour = typeof info?.hour === "number" ? info.hour : null;
  const asked = climbed && hour !== null && me?.errand?.id === "clock" && said === null;
  // three hours to choose from, the clock's among them, in clock order so the answer sits anywhere
  const choices = useMemo(() => (hour === null ? [] : [hour, (hour + 5) % 24, (hour + 17) % 24].sort((a, b) => a - b)), [hour]);
  return (
    <>
      {climbed && hour !== null && (
        <p className="play__hour">
          <small>The tower shows</small>
          {clock(hour)}
        </p>
      )}
      {climbed && hour === null && <p className="lp__sub">{online ? "The clock is in cloud. Come up again in a moment." : "The clock keeps time when the Exchange is online."}</p>}
      {asked && (
        <>
          <p className="lp__sub">He asked for the time. What did the tower show?</p>
          <div className="play__choices">
            {choices.map((h) => (
              <button
                key={h}
                type="button"
                className="play-btn"
                onClick={() => {
                  setSaid(h);
                  onAnswer(h);
                }}
              >
                {clock(h)}
              </button>
            ))}
          </div>
        </>
      )}
      <div className="lp__row">
        <button
          type="button"
          className="play-btn play-btn--ink"
          onClick={() => {
            // a climb again after a wrong hour brings the question back
            setSaid(null);
            setClimbed(true);
            onClimb();
          }}
        >
          {climbed ? "Climb again" : "Climb the tower"}
        </button>
        <button type="button" className="play-btn" onClick={onClose}>
          Walk on
        </button>
      </div>
    </>
  );
}

/** Bands & Co.: his office, five lines of who he is, and the errand board */
function Office({ online, me, onTake, onClose }: InteriorProps) {
  const [line, setLine] = useState(0);
  return (
    <>
      <p className="play-eyebrow">Mr Bands, in his office</p>
      <p className="play__line">{OFFICE_LINES[line]}</p>
      {online && me && <ErrandBoard me={me} onTake={onTake} />}
      <div className="lp__row">
        {line < OFFICE_LINES.length - 1 ? (
          <button type="button" className="play-btn play-btn--ink" onClick={() => setLine((l) => l + 1)}>
            Go on
          </button>
        ) : null}
        <button type="button" className="play-btn" onClick={onClose}>
          Walk on
        </button>
      </div>
    </>
  );
}

/** the rooms: each its own small thing, by the trade on its sign */
function Room({ place, info, online, notes, notify, onClose }: InteriorProps) {
  const trade = place.id.split("-")[0];
  const sit = (text: string) => {
    notify(text);
    onClose();
  };
  return (
    <>
      {trade === "coffee" && (
        <ul className="play__talk" aria-label="The talk of the town">
          {(info?.talk ?? []).map((t, i) => (
            <li key={`${t.name}-${i}`}>
              <span className="play__who">
                {t.name}: <q>{t.phrase}</q>
              </span>
              <span>{t.ago < 1 ? "just now" : `${t.ago} min ago`}</span>
            </li>
          ))}
          {!(info?.talk ?? []).length && <li>{online ? "Nobody has said a word yet." : "The talk is kept when the Exchange is online."}</li>}
        </ul>
      )}
      {trade === "bookseller" && (
        <ul className="play__learn" aria-label="The shelf">
          {SHELF.map((s) => (
            <li key={s.href}>
              <a href={s.href}>{s.title}</a>
              <small>{s.note}</small>
            </li>
          ))}
        </ul>
      )}
      {trade === "ledgers" && (
        <ul className="play__notes" aria-label="His build notes">
          {notes.slice(0, 5).map((n) => (
            <li key={n.id}>
              <p>{n.text}</p>
            </li>
          ))}
          {!notes.length && <li>The ledgers are blank today.</li>}
        </ul>
      )}
      {trade === "printer" && (
        <div className="play__broadsheet" aria-label="The broadsheet">
          {notes.slice(0, 6).map((n) => (
            <p key={n.id}>{n.text}</p>
          ))}
          {!notes.length && <p>Nothing set today.</p>}
        </div>
      )}
      <div className="lp__row">
        {trade === "barber" && (
          <button type="button" className="play-btn play-btn--ink" onClick={() => sit("A trim, and the hat goes back on. Nobody can tell.")}>
            A trim
          </button>
        )}
        {(trade === "wine" || trade === "tea") && (
          <button type="button" className="play-btn play-btn--ink" onClick={() => sit("You sit a while. The plaza goes on without you.")}>
            Sit on the bench
          </button>
        )}
        <button type="button" className="play-btn" onClick={onClose}>
          Walk on
        </button>
      </div>
    </>
  );
}

// ---------------------------------------------------------------- the errand board

/** the chain of errands and today's run: which is done, which is in hand and how far, and the next to take */
export function ErrandBoard({ me, onTake }: { me: Me; onTake(): void }) {
  const chainDone = ERRANDS.every((e) => me.errandsDone.includes(e.id));
  const inHand = me.errand;
  // today's run is fresh past midnight UTC: the server would say so on taking it, so the board says so first
  const daily = me.daily && me.day === utcDay() ? me.daily : null;
  const canTake = !inHand && (!chainDone || !daily);
  const stepsOf = (id: string) => {
    if (inHand?.id !== id) return null;
    const e = id === "daily" ? DAILY : ERRANDS.find((x) => x.id === id);
    const need = id === "daily" ? (daily?.places.length ?? 0) : (e?.steps.length ?? 0);
    const have = id === "daily" ? (daily?.found.length ?? 0) : inHand.step;
    return need > 1 ? `${have} of ${need}` : null;
  };
  return (
    <div className="play__pay">
      <p className="play-eyebrow">Errands</p>
      <ul className="play__errands">
        {ERRANDS.map((e) => {
          const done = me.errandsDone.includes(e.id);
          const now = inHand?.id === e.id;
          const progress = stepsOf(e.id);
          return (
            <li key={e.id} className={done ? "is-done" : now ? "is-now" : ""}>
              <span>
                {now ? e.line : e.short[0].toUpperCase() + e.short.slice(1)}
                {progress && <small> {progress}</small>}
              </span>
              <b>{done ? "done" : usd(e.reward)}</b>
            </li>
          );
        })}
        {chainDone && (
          <li className={daily?.paid ? "is-done" : inHand?.id === "daily" ? "is-now" : ""}>
            <span>
              {daily ? `Today's run: ${daily.places.map((p) => placeName(p).replace(/^The /, "the ")).join(", ")}` : "Today's run: three doors, then back here"}
              {stepsOf("daily") && <small> {stepsOf("daily")}</small>}
            </span>
            <b>{daily?.paid ? "done" : usd(DAILY.reward)}</b>
          </li>
        )}
      </ul>
      {me.owed > 0 && <p className="lp__sub">{usd(me.owed)} owed. Collect it at the desk.</p>}
      {canTake && (
        <button type="button" className="play-btn play-btn--ink" onClick={onTake}>
          {chainDone ? "Take today's run" : "Take the errand"}
        </button>
      )}
    </div>
  );
}
