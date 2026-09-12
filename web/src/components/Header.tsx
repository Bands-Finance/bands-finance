import { useState } from "react";
import { Wordmark } from "../brand/Logo";
import { useAccount } from "../platform/AccountProvider";
import { shortAddress } from "../platform/useBandsAccount";
import "./Header.css";

export type Route = "home" | "pools" | "learn" | "agents" | "me";

export interface HeaderProps {
  route: Route;
}

/**
 * Site header, ported from Meridian. Routing is hash-based and handled by App;
 * the links here are plain anchors so the browser does the work. The mobile
 * burger mirrors NAV exactly (the inline nav is hidden below 720px).
 *
 * The wallet zone (Meridian's header account states) is back for "Me": it only
 * renders once the platform API has answered, so the static snapshot keeps the
 * old look and never offers a connect button that leads nowhere.
 */
const NAV: { id: Route; label: string; href: string }[] = [
  { id: "home", label: "Home", href: "#/" },
  { id: "pools", label: "Pools", href: "#/pools" },
  { id: "learn", label: "Learn", href: "#/learn" },
  { id: "agents", label: "Agents", href: "#/agents" },
  { id: "me", label: "Me", href: "#/me" },
];

export function Header({ route }: HeaderProps) {
  const [navOpen, setNavOpen] = useState(false);
  const [acctOpen, setAcctOpen] = useState(false);
  const { api, status, address, error, signIn, signOut, connecting } = useAccount();

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

      {api === true && (
        <div className="header__account">
          {status === "guest" && (
            <button className="header__connect" onClick={signIn} disabled={connecting}>
              {connecting ? "Connecting…" : "Connect"}
            </button>
          )}
          {status === "connected" && (
            <button className="header__connect header__connect--sign" onClick={signIn}>
              Sign in
            </button>
          )}
          {status === "signing" && (
            <button className="header__connect header__connect--sign" disabled>
              Sign in your wallet…
            </button>
          )}
          {status === "signed-in" && address && (
            <div className="header__acct-wrap">
              <button className="header__connect header__connect--connected" onClick={() => setAcctOpen((v) => !v)} aria-expanded={acctOpen}>
                <span className="header__connect-dot" aria-hidden="true" />
                {shortAddress(address)}
                <span className="header__caret" aria-hidden="true">▾</span>
              </button>
              {acctOpen && (
                <>
                  <div className="header__acct-scrim" onClick={() => setAcctOpen(false)} />
                  <div className="header__acct-menu" role="menu">
                    <div className="header__acct-head">
                      <span className="header__acct-label">Signed in</span>
                      <a className="header__acct-addr" href={`https://solscan.io/account/${address}`} target="_blank" rel="noreferrer">
                        {shortAddress(address)} ↗
                      </a>
                    </div>
                    <div className="header__acct-section">
                      <a className="header__acct-empty" href="#/me" onClick={() => setAcctOpen(false)}>
                        Your Mr Bands →
                      </a>
                    </div>
                    <button className="header__acct-signout" onClick={() => { setAcctOpen(false); signOut(); }}>
                      Sign out
                    </button>
                  </div>
                </>
              )}
            </div>
          )}
          {error && status !== "signed-in" && <span className="header__acct-err">{error}</span>}
        </div>
      )}

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
