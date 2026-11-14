# Cost controlled Cloud Run deployment

Cloud Run can run this webhook service at low or zero cost while it stays inside its monthly free quota. It is **not a guaranteed zero cost host**: Google requires billing to be enabled, and usage or network traffic outside the free quota can be billed. Set a small budget alert before deployment; budget alerts notify you but are not a hard spending cap.

The service configuration in `cloudrun.service.yaml` scales to zero, uses request based CPU, one instance, one concurrent request, synchronous webhook processing, and the Gemini free model allowlist. The first Telegram update after scale-to-zero can be delayed while the container starts. Long AI jobs can exceed Telegram's webhook timeout; for reliable all day service, use an always-on VM and accept its free-tier availability limits.

## 1. Required values

Keep these values in Google Secret Manager, never in Git:

- `GEMINI_API_KEY`
- `TELEGRAM_BOT_TOKEN`
- `TELEGRAM_WEBHOOK_SECRET` (at least 32 random characters)
- `ADMIN_SECRET` (at least 32 random characters)

Generate two random secrets locally:

```bash
openssl rand -hex 32
openssl rand -hex 32
```

The service account running Cloud Run needs `roles/datastore.user` on the Firebase project so the bot can store Telegram sessions in Firestore. It should also have Secret Manager Secret Accessor on the four secrets.

## 2. Deploy

Enable Cloud Run, Cloud Build, Artifact Registry, and Secret Manager APIs, then create the four secrets and grant the service account access. Deploy the container from the repository:

```bash
gcloud run deploy mr-hany-telegram-bot \
  --source . \
  --region europe-west1 \
  --allow-unauthenticated \
  --port 8080 \
  --cpu 1 \
  --memory 1Gi \
  --timeout 60 \
  --min 0 \
  --max 1 \
  --concurrency 1 \
  --set-env-vars "NODE_ENV=production,TELEGRAM_MODE=webhook,WEBHOOK_EXECUTION_MODE=sync,GEMINI_FREE_TIER_ONLY=true,TELEGRAM_AUTO_SET_WEBHOOK=true,LOG_FORMAT=json" \
  --set-secrets "GEMINI_API_KEY=gemini-api-key:latest,TELEGRAM_BOT_TOKEN=telegram-bot-token:latest,TELEGRAM_WEBHOOK_SECRET=telegram-webhook-secret:latest,ADMIN_SECRET=mr-hany-admin-secret:latest"
```

Get the service URL and set the webhook URL so startup can register it:

```bash
SERVICE_URL=$(gcloud run services describe mr-hany-telegram-bot --region europe-west1 --format="value(status.url)")
gcloud run services update mr-hany-telegram-bot \
  --region europe-west1 \
  --update-env-vars "TELEGRAM_WEBHOOK_URL=${SERVICE_URL}/telegram/webhook"
```

The app uses the Cloud Run service identity to reach Firestore; do not add a service account key to Cloud Run.

## 3. Check the service

```bash
SERVICE_URL=$(gcloud run services describe mr-hany-telegram-bot --region europe-west1 --format="value(status.url)")
curl -i "$SERVICE_URL/healthz"
curl -i "$SERVICE_URL/readyz"
```

The dashboard's **Check Webhook** action requires the `ADMIN_SECRET`. Confirm the registered URL ends with `/telegram/webhook` and that Telegram reports no delivery error.

## 4. Cost and privacy limits

- The Google Cloud free quota is shared across a billing account and can be exhausted. Network egress and some features may be billed separately.
- Firestore's free quota is finite. Telegram sessions are stored in `telegram_sessions`; they contain conversation history and user preferences.
- Gemini's free API tier has rate limits, and Google may use free-tier prompts to improve its services. The `GEMINI_FREE_TIER_ONLY=true` setting avoids the paid-only model and disables live search/maps grounding.
- Cloud Run scales to zero, so this is a cost-conscious webhook deployment, not a warm always-running server.
