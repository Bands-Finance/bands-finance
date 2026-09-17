import { defineConfig, type Plugin } from "vite";
import react from "@vitejs/plugin-react";

/**
 * The same app builds two sites (src/site.ts). The dashboard lives at mrbands.finance and is what
 * gets shared, so its static head has to say so: a crawler reads the HTML, not the React app.
 */
const DASH_URL = "https://mrbands.finance";
const DASH_TITLE = "Mr Bands · He makes markets on Solana and shows his work";
const DASH_DESC = "Mr Bands is an AI market maker with his own wallet on Solana. He lays SOL under the price, earns the fees when traders cross his band, and publishes every move. This is his live statement.";
function dashboardHead(): Plugin {
  return {
    name: "dashboard-head",
    transformIndexHtml(html) {
      if ((process.env.VITE_SITE ?? "").trim().toLowerCase() !== "dashboard") return html;
      return html
        .replace(/<title>[^<]*<\/title>/, `<title>${DASH_TITLE}</title>`)
        .replace(/<meta name="description"[^>]*>/, `<meta name="description" content="${DASH_DESC}" />`)
        .replace(/<meta name="theme-color"[^>]*>/, `<meta name="theme-color" content="#f3ecdd" />`)
        .replace(
          "</head>",
          [
            // the two faces the first screen is set in, fetched before the stylesheet asks for them
            `  <link rel="preload" href="/fonts/fraunces-600-normal-latin.woff2" as="font" type="font/woff2" crossorigin />`,
            `  <link rel="preload" href="/fonts/cormorant-sc-600-normal-latin.woff2" as="font" type="font/woff2" crossorigin />`,
            `  <link rel="canonical" href="${DASH_URL}/" />`,
            `  <meta property="og:type" content="website" />`,
            `  <meta property="og:url" content="${DASH_URL}/" />`,
            `  <meta property="og:title" content="${DASH_TITLE}" />`,
            `  <meta property="og:description" content="${DASH_DESC}" />`,
            `  <meta property="og:image" content="${DASH_URL}/social-card.jpg" />`,
            `  <meta property="og:image:width" content="1200" />`,
            `  <meta property="og:image:height" content="630" />`,
            `  <meta property="og:image:alt" content="An engraving of Mr Bands' desk: a top hat with an orange band, rows of strapped banknote bundles, a ticker under a glass dome." />`,
            `  <meta name="twitter:card" content="summary_large_image" />`,
            `  <meta name="twitter:image" content="${DASH_URL}/social-card.jpg" />`,
            `  </head>`,
          ].join("\n  "),
        )
        // what a crawler reads: the page's substance in plain HTML, replaced by the app the moment it mounts
        .replace(
          '<div id="root"></div>',
          `<div id="root"><main style="max-width:calc(1080px + 2 * clamp(18px,4vw,56px));margin:0 auto;padding:clamp(120px,19vh,210px) clamp(18px,4vw,56px) 0;color:#16120f;font-family:Fraunces,Georgia,serif"><p style="margin:0 0 18px;font:600 12px 'Cormorant SC',Georgia,serif;letter-spacing:.24em;text-transform:uppercase;color:#c9560a">Live on Solana</p><h1 style="max-width:640px;margin:0;font-weight:600;font-size:clamp(44px,6.6vw,104px);line-height:1;letter-spacing:-.025em">Mr Bands makes markets<br>on Solana.</h1><p style="max-width:44ch;margin:26px 0 0;font-size:clamp(17px,1.3vw,20px);line-height:1.5;color:#3d362f">${DASH_DESC}</p><p style="max-width:44ch;margin:.7em 0 0;font-size:clamp(17px,1.3vw,20px);line-height:1.5;color:#3d362f">He lays SOL under the price. Traders cross his band and he gets paid. Fees fall into the dish. When the price walks away, he lays the band again. Every move is on the record, with its transaction. <a href="https://bands.finance/#/learn" style="color:#c9560a">How it works</a></p></main></div>`,
        );
    },
  };
}

export default defineConfig({
  plugins: [react(), dashboardHead()],
  server: {
    port: 5173,
    proxy: { "/api": "http://localhost:3000" },
  },
  build: { outDir: "dist", sourcemap: false },
});
