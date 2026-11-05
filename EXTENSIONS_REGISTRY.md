# Girru Extensions Registry

> المخزن الرسمي لإضافات Girru — الرسمية والمجتمعية في مكان واحد.

---

## ما هو هذا الـ Repo؟

هذا الـ repo هو المصدر الرسمي لجميع إضافات (extensions) منصة **Girru**.
كل إضافة لها مجلد خاص بها، واسم المجلد هو معرّفها الفريد — وبما أن GitHub لا يسمح بمجلدين بنفس الاسم، فالتفرد مضمون تلقائياً.

```
Agent-Player/extensions
├── public-chat/          ← رسمي
├── email-client/         ← رسمي
├── discord/              ← رسمي
├── slack/                ← رسمي
├── john.analytics/       ← مجتمعي (PR من مطور خارجي)
└── jane.world-maps/      ← مجتمعي
```

---

## هيكل الإضافة

كل إضافة تتبع هذا الهيكل الموحّد:

```
my-extension/
├── agentplayer.plugin.json     ← الـ Manifest (مطلوب)
├── index.js                    ← Backend activation (مطلوب)
├── migrations/                 ← جداول قاعدة البيانات (اختياري)
│   └── 001_init.sql
└── frontend/                   ← صفحات الواجهة (اختياري)
    └── dashboard/
        └── my-extension/
            ├── page.tsx
            └── ...
```

### عند التثبيت (`ext install my-extension`)

```
migrations/    → تُشغَّل في قاعدة البيانات
index.js       → يُحمَّل في الـ Backend
frontend/      → تُنسخ إلى مساراتها في Next.js
```

### عند الإزالة (`ext remove my-extension`)

```
frontend/      ← تُحذف من Next.js
الجداول       ← تبقى (لحماية البيانات)
```

---

## الـ Manifest (`agentplayer.plugin.json`)

```json
{
  "id": "public-chat",
  "name": "Public Chat Rooms",
  "description": "Create and manage public AI-powered chat rooms with avatar support and embedding",
  "version": "1.0.0",
  "type": "app",
  "author": "agent-player",
  "main": "index.js",
  "agentplayer": ">=1.3.0",
  "capabilities": {
    "database": true,
    "cron": false,
    "tools": false,
    "api": true,
    "frontend": true
  },
  "frontend": {
    "pages": [
      {
        "src": "frontend/dashboard/public-chat",
        "dest": "src/app/(dashboard)/dashboard/public-chat"
      }
    ]
  }
}
```

### حقول الـ Manifest

| الحقل | النوع | الوصف |
|-------|-------|-------|
| `id` | string | معرّف فريد (نفس اسم المجلد) |
| `name` | string | الاسم المعروض |
| `description` | string | وصف مختصر |
| `version` | string | إصدار semantic (1.0.0) |
| `type` | string | `app` \| `channel` \| `tool` \| `integration` |
| `author` | string | اسم المطور أو GitHub username |
| `main` | string | ملف الـ entry point |
| `agentplayer` | string | الحد الأدنى من إصدار Girru |
| `capabilities` | object | ما تحتاجه الإضافة |
| `frontend.pages` | array | مسارات الصفحات للنسخ |

---

## الـ `index.js` — Backend Entry Point

```javascript
import { join, dirname } from 'path';
import { fileURLToPath } from 'url';

const __dirname = dirname(fileURLToPath(import.meta.url));

export async function activate(api) {
  // 1. تشغيل migrations لإنشاء الجداول
  await api.runMigrations([
    join(__dirname, 'migrations', '001_init.sql'),
  ]);

  // 2. تسجيل API routes
  const { registerMyRoutes } = await import('../../src/api/routes/my-extension.js');
  await api.fastify.register(registerMyRoutes);

  // 3. تسجيل أدوات الـ AI (اختياري)
  api.registerTool({
    name: 'my_tool',
    description: 'Does something useful',
    handler: async (args) => ({ result: 'done' }),
  });

  api.log('info', 'My Extension activated');
}

export async function deactivate(api) {
  api.log('info', 'My Extension deactivated');
}
```

### الـ Extension API

```typescript
api.fastify              // Fastify instance للـ routes
api.db                   // Database instance
api.runMigrations([])    // تشغيل migration files
api.registerTool({})     // إضافة AI tool
api.getConfig()          // قراءة إعدادات الإضافة
api.setConfig({})        // حفظ إعدادات الإضافة
api.log(level, message)  // تسجيل الأحداث
```

---

## أنواع الإضافات

| النوع | الوصف | مثال |
|-------|-------|-------|
| `app` | تطبيق كامل بواجهة وـ API | public-chat, email-client |
| `channel` | قناة تواصل تظهر في Sidebar | discord, slack, telegram |
| `tool` | أداة للـ AI Agent | web-search, code-runner |
| `integration` | تكامل مع خدمة خارجية | google-calendar, stripe |

---

## كيف تنشر إضافتك؟

### 1. Fork هذا الـ Repo

```bash
git clone https://github.com/Agent-Player/extensions.git
cd extensions
```

### 2. أنشئ مجلد إضافتك

اسم المجلد = معرّف الإضافة. استخدم الصيغة: `author.extension-name`

```bash
mkdir john.my-analytics
cd john.my-analytics
```

### 3. أنشئ الـ Manifest

```bash
# يمكن استخدام الـ CLI لتوليده تلقائياً
npx agentplayer-cli ext:create
```

### 4. ضع ملفاتك

```
john.my-analytics/
├── agentplayer.plugin.json
├── index.js
├── migrations/
│   └── 001_init.sql
└── frontend/
    └── dashboard/
        └── my-analytics/
            └── page.tsx
```

### 5. تحقق من صحة الإضافة

```bash
# GitHub Actions سيتحقق تلقائياً عند فتح الـ PR:
# ✓ agentplayer.plugin.json صحيح
# ✓ id يطابق اسم المجلد
# ✓ لا يوجد id مكرر
# ✓ index.js موجود
# ✓ لا malicious code
```

### 6. افتح Pull Request

```bash
git checkout -b add-john.my-analytics
git add john.my-analytics/
git commit -m "feat: add john.my-analytics extension"
git push origin add-john.my-analytics
# افتح PR على GitHub
```

---

## كيف تثبّت إضافة في نظامك؟

```bash
# تثبيت إضافة من الـ Registry
npm run ext:install public-chat

# إزالة إضافة
npm run ext:remove public-chat

# تثبيت كل الإضافات الموجودة محلياً
npm run ext:sync

# تفعيل/تعطيل الإضافة من واجهة النظام
# Dashboard → Extensions → Toggle
```

---

## قواعد النشر

1. **اسم المجلد فريد** — لا يمكن تكراره (GitHub يمنع ذلك تلقائياً)
2. **الصيغة الموصى بها للاسم**: `author.extension-name` (بالحروف الصغيرة والنقطة)
3. **`id` في الـ manifest يجب أن يطابق اسم المجلد بالضبط**
4. **`index.js` فقط** — لا TypeScript في الـ entry point
5. **`migrations/` تستخدم `IF NOT EXISTS`** دائماً
6. **لا تعديل على ملفات إضافات الآخرين** — كل PR يمس مجلداً واحداً فقط

---

## الإضافات الرسمية

### ✅ Active Extensions (شغالة)

| الإضافة | النوع | الوصف | الحالة |
|---------|-------|-------|--------|
| `waf-security` | tool | WAF Security Scanner - فحص أمان تطبيقات الويب | ✅ **Active** |

### ⚠️ Extensions Needing Migration (محتاجة تحديث)

| الإضافة | النوع | الوصف | الحالة | المطلوب |
|---------|-------|-------|--------|---------|
| `discord` | channel | تكامل مع Discord | ⚠️ **Needs Migration** | Convert to new SDK format |
| `slack` | channel | تكامل مع Slack | ⚠️ **Needs Migration** | Convert to new SDK format |
| `telegram` | channel | تكامل مع Telegram | ⚠️ **Needs Migration** | Convert to new SDK format |
| `whatsapp` | channel | تكامل مع WhatsApp | ⚠️ **Needs Migration** | Convert to new SDK format |

### 📋 Migration Checklist for Old Extensions

**الإضافات الأربعة (Discord, Slack, Telegram, WhatsApp) تحتاج:**

- [ ] تحديث الـ Manifest:
  - من `agent-player.plugin.json` → `agentplayer.plugin.json`
  - إضافة `capabilities` object
  - تحديث `frontend.pages` structure

- [ ] تحويل TypeScript إلى JavaScript:
  - ملف `index.js` يجب يكون pure JavaScript
  - لا TypeScript syntax في الـ entry point
  - يمكن استخدام TypeScript في باقي الملفات

- [ ] تحديث الـ API Integration:
  - استخدام ExtensionApi من SDK
  - `api.fastify.register()` للـ routes
  - `api.registerTool()` للأدوات

- [ ] اختبار Integration:
  - تثبيت الإضافة محلياً
  - اختبار الـ activation/deactivation
  - التأكد من الـ migrations شغالة

**وقت تقديري:** 1 يوم لكل إضافة (4 أيام للكل)

---

## الـ CLI

```bash
# عرض الإضافات المتاحة في الـ Registry
npx agentplayer-cli ext:list

# تثبيت إضافة
npx agentplayer-cli ext:install public-chat

# إزالة إضافة
npx agentplayer-cli ext:remove public-chat

# إنشاء إضافة جديدة (wizard تفاعلي)
npx agentplayer-cli ext:create

# التحقق من صحة إضافة
npx agentplayer-cli ext:validate ./my-extension
```

---

## الترخيص

كل إضافة تحدد ترخيصها الخاص.
الإضافات الرسمية مرخصة تحت [MIT License](LICENSE).

---

## 📋 TODO: Extensions Migration Roadmap

### 🟡 Phase 1: Channel Extensions (4 إضافات - 4 أيام)

#### 1. Discord Extension ⚠️ **Priority: Medium**
**Time:** 1 day
**Status:** Needs migration to new SDK

**Tasks:**
- [ ] Update manifest (`agent-player.plugin.json` → `agentplayer.plugin.json`)
- [ ] Convert `index.ts` to `index.js` (pure JavaScript)
- [ ] Update to use new ExtensionApi
- [ ] Test bot connectivity and message handling
- [ ] Update dashboard integration

#### 2. Slack Extension ⚠️ **Priority: Medium**
**Time:** 1 day
**Status:** Needs migration to new SDK

**Tasks:**
- [ ] Update manifest format
- [ ] Convert TypeScript to JavaScript
- [ ] Update OAuth flow to new SDK
- [ ] Test workspace integration
- [ ] Update slash commands handling

#### 3. Telegram Extension ⚠️ **Priority: Medium**
**Time:** 1 day
**Status:** Needs migration to new SDK

**Tasks:**
- [ ] Update manifest format
- [ ] Convert TypeScript to JavaScript
- [ ] Update bot token handling
- [ ] Test message polling/webhooks
- [ ] Update command handlers

#### 4. WhatsApp Extension ⚠️ **Priority: Medium**
**Time:** 1 day
**Status:** Needs migration to new SDK

**Tasks:**
- [ ] Update manifest format
- [ ] Convert TypeScript to JavaScript
- [ ] Update Twilio integration
- [ ] Test message sending/receiving
- [ ] Update webhook handling

---

### 🎯 Migration vs AI Systems Priority

**Important Note:** Extensions migration is **lower priority** than AI Systems development.

| Category | Priority | Reason |
|----------|----------|--------|
| **AI Systems** (Multi-Tier Memory, Self-Evolution) | 🔴 **HIGH** | Improves agent intelligence for ALL channels |
| **Extensions Migration** (Discord, Slack, etc.) | 🟡 **MEDIUM** | Adds new channels but doesn't improve intelligence |

**Recommendation:**
1. Complete AI Systems first (Multi-Tier Memory + Self-Evolution)
2. Then migrate extensions when needed

This ensures the agent is smarter on ALL platforms before adding more platforms.

---

### 📊 Extension Migration Summary

| Extension | Type | Status | Priority | Est. Time |
|-----------|------|--------|----------|-----------|
| waf-security | tool | ✅ Active | - | Done |
| public-chat | app | ✅ Active | - | Done |
| email-client | app | ✅ Active | - | Done |
| discord | channel | ⚠️ Needs Migration | 🟡 Medium | 1 day |
| slack | channel | ⚠️ Needs Migration | 🟡 Medium | 1 day |
| telegram | channel | ⚠️ Needs Migration | 🟡 Medium | 1 day |
| whatsapp | channel | ⚠️ Needs Migration | 🟡 Medium | 1 day |

**Total Active:** 3 extensions ✅
**Needs Migration:** 4 extensions ⚠️
**Total Time for Migration:** 4 days

---

<div align="center">
  <sub>Built with ❤️ by the Girru community</sub>
  <br>
  <sub>Last Updated: 2026-02-23</sub>
</div>
