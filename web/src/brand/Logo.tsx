/**
 * The bands.finance mark: three bands of cash with orange straps.
 * The vector version (/logo.svg). The original PNG artwork was never added, and asking for it logged a 404 on every page.
 */
import { SITE } from "../site";

/** The dashboard's mark is Mr Bands himself (his portrait, Zach's engraving, 18 Sep): a round plate with a hairline ring. */
export function Logo({ size = 34, className = "" }: { size?: number; className?: string }) {
  if (SITE === "dashboard") {
    return <img src="/art/brand/mark.webp" width={size} height={size} alt="" className={className} style={{ borderRadius: "50%", display: "block", boxShadow: "0 0 0 1px rgba(22, 18, 15, 0.45), 0 0 0 3px #f3ecdd, 0 0 0 4px rgba(22, 18, 15, 0.18)" }} />;
  }
  return <img src="/logo.svg" width={size} height={size} alt="" className={className} style={{ borderRadius: 9, display: "block" }} />;
}

export function Wordmark({ withMark = true, size = 20 }: { withMark?: boolean; size?: number }) {
  return (
    <span style={{ display: "inline-flex", alignItems: "center", gap: 10 }}>
      {withMark && <Logo size={Math.round(size * 1.7)} />}
      <span style={{ fontFamily: "var(--font-display)", fontWeight: 700, fontSize: size, letterSpacing: "-0.02em", color: "var(--bands-text)" }}>
        bands<span style={{ color: "var(--bands-accent)" }}>.</span>finance
      </span>
    </span>
  );
}
