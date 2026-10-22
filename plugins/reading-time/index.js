// Contoh plugin. API: api.on(hook, fn), api.router (/p/<slug>/...), api.adminRouter (/admin/x/<slug>/...),
// api.q / api.one (database), api.addAdminLink(label), api.adminPage(res, title, html).
// Hook: 'head', 'body_end' (kembalikan string HTML), 'content' (filter: terima & kembalikan HTML).
module.exports = (api) => {
  api.on('content', (html, post) => {
    const words = String(html).replace(/<[^>]+>/g, ' ').split(/\s+/).filter(Boolean).length;
    const minutes = Math.max(1, Math.round(words / 200));
    return `<p class="reading-time"><em>Waktu baca: ${minutes} menit</em></p>${html}`;
  });

  api.router.get('/ping', (req, res) => res.json({ ok: true, plugin: 'reading-time' }));

  api.adminRouter.get('/', (req, res) => api.adminPage(res, 'Reading Time', '<p>Plugin aktif. Estimasi dihitung dari 200 kata per menit.</p>'));
  api.addAdminLink('Reading Time');
};
