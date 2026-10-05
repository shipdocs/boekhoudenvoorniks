/*
 * Meta Pixel (advertentiemeting), pas na toestemming van de bezoeker.
 * Zonder "ja" wordt het script van Meta niet geladen en gaat er niets naar Meta.
 * De keuze staat alleen in de browser van de bezoeker (localStorage) en is te wijzigen via de voettekst.
 */
(function () {
  var PIXEL_ID = '919081251050410';
  var KEY = 'bvn-meta-pixel';

  function read() { try { return localStorage.getItem(KEY); } catch (e) { return null; } }
  function write(v) { try { localStorage.setItem(KEY, v); } catch (e) { /* blijft dan alleen voor deze pagina */ } }

  function loadPixel() {
    if (window.fbq) return;
    var f = window, b = document, e = 'script', n, t, s;
    n = f.fbq = function () { n.callMethod ? n.callMethod.apply(n, arguments) : n.queue.push(arguments); };
    if (!f._fbq) f._fbq = n;
    n.push = n; n.loaded = true; n.version = '2.0'; n.queue = [];
    t = b.createElement(e); t.async = true; t.src = 'https://connect.facebook.net/en_US/fbevents.js';
    s = b.getElementsByTagName(e)[0]; s.parentNode.insertBefore(t, s);
    f.fbq('init', PIXEL_ID);
    f.fbq('track', 'PageView');
  }

  function banner() {
    if (document.getElementById('cookie-banner')) return;
    var el = document.createElement('div');
    el.id = 'cookie-banner';
    el.setAttribute('role', 'dialog');
    el.setAttribute('aria-label', 'Meten van advertenties');
    el.innerHTML = '<p><strong>Mogen we meten of onze advertentie werkt?</strong> Met je toestemming laden we de Meta Pixel (Facebook en Instagram). Meta plaatst dan cookies en ziet dat je deze site bezocht. Zonder toestemming gaat er niets naar Meta. <a href="privacy.html#website">Meer uitleg</a></p>' +
      '<div class="row"><button type="button" class="btn small" data-choice="ja">Toestaan</button><button type="button" class="btn small ghost" data-choice="nee">Niet toestaan</button></div>';
    el.addEventListener('click', function (ev) {
      var choice = ev.target && ev.target.getAttribute && ev.target.getAttribute('data-choice');
      if (!choice) return;
      write(choice);
      el.remove();
      if (choice === 'ja') loadPixel();
    });
    document.body.appendChild(el);
  }

  var saved = read();
  if (saved === 'ja') loadPixel();
  else if (saved !== 'nee') banner();

  document.addEventListener('click', function (ev) {
    var t = ev.target;
    if (t && t.closest && t.closest('[data-cookie-settings]')) {
      ev.preventDefault();
      write('');
      banner();
    }
  });
})();
