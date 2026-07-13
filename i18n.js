/* Quantra AI — lightweight i18n (English ⇄ العربية) with RTL.
   Zero-dependency, opt-in: does NOTHING unless the user picks Arabic. English
   users are completely unaffected. Translates the static UI chrome (nav, tabs,
   buttons, labels, placeholders) by exact-string match — dynamic analysis text
   stays source-language for now (full content localization is a funded phase).
   Numbers/prices are forced LTR inside the RTL layout so they stay readable. */
(() => {
  'use strict';
  const AR = {
    // top nav
    'Terminal': 'الطرفية', 'Brief': 'الموجز', 'Web3': 'ويب٣', 'Discover': 'اكتشف',
    'Calendar': 'التقويم', 'Screener': 'الفرز', 'Paper': 'تداول تجريبي', 'Trade': 'تداول',
    'Portfolio': 'المحفظة', 'Community': 'المجتمع', 'Track record': 'سجل الأداء', 'News': 'الأخبار',
    'Sign in': 'تسجيل الدخول', 'Live': 'مباشر', 'System status': 'حالة النظام',
    // board tabs
    'Crypto': 'العملات الرقمية', 'Stocks': 'الأسهم', 'ETFs': 'الصناديق', 'Commodities': 'السلع',
    'Futures': 'العقود الآجلة', 'Indices': 'المؤشرات', 'Forex': 'الفوركس',
    '★ For you': '★ لك', '👥 Team': '👥 الفريق',
    // board + detail
    'Asset': 'الأصل', 'Price': 'السعر', 'Loading live markets…': 'جارٍ تحميل الأسواق المباشرة…',
    'Search any symbol…': 'ابحث عن أي رمز…', 'Select an asset to generate a live read.': 'اختر أصلاً لعرض تحليل مباشر.',
    'Interval': 'الفاصل الزمني', 'Range': 'المدى', 'Chart': 'الرسم البياني',
    'Seconds · live': 'ثوانٍ · مباشر', 'Minute': 'دقيقة', 'Hour': 'ساعة', 'Day': 'يوم', 'Week': 'أسبوع',
    'Line': 'خط', 'Area': 'مساحة',
    // account menu
    'Plan': 'الخطة', 'Workspace': 'مساحة العمل', 'Export my data': 'تصدير بياناتي',
    'Sign out': 'تسجيل الخروج', 'Delete account': 'حذف الحساب', 'Free': 'مجاني',
    // landing (index) common CTAs
    'Open the terminal': 'افتح الطرفية', 'Get started': 'ابدأ الآن', 'Live demo': 'عرض مباشر',
    'The honest markets terminal': 'منصة الأسواق الصادقة',
  };
  const KEY = 'quantra.lang';
  const getLang = () => { try { return localStorage.getItem(KEY) || 'en'; } catch { return 'en'; } };
  const setLang = (l) => { try { localStorage.setItem(KEY, l); } catch {} };

  function translate() {
    if (getLang() !== 'ar') return;
    const walk = (root) => {
      // element text: leaf elements whose trimmed text exactly matches a key
      root.querySelectorAll('a, button, span, label, option, h1, h2, h3, th, div, small, p').forEach((el) => {
        if (el.children.length === 0) {
          const t = el.textContent.trim();
          if (AR[t]) el.textContent = AR[t];
        }
      });
      // placeholders
      root.querySelectorAll('input[placeholder]').forEach((el) => {
        const t = el.getAttribute('placeholder').trim(); if (AR[t]) el.setAttribute('placeholder', AR[t]);
      });
    };
    walk(document);
  }

  function applyDir() {
    const ar = getLang() === 'ar';
    document.documentElement.setAttribute('dir', ar ? 'rtl' : 'ltr');
    document.documentElement.setAttribute('lang', ar ? 'ar' : 'en');
  }

  function toggleBtn() {
    // fixed floating button — reachable on every page layout AND above the auth gate
    if (document.getElementById('langTog')) return;
    const b = document.createElement('button');
    b.id = 'langTog'; b.type = 'button'; b.className = 'lang-tog';
    b.textContent = getLang() === 'ar' ? 'EN' : 'ع';
    b.title = getLang() === 'ar' ? 'Switch to English' : 'التبديل إلى العربية';
    b.addEventListener('click', () => { setLang(getLang() === 'ar' ? 'en' : 'ar'); location.reload(); });
    document.body.appendChild(b);
  }

  function boot() { applyDir(); toggleBtn(); translate(); }
  if (document.readyState !== 'loading') boot(); else document.addEventListener('DOMContentLoaded', boot);
  // re-translate after late dynamic renders (board, menus) — cheap, idempotent
  if (getLang() === 'ar') { let n = 0; const iv = setInterval(() => { translate(); if (++n >= 8) clearInterval(iv); }, 800); }
})();
