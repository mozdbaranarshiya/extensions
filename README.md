# مدار | پنل امن مدیریت توکن ادمین

یک سامانهٔ **فارسی، راست‌به‌چپ و سازگار با GitHub Pages** برای **توکن‌های مدیریتی**، با backend جداگانه روی Cloudflare Workers + D1.

> [!IMPORTANT]
> این یک **مدیر توکن مستقل** است، نه سامانهٔ صدور یا تمدید توکن‌های سرویس GPT Yar. در اکستنشن ارسالی نسخهٔ `4.6.4`، درخواست‌های توکن به `api.gptyar.com` می‌روند و مسیرهایی مانند `/accupdator/subscribers/create` برای کاربر/مشترک دیده می‌شوند؛ این پروژه **هیچ‌یک از مسیرهای مشترکان یا مدیریت توکن کاربران را ندارد**. تا زمانی که مالک backend اصلی، کنترل توکن‌های ادمین را از طریق introspection یا API ویژه به این سرویس متصل نکند، توکن‌های `adm_...` توسط آن اکستنشن پذیرفته نمی‌شوند.

## بخش‌های سامانه

- داشبورد فارسی: آمار فعال، لغوشده، منقضی و فعالیت‌های اخیر.
- فهرست و **صدور، تمدید، چرخش و لغو توکن‌های مدیریتی**.
- نمایش مقدار توکن **فقط یک بار** (هنگام صدور یا چرخش).
- ورود مدیر از طریق GitHub OAuth و **allowlist شناسهٔ عددی GitHub در سمت سرور**.
- هش HMAC-SHA256 با secret سمت سرور؛ هیچ توکن خامی در D1 ذخیره نمی‌شود.
- گزارش عملیات مدیریتی؛ نشست کوتاه‌مدت یک‌ساعته، نگهداری نشست فقط در حافظهٔ صفحه.
- endpoint اختیاری **server-to-server** برای بررسی توکن ادمین: `POST /api/introspect` با کلید محرمانهٔ مجزا.
- **بدون endpoint یا مدل دادهٔ توکن کاربران**.

## ساختار

```text
index.html                    # صفحهٔ GitHub Pages
config.js                     # فقط نشانی عمومی API؛ هرگز رمز وارد نکنید
assets/app.js                 # رابط کاربری و API client
assets/styles.css             # طراحی responsive
.nojekyll
worker/src/index.js           # سرور مدیریت + احراز هویت GitHub
worker/wrangler.toml          # تنظیمات Worker + D1
worker/migrations/0001_initial.sql
worker/.dev.vars.example      # صرفاً نمونه؛ بدون secrets واقعی
worker/tests/worker.test.mjs  # تست‌های محلی
```

## راه‌اندازی به ترتیب

### ۱. ساخت دیتابیس Cloudflare D1

Cloudflare account لازم است. در پوشهٔ `worker` اجرا کنید:

```bash
npx wrangler login
npx wrangler d1 create extensions_admin_tokens
```

شناسهٔ `database_id` بازگشتی را در `worker/wrangler.toml` جایگزین `YOUR_D1_DATABASE_UUID` کنید. سپس:

```bash
npx wrangler d1 migrations apply extensions_admin_tokens --remote
```

### ۲. ساخت OAuth App در GitHub

در **GitHub → Settings → Developer settings → OAuth Apps → New OAuth App**، یک برنامهٔ OAuth بسازید:

- **Homepage URL**: `https://mozdbaranarshiya.github.io/extensions/`
- **Authorization callback URL**: `https://YOUR-WORKER.YOUR-SUBDOMAIN.workers.dev/auth/callback`

**Client ID** عمومی را در `worker/wrangler.toml` جایگزین `GITHUB_CLIENT_ID` کنید؛ **Client Secret** را فقط در secretهای Worker وارد کنید. برای اجازهٔ ورود، شناسهٔ **عددی** حساب‌های مدیر را در `ALLOWED_GITHUB_IDS` با کاما جدا کنید. از `login`/username استفاده نکنید، زیرا قابل تغییر است.

### ۳. پیکربندی و انتشار Worker

`PUBLIC_WORKER_ORIGIN` را دقیقاً برابر نشانی HTTPS Worker خود قرار دهید؛ `FRONTEND_URL` باید در حالت پروژهٔ Pages به `https://mozdbaranarshiya.github.io/extensions/` اشاره کند. سپس در پوشهٔ `worker`:

```bash
npx wrangler secret put GITHUB_CLIENT_SECRET
npx wrangler secret put TOKEN_PEPPER
npx wrangler secret put INTROSPECTION_KEY
npx wrangler deploy
```

برای `TOKEN_PEPPER` و `INTROSPECTION_KEY` دو مقدار تصادفی **مستقل و قوی** بسازید (مثلاً با `openssl rand -hex 32`)؛ مقدار هر دو محرمانه است. **هرگز secretها، Client Secret یا توکن صادرشده را در git، config.js یا issue قرار ندهید.** تعویض `TOKEN_PEPPER` باعث نامعتبر شدن توکن‌های موجود می‌شود.

**نکتهٔ راه‌اندازی اولیه:** برای گرفتن نشانی Worker، یک بار می‌توانید `wrangler deploy` را بعد از جایگزینی مقادیر عمومی اجرا کنید، بعد نشانی واقعی را در `PUBLIC_WORKER_ORIGIN` و تنظیمات GitHub OAuth قرار دهید و دوباره deploy کنید. تا پیکربندی کامل نشود، API با خطای 503 پاسخ می‌دهد.

### ۴. GitHub Pages

در فایل عمومی `config.js`، نشانی Worker را بگذارید:

```js
window.ADMIN_PANEL_CONFIG = Object.freeze({
  API_BASE_URL: 'https://YOUR-WORKER.YOUR-SUBDOMAIN.workers.dev'
});
```

در **Repository → Settings → Pages**، گزینهٔ **Deploy from a branch** را انتخاب و branch `main` و پوشهٔ `/ (root)` را تنظیم کنید. صفحهٔ پروژه در این آدرس خواهد بود:

`https://mozdbaranarshiya.github.io/extensions/`

فعّال کردن GitHub Pages و ساخت Secretهای Cloudflare باید **توسط صاحب حساب** انجام شوند؛ صرفاً قرار دادن کد در مخزن، backend یا Pages را خودکار فعال نمی‌کند.

## API محدود به ادمین

| روش | مسیر | کاربرد |
|---|---|---|
| GET | `/auth/start` | ورود با GitHub OAuth |
| GET | `/auth/callback` | برگشت از GitHub |
| GET | `/api/me` | هویت مدیر |
| POST | `/api/logout` | خروج |
| GET/POST | `/api/admin-tokens` | فهرست / صدور توکن ادمین |
| POST | `/api/admin-tokens/:id/extend` | تمدید |
| POST | `/api/admin-tokens/:id/rotate` | چرخش + لغو قبلی |
| POST | `/api/admin-tokens/:id/revoke` | لغو |
| GET | `/api/audit` | گزارش رویدادها |
| POST | `/api/introspect` | بررسی اعتبار توکن؛ فقط سرویس‌های مورداعتماد |

**سایر مسیرها، از جمله `/accupdator/subscribers/*`، پشتیبانی نمی‌شوند (404).** حتی اگر کسی با DevTools صفحه را تغییر دهد، برای عملیات مدیر نیاز به نشست معتبر و مجوز سمت سرور دارد. خود صفحهٔ GitHub Pages عمومی است؛ محرمانه‌بودن داده و عملیات را صرفاً backend تأمین می‌کند.

### مثال استفاده از introspection در backend مورد اعتماد

درخواست به Worker از **سرور** (نه مرورگر و نه فایل‌های عمومی) فرستاده شود:

```bash
curl -X POST "https://YOUR-WORKER.YOUR-SUBDOMAIN.workers.dev/api/introspect" \
  -H "Authorization: Bearer YOUR_SERVER_INTROSPECTION_KEY" \
  -H 'Content-Type: application/json' \
  --data '{"token":"adm_THE_ADMIN_TOKEN"}'
```

پاسخ به‌صورت `{ "active": true/false, ... }` است. کلید `INTROSPECTION_KEY` به‌هیچ‌وجه نباید در اکستنشن مرورگر یا GitHub Pages باشد. در صورت اتصال به backend موجود، **آن backend** باید این فراخوانی را server-to-server انجام دهد.

## آزمایش محلی

برای بررسی منطق worker با Node.js 22 یا جدیدتر:

```bash
cd worker
npm test
```

تست‌ها از پایگاه دادهٔ SQLite حافظه‌ای استفاده می‌کنند و به حساب Cloudflare/GitHub احتیاج ندارند. برای پیش‌نمایش ظاهر از یک HTTP server محلی استفاده کنید؛ در حالت بدون تنظیم backend، اطلاعات واقعی نمایش داده نخواهد شد.

## یادداشت‌های امنیتی

- GitHub Pages از backend یا اجرای کد محافظت‌شده پشتیبانی نمی‌کند؛ بنابراین Worker ضروری است.
- dashboard مقدار توکن را در `localStorage` یا `sessionStorage` نگه نمی‌دارد؛ با refresh دوباره باید وارد شوید.
- امنیت نهایی deployment به حفاظت GitHub/Cloudflare و کلیدهای محرمانه، MFA مدیر، تنظیم CORS/redirect دقیق، rate limiting در Cloudflare و پایش لاگ‌ها وابسته است.
- اگر هدف مدیریت **توکن‌های واقعی GPT Yar** است، مالک آن backend باید API مستند و مجاز ویژهٔ توکن‌های مدیریتی بدهد؛ از روی اکستنشن، endpoint ساخت/تمدید توکن ادمین قابل تأیید نبود. **نباید با APIهای توکن کاربران این کار را شبیه‌سازی کرد.**