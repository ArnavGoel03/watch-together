# Website spacing refresh, 2026-09-15

- [x] Inspect existing layout and identify the spacing collapse.
- [x] Restore vertical spacing and redesign feature, setup and privacy layouts.
- [x] Verify desktop/mobile renders, demo behaviour and project gates.
- [x] Commit, push, deploy the site and verify production assets.
- [x] Update project state and Atlas records.

The `.wrap` padding shorthand overrides header, section and footer block padding.
Keep container gutters on the inline axis so each section owns its vertical rhythm.
Existing approved copy and product artwork remain the source for this change.

## Verification

- `npm test`: lint, six TypeScript configurations, dash/version gates, 252 Node,
  64 Vitest and 46 Worker tests pass.
- CI `34952106797`: all six jobs pass, including real workerd, Chrome/Firefox,
  store package builds, responsive geometry and demo checks.
- Desktop and phone viewport screenshots reviewed; retained in
  `docs/evidence/site-refresh-2026-09-15/`. Full-page captures after resizing were
  incomplete, so the gate now scrolls each section into view before capture.
- All homepage text matches the previous approved source (whitespace/order ignored).
- Vercel deployment `dpl_CxxW3ymtmdaBXNuqjxzrZBJBZVFB`, source `62944e6`.
  Live homepage, styles, script, support and privacy match local source bytes.
- Unscoped deploy was rejected; explicit `--scope arnavgoel03s-projects` succeeded.

No website-refresh work remains. Existing store submission and provider
qualification tasks remain in their own release records.
