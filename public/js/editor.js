(function () {
  const csrf = document.querySelector('meta[name="csrf"]').content;
  const modal = document.getElementById('media-modal');
  const grid = document.getElementById('modal-grid');
  let onPick = null;

  async function loadMedia() {
    const res = await fetch('/admin/media/list.json', { credentials: 'same-origin' });
    const items = await res.json();
    grid.innerHTML = '';
    items.forEach((m) => {
      const d = document.createElement('div');
      d.className = 'media-item pick';
      const img = document.createElement('img');
      img.src = '/uploads/' + m.filename; img.alt = m.alt || '';
      d.appendChild(img);
      d.addEventListener('click', () => { modal.hidden = true; onPick && onPick(m); });
      grid.appendChild(d);
    });
    if (!items.length) grid.textContent = 'Belum ada media. Unggah gambar di atas.';
  }
  function openPicker(cb) { onPick = cb; modal.hidden = false; loadMedia(); }
  document.getElementById('modal-close').addEventListener('click', () => { modal.hidden = true; });

  async function upload(files) {
    const fd = new FormData();
    [...files].forEach((f) => fd.append('files', f));
    const res = await fetch('/admin/media/upload', { method: 'POST', body: fd, headers: { 'x-csrf-token': csrf, Accept: 'application/json' }, credentials: 'same-origin' });
    const data = await res.json();
    if (data.error) { alert(data.error); return []; }
    return data.files;
  }
  document.getElementById('modal-upload').addEventListener('change', async (e) => {
    await upload(e.target.files); e.target.value = ''; loadMedia();
  });

  const quill = new Quill('#editor', {
    theme: 'snow',
    placeholder: 'Tulis berita di sini...',
    modules: {
      toolbar: {
        container: [[{ header: [2, 3, 4, false] }], ['bold', 'italic', 'underline', 'strike'], [{ color: [] }],
          [{ list: 'ordered' }, { list: 'bullet' }], [{ align: [] }], ['blockquote', 'code-block'], ['link', 'image', 'video'], ['clean']],
        handlers: {
          image() {
            openPicker((m) => {
              const range = quill.getSelection(true);
              quill.insertEmbed(range.index, 'image', '/uploads/' + m.filename, 'user');
              quill.setSelection(range.index + 1);
            });
          },
        },
      },
    },
  });

  const form = document.getElementById('post-form');
  form.addEventListener('submit', () => {
    document.getElementById('content').value = quill.root.innerHTML === '<p><br></p>' ? '' : quill.root.innerHTML;
  });

  const field = document.getElementById('featured_image');
  const preview = document.getElementById('featured-preview');
  document.getElementById('pick-featured').addEventListener('click', () => openPicker((m) => {
    field.value = m.filename;
    preview.innerHTML = '';
    const img = document.createElement('img'); img.src = '/uploads/' + m.filename; preview.appendChild(img);
  }));
  document.getElementById('clear-featured').addEventListener('click', () => { field.value = ''; preview.innerHTML = ''; });
})();
