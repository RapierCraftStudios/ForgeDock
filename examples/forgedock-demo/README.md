# ForgeDock Demo — A Risk-Free First Pipeline Run

A tiny **Notes API** (~400 lines, zero dependencies) with twenty pre-written
issues. It exists so you can watch ForgeDock investigate, build, review, and
merge a change **without touching your real codebase**.

> Clone → `npx forgedock` → open Claude Code → `/work-on 1` → watch it go.

---

## Why this exists

Trying ForgeDock on your own project means trusting an AI pipeline with real
code on your very first run. This demo removes that risk: it's a self-contained
sandbox where every issue is small, fast, and safe to break.

The API has a handful of **intentional, clearly-labelled flaws** (a missing auth
check, two injection-vulnerable query paths, a mass-assignment gap) so that
ForgeDock's `/review-pr` agents have real findings to surface — that's the part
that makes the review feel impressive.

---

## What's inside

```
forgedock-demo/
├── src/
│   ├── server.js        # built-in http server + router (no Express)
│   ├── router.js        # (added by Issue #3)
│   ├── routes/notes.js  # CRUD + count/tags/patch handlers — has intentional flaws
│   ├── db.js            # in-memory store with tags, createdAt, archived fields
│   └── auth.js          # bearer-token check
├── scripts/smoke.js     # dependency-free smoke test (npm run smoke)
├── issues/              # 20 graded issue specs
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

## The twenty demo issues

Each issue targets a different pipeline strength and difficulty tier.
Issues 1–5 are the original quick-start set; issues 6–20 expand the corpus
for statistically meaningful one-shot benchmark runs.

| # | Difficulty | Type | Title |
|---|-----------|------|-------|
| 1 | Easy | Bug / security | DELETE is missing an auth check |
| 2 | Medium | Feature / security | Safe filtering for `GET /notes` |
| 3 | Easy | Refactor | Extract the router module |
| 4 | Medium | Performance | O(1) `findById` |
| 5 | Easy | Docs | Add an API reference |
| 6 | Medium | Bug | POST stores malformed tags without validation |
| 7 | Medium | Bug | Negative `?offset=` returns wrong notes instead of 400 |
| 8 | Hard | Bug / security | PATCH allows mass-assignment of owner and secret |
| 9 | Hard | Bug / security | GET /notes/count is vulnerable to expression injection |
| 10 | Easy | Feature | Add `?sort=` parameter to GET /notes |
| 11 | Medium | Feature | Allow PATCH to update tags |
| 12 | Hard | Feature | POST /notes/bulk for all-or-nothing batch creation |
| 13 | Hard | Feature | Archive/soft-delete with `?archived=` list filter |
| 14 | Easy | Refactor | Extract title validation into validate.js |
| 15 | Medium | Refactor | Centralize auth enforcement with a protected route flag |
| 16 | Hard | Refactor | Extract generic store machinery into store.js |
| 17 | Easy | Performance | Replace O(n²) tag de-dup in listTags with a Set |
| 18 | Medium | Performance | Remove unnecessary O(n²) sort before pagination slice |
| 19 | Easy | Docs | Complete API reference covering all endpoints |
| 20 | Easy | Docs | Document the intentional-flaw and graded-issue convention |

Full specs live in [`issues/`](./issues). When you run `bootstrap.sh`, these
become real GitHub issues #1–#20 in your demo repo, in this order.

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
4. File all twenty issues from [`issues/`](./issues).

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

Try `/work-on 2` through `/work-on 20` to see the full range of pipeline phases
and issue types, or run `/orchestrate` to let ForgeDock work several issues in
parallel.

When you're comfortable, point ForgeDock at your real project — you've already
seen exactly what it does.
