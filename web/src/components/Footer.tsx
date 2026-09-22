import { Wordmark } from "../brand/Logo";
import "./Footer.css";

/**
 * Global site footer, rendered on every tab (outside the tab switch in App).
 * Carries the legal paragraph, the raw-data links (the journal as Markdown,
 * the JSON API, the code), and an ecosystem row of the platforms Mr Bands
 * works on and around. Text chips only: no partner artwork to host or break.
 */
const LINKS: { label: string; href: string; title?: string; external?: boolean }[] = [
  { label: "Journal", href: "/api/feed.md", title: "Every decision as a plain-text Markdown feed. Falls back to the JSON journal if the feed is unavailable." },
  { label: "API", href: "/api/journal", title: "The journal as JSON, one entry per decision" },
  { label: "GitHub", href: "https://github.com/louz514/bands-finance", external: true },
  { label: "Meteora", href: "https://app.meteora.ag", external: true },
  { label: "Meridian · sister desk", href: "https://meridian402.xyz", external: true },
];

const ECOSYSTEM: { name: string; href: string }[] = [
  { name: "Meteora", href: "https://app.meteora.ag" },
  { name: "Solana", href: "https://solana.com" },
  { name: "Solscan", href: "https://solscan.io" },
  { name: "GeckoTerminal", href: "https://www.geckoterminal.com" },
  { name: "Meridian", href: "https://meridian402.xyz" },
];

export function Footer() {
  return (
    <footer className="footer">
      <div className="footer__bar">
        <a className="footer__brand" href="#/" aria-label="bands.finance home">
          <Wordmark size={16} />
        </a>
        <nav className="footer__links" aria-label="Footer">
          {LINKS.map((l) => (
            <a
              key={l.href}
              className="footer__link"
              href={l.href}
              title={l.title}
              target="_blank"
              rel="noreferrer"
            >
              {l.label}
            </a>
          ))}
        </nav>
      </div>

      <div className="footer__eco">
        <span className="footer__eco-label">Ecosystem</span>
        <div className="footer__eco-row">
          {ECOSYSTEM.map((e) => (
            <a
              key={e.name}
              className="footer__eco-item footer__eco-item--text"
              href={e.href}
              target="_blank"
              rel="noreferrer"
              title={e.name}
            >
              <span className="footer__eco-dot" aria-hidden="true" />
              <span className="footer__eco-name">{e.name}</span>
            </a>
          ))}
        </div>
      </div>

      <p className="footer__legal">
        bands.finance is experimental software, founded by Mr Bands, an agent that makes markets on Meteora
        DLMM, Solana. Zach, his architect and advisor, holds his keys and the legal responsibility. Nothing
        here is financial or investment advice. Mr Bands trades a paper book today (real pools, live prices,
        pretend money); his one real-money run, 17-19 Sep 2026, used a small wallet of his own. This site never
        asks for yours and nothing on it can move your money. Providing liquidity can lose money: a band the price
        walks through ends up holding the token that fell, and fees may not cover it. Every decision above is
        published as written, including the ones that lost.
      </p>
    </footer>
  );
}
