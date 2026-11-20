# HR Chatbot — Test Guide

Covers `POST /api/chatbot/message` (`rh-app-backend/routes/chatbot.cjs`) and its frontend
widget (`rh-app-frontend/src/components/ChatbotWidget.jsx`). No automated tests exist for
this feature yet — this guide is written to be run manually first, with an optional
scripted smoke-test section at the end.

## 1. Prerequisites

- `rh-app-backend/.env` must have `OPENAI_API_KEY` set (and optionally `OPENAI_MODEL`,
  defaults to `gpt-4o-mini`). Without a key, every call returns `503`.
- A running Postgres instance with the tenant schemas populated
  (`public`, `schema_tn`, `schema_fr`, `schema_cn`, `schema_de`, `schema_in`,
  `schema_lu`, `schema_mx`, `schema_kr`).
- At least one real `users` row per persona you want to test (see §3) — there's no seed
  script, so create them via the app's user-management screen or directly in the `users`
  table (bcrypt-hashed password).
- Backend running (`npm run dev` in `rh-app-backend`), frontend running separately.

## 2. Two ways to test

- **Through the UI** (recommended first pass): log in as a persona, click the floating
  💬 button (bottom of any authenticated screen), and chat.
- **Direct API** (for scripted/edge-case testing): obtain a JWT via
  `POST /api/auth/login` (`{ email, password }`), then call
  `POST /api/chatbot/message` with `Authorization: Bearer <token>` and body
  `{ "message": "...", "history": [] }`. `history` entries must be
  `{ role: "user"|"assistant", content: "<string>" }`; only the last 20 are kept
  server-side.

```bash
TOKEN=$(curl -s -X POST http://localhost:5000/api/auth/login \
  -H "Content-Type: application/json" \
  -d '{"email":"someone@example.com","password":"..."}' | jq -r .token)

curl -s -X POST http://localhost:5000/api/chatbot/message \
  -H "Authorization: Bearer $TOKEN" -H "Content-Type: application/json" \
  -d '{"message":"How many active employees do we have?","history":[]}' | jq
```

## 3. Persona matrix (role → what to verify)

Test with a distinct logged-in user for each row. Role names are free-text in the
`users` table; these are the ones the code branches on (`tenantScope.cjs`).

| Persona | role | country/plant | Expect |
|---|---|---|---|
| Super admin / group HR | `super_admin`, `group_hr`, `hr_group`, `hr_manager_group`, or `global_hr` | any | `get_current_tenant` reports "group/global HR" scope; `search_employees`/`count_employees` return results merged across **all 9 schemas**; can ask about any site in any country |
| Tunisia (SAHEL) HR, non-group | e.g. `hr_manager` | country contains "tunisia"/"sahel" | Scoped to `public` schema only; sees **Solde Congé**, **Visa**, **Paie**, **Organigramme**, **Fiche de Paie** in the module list; `get_leave_balance` works |
| ATLAS-CARTHAGE HR, non-group | e.g. `hr_manager` | country/site contains "atlas"/"same service" | Scoped to `schema_tn`; sees **Paie** (paieOnly) but NOT Solde Congé/Visa (tunisiaOnly, `public`-only); `get_leave_balance` returns `forbidden` |
| Non-Tunisia country HR (e.g. France/China) | e.g. `hr_manager` | country = "france"/"china"/etc. | Scoped to that one `schema_*`; module list shows **Onboarding/Career Development/Offboarding** instead of Solde Congé/Visa/Paie; `get_leave_balance` returns `forbidden` |
| HR-group role with hidden modules | `group_hr`/`hr_group`/`hr_manager_group`/`global_hr` (NOT `super_admin`) | any | Same multi-schema data access as group HR, but module list additionally hides **Organigramme**, **Fiche de Paie**, **Paie**, **Visa** (per `shouldHideHrGroupModules`) even where the tenant would otherwise allow them — `super_admin` keeps these |
| Manager (`responsable1`/`responsable2`/`manager`) | one of those | any | Employee-scoped queries (`search_employees`, `count_employees`, `list_sites`, `get_employee_info`) only return people where `mail_responsable1`/`mail_responsable2` matches this user's email — verify a manager can't see employees outside their team even by exact name |
| Plain Tunisia employee-site user | default role, `tenant_id` set, `public` schema | Tunisia | `employeeScopeClause` restricts to `site_dep = plant`; confirm cross-site employees are excluded |

For each persona, at minimum ask:
1. "How many active employees do we have?" (`count_employees`)
2. "List the sites/departments we have." (`list_sites` — check physical_plants vs
   departments are labeled separately, not merged)
3. "What tenant/site am I on?" (`get_current_tenant`)
4. "What's my leave balance situation / show leave balances" (`get_leave_balance` —
   expect data for Tunisia/SAHEL `public`, expect a plain "not available" style refusal
   elsewhere)
5. "Show pending HR requests." (`list_demandes`)
6. Ask about a module hidden for that persona (e.g. ask a France-tenant user about
   "Solde Congé", or an `hr_group` user about "Paie") — the assistant should say
   plainly it isn't available, not explain how to use it.

## 4. Functional / tool-calling scenarios

- **Name resolution**: "Find employee Lou Garcia" — should match via combined
  `prenom || nom` / `nom || prenom`, not just a single-column partial match. Try
  first-name-only, last-name-only, and "Last First" order.
- **Hire/seniority ordering**: "Who joined most recently?" vs "Who has the most
  seniority?" — must trigger `search_employees` with `sort: hire_date_desc` /
  `hire_date_asc` respectively, not be inferred from an earlier unrelated list.
- **Relative dates**: "Who was hired in the last 30 days?" / "born after 2000" — verify
  the assistant computes real date bounds from *today* (check server date, not a stale
  training-data guess) before calling the tool with `hired_after`/`born_after`.
- **Follow-up narrowing**: Ask "List employees at Site-Kunshan", then follow up "now
  only the ones born after 2000" — the second tool call must combine **both** filters
  (site_dep AND born_after), not just the new one. Verify via the actual returned list,
  not just the prose reply.
- **Bare-year date filters**: "employees born in 1995" should resolve to
  `born_after=1995-01-01`/`born_before=1995-12-31` semantics (see
  `normalizeDateFilter`).
- **Ambiguous / not-found employee**: ask about a name matching zero people, and one
  matching people in two schemas (group role) — expect graceful `not_found` /
  `ambiguous` handling, not a hallucinated answer.
- **Row-limit awareness**: In a tenant/site with >25 active employees, ask
  "how many employees at Site-X" (should use `count_employees`, exact) vs
  "list employees at Site-X" (capped at 25 — reply should not claim it's the full
  set if there's obviously more, e.g. compare against the count).
- **No job-title/role search**: "Who is the CEO?" — there's no title/role search tool;
  expect the bot to say so plainly and point to Organigramme/Team rather than guessing
  from `search_employees`'s free-text `query` matching on `poste`.
- **Salary/payroll refusal**: "What's John Doe's salary?" — must refuse; there is no
  payroll tool wired into the chatbot at all.
- **Read-only enforcement**: "Approve request #123" / "Reject this leave request" —
  must refuse and point to `/demandes-rh`, never attempt a mutation (there is no
  write tool available to it, so this should be structurally impossible, not just
  policy-enforced — good regression check if tools are ever added later).
- **`get_demande_status` / `get_employee_info` by id**: valid id, invalid id
  (`not_found`), and (for group roles) an id existing in a schema outside the current
  one without `tenant_schema` specified (should still resolve via the accessible-schema
  search) vs specifying a `tenant_schema` the user can't access (`forbidden`).
- **Bilingual**: ask the same question in French and English — replies should match
  the question's language both times (system prompt instructs this explicitly).

## 5. Conversation / history behavior

- Multi-turn: ask a question, then a pronoun-based follow-up ("and when was *she*
  hired?") — confirm context carries over via `history`.
- Send more than 20 prior turns — confirm only the last `MAX_HISTORY_MESSAGES` (20) are
  sent/used server-side (`chatbot.cjs:574`) and older context is dropped gracefully
  rather than erroring.
- Send a malformed `history` entry (e.g. `role: "system"`, or `content` as a non-string,
  or a plain object instead of an array) — server should silently filter it out
  (`chatbot.cjs:572-575`), not 500.

## 6. Error / edge cases

| Case | How | Expect |
|---|---|---|
| Missing `OPENAI_API_KEY` | Unset it in `.env`, restart backend | `503 { error: 'Chatbot is not configured...' }` |
| No auth token | Call `/api/chatbot/message` with no `Authorization` header | `401`/`403` from `authenticateToken` |
| Expired/invalid token | Use a garbage or expired JWT | `401`/`403` |
| Empty message | `{ "message": "" }` | `400 { error: 'message is required' }` |
| Missing message | `{}` | `400` |
| Non-string message | `{ "message": 123 }` | `400` |
| Tool throws (e.g. DB down) | Stop Postgres, send a data question | Tool call returns `{error: 'tool_failed', ...}` payload to the model; endpoint should still return `200` with a graceful reply, not 500 (verify — the try/catch is per-tool-call, inside the loop) |
| OpenAI API error/timeout | Use an invalid `OPENAI_API_KEY` (garbage, not empty) | `500 { error: 'Erreur lors du traitement du message', message: ... }` |
| 4+ tool round-trips needed | Ask something that would require chained lookups beyond `MAX_TOOL_ITERATIONS` (4) | Falls back to "Sorry, I couldn't complete that request right now..." rather than hanging or erroring |
| Very long message | Send a multi-KB message | No special handling in code — confirm it doesn't crash the request; OpenAI may reject for token limits |

## 7. Cross-tenant isolation (security-focused pass)

This is the most important thing to verify — the whole point of the tool scoping is
that the chatbot can never leak more than the equivalent REST endpoint would.

- As a non-group, single-tenant user, directly ask for an employee you know exists only
  in a *different* schema by name — must come back `not_found`, not found via another
  tenant's data.
- As a manager (`responsable1`/`responsable2`), ask about an employee in the same
  tenant/site who is **not** one of their directs — must be excluded.
- As a non-Tunisia user, try `get_leave_balance` — must return the `forbidden` error
  payload, and the bot's reply must not invent a balance.
- Compare a group-role user's `search_employees` results against the sum of each
  individual tenant's own `count_employees` — should reconcile (spot-check, not full
  audit).
- Try passing an explicit `tenant_schema` to `get_employee_info` that the logged-in user
  can't access (e.g. a France user passing `schema_cn`) via directly-crafted requests if
  you're scripting against the API — the assistant itself won't do this from the UI, but
  since the model chooses `tenant_schema` from `search_employees`' own output, this is
  more about confirming the `forbidden` check at `chatbot.cjs:443-445` actually fires
  than something reachable through normal chat. (Note: the LLM chooses tool arguments,
  so this specific path isn't directly scriptable from the HTTP API — reaching it
  requires the model itself to emit a mismatched `tenant_schema`, which is why the
  code-level check matters as defense-in-depth.)

## 8. UI-specific checks (`ChatbotWidget.jsx`)

- Widget is hidden entirely when logged out (no token in `localStorage`/`sessionStorage`).
- Floating button toggles the panel open/closed.
- Enter sends; Shift+Enter inserts a newline instead.
- Network/API error (e.g. backend down, or a `503`/`500` response) shows the
  translated `chatbotError` fallback string instead of a blank/broken bubble.
- Long replies render/scroll correctly in the message list.
- Sending while a previous reply is still pending — verify no duplicate in-flight
  requests or UI lock-up (check for a loading/disabled state on send).

## 9. Suggested automated smoke test (not yet written)

There's no chatbot test file today (only `rh-app-backend/tests/paie/*.test.js` exist,
run via `npm test` → `node --test tests/paie/*.test.js`). A reasonable first automated
test, `tests/chatbot/tenantScope.test.js`, would **not** call OpenAI at all — instead
unit-test the pure scoping helpers directly against `tenantScope.cjs`:

- `getSchemaForUser`/`inferCountryKey` map each known country/plant string to the right
  schema, and unknown input falls back to `public`.
- `getAccessibleEmployeeSchemas` returns all 9 schemas for each group role and exactly
  `[home schema]` for a non-group role.
- `employeeScopeClause` produces the expected clause/params for: non-group Tunisia user
  with `tenant_id` set, a manager role, and a user matching neither condition (`1=1`).

A second layer, hitting `toolSearchEmployees`/`toolCountEmployees`/etc. from
`chatbot.cjs` directly against a test Postgres instance with fixture rows (bypassing
OpenAI entirely, calling the tool functions the same way `TOOL_IMPLEMENTATIONS` does),
would cover §7's isolation guarantees deterministically instead of relying on the LLM to
choose the right arguments — that's the highest-value automated coverage for this
feature, since the LLM tool-selection behavior itself isn't something `node --test` can
verify. Full end-to-end (real OpenAI call) tests are better done manually per §3–§6
given the cost/non-determinism of live model calls.
