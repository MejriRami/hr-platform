# HR Platform

**▶ [Video walkthrough (3.5 min)](https://mejrirami.github.io/demos/#hr)**

A multi-country, multi-subsidiary HR platform: one application for employees, requests, attendance, payroll
and reporting, with each user's access limited to their own countries and sites, and an AI assistant built in.

## Features

- **Dashboard and statistics**: headcount, contracts to renew, departures; breakdowns by site, seniority, age; PDF / Excel export.
- **Employees**: search and filters across all countries (site, department, position, grade, contract), full employee record, onboarding / offboarding, career events, archives.
- **Org chart** generated from roles and reporting lines, per site, with zoom, search and PDF export.
- **HR requests**: leave, absence permissions, business trips, with multi-level approval workflows per site (`backend/workflow-resolver.cjs`) and notifications.
- **Attendance**: weekly view fed by approved requests and biometric time clocks; automatic leave balances.
- **Visa files**: required documents, progress tracking, generated certificates.
- **Payroll** (`backend/services/paie/`, `backend/routes/paie.cjs`): salaries encrypted at rest with AES-256-GCM and unlocked only with a secret code by authorized users; engine computing social security, income tax and solidarity contributions from imported attendance; payroll journal validation before payslips; covered by tests (`backend/tests/paie/`).
- **AI assistant** (`backend/routes/chatbot.cjs`): OpenAI function calling over HR tools; identity comes from the verified token, every tool enforces the user's country and site scope, and there is no payroll tool at all.
- **Multi-tenant data model**: one PostgreSQL schema per country, selected per request; Microsoft 365 account requests and Microsoft Entra sign-in.

## Architecture

| Part | Stack |
|---|---|
| `backend/` | Node.js, Express, PostgreSQL (schema per country), OpenAI API, Microsoft Graph |
| `frontend/` | React (Create React App), multilingual UI (8 languages) |

## Run locally

```bash
# backend
cd backend
npm install
cp .env.example .env            # DATABASE_URL, JWT_SECRET, OPENAI_API_KEY ...
node server.js                  # port 5000 by default

# frontend
cd frontend
npm install
REACT_APP_API_URL=http://localhost:5000 npm start
```

Company, people and site names in this repository are fictional (the company is "Northwind").
