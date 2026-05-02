/**
 * Cloudflare Worker – multipart video upload naar R2
 *
 * Environment variables:
 *   UPLOAD_TOKEN  – geheime token die de webapp meestuurt
 *   PUBLIC_URL    – publieke R2-URL, bijv. https://pub-xxx.r2.dev
 *
 * R2 binding:
 *   Name: VIDEOS  → jouw R2-bucket
 *
 * Endpoints (allemaal POST):
 *   /init       – start multipart upload, geeft { uploadId, key } terug
 *   /part       – upload één stuk, geeft { etag } terug
 *   /complete   – rondt upload af, geeft { url } terug
 */

const CORS = {
  'Access-Control-Allow-Origin':  '*',
  'Access-Control-Allow-Methods': 'POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, X-File-Name, X-Upload-Token, X-Upload-Id, X-Key, X-Part-Number',
};

function unauthorized(msg = 'Unauthorized') {
  return new Response(msg, { status: 401, headers: CORS });
}

export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS });
    }
    if (request.method !== 'POST') {
      return new Response('Method not allowed', { status: 405, headers: CORS });
    }
    if (request.headers.get('X-Upload-Token') !== env.UPLOAD_TOKEN) {
      return unauthorized();
    }

    const action = new URL(request.url).pathname.replace(/^\//, '') || '';

    // ── /init ───────────────────────────────────────────
    if (action === 'init') {
      const origName = request.headers.get('X-File-Name') || 'video.mp4';
      const ext      = (origName.split('.').pop() || 'mp4').toLowerCase();
      const key      = `${Date.now()}_${Math.random().toString(36).slice(2, 10)}.${ext}`;
      const upload   = await env.VIDEOS.createMultipartUpload(key, {
        httpMetadata: { contentType: request.headers.get('Content-Type') || 'video/mp4' },
      });
      return new Response(
        JSON.stringify({ uploadId: upload.uploadId, key }),
        { headers: { ...CORS, 'Content-Type': 'application/json' } }
      );
    }

    // ── /part ───────────────────────────────────────────
    if (action === 'part') {
      const uploadId   = request.headers.get('X-Upload-Id');
      const key        = request.headers.get('X-Key');
      const partNumber = parseInt(request.headers.get('X-Part-Number') || '1', 10);
      const upload     = env.VIDEOS.resumeMultipartUpload(key, uploadId);
      const part       = await upload.uploadPart(partNumber, request.body);
      return new Response(
        JSON.stringify({ etag: part.etag }),
        { headers: { ...CORS, 'Content-Type': 'application/json' } }
      );
    }

    // ── /complete ───────────────────────────────────────
    if (action === 'complete') {
      const uploadId = request.headers.get('X-Upload-Id');
      const key      = request.headers.get('X-Key');
      const parts    = await request.json();
      const upload   = env.VIDEOS.resumeMultipartUpload(key, uploadId);
      await upload.complete(parts);
      return new Response(
        JSON.stringify({ url: `${env.PUBLIC_URL}/${key}` }),
        { headers: { ...CORS, 'Content-Type': 'application/json' } }
      );
    }

    return new Response('Not found', { status: 404, headers: CORS });
  },
};
