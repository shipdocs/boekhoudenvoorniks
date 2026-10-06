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
    if (document.getElementById('cookie-banner')) return;
    var el = document.createElement('div');
    el.id = 'cookie-banner';
    el.setAttribute('role', 'dialog');
    el.setAttribute('aria-label', 'Meten van advertenties');
    var p = document.createElement('p');
    var strong = document.createElement('strong');
    strong.textContent = 'Mogen we meten of onze advertentie werkt?';
    p.appendChild(strong);
    p.appendChild(document.createTextNode(' Met je toestemming laden we de Meta Pixel (Facebook en Instagram). Meta plaatst dan cookies en ziet dat je deze site bezocht. Zonder toestemming gaat er niets naar Meta. '));
    var more = document.createElement('a');
    more.href = 'privacy.html#website';
    more.textContent = 'Meer uitleg';
    p.appendChild(more);

    var row = document.createElement('div');
    row.className = 'row';
    var yes = document.createElement('button');
    yes.type = 'button';
    yes.className = 'btn small';
    yes.setAttribute('data-choice', 'ja');
    yes.textContent = 'Toestaan';
    var no = document.createElement('button');
    no.type = 'button';
    no.className = 'btn small ghost';
    no.setAttribute('data-choice', 'nee');
    no.textContent = 'Niet toestaan';
    row.appendChild(yes);
    row.appendChild(no);
    el.appendChild(p);
    el.appendChild(row);
    el.addEventListener('click', function (ev) {
      var choice = ev.target && ev.target.getAttribute && ev.target.getAttribute('data-choice');
      if (!choice) return;
      write(choice);
      el.remove();
      if (choice === 'ja') loadPixel();
    });
    document.body.appendChild(el);
  }

  var saved = readChoice();
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
