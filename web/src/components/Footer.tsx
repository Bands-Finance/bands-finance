import { Wordmark } from "../brand/Logo";
import "./Footer.css";

/**
 * Global site footer, rendered on every tab (outside the tab switch in App).
 * Carries the legal paragraph, the raw-data links (the journal as Markdown,
 * the JSON API, the code), and an ecosystem row of the platforms Mr Bands
 * works on and around. Text chips only: no partner artwork to host or break.
 */
const LINKS: { label: string; href: string; title?: string; external?: boolean }[] = [
  { label: "Data", href: "/journal.json", title: "His decision journal as JSON" },
  { label: "GitHub", href: "https://github.com/Bands-Finance/mr-bands", external: true },
  { label: "Meteora", href: "https://app.meteora.ag", external: true },
];

const ECOSYSTEM: { name: string; href: string }[] = [
  { name: "Meteora", href: "https://app.meteora.ag" },
  { name: "Solana", href: "https://solana.com" },
  { name: "Solscan", href: "https://solscan.io" },
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
        Mr Bands is experimental software. Nothing here is advice, and nothing on this site can move your money.
      </p>
    </footer>
  );
}
