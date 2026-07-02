# Quantra AI — Backend Schema

> ✅ done & live · ⬜ left

Storage is dual-backend: **Postgres** on Render (DATABASE_URL) or a **file store**
(`data/*.json`) locally. Same logical schema either way.

## Entities
```
orgs (workspace)                    users
┌──────────────────┐    1..n  ┌──────────────────────┐
│ id               │◄─────────│ email (id, lowercase)│
│ name             │          │ passHash (scrypt)    │
│ plan (ultimate)  │          │ verified, createdAt  │
│ usage {day, ai}  │          │ orgId                │
└──────────────────┘          └──────────┬───────────┘
                                          │ 1..1
                              userData (per user)
                              ┌─────────────────────────────┐
                              │ watchlist[]  prefs{}        │
                              │ screens[]    portfolio[]    │
                              │ layouts[]    paper{}        │
                              │ alerts[]     affinity[]     │  ← personalization (top-40)
                              │ pushSubs[]   notes[]        │
                              └─────────────────────────────┘
sessions                       snapshots (track record)
┌──────────────────┐          ┌──────────────────────────────┐
│ token (random)   │          │ date (unique)                │
│ email, createdAt │          │ items[{type,symbol,score,    │
│ expiry           │          │        price,sd}]            │
└──────────────────┘          │ prevHash, hash (SHA-256      │
                              │ chain — tamper-evident)      │
audit log                     └──────────────────────────────┘
┌──────────────────────────┐
│ ts, action, actor, ip,   │   community: ideas[], votes
│ meta {}                  │   (per-org shared store)
└──────────────────────────┘
```

## Relationships & rules
- user → org: many-to-one (workspace); plan read from org, currently forced Ultimate
  (FORCE_ULTIMATE) and super-admins always Ultimate. ✅
- sessions expire; cookie HttpOnly+SameSite=Lax+Secure. ✅
- snapshots form a hash chain: `hash = SHA256(date + items + prevHash)` — the public
  ledger at /api/track-record/ledger breaks if any row is edited/back-dated. ✅
- audit log records signup/login/deny/admin actions with IP. ✅

## Security / access rules
| Rule | Status |
|---|---|
| Passwords one-way scrypt; nobody (incl. admin) can read them | ✅ |
| Admin can delete accounts; cannot approve-gate (removed by request) | ✅ |
| /api/me/* requires session; /api/admin/* requires SUPER_ADMINS email | ✅ |
| Rate limits: auth attempts, broker connect (15/h), orders (60/h) | ✅ |
| Row-level: users only ever read/write their own userData | ✅ (enforced in code) |
| ⬜ DB-level RLS policies (single-app server owns the DB; app-layer enforced) | left |
| ⬜ Session table pruning job (expired rows accumulate) | left |
| ⬜ Backups/restore runbook for Render Postgres | left |

## Schema checklist vs template
| Template item | Status |
|---|---|
| Database tables | ✅ documented above |
| Relationships | ✅ |
| Auth rules | ✅ |
| User security policies | ✅ app-layer (DB-level RLS left) |
| Diagram | ✅ |
