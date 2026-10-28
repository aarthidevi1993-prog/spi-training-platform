# Review Notes: ARSÈNE SPI Training Platform (source-code review copy)

**ARSÈNE Technology Services Private Limited**

| | |
|---|---|
| Purpose | Source-code review copy for internal management review. **This is not a project handover.** |
| Prepared | 22 October 2026 |
| Source | Git commit `fbd90cc` ("feat: implement training reports and exports") on branch `trial/course-management` |
| Contents | 648 files from that commit, unchanged, plus this note |
| Classification | Internal: Company Confidential. Please keep it in a restricted location. |

## About this copy

- Every file is an exact copy of the committed version at `fbd90cc`. The folder structure is the same as in the project.
- Commit `fbd90cc` adds the **Reports** feature. At the time of copying, this commit had **not yet been deployed to Production**. The live site was running the previous commit, `c38ec8e`.
- Uncommitted local work in the developer's copy is **not** included.

## Excluded on purpose

| Excluded | Reason |
|---|---|
| `.env.local` and any other `.env*` file except `.env.example` | Local environment settings and secrets. They are never shared. `.env.example` contains only empty placeholders. |
| `supabase/.temp/` | Supabase command-line link data (project reference, database connection details) |
| `.git/` | Version-control history and remote account settings |
| `node_modules/`, `.next/` | Installed third-party packages and build output. They are recreated by `npm install` and `npm run build`. |
| `tsconfig.tsbuildinfo`, `next-env.d.ts` | Files generated automatically by the tools |
| `supabase/migrations/0029a_invitation_binding_and_recovery.sql.backup` | A stray local backup, not part of the schema |
| `public/ocr/` (14 files, about 15 MB) | Third-party OCR and PDF engine files. They are recreated by `scripts/copy-ocr-assets.mjs` after `npm install`. |

## Please note

1. **`README.md` is out of date.** It still describes the early "Part 1" foundation and says no modules are implemented. That is no longer true: courses, batches, enrolment, classes, attendance, assignments, question bank and import, tests, results, reports, certificates, notifications, dashboards and user management are all implemented. Treat the source code and `supabase/migrations/` as authoritative.
2. **Demo password in `src/config/auth.ts`.** It is a deliberately public password for local demo mode only. Production builds force demo mode off.
3. **`src/features/`** contains early placeholder folders (READMEs and empty `index.ts` files) from the initial scaffold. The working code is in `src/app`, `src/components`, `src/services`, `src/repositories` and `src/lib`.
4. **Test data is synthetic.** Tests use fictional names, `.test` e-mail domains and dummy phone numbers. One test contains the public production web address.

## Where to start reading

| Topic | Location |
|---|---|
| Pages for each role | `src/app/admin`, `src/app/trainer`, `src/app/student` |
| Access control | `src/middleware.ts`, `src/lib/auth/`, the services in `src/services/` |
| Business rules | `src/services/` |
| Database queries | `src/repositories/` |
| Database schema and security rules | `supabase/migrations/` (apply in numeric order; `0029a` comes after `0029`) |
| Live-change procedures | `docs/runbooks/` |
| Automated tests | `tests/` (each suite has a `run.mjs`) |
