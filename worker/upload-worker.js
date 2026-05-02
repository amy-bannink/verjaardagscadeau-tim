/**
 * Cloudflare Worker – video upload proxy naar R2
 *
 * Environment variables (instellen in Worker-instellingen):
 *   UPLOAD_TOKEN  – geheime token die de webapp meestuurt
 *   PUBLIC_URL    – publieke R2-URL, bijv. https://pub-xxx.r2.dev
 *
 * R2 binding (instellen in Worker-instellingen):
 *   Name: VIDEOS  → jouw R2-bucket
 */

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, X-File-Name, X-Upload-Token',
};

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS });
    }

    if (request.method !== 'POST') {
      return new Response('Method not allowed', { status: 405, headers: CORS });
    }

    // Token-controle
    if (request.headers.get('X-Upload-Token') !== env.UPLOAD_TOKEN) {
      return new Response('Unauthorized', { status: 401, headers: CORS });
    }

    // Bestandsnaam genereren
    const origName = request.headers.get('X-File-Name') || 'video.mp4';
    const ext      = (origName.split('.').pop() || 'mp4').toLowerCase();
    const fileName = `${Date.now()}_${Math.random().toString(36).slice(2, 10)}.${ext}`;

    // Stream direct naar R2 (geen buffering in geheugen)
    await env.VIDEOS.put(fileName, request.body, {
      httpMetadata: { contentType: request.headers.get('Content-Type') || 'video/mp4' },
    });

    return new Response(
      JSON.stringify({ url: `${env.PUBLIC_URL}/${fileName}` }),
      { headers: { ...CORS, 'Content-Type': 'application/json' } }
    );
  },
};
