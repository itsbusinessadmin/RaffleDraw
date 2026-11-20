// Optional Cloudflare Worker for environments where Apps Script redirects
// cannot be read cross-origin. Configure APPS_SCRIPT_URL on the Worker.
export default {
  async fetch(request, env) {
    const origin = request.headers.get('Origin');
    const allowed = env.PAGES_ORIGIN || 'https://itsbusinessadmin.github.io';
    if (origin && origin !== allowed) return new Response(null, { status: 403 });
    const headers = {
      'Access-Control-Allow-Origin': allowed,
      'Access-Control-Allow-Methods': 'POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Cache-Control': 'no-store',
      'Content-Type': 'application/json;charset=UTF-8',
      'Vary': 'Origin'
    };
    const reply = (body, status) => new Response(body, { status, headers });
    if (new URL(request.url).pathname !== '/') return reply(null, 404);
    if (request.method === 'OPTIONS') return reply(null, 204);
    if (request.method !== 'POST') return reply(null, 405);
    if (!/^https:\/\/script\.google\.com\/macros\/s\/[A-Za-z0-9_-]+\/exec$/.test(env.APPS_SCRIPT_URL || '')) {
      return reply(JSON.stringify({ ok: false, message: 'Configure the Apps Script deployment URL on the gateway.' }), 503);
    }
    if (!request.body) return reply(null, 400);
    const reader = request.body.getReader();
    const decoder = new TextDecoder('utf-8', { fatal: true });
    let body = '';
    let size = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done) break;
        size += value.byteLength;
        if (size > 4096) { await reader.cancel(); return reply(null, 413); }
        body += decoder.decode(value, { stream: true });
      }
      body += decoder.decode();
    } catch (_) {
      return reply(null, 400);
    }
    try {
      const upstream = await fetch(env.APPS_SCRIPT_URL, {
        method: 'POST', redirect: 'follow',
        headers: { 'Content-Type': 'text/plain;charset=UTF-8' }, body
      });
      if (!upstream.ok || !upstream.headers.get('Content-Type')?.includes('application/json')) {
        return reply(JSON.stringify({ ok: false, message: 'Apps Script returned an invalid response.' }), 502);
      }
      return reply(upstream.body, 200);
    } catch (_) {
      return reply(JSON.stringify({ ok: false, message: 'Apps Script could not be reached.' }), 502);
    }
  }
};
