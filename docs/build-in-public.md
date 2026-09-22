# Build in public

Mr Bands builds in public: each step that makes him more of his own operator is done, then posted by him, in the
builder voice (docs/talk.md). This file is the running plan. Nothing here is set up until Zach says go; each step
lists what Zach does (sign-ups a human must do), what the code does, and what he posts.

## Part 1: his own identity (saved 22 Sep, not started)

The first part of the series (Zach, 22 Sep: "the first steps of the build in public is giving the agent his own
email and access to the github").

### Step 1. His own email: bands@mrbands.finance

- **Zach:** picks the inbox kind (open question: an agent inbox with an API he reads and sends from himself, a
  regular mail host on the domain, or a free mailbox for now) and signs up; hands over only an API key, into
  `mr-bands/.env`, never into chat.
- **Code:** add the provider's MX, SPF and DKIM records to mrbands.finance on Vercel DNS (both domains are on
  Vercel, and neither has mail records today); if it is an agent inbox, his mail tools behind guards (read and reply
  to mail addressed to him; no unsolicited mail; nothing about money, keys or the token), on OpenHermit like his
  other tools.
- **He posts:** that he has his own address and what it is for.

### Step 2. His own GitHub

- **Done 22 Sep:** the organization exists (github.com/Bands-Finance, created by Zach) and the repo moved into it
  (Bands-Finance/bands-finance, still private); the git remote and the site's code links point there.
- **Zach:** creates his machine account (a human-run bot account is allowed on GitHub): suggested username
  `mrbandssol` to match X, signed up with bands@mrbands.finance, two-factor on, name "Mr Bands", his X bio, his
  avatar, link mrbands.finance. Adds his account to the organization as an owner. Makes a fine-grained token
  on his account with write access to that repo only, into `mr-bands/.env` as `GITHUB_TOKEN`.
- **Code:** the git remote and the site's GitHub link (web/src/components/Footer.tsx) move to the organization; his
  commits are authored as Mr Bands (open question: every commit, or only the ones the desk and the talk loop make).
- **He posts:** that his code now lives under his own organization and account, and that the build log he posts
  comes from his own commits (src/talk/autoBuild.ts).

## Already running

- The builder voice on X, with the auto build log (every commit becomes a build note; private areas stay out) and a
  "What I shipped today" note after 20:00 UTC.
- Replies to people who mention him, in the same voice.
- OpenHermit, the agentic runtime he runs on, is part of his story.
