# Renaming this project

End-to-end renames are orchestrated by `bin/proj rename`. The legacy step-by-step
workflow is preserved at the bottom for situations where you want manual control.

---

## Recommended path — one command

```sh
bin/proj rename --to <new-slug> --display "<New Display Name>"
```

This runs every step in order, prompts before each shared-system change, and
re-validates at the end:

1. Pre-flight `proj validate`
2. Update `project.config.json` (move current slug into `previousSlugs`)
3. `git grep`-driven sed across this repo + the portfolio site
4. Append a rename event to `.rename-history.jsonl`
5. `mv` the local folder
6. `gh repo rename` (skip with `--skip-github`)
7. Vercel project rename via REST API + alias preservation (skip with `--skip-vercel`)
8. Re-run `proj validate` from the new folder

Flags:

| Flag             | Purpose                                                   |
|------------------|-----------------------------------------------------------|
| `--to <slug>`     | New canonical slug (kebab-case lowercase) — **required**  |
| `--display "..."` | New display name (default: keep current)                  |
| `--dry-run`       | Print the plan, change nothing                            |
| `--yes`           | Skip confirmation prompts                                 |
| `--skip-github`   | Don't run `gh repo rename`                                |
| `--skip-vercel`   | Don't touch Vercel project / domains                      |
| `--notes "..."`   | Recorded in the history log entry                         |

After the rename, `cd` into the new folder — the script's path is now under
`~/Documents/Projects/<new>/bin/proj`.

---

## Manual path (legacy reference)

For full transparency about what `proj rename` does under the hood — or for
breaking the operation into pieces when something goes wrong mid-flight.

### 0. Pre-flight
```sh
proj validate
```

### 1. Update the config
Edit `project.config.json`:
- Move current `slug` into `previousSlugs[]`
- Move current `displayName` into `previousDisplayNames[]`
- Set new `slug`, `displayName`, `urls.production`
- Update `github.repo`, `vercel.project`, `bundleId`, `packageName`

### 2. Rename the local folder
```sh
mv ~/Documents/Projects/<old> ~/Documents/Projects/<new>
cd ~/Documents/Projects/<new>
```

### 3. Rename the GitHub repo
```sh
gh repo rename <new> --yes      # auto-updates the local remote
git remote -v                   # verify
```

### 4. Rename the Vercel project
```sh
TOKEN=$(jq -r .token ~/Library/Application\ Support/com.vercel.cli/auth.json)
TEAM=team_xxx   # `curl -s "https://api.vercel.com/v2/teams" -H "Authorization: Bearer $TOKEN" | jq`

curl -s -X PATCH "https://api.vercel.com/v9/projects/<old>?teamId=$TEAM" \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"name":"<new>"}'
```
The old `<old>.vercel.app` subdomain is preserved on the renamed project. If you
also want a `<new>.vercel.app` (or fallback like `<new>-app.vercel.app`), POST it
to the project's domains list.

### 5. Sed-replace stale references
```sh
grep -rln --exclude-dir=node_modules --exclude-dir=.next --exclude-dir=.git \
  "<old>" . ~/Documents/Projects/portfolio \
  | xargs sed -i '' "s/<old>/<new>/g"
```
Run a second pass for display names — `sed "s/Old Name/New Name/g"`.

### 6. Add a Next.js redirect
```ts
// portfolio/next.config.ts
async redirects() {
  return [
    { source: "/projects/<old>", destination: "/projects/<new>", permanent: true },
  ];
}
```
Add `next.config.ts` to `keepReferencesIn` in your `project.config.json` so the
drift checker doesn't flag the redirect rule.

### 7. Log the rename
```sh
proj log --old <old> --new <new> \
  --display-old "Old Name" --display-new "New Name" \
  --surfaces folder,github,vercel,site,ios,android \
  --notes "Why this rename happened"
```

### 8. Verify
```sh
proj drift       # no leftovers
proj validate    # everything in sync
```

### 9. Commit + push
```sh
git add -A
git commit -m "Rename <old> → <new>"
git push
```

---

## Recovering from a half-done rename

```sh
proj history     # which rename ran, what surfaces were touched
proj validate    # which surfaces still match config, which don't
proj drift       # where stale references still live
```

If a third-party link still points at `<old>.vercel.app` and you accidentally
removed it from the project's aliases, add it back:

```sh
curl -s -X POST "https://api.vercel.com/v10/projects/<new>/domains?teamId=$TEAM" \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"name":"<old>.vercel.app"}'
```
