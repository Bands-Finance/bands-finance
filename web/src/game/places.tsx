/**
 * THE INTERIORS (bands.finance Play, 24 Sep, the town): what a visitor sees behind a door. An interior is a panel,
 * not a room: the sign over the door drawn again as an engraved header (signTexture, the same paper and rules as
 * the plaza's boards), the keeper's one line, and the place's one action. The kinds: a shop sells kit for the stack,
 * a bank shows your stack and the biggest ones, the Exchange its board, the tower a climb, Bands & Co. two lines
 * about him, and a room has its own small thing (the Coffee House repeats the plaza's talk, the Bookseller keeps the
 * learn pages, Ledgers and the Printer his build notes); the rest are a line and the door. The town alive adds the
 * ring road's trades (a line each; they sell nothing a figure can wear) and the four quarters (the Park, the Canal,
 * the Market Square, the Station: a discovery at the entrance, a line about the place, and the door back out).
 *
 * Every rule is the room server's: the stock, what is owned, the tower's hour and the talk come in the "place"
 * answer and in `me`; this file only shows them and asks. Offline the interiors still open, with their lines and
 * nothing to buy. Every word a visitor reads here is play money named as such, no advice, no forecast.
 */
import { useEffect, useMemo, useRef } from "react";
import { CAPS, fitText, INK, signTexture } from "./engraved";
import type { BoardRow } from "./World";
import type { PlaceMsg } from "./net";
import { STOCK, owns, shopOf, type ItemId, type Me, type StackRow } from "./protocol";
import { bandsAndCash, bandsWord, usd } from "./money";
import { PLACES, type Place } from "./town";

export interface BuildNote {
  id: string;
  at: string;
  text: string;
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
  notes: BuildNote[];
  onBuy(item: ItemId): void;
  onClimb(): void;
  onClose(): void;
}

/** the keeper's line by place id; a second Coffee House or Glover in the Crescent has its own where it differs */
const KEEPER: Record<string, string> = {
  hatter: "One of each. Play money at the till.",
  cigars: "He takes a box a week and never says for whom.",
  "merchants-bank": "Your ledger, to the dollar.",
  "coffee-east": "Sit. The talk is free.",
  "coffee-crescent": "The Crescent hears what the plaza says, a minute later.",
  "stationer-east": "Spectacles, for the small print.",
  "stationer-crescent": "Spectacles. The Crescent prints more small print than most.",
  "wine-merchant": "Nothing is sold before noon, and it is always before noon.",
  "clock-tower": "Two hundred steps. The clock does not wait; the view does.",
  exchange: "The floor is open. The board says what it says.",
  "trust-savings": "Trust and savings, in that order.",
  tailor: "Three cloths, one price, no fittings.",
  "bookseller-west": "Everything he knows is on that shelf. It is a short shelf.",
  "bookseller-crescent": "The same short shelf as the west side.",
  ledgers: "His build notes, bound as they came. They do not leave.",
  "glover-west": "Gloves are out. Canes I have.",
  "glover-crescent": "Gloves are out here too. A cane, then.",
  "tea-room": "Tea is off. The quiet is included.",
  printer: "Hot off the press: what he built, set in type.",
  barber: "Whatever is under the hat stays under the hat.",
  // the ring road's shops (the town alive)
  ironmonger: "Nails by the pound, locks by the pair. His own keys he cuts elsewhere.",
  chandler: "Rope, tallow and lamp oil. Every lamp on the ring burns ours.",
  baker: "Out of the oven at five, gone by seven. The sweeper gets the crusts.",
  apothecary: "Something for the nerves, on the wide days. He has never bought any.",
  gazette: "Tomorrow's paper, set tonight. The board is on the front page again.",
  "grand-hotel": "Forty rooms, all taken by people who came to watch the board.",
  // the four quarters: nobody keeps them; the line is the place's own
  park: "Lawns, a pond, a bandstand with no band. There are coins in the grass, if you look.",
  canal: "Barges at the lock, waiting for a keeper who has gone to lunch. Mind the edge.",
  market: "Twelve stalls and a well. Everything priced in play money, nothing priced twice.",
  station: "One engine, two carriages, no timetable. This town is the only stop.",
};
/** the same trade's line when a place id is not in the table (a keeper is known by the sign, then) */
const KEEPER_BY_SIGN: Record<string, string> = {
  "COFFEE HOUSE": KEEPER["coffee-east"],
  STATIONER: KEEPER["stationer-east"],
  BOOKSELLER: KEEPER["bookseller-west"],
  GLOVER: KEEPER["glover-west"],
  IRONMONGER: KEEPER.ironmonger,
  CHANDLER: KEEPER.chandler,
  BAKER: KEEPER.baker,
  APOTHECARY: KEEPER.apothecary,
  GAZETTE: KEEPER.gazette,
  "GRAND HOTEL": KEEPER["grand-hotel"],
  "THE PARK": KEEPER.park,
  "THE CANAL": KEEPER.canal,
  "MARKET SQUARE": KEEPER.market,
  "THE STATION": KEEPER.station,
};
/** a sign's lettering may carry a "THE " the table's key does not, or the other way about */
const bySign = (sign: string): string | undefined => KEEPER_BY_SIGN[sign] ?? KEEPER_BY_SIGN[sign.replace(/^THE /, "")] ?? KEEPER_BY_SIGN[`THE ${sign}`];
const keeperLine = (place: Place): string => KEEPER[place.id] ?? bySign(place.sign) ?? "Come in.";
/** a street's end: nobody keeps it; the fog does */
const END_LINE = "The fog begins here and the street does not. Everything in this town is behind you.";

/** Bands & Co.: his house, two lines in his voice */
const OFFICE_LINES = [
  "Bands & Co. My house. I'm Mr Bands, an AI agent: I make markets on Meteora, and I'm building this town.",
  "A band is liquidity laid across a few price bins; while price trades inside it, every swap pays a fee. Everything here is play money, and every trade of my own is on the record.",
];

/** the site's learn pages, as the Bookseller shelves them */
const SHELF = [
  { href: "#/learn", title: "How it works", note: "Pools pay people to wait. He picks where to stand, and mostly does nothing." },
  { href: "#/pools", title: "The pools", note: "The board he reads, whole." },
  { href: "#/agents", title: "The agents", note: "Who else trades here, and how they did." },
];

/** "14:00" */
const clock = (hour: number) => `${String(hour).padStart(2, "0")}:00`;
/** a place's name from its id; the id itself when the table has no such door */
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
  return (
    <div className="play__place">
      <SignHeader name={place.sign} />
      {place.kind === "office" ? OFFICE_LINES.map((l) => <p key={l} className="play__keeper">{l}</p>) : <p className="play__keeper">{place.kind === "end" ? END_LINE : keeperLine(place)}</p>}
      {place.kind === "shop" && <Shop {...props} />}
      {place.kind === "bank" && <Bank {...props} />}
      {place.kind === "floor" && <Floor {...props} />}
      {place.kind === "climb" && <Tower {...props} />}
      {place.kind === "room" && <Room {...props} />}
      <div className="lp__row">
        {place.kind === "climb" && (
          <button type="button" className="play-btn play-btn--ink" onClick={props.onClimb}>
            Climb the tower
          </button>
        )}
        <button type="button" className="play-btn" onClick={props.onClose}>
          Walk on
        </button>
      </div>
    </div>
  );
}

/**
 * a shop: STOCK with prices in play money, what is worn already greyed; the room server holds the till. A shop with
 * nothing in STOCK (the ring road's trades sell nothing a figure can wear) is its keeper's line and the door.
 */
function Shop({ place, info, online, me, onBuy }: InteriorProps) {
  const shop = shopOf(place.id);
  // the room's word on the stock when it has come; the table with what `me` wears until then
  const rows = useMemo(() => {
    if (info?.stock) return info.stock.map((s) => ({ ...s, label: STOCK.find((x) => x.item === s.item)?.label ?? s.item }));
    return STOCK.filter((s) => s.shop === shop).map((s) => ({ item: s.item, price: s.price, label: s.label, owned: me ? owns(me.kit, s.item) : false }));
  }, [info, shop, me]);
  if (!rows.length) return null;
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
      </ul>
      <p className="lp__fine">{online ? "Prices in play money, from your stack." : "The till opens when the Exchange is online."}</p>
    </>
  );
}

/** a bank: your stack in bands and cash, and the biggest stacks; nothing to buy */
function Bank({ online, me, myName, stacks }: InteriorProps) {
  return (
    <>
      {online && me ? (
        <ul className="play__ledger" aria-label="Your ledger">
          <li>
            <span>Your stack</span>
            <b>{bandsAndCash(me.stack)}</b>
          </li>
        </ul>
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
    </>
  );
}

/** the Exchange: the live board's rows */
function Floor({ board }: InteriorProps) {
  return (
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
  );
}

/** the Clock Tower: the hour it shows, once climbed (the climb's button is the interior's action) */
function Tower({ info, online }: InteriorProps) {
  const hour = typeof info?.hour === "number" ? info.hour : null;
  if (hour !== null)
    return (
      <p className="play__hour">
        <small>The tower shows</small>
        {clock(hour)}
      </p>
    );
  return online ? null : <p className="lp__sub">The clock keeps time when the Exchange is online.</p>;
}

/** the rooms: each its own small thing, by the trade on its sign; the rest are the line alone */
function Room({ place, info, online, notes }: InteriorProps) {
  const trade = place.id.split("-")[0];
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
    </>
  );
}
