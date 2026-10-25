# Daily Dig

A small, finite daily feed of history snippets from Wikipedia, laid out like
Instagram: one post per screen, images first, short swipeable cards, and a link
to the full article. Each morning brings a fixed number of posts (20 by default,
about 25 minutes of reading), and when you reach the end you're done for the day.

## How it works

```
GitHub Actions (every morning)
  └─ scripts/build-feed.mjs  → picks articles from your topics, splits each
                               article's opening section into cards, adds images
                               and credits, writes site/feed/latest.json
GitHub Pages
  └─ site/                   → the phone app (a PWA): reads latest.json,
                               works offline once it has loaded for the day
```

- **No accounts, no tracking, no infinite scroll.** Saved posts and reading
  progress live only on your phone.
- **Articles don't repeat** for 180 days (`data/history.json` keeps track).
- **Candidates are cached** in `data/candidates.json`. Crawling Wikipedia's
  categories is slow, so each topic is only re-crawled every 14 days, or as soon
  as you change that topic in the config.

## Changing topics and settings

Everything you'd want to tweak is in [`config.json`](config.json):

| Setting | What it does |
|---|---|
| `postsPerDay` | How many posts arrive each day. |
| `topics` | The subjects in your feed (see below). |
| `topics[].weight` | Share of the daily posts. `2` gets twice as many as `1`. |
| `topics[].depth` | How far into sub-categories to look. `0` is the category itself, `2` goes two levels down. Higher means more variety but more drift off-topic. |
| `topics[].categories` | Wikipedia category names, without the `Category:` prefix. |
| `skipCategoriesMatching` | Sub-categories containing these words are never explored. |
| `skipDescriptionsMatching` | Articles whose short description contains these words are skipped (keeps out councils, Acts of Parliament, companies and so on). |
| `repeatAfterDays` | How long before an article may appear again. |
| `minLeadWords` | Skip articles whose opening section is shorter than this. |
| `maxCardsPerPost` | The maximum number of text cards per post. |

**Adding a topic:** find a category on Wikipedia (it's listed at the bottom of
any article, e.g. *Category:Roman Britain*) and add a block like:

```json
{
  "id": "roman-britain",
  "label": "Roman Britain",
  "weight": 1,
  "depth": 2,
  "categories": ["Roman Britain"]
}
```

Renamed categories that redirect to new names (like *Medieval England* →
*Medieval history of England*) are followed automatically. A category that
doesn't exist prints a warning in the build log.

## Running it locally

Needs Node 20 or newer. There are no dependencies to install.

```bash
node scripts/build-feed.mjs --force --posts=5
```

```bash
node scripts/serve.mjs
```

Then open http://localhost:4173. Other flags for the build script:
`--refresh` re-crawls all topics now, and `--date=YYYY-MM-DD` builds a feed for another day.

## Putting it on your phone

1. **Create a public GitHub repository** (e.g. `daily-dig`) and push the contents
   of this folder to its `main` branch. GitHub Pages is free for public repos.
   All the content is from Wikipedia anyway.
2. In the repo go to **Settings → Pages** and set **Source** to **GitHub Actions**.
3. Go to **Actions → Daily feed → Run workflow** to build and publish the first
   feed. After that it runs by itself every morning at 05:20 UTC.
4. Your app is at `https://<your-username>.github.io/daily-dig/`.
5. On your iPhone, open that address in **Safari**, tap **Share → Add to Home
   Screen**. On Android, open it in Chrome and choose **Install app**.

The workflow commits each day's feed back to the repo. GitHub pauses scheduled
workflows in repos with no activity for 60 days. If that ever happens, the
Actions tab shows a button to turn the schedule back on.

## Credits

Text is from Wikipedia under CC BY-SA 4.0. Images come from Wikimedia Commons
under their individual licences. Each post's final card credits the author and
licence, linked to the original file.
