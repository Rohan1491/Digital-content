/* Shared mobile nav — include at end of body on every page */
(function () {
  const topbar = document.querySelector('.topbar');
  const sidebar = document.querySelector('.sidebar');
  if (!topbar || !sidebar) return;

  // Inject hamburger button before the page title
  const ham = document.createElement('button');
  ham.className = 'hamburger';
  ham.setAttribute('aria-label', 'Toggle menu');
  ham.innerHTML = '<span></span><span></span><span></span>';
  topbar.insertBefore(ham, topbar.firstChild);

  // Inject overlay behind the open sidebar
  const overlay = document.createElement('div');
  overlay.className = 'sidebar-overlay';
  document.body.appendChild(overlay);

  function openSidebar() {
    sidebar.classList.add('open');
    overlay.classList.add('show');
  }
  function closeSidebar() {
    sidebar.classList.remove('open');
    overlay.classList.remove('show');
  }

  ham.addEventListener('click', () =>
    sidebar.classList.contains('open') ? closeSidebar() : openSidebar()
  );
  overlay.addEventListener('click', closeSidebar);

  // Close on nav link tap on mobile
  sidebar.querySelectorAll('.nav-link').forEach(a =>
    a.addEventListener('click', () => { if (window.innerWidth <= 768) closeSidebar(); })
  );

  // Wrap every table inside a .card in a scroll container
  document.querySelectorAll('.card table').forEach(t => {
    if (t.closest('.tbl-wrap')) return;
    const wrap = document.createElement('div');
    wrap.className = 'tbl-wrap';
    t.parentNode.insertBefore(wrap, t);
    wrap.appendChild(t);
  });
})();
