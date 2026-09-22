/**
 * Which site this build is. One codebase, two shells, two Vercel projects:
 *   platform   bands.finance: the platform, the pools screener, learn, agents, your own Mr Bands
 *   dashboard  just Mr Bands at work: the money, the open bands, the desk feed, nothing else
 * Chosen at build time by VITE_SITE (web/scripts/deploy-dash.mjs sets it for the dashboard project),
 * so the two sites read the same journal, the same model and the same components and cannot disagree.
 */
export type Site = "platform" | "dashboard";

const raw = (import.meta.env.VITE_SITE ?? "").trim().toLowerCase();
export const SITE: Site = raw === "dashboard" ? "dashboard" : "platform";

/** Where the platform lives, for the dashboard's "how it works" links. */
export const PLATFORM_URL = (import.meta.env.VITE_PLATFORM_URL ?? "https://bands.finance").replace(/\/$/, "");

/**
 * The entry's two outside pages, each linked from the "For other agents" chapter (id "hire") only once it exists: the token's
 * page on ClawPump and his account on X. Baked in at build time as VITE_TOKEN_URL and VITE_X_URL, so the
 * links appear the day the mint and the post exist without a code change; until then the page says the
 * token is coming and claims nothing more.
 */
const optionalUrl = (v: string | undefined): string | null => (v && v.trim() ? v.trim() : null);
/**
 * Zach, 22 Sep: the token is not linked from the site yet. The chapter says nothing about $BANDS and prints no
 * ClawPump link, even once VITE_TOKEN_URL is set, until VITE_TOKEN_ON_SITE=true is baked in at deploy.
 */
export const TOKEN_ON_SITE = (import.meta.env.VITE_TOKEN_ON_SITE ?? "").trim().toLowerCase() === "true";
export const TOKEN_URL = TOKEN_ON_SITE ? optionalUrl(import.meta.env.VITE_TOKEN_URL) : null;
export const X_URL = optionalUrl(import.meta.env.VITE_X_URL);
