# Free hosting deployment (Render)

This Blueprint runs the existing Node server and the frontend together as one Docker web service. It keeps Firebase Auth and Firestore as the app services, and stores Telegram sessions in Firestore.

## Deploy

1. Sign in to Render with the GitHub account that can access this repository, choose **New > Blueprint**, and select `MRHany` on the `codex/free-cloud-foundation` branch.
2. Confirm that Render detects `render.yaml` and selects the free Frankfurt Docker web service.
3. During Blueprint setup, enter these values in Render's environment-variable form. Never put the values in GitHub or in chat:
   - `TELEGRAM_BOT_TOKEN`: token from BotFather.
   - `TELEGRAM_WEBHOOK_SECRET`: random letters, numbers, `_` or `-`, at least 32 characters.
   - `ADMIN_SECRET`: random secret at least 32 characters.
   - `GEMINI_API_KEY`: a Google AI Studio API key on the free tier.
   - `GOOGLE_SERVICE_ACCOUNT_JSON_B64`: base64-encoded Firebase service account JSON. Grant it only the Cloud Datastore User role.
4. Create the service. Render injects `RENDER_EXTERNAL_URL`; the app uses it to register the Telegram webhook automatically.
5. In Firebase Console > Authentication > Settings > Authorized domains, add the Render hostname if Google sign-in is used.
6. Open the Render service URL and check `/healthz`. Then message the bot on Telegram.

## Free-tier limits

The Blueprint selects Render's free web-service plan. Free services sleep after 15 minutes without inbound traffic and can take around a minute to wake. A Telegram update may therefore be delayed while the service wakes. Free service storage is ephemeral, so durable session history uses Firestore. Render's free quota and policies can change; review them before production use. This is a free trial-grade setup, not a 24/7 uptime guarantee.

The Firebase project remains on its current plan; this setup does not enable Blaze. Firestore free quotas still apply. Gemini free-tier quotas also apply, and free-tier prompts may be used by Google to improve its products.
