// Laetoli Data — landing site. Tiny progressive enhancement: copy-to-clipboard.
// No dependencies. Site works fully without JS.
(function () {
  'use strict';

  document.querySelectorAll('.copy-btn').forEach(function (btn) {
    btn.addEventListener('click', function () {
      var targetId = btn.getAttribute('data-copy-target');
      var el = targetId && document.getElementById(targetId);
      if (!el) return;
      var text = el.innerText;
      var done = function () {
        var original = btn.textContent;
        btn.textContent = 'Imenakiliwa ✓';
        btn.classList.add('copied');
        setTimeout(function () {
          btn.textContent = original;
          btn.classList.remove('copied');
        }, 1800);
      };
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(done).catch(fallback);
      } else {
        fallback();
      }
      function fallback() {
        try {
          var ta = document.createElement('textarea');
          ta.value = text;
          ta.style.position = 'fixed';
          ta.style.opacity = '0';
          document.body.appendChild(ta);
          ta.select();
          document.execCommand('copy');
          document.body.removeChild(ta);
          done();
        } catch (e) { /* no-op */ }
      }
    });
  });
})();
