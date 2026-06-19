// Mobile nav toggle. ~400 bytes. No framework.
(function () {
  var btn = document.querySelector('[data-nav-toggle]');
  var nav = document.querySelector('[data-nav]');
  if (!btn || !nav) return;

  btn.addEventListener('click', function () {
    var open = nav.getAttribute('data-open') === 'true';
    nav.setAttribute('data-open', open ? 'false' : 'true');
    btn.setAttribute('aria-expanded', open ? 'false' : 'true');
  });
})();
