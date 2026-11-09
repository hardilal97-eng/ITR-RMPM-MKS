export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    // Endpoint proxy opsional ke Google Sheets (jika dibutuhkan selain JSONP)
    if (url.pathname === '/api/sheet') {
      const sheetId = url.searchParams.get('id') || '1zNqfqYFt4DTstU2AnHJFrkgtBH7Ee1mOqw79pHvUxfQ';
      const sheetName = url.searchParams.get('sheet') || 'KEBUTUHAN RMPM';
      const targetUrl = `https://docs.google.com/spreadsheets/d/${encodeURIComponent(sheetId)}/gviz/tq?tqx=out:json&sheet=${encodeURIComponent(sheetName)}`;

      const resp = await fetch(targetUrl);
      const text = await resp.text();
      return new Response(text, {
        status: resp.status,
        headers: {
          'Content-Type': 'application/json; charset=utf-8',
          'Access-Control-Allow-Origin': '*',
          'Cache-Control': 'no-store'
        }
      });
    }

    // Layani file statis (index.html, styles.css, app.js) melalui Cloudflare Workers Assets
    return env.ASSETS.fetch(request);
  }
};
