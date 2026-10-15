// Zoeken in de handleiding (gebouwd door scripts/site-handleiding.cjs; niet met de hand aanpassen).
  (function () {
    var input = document.getElementById('zoek');
    var treffers = document.getElementById('treffers');
    var lijst = treffers.querySelector('ul');
    var geen = document.getElementById('geen-treffers');
    var hoofdstukken = document.getElementById('hoofdstukken');
    var data = null;
    function laad() {
      if (data) return Promise.resolve(data);
      return fetch('zoek.json').then(function (r) { return r.json(); }).then(function (d) { data = d; return d; }).catch(function () { return []; });
    }
    function toon(q) {
      q = q.trim().toLowerCase();
      if (q.length < 2) { treffers.hidden = true; hoofdstukken.hidden = false; return; }
      laad().then(function (d) {
        var woorden = q.split(/\s+/);
        var hits = [];
        d.forEach(function (p) {
          p.secties.forEach(function (s) {
            var tekst = (p.titel + ' ' + s.kop + ' ' + s.tekst).toLowerCase();
            if (woorden.every(function (w) { return tekst.indexOf(w) !== -1; })) {
              var i = s.tekst.toLowerCase().indexOf(woorden[0]);
              var frag = i >= 0 ? s.tekst.slice(Math.max(0, i - 60), i + 120) : s.tekst.slice(0, 160);
              hits.push({ url: p.url + (s.id ? '#' + s.id : ''), titel: p.titel, kop: s.kop, frag: (i > 60 ? '… ' : '') + frag + (s.tekst.length > i + 120 ? ' …' : '') });
            }
          });
        });
        lijst.innerHTML = '';
        hits.slice(0, 20).forEach(function (h) {
          var li = document.createElement('li');
          var a = document.createElement('a'); a.href = h.url; a.textContent = h.titel + (h.kop ? ' › ' + h.kop : '');
          var small = document.createElement('small'); small.textContent = h.frag;
          li.appendChild(a); li.appendChild(small); lijst.appendChild(li);
        });
        geen.hidden = hits.length > 0;
        treffers.hidden = false;
        hoofdstukken.hidden = true;
      });
    }
    input.addEventListener('input', function () { toon(input.value); });
    if (location.hash.length > 1) { input.value = decodeURIComponent(location.hash.slice(1)).replace(/\+/g, ' '); toon(input.value); }
  })();
