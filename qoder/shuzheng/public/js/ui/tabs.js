const buttons = document.querySelectorAll('#tabs button');
const views = document.querySelectorAll('#view section');

function show(name) {
  buttons.forEach((b) => b.classList.toggle('active', b.dataset.view === name));
  views.forEach((v) => {
    v.hidden = v.dataset.view !== name;
  });
  window.dispatchEvent(new CustomEvent('view:shown', { detail: { view: name } }));
}

buttons.forEach((btn) => {
  btn.addEventListener('click', () => show(btn.dataset.view));
});
