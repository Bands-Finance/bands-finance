# The dashboard site

This directory holds only the Vercel link for the **dashboard** site (`.vercel/project.json`, never committed).
The site itself is `web/`, built with `VITE_SITE=dashboard` (see `web/src/site.ts`): the same journal, model
and components as bands.finance, with the navigation, hero, screener and account pages left out. Just Mr Bands
at work.

Link it once:

    cd dash && vercel link --yes --project mr-bands-live

Deploy (the desk does this itself, with its own env, after every snapshot when the link exists).
By hand, run it as the live desk does, or the snapshot ships an empty book (SNAPSHOT_BOOK unset is "none"); while
the real book is being traded a plain shell is refused outright (src/publish/snapshot.ts plainShellRefusal):

    set -a; . ops/live.env; set +a; npm run dash:deploy
