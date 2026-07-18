# 3DBPoint License Platform

Self-contained licensing API and admin console for 3DBPoint-owned devices.

This service is intended for your own firmware/apps and local management tooling. It does not remove, forge, or bypass third-party commercial license checks.

## Domains

- API: `https://api.3dbpoint.com`
- Admin: `https://cpanel.3dbpoint.com`

Both domains can point to the same Coolify app. The app serves API routes under `/api/v1/*` and admin pages everywhere else.

## Coolify Setup

1. Create a new Coolify project/app from this folder or from a Git repo containing this folder.
2. Set the build pack to Dockerfile.
3. Set domain names:
   - `api.3dbpoint.com`
   - `cpanel.3dbpoint.com`
4. Add a persistent volume:
   - Container path: `/data`
5. Add environment variables:

```env
PORT=3000
PUBLIC_API_URL=https://api.3dbpoint.com
PUBLIC_ADMIN_URL=https://cpanel.3dbpoint.com
APP_SECRET=replace-with-a-long-random-secret
ADMIN_USERNAME=admin
ADMIN_PASSWORD=replace-with-a-strong-password
DATA_DIR=/data
```

6. Deploy.
7. Open `https://cpanel.3dbpoint.com/login`.
8. Create an API token at `API Tokens`.
9. Register devices and create licenses in the admin console.

## API

All protected API endpoints require:

```http
Authorization: Bearer <api-token>
```

Endpoints:

```http
GET  /health
GET  /api/v1/status
POST /api/v1/devices/register
GET  /api/v1/devices/:serial/license
POST /api/v1/licenses/validate
```

Register device:

```bash
curl -X POST https://api.3dbpoint.com/api/v1/devices/register \
  -H "Authorization: Bearer $API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"serial":"orangepi-001","name":"Orange Pi One"}'
```

Check license:

```bash
curl https://api.3dbpoint.com/api/v1/devices/orangepi-001/license \
  -H "Authorization: Bearer $API_TOKEN"
```

Validate license key:

```bash
curl -X POST https://api.3dbpoint.com/api/v1/licenses/validate \
  -H "Authorization: Bearer $API_TOKEN" \
  -H "Content-Type: application/json" \
  -d '{"serial":"orangepi-001","key":"3DB-XXXX-YYYY"}'
```

## Data Storage

The app stores data in `/data/db.json`.

Back up the Coolify volume regularly. The file includes token hashes, devices, licenses, and audit entries. API token plaintext is shown once during creation and is not stored.

## Local Development

```bash
cp .env.example .env
npm start
```

Open:

```text
http://localhost:3000/login
```
