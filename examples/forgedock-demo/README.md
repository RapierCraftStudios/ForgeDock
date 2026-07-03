# ForgeDock Demo — A Risk-Free First Pipeline Run

A tiny **Notes API** (~300 lines, zero dependencies) with five pre-written
issues. It exists so you can watch ForgeDock investigate, build, review, and
merge a change **without touching your real codebase**.

> Clone → `npx forgedock` → open Claude Code → `/work-on 1` → watch it go.

---

## Why this exists

Trying ForgeDock on your own project means trusting an AI pipeline with real
code on your very first run. This demo removes that risk: it's a self-contained
sandbox where every issue is small, fast, and safe to break.

The API has a couple of **intentional, clearly-labelled flaws** (a missing auth
check, an unsafe query path) so that ForgeDock's `/review-pr` agents have real
findings to surface — that's the part that makes the review feel impressive.

---

## What's inside

```
forgedock-demo/
├── src/
│   ├── server.js        # built-in http server + router (no Express)
│   ├── router.js        # (added by Issue #3)
│   ├── routes/notes.js  # CRUD handlers — has the intentional flaws
│   ├── db.js            # in-memory store
│   └── auth.js          # bearer-token check
├── scripts/smoke.js     # dependency-free smoke test (npm run smoke)
├── issues/              # the 5 pre-written issue specs
├── forge.yaml           # minimal working ForgeDock config
├── labels.json          # workflow + priority labels
└── bootstrap.sh         # one command to stand up the live repo
```

No database. No Docker. No API keys. Runs on Node 18+.

---

## Run it locally (optional)

```bash
node src/server.js          # starts on http://localhost:3000
# in another terminal:
curl http://localhost:3000/notes
npm run smoke               # runs the smoke test
```

---

## The five demo issues

Each issue targets a different pipeline strength and is scoped to finish fast.

| # | Type | Title | What it shows |
|---|------|-------|---------------|
| 1 | Bug / security | DELETE is missing an auth check | Simplest fix — fastest run |
| 2 | Feature / security | Safe filtering for `GET /notes` | Investigation + architecture |
| 3 | Refactor | Extract the router module | "No behavior change" review |
| 4 | Performance | O(1) `findById` | Investigation phase tracing the hot path |
| 5 | Docs | Add an API reference | Pipeline handles non-code work |

Full specs live in [`issues/`](./issues). When you run `bootstrap.sh`, these
become real GitHub issues #1–#5 in your demo repo, in this order.

---

## Stand up your own live demo repo

The scaffold is complete and ready — the only step that needs your GitHub
credentials is creating the actual repo. One command does it:

```bash
# requires an authenticated gh CLI (gh auth login)
./bootstrap.sh                        # creates <your-user>/forgedock-demo (public)
# or:
./bootstrap.sh my-org/forgedock-demo  # custom owner/repo
```

`bootstrap.sh` will:

1. Create the GitHub repo (skips if it already exists).
2. Push this codebase to `main`.
3. Create the workflow + priority labels (via `npx forgedock labels setup`,
   falling back to `labels.json`).
4. File the five issues from [`issues/`](./issues).

Then:

```bash
git clone https://github.com/<you>/forgedock-demo.git
cd forgedock-demo
npx forgedock              # install the ForgeDock commands
# open Claude Code in this directory, then run:
/work-on 1
```

Watch ForgeDock investigate the missing-auth bug, write the fix, run the quality
gate, open a PR, review it, and merge — all on a repo you can safely throw away.

---

## After your first run

Try `/work-on 2` through `/work-on 5` to see the other pipeline phases, or run
`/orchestrate` to let ForgeDock work several issues in parallel.

When you're comfortable, point ForgeDock at your real project — you've already
seen exactly what it does.
