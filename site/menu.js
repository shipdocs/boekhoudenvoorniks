(function () {
  var top = document.querySelector('.top');
  if (!top) return;
  var button = top.querySelector('.menu-button');
  if (!button) return;
  button.addEventListener('click', function () {
    var open = top.classList.toggle('open');
    button.setAttribute('aria-expanded', String(open));
  });
  top.querySelectorAll('details.sub').forEach(function (d) {
    d.addEventListener('toggle', function () {
      if (!d.open) return;
      top.querySelectorAll('details.sub[open]').forEach(function (o) { if (o !== d) o.open = false; });
    });
  });
  function closeAll() {
    var focused = document.activeElement, wasInside = top.contains(focused);
    top.querySelectorAll('details.sub[open]').forEach(function (o) {
      o.open = false;
      if (o.contains(focused)) { o.querySelector('summary').focus(); wasInside = false; }
    });
    if (!top.classList.contains('open')) return;
    top.classList.remove('open');
    button.setAttribute('aria-expanded', 'false');
    if (wasInside && focused !== button) button.focus();
  }
  document.addEventListener('click', function (e) { if (!top.contains(e.target)) closeAll(); });
  document.addEventListener('keydown', function (e) { if (e.key === 'Escape') closeAll(); });
})();
