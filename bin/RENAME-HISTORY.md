# Rename history — Serenity

Append-only log of every rename event for this project. Lives at
`./.rename-history.jsonl` (one JSON object per line).

## Why this exists

When a project's name changes across local folder + GitHub repo + Vercel
project + iOS bundle URLs + Android base URLs + portfolio site + docs,
things eventually break — a hardcoded old URL surfacing in a screenshot,
a stale OG image, a search index hit, a backlink. This log makes those
breakages debuggable. Look up the old slug here, see what the new slug
+ URLs are, fix the dangling link.

## Adding an entry

```sh
bin/log-rename.sh \
  --old pcod-tracker \
  --new serenity \
  --display-old "PCOD Tracker" \
  --display-new "Serenity" \
  --surfaces folder,github,vercel,site,ios,android \
  --notes "Native rewrite eclipsed PWA-era branding"
```

## Schema

```jsonc
{
  "ts":            "ISO-8601 timestamp",
  "type":          "project-rename",
  "old":           "old kebab-case slug",
  "new":           "new kebab-case slug",
  "displayOld":    "old human-readable name (optional)",
  "displayNew":    "new human-readable name (optional)",
  "surfaces":      ["folder", "github", "vercel", "site", "ios", "android"],
  "domains": {
    "old":         ["pcod-tracker.vercel.app"],
    "new":         ["serenity-pcos.vercel.app"],
    "preserved":   ["pcod-tracker.vercel.app"]
  },
  "redirects": [
    {"from": "/projects/pcod-tracker", "to": "/projects/serenity", "permanent": true}
  ],
  "notes":         "free-form context"
}
```
