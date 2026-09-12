import { Component, type ErrorInfo, type ReactNode } from "react";

/**
 * Keeps one decorative subtree from taking the whole page down.
 *
 * The hero's WebGL globe threw "Error creating WebGL context" on any device
 * that cannot give it one (no GPU, hardware acceleration off, a blocklisted
 * driver, or a privacy setting that refuses WebGL for fingerprinting reasons).
 * React unmounts the entire tree when a render throws and nothing catches it,
 * so an ornament failing served those visitors a blank white page: HTML 200,
 * JS 200, nothing rendered, and no HTTP check anywhere would ever show it.
 *
 * Renders `fallback` (nothing, by default) instead. A background that is
 * missing is a visual downgrade; a background that throws is an outage.
 */
interface Props {
  children: ReactNode;
  fallback?: ReactNode;
  /** Named in the console line, so a failure says which part gave up. */
  label?: string;
}

export class SafeBoundary extends Component<Props, { failed: boolean }> {
  state = { failed: false };

  static getDerivedStateFromError(): { failed: boolean } {
    return { failed: true };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    // Console only. This is a degraded ornament, not something to interrupt
    // the visitor over.
    console.warn(`[${this.props.label ?? "SafeBoundary"}] disabled after an error:`, error.message, info.componentStack?.slice(0, 200));
  }

  render(): ReactNode {
    return this.state.failed ? (this.props.fallback ?? null) : this.props.children;
  }
}

/**
 * Can this browser actually give us a WebGL context? Checked before mounting
 * the globe so an unsupported device skips the work entirely instead of
 * downloading half a megabyte of Three.js to fail with it. The boundary above
 * is still the real guarantee: contexts can also be lost after a successful
 * creation (GPU reset, tab backgrounded too long, driver crash).
 */
export function hasWebGL(): boolean {
  if (typeof document === "undefined") return false;
  try {
    const canvas = document.createElement("canvas");
    return !!(canvas.getContext("webgl2") ?? canvas.getContext("webgl"));
  } catch {
    return false;
  }
}
