import dotenv from "dotenv";
import { Bot } from "grammy";

dotenv.config({ override: true });

async function main() {
  const action = (process.argv[2] || "info").toLowerCase();
  const argUrl = process.argv[3];

  const token = (process.env.TELEGRAM_BOT_TOKEN || "").trim().replace(/^["']|["']$/g, "");
  if (!token || token === "YOUR_TELEGRAM_BOT_TOKEN") {
    console.error("Error: TELEGRAM_BOT_TOKEN is not set in environment.");
    process.exit(1);
  }

  const bot = new Bot(token);

  if (action === "info") {
    const [me, info] = await Promise.all([bot.api.getMe(), bot.api.getWebhookInfo()]);
    console.log(
      JSON.stringify(
        {
          bot: { id: me.id, username: me.username, firstName: me.first_name },
          webhook: info,
        },
        null,
        2
      )
    );
    return;
  }

  if (action === "delete") {
    const dropPending = process.argv.includes("--drop-pending");
    await bot.api.deleteWebhook({ drop_pending_updates: dropPending });
    console.log(`Webhook deleted (drop_pending_updates=${dropPending}).`);
    return;
  }

  if (action === "set") {
    const rawUrl = (argUrl || process.env.TELEGRAM_WEBHOOK_URL || "").trim();
    const secret = (process.env.TELEGRAM_WEBHOOK_SECRET || "").trim();

    if (!rawUrl || !rawUrl.startsWith("https://")) {
      console.error(
        "Error: Provide an HTTPS webhook URL as argument or set TELEGRAM_WEBHOOK_URL=https://<cloud-run-url>/telegram/webhook"
      );
      process.exit(1);
    }
    if (!secret || secret.length < 8 || secret.startsWith("YOUR_")) {
      console.error(
        "Error: TELEGRAM_WEBHOOK_SECRET must be configured (at least 8 characters, recommended 32+ hex chars)."
      );
      process.exit(1);
    }

    const cleanUrl = rawUrl.replace(/\/+$/, "");
    const finalUrl =
      cleanUrl.endsWith("/telegram/webhook") || cleanUrl.endsWith("/api/telegram/webhook")
        ? cleanUrl
        : `${cleanUrl}/telegram/webhook`;

    await bot.api.setWebhook(finalUrl, {
      secret_token: secret,
      drop_pending_updates: false,
      max_connections: 40,
      allowed_updates: ["message", "callback_query"],
    });

    const info = await bot.api.getWebhookInfo();
    console.log(JSON.stringify({ ok: true, registeredUrl: finalUrl, webhookInfo: info }, null, 2));
    return;
  }

  console.error("Unknown command. Use: tsx scripts/telegram-webhook.ts [info|set|delete] [https-url]");
  process.exit(1);
}

main().catch((err) => {
  console.error("Webhook CLI failed:", err?.message || err);
  process.exit(1);
});
