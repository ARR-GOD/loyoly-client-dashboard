# Loyoly Client Dashboard

Internal performance dashboard displaying all Loyoly clients with metrics synced from HubSpot.

## Setup

```bash
npm install
cp .env.example .env
# Edit .env with your HubSpot API key and Google Client ID
```

## Refresh data

```bash
npm run refresh
```

This pulls ~507 clients from HubSpot, transforms the data, saves to `data/clients.json`, and regenerates `index.html`.

## Deploy to Vercel

```bash
npm i -g vercel
vercel secrets add hubspot-api-key "pat-na1-xxxxxxxx"
vercel secrets add google-client-id "YOUR_ID.apps.googleusercontent.com"
vercel --prod
```

## Auth

- Google Sign-In: restricted to `@loyoly.io`, `@loyoly.com`, `@auracorp.fr`
- Password fallback: `loyoly2026`
- Session persists 7 days in localStorage
