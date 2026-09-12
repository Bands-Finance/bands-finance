import { useState } from "react";
import { Wordmark } from "../brand/Logo";
import "./Header.css";

export type Route = "home" | "pools" | "learn" | "agents";

export interface HeaderProps {
  route: Route;
}

/**
 * Site header, ported from Meridian minus the wallet zone: bands.finance never
 * asks for a wallet, so there is nothing to connect. Routing is hash-based and
 * handled by App; the links here are plain anchors so the browser does the work.
 * The mobile burger mirrors NAV exactly (the inline nav is hidden below 720px).
 */
const NAV: { id: Route; label: string; href: string }[] = [
  { id: "home", label: "Home", href: "#/" },
  { id: "pools", label: "Pools", href: "#/pools" },
  { id: "learn", label: "Learn", href: "#/learn" },
  { id: "agents", label: "Agents", href: "#/agents" },
];

export function Header({ route }: HeaderProps) {
  const [navOpen, setNavOpen] = useState(false);

  return (
    <header className="header">
      <a className="header__brand" href="#/" aria-label="bands.finance home">
        <Wordmark />
      </a>
      <nav className="header__nav" aria-label="Primary">
        {NAV.map((n) => (
          <a
            key={n.id}
            href={n.href}
            className={`header__link${route === n.id ? " header__link--active" : ""}`}
            aria-current={route === n.id ? "page" : undefined}
          >
            {n.label}
          </a>
        ))}
      </nav>

      {/* Mobile-only nav: the inline nav is hidden below 720px, so without this
          a phone visitor cannot switch tabs. Mirrors NAV exactly. */}
      <button
        className="header__burger"
        aria-label="Menu"
        aria-expanded={navOpen}
        onClick={() => setNavOpen((v) => !v)}
      >
        <span /><span /><span />
      </button>
      {navOpen && (
        <>
          <div className="header__mnav-scrim" onClick={() => setNavOpen(false)} />
          <div className="header__mnav" role="menu">
            {NAV.map((n) => (
              <a
                key={n.id}
                href={n.href}
                className="header__mnav-link"
                role="menuitem"
                aria-current={route === n.id ? "page" : undefined}
                onClick={() => setNavOpen(false)}
              >
                {n.label}
              </a>
            ))}
          </div>
        </>
      )}

      <span className="header__progress" aria-hidden="true" />
    </header>
  );
}
