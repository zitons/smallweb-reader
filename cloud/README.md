# Small Web Reader

A personal reading list for independent blogs: a static GitHub Pages frontend,
daily GitHub Actions generation, and a Cloudflare Worker with D1 for private
reading state and feedback. No local models and no AI-generated summaries.

Built on the Preact reading UI and concepts from
[CondenseIt](https://github.com/wildlifechorus/condenseit) (MIT). See `LICENSE`.

## How it works

1. Actions downloads Kagi Small Web RSS/Atom and merges recent candidates from D1.
2. SiliconFlow `BAAI/bge-m3` embeds articles and six separate topic descriptions.
3. Selection keeps topic coverage, limits each author, removes similar articles,
   and reserves a small exploration slot. Feedback makes a limited adjustment.
4. The daily list is published through an authenticated service endpoint.
5. GitHub Pages fetches lists from the Worker after the reader logs in.

The default interests are cognitive science, spaced repetition, school education,
computer science, open source, and rational thinking. Edit `cloud/config.yaml`.
Similarity is relevance, not a quality guarantee; the initial thresholds are
heuristics, not measured accuracy scores.

The daily workflow runs at approximately 07:17 Asia/Shanghai. GitHub may delay
scheduled runs; **Actions > Generate daily reading list > Run workflow** is also
available. Public repositories with no activity for 60 days can have schedules
disabled by GitHub.

## Deploy

### Cloudflare

```sh
cd cloud/worker
npm ci
npx wrangler login
npx wrangler d1 create smallweb-reader
```

Put the returned database ID into `wrangler.jsonc`. Set `ALLOWED_ORIGINS` to your
exact Pages origin, such as `https://YOUR_USER.github.io` (no repository path).

```sh
npm run migrate:remote
npx wrangler secret put AUTH_PASSWORD
npx wrangler secret put SESSION_SECRET
npx wrangler secret put SYNC_TOKEN
npm run deploy
```

Use different random secrets. `AUTH_PASSWORD` is the reader's login password.
`SESSION_SECRET` signs 12-hour login tokens. `SYNC_TOKEN` allows the daily job to
read feedback and publish lists; it cannot log in as the reader. Never put these
values or the embedding API key in `vars` or frontend build variables.

### GitHub

In repository settings:

- Set **Pages > Source** to **GitHub Actions**.
- Add the Actions variable `READER_API_URL` with the deployed Worker URL.
- Add the Actions secret `READER_SYNC_TOKEN` with the Worker's `SYNC_TOKEN`.
- Add the Actions secret `SILICONFLOW_API_KEY` with your embedding API key.

Run **Publish reader to GitHub Pages**, then **Generate daily reading list**.
The frontend uses the Pages base path, so project repositories work without a
custom domain. Data updates do not require rebuilding the frontend.

Only the application shell is published to Pages. Articles, private feedback and
reading history are fetched through authenticated API calls. The Actions cache
contains embeddings of public blog content and the configured topic descriptions,
not passwords, feedback, or reading history. Failed collection or embedding
requests leave the previous digest available. Re-running on the same date replaces
that day's digest rather than creating a duplicate.

## Feedback

- **有收获**: a positive interest signal, once per article.
- **话题不感兴趣**: a small negative interest signal.
- **质量不佳 / 已经了解**: hide that article; do not infer dislike of its topic.
- **已读**: reading state, not approval.
- **收藏**: reading list, not approval.

Changing a verdict replaces the previous one. The next daily run uses the current
feedback. Clear feedback restores a neutral verdict; reading state is independent.
Saved articles remain available even if they no longer appear in the daily list.

## Local development

```sh
uv sync
cd cloud/worker
npm ci
# Create ignored .dev.vars with AUTH_PASSWORD, SESSION_SECRET, SYNC_TOKEN.
npm run migrate:local
npm run dev
```

Generate a list from the repo root with `READER_API_URL`, `READER_SYNC_TOKEN`, and
`SILICONFLOW_API_KEY` in the environment:

```sh
uv run python cloud/generate.py
```

Build the frontend with `VITE_CLOUD_MODE=true`,
`VITE_API_BASE_URL=http://127.0.0.1:8787`, and `VITE_BASE_PATH=/smallweb-reader/`.
Use `npm run preview -- --host 127.0.0.1 --port 4173` in `frontend`.
Sessions use a bearer token in per-tab session storage, so cross-site cookies are
not required between GitHub Pages and Workers. Logout deletes the local token;
already issued tokens expire after 12 hours. Rotate `SESSION_SECRET` to invalidate
all issued sessions.

## Checks

```sh
uv run --with pytest python -m pytest tests/test_cloud_generation.py -q
cd cloud/worker
npm run typecheck
npm test
cd ../../frontend
npm run build
# Set READER_PASSWORD for a local instance populated with a reading list.
node tests/cloud-smoke.mjs
```

The original CondenseIt self-hosted app remains available when the frontend is
built without `VITE_CLOUD_MODE=true`. Cloud mode uses the separate lightweight API
in `cloud/worker`, not the original FastAPI server.
