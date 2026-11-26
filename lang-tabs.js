/*
 * GORDIX Studio — 共用語系切換分頁 (EN / 中文 / 日本語)
 * Shared language tabs. Each page calls:
 *   GordixLang.mount(containerEl, currentLang, onChange)
 * onChange(lang) is invoked when the user picks a language.
 */
(function () {
    var LANGS = [
        { code: 'en', label: 'EN', title: 'English' },
        { code: 'zh', label: '中文', title: '繁體中文' },
        { code: 'ja', label: '日本語', title: '日本語' }
    ];
    var HTML_LANG = { en: 'en', zh: 'zh-TW', ja: 'ja' };
    var mounted = [];

    function isValid(l) { return l === 'en' || l === 'zh' || l === 'ja'; }

    // 初始語系：已儲存 → 瀏覽器語系 → 日本語
    function initial() {
        var saved = null;
        try { saved = localStorage.getItem('gordix-lang'); } catch (e) {}
        if (isValid(saved)) return saved;
        var nav = (navigator.languages && navigator.languages[0]) || navigator.language || '';
        nav = nav.toLowerCase();
        var l = nav.indexOf('ja') === 0 ? 'ja' : nav.indexOf('zh') === 0 ? 'zh' : nav.indexOf('en') === 0 ? 'en' : 'ja';
        try { localStorage.setItem('gordix-lang', l); } catch (e) {}
        return l;
    }

    function paint(lang) {
        document.documentElement.lang = HTML_LANG[lang] || lang;
        mounted.forEach(function (m) {
            m.buttons.forEach(function (b) {
                var on = b.getAttribute('data-lang') === lang;
                b.setAttribute('aria-selected', on ? 'true' : 'false');
                b.tabIndex = on ? 0 : -1;
                b.className = 'gx-lang-btn' + (on ? ' gx-lang-on' : '');
            });
        });
    }

    function injectStyle() {
        if (document.getElementById('gx-lang-style')) return;
        var s = document.createElement('style');
        s.id = 'gx-lang-style';
        s.textContent =
            '.gx-lang-tabs{display:inline-flex;align-items:center;gap:2px;padding:2px;border-radius:8px;' +
            'background:rgba(255,255,255,.10);border:1px solid rgba(255,255,255,.20);flex-shrink:0}' +
            '.gx-lang-btn{font:700 11px/1 system-ui,-apple-system,"Segoe UI","Hiragino Sans","Noto Sans JP","Noto Sans TC",sans-serif;' +
            'padding:6px 8px;border-radius:6px;color:rgba(255,255,255,.80);background:transparent;border:0;cursor:pointer;' +
            'white-space:nowrap;transition:background-color .15s,color .15s}' +
            '.gx-lang-btn:hover{background:rgba(255,255,255,.16);color:#fff}' +
            '.gx-lang-btn:focus-visible{outline:2px solid #fb923c;outline-offset:1px}' +
            '.gx-lang-on,.gx-lang-on:hover{background:#fff;color:#0f172a}' +
            '@media (max-width:480px){.gx-lang-tabs{gap:0;padding:1px}.gx-lang-btn{padding:5px 3px;font-size:10px;letter-spacing:-.02em}}@media (max-width:400px){.gx-lang-btn{padding:5px 2px}}';
        document.head.appendChild(s);
    }

    function mount(container, current, onChange) {
        if (!container) return;
        injectStyle();
        container.innerHTML = '';
        container.className = 'gx-lang-tabs';
        container.setAttribute('role', 'tablist');
        container.setAttribute('aria-label', 'Language / 語言 / 言語');
        var buttons = LANGS.map(function (L) {
            var b = document.createElement('button');
            b.type = 'button';
            b.setAttribute('role', 'tab');
            b.setAttribute('data-lang', L.code);
            b.setAttribute('lang', HTML_LANG[L.code]);
            b.title = L.title;
            b.textContent = L.label;
            b.addEventListener('click', function () {
                try { localStorage.setItem('gordix-lang', L.code); } catch (e) {}
                paint(L.code);
                onChange(L.code);
            });
            container.appendChild(b);
            return b;
        });
        // 左右方向鍵切換
        container.addEventListener('keydown', function (e) {
            if (e.key !== 'ArrowLeft' && e.key !== 'ArrowRight') return;
            var i = buttons.indexOf(document.activeElement);
            if (i < 0) return;
            var n = buttons[(i + (e.key === 'ArrowRight' ? 1 : buttons.length - 1)) % buttons.length];
            n.focus(); n.click();
        });
        mounted.push({ buttons: buttons });
        paint(current);
    }

    window.GordixLang = { initial: initial, mount: mount, paint: paint, isValid: isValid };
})();
