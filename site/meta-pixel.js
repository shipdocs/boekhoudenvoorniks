/*
 * Meta Pixel (advertentiemeting), pas na toestemming van de bezoeker.
 * Zonder "ja" wordt het script van Meta niet geladen en gaat er niets naar Meta.
 * De keuze staat alleen in de browser van de bezoeker (localStorage) en is te wijzigen via de voettekst.
 */
(function () {
  var PIXEL_ID = '919081251050410';
  var KEY = 'bvn-meta-pixel';

  function read() { try { return localStorage.getItem(KEY); } catch (e) { return null; } }
  var memoryChoice = null;
  function readChoice() { return read() || memoryChoice; }
  function write(v) {
    memoryChoice = v || null;
    try {
      if (v) localStorage.setItem(KEY, v);
      else localStorage.removeItem(KEY);
    } catch (e) { /* keuze blijft dan alleen voor deze pagina */ }
  }

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
    var el = document.getElementById('privacy-choice');
    if (el) el.hidden = false;
  }

  function hideBanner() {
    var el = document.getElementById('privacy-choice');
    if (el) el.hidden = true;
  }

  var el = document.getElementById('privacy-choice');
  if (el) {
    el.addEventListener('click', function (ev) {
      var choice = ev.target && ev.target.getAttribute && ev.target.getAttribute('data-choice');
      if (!choice) return;
      write(choice);
      hideBanner();
      if (choice === 'ja') loadPixel();
    });
  }

  var saved = readChoice();
  if (saved === 'ja') { hideBanner(); loadPixel(); }
  else if (saved === 'nee') hideBanner();
  else banner();

  document.addEventListener('click', function (ev) {
    var t = ev.target;
    if (t && t.closest && t.closest('[data-cookie-settings]')) {
      ev.preventDefault();
      write('');
      banner();
    }
  });
})();
