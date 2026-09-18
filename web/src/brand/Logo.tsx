/**
 * The bands.finance mark: three bands of cash with orange straps.
 * Uses /logo.png when the original artwork is in web/public, otherwise the vector version.
 */
import { useState } from "react";
import { SITE } from "../site";

/** The dashboard's mark is Mr Bands himself (his portrait, Zach's engraving, 18 Sep): a round plate with a hairline ring. */
export function Logo({ size = 34, className = "" }: { size?: number; className?: string }) {
  const [png, setPng] = useState(true);
  if (SITE === "dashboard") {
    return <img src="/art/brand/mark.webp" width={size} height={size} alt="" className={className} style={{ borderRadius: "50%", display: "block", boxShadow: "0 0 0 1px rgba(22, 18, 15, 0.45), 0 0 0 3px #f3ecdd, 0 0 0 4px rgba(22, 18, 15, 0.18)" }} />;
  }
  return png ? (
    <img src="/logo.png" width={size} height={size} alt="" className={className} onError={() => setPng(false)} style={{ borderRadius: 9, display: "block" }} />
  ) : (
    <img src="/logo.svg" width={size} height={size} alt="" className={className} style={{ borderRadius: 9, display: "block" }} />
  );
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
