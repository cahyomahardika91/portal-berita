document.addEventListener('submit', (e) => {
  const msg = e.target.dataset.confirm;
  if (msg && !confirm(msg)) e.preventDefault();
});
document.addEventListener('click', (e) => {
  const t = e.target;
  if (t.matches('input.sel')) t.select();
  if (t.matches('button[data-confirm]') && !confirm(t.dataset.confirm)) e.preventDefault();
  if (t.matches('.add-row')) {
    const loc = t.dataset.loc;
    const div = document.createElement('div');
    div.className = 'menu-row';
    div.innerHTML = `<input name="${loc}_label" placeholder="Label"><input name="${loc}_url" placeholder="/category/slug atau https://..."><button type="button" class="link danger rm">✕</button>`;
    document.querySelector(`.menu-rows[data-loc="${loc}"]`).appendChild(div);
  }
  if (t.matches('.rm')) t.closest('.menu-row').remove();
});
