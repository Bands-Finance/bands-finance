# The dashboard site

This directory holds only the Vercel link for the **dashboard** site (`.vercel/project.json`, never committed).
The site itself is `web/`, built with `VITE_SITE=dashboard` (see `web/src/site.ts`): the same journal, model
and components as bands.finance, with the navigation, hero, screener and account pages left out. Just Mr Bands
at work.

Link it once:

    cd dash && vercel link --yes --project mr-bands-live

Deploy (the desk does this itself, with its own DATA_DIR, after every snapshot when the link exists).
By hand, point the snapshot at the desk's data or it publishes whatever `data/` holds:

    DATA_DIR=data-live npm run dash:deploy
