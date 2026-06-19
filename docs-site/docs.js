/* Laetoli Data docs — shared interactivity: mobile drawer, copy buttons,
   active-link highlight. Zero dependencies. */
(function () {
  'use strict';

  // ---- Mobile sidebar drawer -------------------------------------------
  var body = document.body;
  var toggle = document.querySelector('.menu-toggle');
  var scrim = document.querySelector('.scrim');

  function closeNav() { body.classList.remove('nav-open'); }
  if (toggle) {
    toggle.addEventListener('click', function () {
      body.classList.toggle('nav-open');
    });
  }
  if (scrim) scrim.addEventListener('click', closeNav);
  document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape') closeNav();
  });
  // Close the drawer after picking a destination (mobile).
  document.querySelectorAll('.side-link').forEach(function (a) {
    a.addEventListener('click', closeNav);
  });

  // ---- Active sidebar link (by current file name) ----------------------
  var here = location.pathname.split('/').pop() || 'index.html';
  document.querySelectorAll('.side-link').forEach(function (a) {
    var href = (a.getAttribute('href') || '').split('/').pop();
    if (href === here) a.classList.add('active');
  });

  // ---- Copy-to-clipboard buttons ---------------------------------------
  document.querySelectorAll('.copy-btn').forEach(function (btn) {
    btn.addEventListener('click', function () {
      var sel = btn.getAttribute('data-copy-target');
      var el = sel ? document.getElementById(sel) : null;
      if (!el) return;
      var text = el.innerText;
      var done = function () {
        var orig = btn.textContent;
        btn.textContent = 'Imenakiliwa ✓';
        btn.classList.add('copied');
        setTimeout(function () {
          btn.textContent = orig;
          btn.classList.remove('copied');
        }, 1600);
      };
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(done, fallback);
      } else {
        fallback();
      }
      function fallback() {
        var ta = document.createElement('textarea');
        ta.value = text;
        ta.style.position = 'fixed';
        ta.style.opacity = '0';
        document.body.appendChild(ta);
        ta.select();
        try { document.execCommand('copy'); done(); } catch (e) { /* noop */ }
        document.body.removeChild(ta);
      }
    });
  });
})();
