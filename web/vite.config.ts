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
