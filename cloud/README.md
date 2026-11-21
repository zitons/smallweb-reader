# Small Web Reader

A personal article library for independent blogs: a static GitHub Pages frontend,
hourly RSS collection, daily recommendations, and a Cloudflare Worker with D1
for the archive, private reading state and feedback. No local models and no AI-generated summaries.

Built on the Preact reading UI and concepts from
[CondenseIt](https://github.com/wildlifechorus/condenseit) (MIT). See `LICENSE`.

## How it works

1. An hourly Actions job archives every entry returned by Kagi Small Web RSS/Atom,
   without calling an embedding model. All collected articles remain available
   for search, reading, saving and explicit feedback through the article library.
   The source feed is a window of recent entries, not a complete historical dump.
   The separate daily job merges recent candidates from D1 for ranking.
2. SiliconFlow `BAAI/bge-m3` embeds articles and eight initial topic descriptions.
3. Explicitly approved articles form multiple interest centers using spherical
   KMeans on API vectors (no local language model). Selection ranks against the
   nearest center, limits authors, removes similar articles and reserves a small
   exploration slot among eligible candidates.
4. The daily list is published through an authenticated service endpoint.
5. GitHub Pages opens the full article library after login. Server-side search
   covers all archived titles, sources and content; cursor pagination has no
   recent-date cutoff. Daily selections remain a separate optional view.

The default interests are cognitive science, spaced repetition, school education,
computer science, open source, rational thinking, language learning and
comprehensible input. Use **Settings > Interests** in the reader;
initial defaults are in `cloud/preferences.json`.
Similarity is relevance, not a quality guarantee; the initial thresholds are
heuristics, not measured accuracy scores.

The archive workflow runs hourly; manually run **Sync article archive** for an
immediate collection. The daily workflow runs at approximately 07:17 Asia/Shanghai. GitHub may delay
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

Run **Publish reader to GitHub Pages**, **Sync article archive**, then optionally
**Generate daily reading list**.
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
All archived articles accept feedback, including older articles never selected
for a daily list. Saved articles remain available outside daily selections.

## Reading interface

The hosted reader uses GitHub's Primer CSS with a compact monochrome layout,
small corners and thin borders. It defaults to dark mode and remembers an explicit
light/dark choice. Desktop navigation, title/source/excerpt filtering, history,
read-state controls, expandable excerpts and explicit feedback remain available.
Saving updates the library and its count immediately; clicking or saving never
trains a positive interest signal. Only the light and dark color tokens are bundled.
Icons ship as inline SVG, with no external font CDN.

A browser regression script uses real public article content and intercepts
feedback writes, so UI checks do not change the reader's actual preferences:
`frontend/tests/reader-ui.mjs`. It covers login, save/reload/unsave, current verdicts,
search, excerpts, read controls, expired-session recovery, theme persistence and
four viewport widths.

## Reader settings

The gear button opens Settings on desktop and mobile. Theme, compact/comfortable
density and default read filtering are saved in D1 and loaded after login on each
device. The header theme button saves just the theme, preserving other settings.
The saved hide-read preference is the startup default; the list checkbox can
temporarily change the current view.

Interest names and descriptions can be added, edited or deleted (1?20 interests).
Saving changes future daily runs, not the already published list. Descriptions
guide cold-start/mixed retrieval; the explicit-positive article profile still
takes over once enough effective samples exist. No embedding call is made while
editing settings. Cloudflare exposes authenticated GET/POST /api/settings and the
service snapshot carries saved interests to the generator. Display settings do
not enter the vector cache or static Pages output.

Apply all Worker migrations, including 0002_settings.sql and
0003_article_archive.sql, before deploying the Worker. Unsaved edits are kept in the form until saved or
explicitly discarded. Failed validation leaves the stored preferences unchanged.

## Learning from approved articles

Only the current **有收获** verdict supplies a positive sample. Clicking, reading
and saving never imply approval. Changing or undoing the verdict removes that
sample on the next daily run. Topic dislikes retain a small ranking penalty;
quality/known feedback hides an article without training a topic dislike.

With no approved samples, initial topic descriptions provide exploratory results.
For n effective approved articles, the profile weight is min(n / 10, 1);
the remainder uses initial descriptions. Ten is an adjustable starting policy,
not an accuracy guarantee. A source contributes at most three samples. Once ten
effective samples exist, written topics no longer determine relevance.

Spherical KMeans uses up to min(10, floor(sqrt(n))) centers, bounded by unique
vectors. This adapts rssfilter's multiple-interest approach; it does not copy
rssfilter's fixed ten clusters or implicit click signal. Recommendations identify
a real approved article representing their closest interest group instead of
asserting an unverified topic classification. Diversity follows interest groups
once the profile has at least half the relevance weight.

Approved and topic-disliked article text is retrieved independently of the recent
candidate pool (up to 300 most recently rated articles). Old samples remain useful
after the 30-day candidate limit. Only public article text vectors enter the
Actions cache; verdicts and computed interest centers are not cached or published
to Pages. The previous 0.42 relevance threshold remains unchanged. These changes
have functional regression tests, not a measured recommendation accuracy score.

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
