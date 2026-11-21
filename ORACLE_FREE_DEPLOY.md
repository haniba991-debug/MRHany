# Oracle Always Free VM deployment

This is the always-on VM path for the Telegram webhook. It avoids a sleeping web process, but Oracle's free compute capacity can be unavailable and idle Always Free VMs may be reclaimed. No free provider can guarantee both uninterrupted uptime and a zero bill.

## Prerequisites

- An Oracle Cloud account with an Always Free eligible VM (Ubuntu ARM64 is supported by the Dockerfile).
- A DNS name pointed at the VM's public IP. A free dynamic DNS name can work; the domain provider's availability and terms apply.
- In the Oracle network security list, allow inbound TCP ports 80 and 443. Do not expose app port 8080 publicly.
- A Google service account for the Firebase project with the `Cloud Datastore User` role, used only for Firestore session persistence.

## Configure

On the VM, install Docker Engine and the Docker Compose plugin, clone the repository, then create a private `/app/.env.production` file (mode `600`) with:

```dotenv
NODE_ENV=production
PORT=8080
TELEGRAM_MODE=webhook
WEBHOOK_EXECUTION_MODE=sync
TELEGRAM_AUTO_SET_WEBHOOK=true
GEMINI_FREE_TIER_ONLY=true
LOG_FORMAT=json
TELEGRAM_WEBHOOK_URL=https://YOUR_DOMAIN/telegram/webhook
TELEGRAM_BOT_TOKEN=YOUR_BOTFATHER_TOKEN
TELEGRAM_WEBHOOK_SECRET=GENERATE_WITH_OPENSSL_RAND_HEX_32
ADMIN_SECRET=GENERATE_WITH_OPENSSL_RAND_HEX_32
GEMINI_API_KEY=YOUR_GOOGLE_AI_STUDIO_KEY
GCP_PROJECT_ID=YOUR_FIREBASE_PROJECT_ID
FIRESTORE_DATABASE_ID=(default)
TELEGRAM_MAX_FILE_BYTES=20971520
GOOGLE_SERVICE_ACCOUNT_JSON_B64=BASE64_OF_SERVICE_ACCOUNT_JSON
PUBLIC_DOMAIN=YOUR_DOMAIN
```

Generate secrets on the VM with `openssl rand -hex 32`. Keep the service account JSON and `.env.production` off GitHub, and do not paste them into chat. Encode the service account key locally on the VM with `base64 -w0 service-account.json` and put the result into the environment file. Grant only the required Firestore data role to that service account.

## Run

Create the Caddy configuration and Compose file provided in this repository, then start the service:

```bash
docker compose --env-file .env.production -f compose.oracle.yaml up -d --build
docker compose --env-file .env.production -f compose.oracle.yaml logs -f app
```

Caddy requests and renews the HTTPS certificate automatically when the domain resolves to the VM and ports 80/443 are reachable. The bot registers its Telegram webhook at startup. Check `https://YOUR_DOMAIN/healthz`, then use the admin dashboard's webhook check.

## Keep it healthy

- Configure Oracle Cloud budget alerts even for an Always Free tenancy.
- Monitor the VM and Firestore quota. Firestore free quota is finite; session writes can stop working if credentials or quotas fail, but the bot falls back to in-memory sessions and logs the error.
- Back up `.env.production` and the service account key securely. The VM's local temporary generated files are not a durable user file store.
- Oracle may reclaim idle Always Free compute; this plan is not an uptime guarantee.
