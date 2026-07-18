# PisoFi Local Console Notes

Date: 2026-07-18

## Orange Pi Access

- SSH host: `192.168.137.235`
- SSH user: `codex`
- SSH key: `C:\Users\PC\.ssh\orangepi_codex_ed25519`

## Deployed Local Console

- URL: `http://192.168.137.235/local-console/index.php`
- API base: `http://192.168.137.235/local-console/api.php?path=...`
- Remote path: `/var/www/html/pisofi/public/local-console/`

## API Paths Implemented

- `status`
- `dashboard/stats`
- `clients`
- `devices`
- `tickets`
- `wipass`
- `rates`
- `licenses`
- `credits`
- `credits/balance`
- `tokens`

## Design/Data Sources

- Uses existing PisoFi public CSS/assets from `/var/www/html/pisofi/public`.
- Uses the route concepts from `pisofi-site-copy.zip`.
- Reads the existing `pisofi` MariaDB tables.
- Does not expose stored access-token values.
- Does not forge or bypass commercial PisoFi licensing.

## Relevant Live App Paths

- Captive portal front controller: `/var/www/html/pisofi/public/index.php`
- Real Slim app: `/.cache/tmp/55/05/pfi/bootstrap/app.php`
- Web routes: `/.cache/tmp/55/05/pfi/app/Routes/web.php`
- API routes: `/.cache/tmp/55/05/pfi/app/Routes/api.php`
- Portal controller: `/.cache/tmp/55/05/pfi/app/Controllers/PortalController.php`
- Cloud request class: `/.cache/tmp/55/05/pfi/app/Pisofi/Server/PisofiServerRequest.php`
