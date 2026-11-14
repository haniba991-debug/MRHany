# دليل نشر بوت مستر هاني (Mr. Hany) على Google Cloud Run مع Telegram Webhook

هذا الدليل يشرح خطوة بخطوة تحويل ونشر **Mr. Hany – Advanced AI Assistant** كخدمة مستقلة بالكامل على **Google Cloud Run** باستخدام **HTTPS Webhook** و **Google Secret Manager**.

---

## 1. المتطلبات المسبقة (Prerequisites)

1. مشروع Google Cloud: `gen-lang-client-0702633943` (مع تفعيل الفوترة Billing).
2. تثبيت وتهيئة `gcloud` CLI:
   ```bash
   gcloud auth login
   gcloud config set project gen-lang-client-0702633943
   ```
3. تفعيل واجهات البرمجة المطلوبة:
   ```bash
   gcloud services enable \
     run.googleapis.com \
     cloudbuild.googleapis.com \
     artifactregistry.googleapis.com \
     secretmanager.googleapis.com
   ```

---

## 2. إنشاء الأسرار في Secret Manager (تأمين المفاتيح)

> لا تضع أي مفاتيح أو توكنات داخل الكود أو `Dockerfile` مطلقاً.

1. إنشاء توكن سري قوي للتحقق من Webhook (32 بايت عشوائي):
   ```bash
   WEBHOOK_SECRET=$(openssl rand -hex 32)
   echo "Generated Webhook Secret: $WEBHOOK_SECRET"
   ```
2. حفظ الأسرار في **Google Secret Manager**:
   ```bash
   printf "%s" "YOUR_REAL_GEMINI_API_KEY" | gcloud secrets create gemini-api-key --data-file=-
   printf "%s" "YOUR_REAL_TELEGRAM_BOT_TOKEN" | gcloud secrets create telegram-bot-token --data-file=-
   printf "%s" "$WEBHOOK_SECRET" | gcloud secrets create telegram-webhook-secret --data-file=-
   printf "%s" "$(openssl rand -hex 24)" | gcloud secrets create mr-hany-admin-secret --data-file=-
   ```
3. منح حساب الخدمة الافتراضي لـ Cloud Run صلاحية قراءة الأسرار:
   ```bash
   PROJECT_NUMBER=$(gcloud projects describe gen-lang-client-0702633943 --format="value(projectNumber)")
   SA_EMAIL="${PROJECT_NUMBER}-compute@developer.gserviceaccount.com"

   for SECRET in gemini-api-key telegram-bot-token telegram-webhook-secret mr-hany-admin-secret; do
     gcloud secrets add-iam-policy-binding "$SECRET" \
       --member="serviceAccount:${SA_EMAIL}" \
       --role="roles/secretmanager.secretAccessor"
   done
   ```

---

## 3. النشر على Google Cloud Run

استخدم الأمر التالي لبناء صورة Docker ونشرها مباشرة على Cloud Run:

> **هام جداً:** يجب تفعيل `--no-cpu-throttling` حتى تستمر المهام الطويلة (مثل تحليل المخططات وتوليد ملفات Excel/PDF/Word بالذكاء الاصطناعي) في التنفيذ بسلاسة بعد إرسال استجابة `200 OK` الفورية لتليجرام.

```bash
gcloud run deploy mr-hany-telegram-bot \
  --source . \
  --region europe-west1 \
  --platform managed \
  --allow-unauthenticated \
  --port 8080 \
  --cpu 2 \
  --memory 2Gi \
  --timeout 300 \
  --min-instances 1 \
  --max-instances 5 \
  --no-cpu-throttling \
  --set-env-vars "NODE_ENV=production,TELEGRAM_MODE=webhook,WEBHOOK_EXECUTION_MODE=async,LOG_FORMAT=json,TELEGRAM_AUTO_SET_WEBHOOK=true" \
  --set-secrets "GEMINI_API_KEY=gemini-api-key:latest,TELEGRAM_BOT_TOKEN=telegram-bot-token:latest,TELEGRAM_WEBHOOK_SECRET=telegram-webhook-secret:latest,ADMIN_SECRET=mr-hany-admin-secret:latest"
```

---

## 4. ربط Telegram Webhook برابط Cloud Run HTTPS

بعد انتهاء النشر، احصل على رابط الخدمة الرسمي:
```bash
SERVICE_URL=$(gcloud run services describe mr-hany-telegram-bot --region europe-west1 --format="value(status.url)")
echo "Cloud Run URL: $SERVICE_URL"
```

1. **تحديث متغير `TELEGRAM_WEBHOOK_URL` داخل Cloud Run** (للتسجيل التلقائي عند إعادة التشغيل):
   ```bash
   gcloud run services update mr-hany-telegram-bot \
     --region europe-west1 \
     --update-env-vars "TELEGRAM_WEBHOOK_URL=${SERVICE_URL}/telegram/webhook"
   ```

2. **تسجيل Webhook لدى Telegram API مع Secret Token**:
   يمكنك استخدام السكربت الجاهز داخل المشروع:
   ```bash
   TELEGRAM_BOT_TOKEN="YOUR_BOT_TOKEN" \
   TELEGRAM_WEBHOOK_SECRET="$WEBHOOK_SECRET" \
   npm run webhook:set -- "${SERVICE_URL}/telegram/webhook"
   ```
   أو عبر `curl` مباشرة:
   ```bash
   curl -X POST "https://api.telegram.org/bot<TELEGRAM_BOT_TOKEN>/setWebhook" \
     -H "Content-Type: application/json" \
     -d "{
       \"url\": \"${SERVICE_URL}/telegram/webhook\",
       \"secret_token\": \"${WEBHOOK_SECRET}\",
       \"max_connections\": 40,
       \"allowed_updates\": [\"message\", \"callback_query\"]
     }"
   ```

---

## 5. التحقق من جاهزية الخدمة بعد النشر

1. **فحص Health Checks**:
   ```bash
   curl -i "${SERVICE_URL}/healthz"
   curl -i "${SERVICE_URL}/readyz"
   ```
2. **التحقق من حالة Webhook لدى Telegram**:
   ```bash
   TELEGRAM_BOT_TOKEN="YOUR_BOT_TOKEN" npm run webhook:info
   ```
   تأكد أن `url` يطابق `${SERVICE_URL}/telegram/webhook` وأن `last_error_message` فارغ.
3. **التحقق من رفض الطلبات غير المصرح بها**:
   ```bash
   curl -i -X POST "${SERVICE_URL}/telegram/webhook" \
     -H "Content-Type: application/json" \
     -d '{"update_id": 1}'
   # يجب أن يعيد HTTP 401 Unauthorized
   ```
4. **مراقبة السجلات (Cloud Logging)**:
   ```bash
   gcloud run services logs read mr-hany-telegram-bot --region europe-west1 --limit 50
   ```
