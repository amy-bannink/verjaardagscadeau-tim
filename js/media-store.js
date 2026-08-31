/**
 * MEDIA-OPSLAG
 * ════════════
 * Foto's stonden als base64-tekst ín de Firestore-documenten. Daardoor moest
 * de browser bij élke pagina-opening de complete fotocollectie downloaden —
 * al gauw tientallen megabytes — en dat ging op een telefoon regelmatig over
 * de tien seconden die Firestore wacht op de backend. Dan viel de app terug op
 * een cache die zelf ook vaak niet weggeschreven kon worden, en leek het of er
 * herinneringen ontbraken.
 *
 * Nu gaan de bestanden naar R2 (dezelfde opslag die de video's al gebruiken)
 * en bewaart Firestore alleen nog de URL. Een herinnering is daarmee een paar
 * honderd bytes in plaats van een paar megabyte.
 *
 * DE OUDE GEGEVENS BLIJVEN ONAANGEROERD. In `memory_images` wordt nooit iets
 * verwijderd of overschreven; die collectie wordt uitsluitend gelezen. Hij is
 * tegelijk het archief van de originelen én de terugvaloptie voor
 * herinneringen die nog niet zijn overgezet.
 *
 *   memory_images       (oud)    base64 per foto  — ALLEEN LEZEN
 *   memory_media        (nieuw)  { memoryId, type, url, thumb, order }
 *   memory_media_state  (nieuw)  per herinnering: is hij overgezet?
 *
 * Zolang een herinnering niet in `memory_media_state` staat, leest de app zijn
 * foto's gewoon uit de oude collectie. Een halverwege afgebroken migratie kan
 * dus niets kapotmaken: die herinnering blijft simpelweg op de oude manier
 * werken tot hij compleet én gecontroleerd is overgezet.
 */

const R2_WORKER_URL   = 'https://video-upload.amy-bannink.workers.dev';
const R2_UPLOAD_TOKEN = 'HerinneringenTim!';

// De 'in'-query van Firestore neemt maximaal tien waarden per keer.
const IN_QUERY_MAX = 10;

/**
 * Zet een bestand in R2 en geef de publieke URL terug.
 * De Worker kent alleen /init, /part en /complete — verwijderen kan er niet,
 * dus een upload kan per definitie niets overschrijven of wissen.
 */
async function uploadToR2(file, onProgress) {
  const CHUNK = 5 * 1024 * 1024; // 5 MB per stuk (R2 minimum)
  const headers = (extra = {}) => ({ 'X-Upload-Token': R2_UPLOAD_TOKEN, ...extra });

  const initRes = await fetch(R2_WORKER_URL + '/init', {
    method: 'POST',
    headers: headers({
      'Content-Type': file.type || 'application/octet-stream',
      'X-File-Name':  file.name,
    }),
  });
  if (!initRes.ok) throw new Error('Init mislukt: ' + await initRes.text());
  const { uploadId, key } = await initRes.json();

  const totalChunks = Math.max(1, Math.ceil(file.size / CHUNK));
  const parts = [];
  for (let i = 0; i < totalChunks; i++) {
    const chunk   = file.slice(i * CHUNK, Math.min((i + 1) * CHUNK, file.size));
    const partRes = await fetch(R2_WORKER_URL + '/part', {
      method: 'POST',
      headers: headers({
        'Content-Type':  file.type || 'application/octet-stream',
        'X-Upload-Id':   uploadId,
        'X-Key':         key,
        'X-Part-Number': String(i + 1),
      }),
      body: chunk,
    });
    if (!partRes.ok) throw new Error('Stuk ' + (i + 1) + ' mislukt: ' + await partRes.text());
    const { etag } = await partRes.json();
    parts.push({ partNumber: i + 1, etag });
    if (onProgress) onProgress(Math.round(((i + 1) / totalChunks) * 100));
  }

  const completeRes = await fetch(R2_WORKER_URL + '/complete', {
    method: 'POST',
    headers: headers({
      'Content-Type': 'application/json',
      'X-Upload-Id':  uploadId,
      'X-Key':        key,
    }),
    body: JSON.stringify(parts),
  });
  if (!completeRes.ok) throw new Error('Afronden mislukt: ' + await completeRes.text());
  return (await completeRes.json()).url;
}

const MediaStore = {

  isVideoItem(item) { return item && typeof item === 'object' && item.type === 'video'; },
  isDataUrl(item)   { return typeof item === 'string' && item.startsWith('data:'); },

  /** base64 data-URL → File, zodat hij door uploadToR2 heen kan. */
  dataUrlToFile(dataUrl, naam) {
    const komma = dataUrl.indexOf(',');
    const head  = dataUrl.slice(0, komma);
    const bytes = atob(dataUrl.slice(komma + 1));
    const mime  = (head.match(/data:([^;]+)/) || [null, 'image/jpeg'])[1];
    const buf   = new Uint8Array(bytes.length);
    for (let i = 0; i < bytes.length; i++) buf[i] = bytes.charCodeAt(i);
    const ext = (mime.split('/')[1] || 'jpg').replace('jpeg', 'jpg');
    return new File([buf], naam + '.' + ext, { type: mime });
  },

  /** Een document uit een van beide collecties → wat de tijdlijn verwacht. */
  toRenderItem(d) {
    if (d.type === 'video') return { type: 'video', url: d.url, thumb: d.thumb || null };
    return d.url || d.data;   // nieuw: een URL — oud: base64
  },

  groupByMemory(docs) {
    const perMemory = {};
    docs.forEach(d => {
      if (!perMemory[d.memoryId]) perMemory[d.memoryId] = [];
      perMemory[d.memoryId].push(d);
    });
    Object.keys(perMemory).forEach(id => {
      perMemory[id] = perMemory[id]
        .sort((a, b) => (a.order || 0) - (b.order || 0))
        .map(d => this.toRenderItem(d));
    });
    return perMemory;
  },

  /** Welke herinneringen zijn al overgezet? */
  async readMigrated(db) {
    const snap = await db.collection('memory_media_state').get();
    const ids  = new Set();
    snap.docs.forEach(d => { if (d.data().migrated) ids.add(d.id); });
    return ids;
  },

  /** Alle nieuwe media, gegroepeerd per herinnering en op volgorde. */
  async readMedia(db) {
    const snap = await db.collection('memory_media').get();
    return this.groupByMemory(snap.docs.map(d => d.data()));
  },

  /**
   * De base64-foto's van herinneringen die nog niet zijn overgezet. Alleen die
   * worden opgehaald, dus hoe verder de migratie vordert, hoe minder er
   * gedownload hoeft te worden — tot het er nul zijn.
   */
  async readLegacyImages(db, memoryIds) {
    const docs = [];
    for (let i = 0; i < memoryIds.length; i += IN_QUERY_MAX) {
      const chunk = memoryIds.slice(i, i + IN_QUERY_MAX);
      const snap  = await db.collection('memory_images').where('memoryId', 'in', chunk).get();
      snap.docs.forEach(d => docs.push(d.data()));
    }
    return this.groupByMemory(docs);
  },

  /**
   * Zet één item klaar als document voor `memory_media`. Een foto die nog een
   * base64-tekst is gaat eerst naar R2; een item dat al een URL heeft blijft
   * zoals het is, zodat bewerken niets opnieuw uploadt.
   */
  async toMediaDoc(item, memoryId, order, onProgress) {
    if (this.isVideoItem(item))
      return { memoryId, type: 'video', url: item.url, thumb: item.thumb || null, order };

    const url = this.isDataUrl(item)
      ? await uploadToR2(this.dataUrlToFile(item, 'foto_' + memoryId + '_' + order), onProgress)
      : item;
    return { memoryId, type: 'image', url, order };
  },

  /**
   * Leg de mediaset van een herinnering vast. Documenten in `memory_media` die
   * er niet meer bij horen worden opgeruimd — dat is onze eigen, nieuwe
   * collectie, en van de oorspronkelijke foto's staat het origineel nog in
   * `memory_images`. Het bestand in R2 blijft hoe dan ook bestaan; de Worker
   * kan niet verwijderen.
   */
  async writeMedia(db, memoryId, mediaDocs) {
    const bestaand = await db.collection('memory_media').where('memoryId', '==', memoryId).get();
    const batch    = db.batch();
    bestaand.docs.forEach(d => batch.delete(d.ref));
    mediaDocs.forEach(doc => batch.set(db.collection('memory_media').doc(), doc));
    batch.set(db.collection('memory_media_state').doc(memoryId), {
      migrated: true,
      count:    mediaDocs.length,
      at:       new Date().toISOString(),
    });
    await batch.commit();
  },

  /**
   * Zet één herinnering over. Puur toevoegend:
   *   • leest `memory_images`, schrijft daar nooit in
   *   • schrijft elke foto naar `memory_media/<id van het oude document>`, dus
   *     een tweede poging overschrijft zijn eigen werk in plaats van dubbele
   *     documenten aan te maken
   *   • markeert de herinnering pas als overgezet nadat élke nieuwe URL
   *     daadwerkelijk opgehaald kon worden
   *
   * Geeft het aantal overgezette items terug.
   */
  async migrateMemory(db, memoryId, hooks = {}) {
    const log    = hooks.log    || function () {};
    const verify = hooks.verify || function () { return Promise.resolve(true); };

    const oud  = await db.collection('memory_images').where('memoryId', '==', memoryId).get();
    const docs = oud.docs
      .map(d => Object.assign({ id: d.id }, d.data()))
      .sort((a, b) => (a.order || 0) - (b.order || 0));

    if (!docs.length) {
      // Ook een herinnering zonder foto's mag afgevinkt worden, anders blijft
      // de app hem elke keer opnieuw in de oude collectie opzoeken.
      await db.collection('memory_media_state').doc(memoryId).set({
        migrated: true, count: 0, at: new Date().toISOString(),
      });
      return 0;
    }

    const nieuw = [];
    for (let i = 0; i < docs.length; i++) {
      const d = docs[i];
      if (d.type === 'video') {
        nieuw.push({ ref: d.id, doc: { memoryId, type: 'video', url: d.url, thumb: d.thumb || null, order: i } });
        log('video ' + (i + 1) + '/' + docs.length + ' — URL blijft ongewijzigd');
        continue;
      }
      if (!this.isDataUrl(d.data)) {
        // Al een URL: overnemen zonder opnieuw te uploaden.
        nieuw.push({ ref: d.id, doc: { memoryId, type: 'image', url: d.data, order: i } });
        log('foto ' + (i + 1) + '/' + docs.length + ' — had al een URL');
        continue;
      }
      const file = this.dataUrlToFile(d.data, 'foto_' + memoryId + '_' + i);
      log('foto ' + (i + 1) + '/' + docs.length + ' — ' + Math.round(file.size / 1024) + ' kB uploaden');
      const url = await uploadToR2(file);
      nieuw.push({ ref: d.id, doc: { memoryId, type: 'image', url, order: i } });
    }

    // Controleer dat elke nieuwe foto echt op te halen is vóórdat deze
    // herinnering als overgezet wordt gemarkeerd.
    for (const n of nieuw) {
      if (n.doc.type === 'video') continue;
      if (!(await verify(n.doc.url)))
        throw new Error('Nieuwe foto is niet op te halen: ' + n.doc.url);
    }

    const batch = db.batch();
    nieuw.forEach(n => batch.set(db.collection('memory_media').doc(n.ref), n.doc));
    batch.set(db.collection('memory_media_state').doc(memoryId), {
      migrated: true,
      count:    nieuw.length,
      at:       new Date().toISOString(),
    });
    await batch.commit();

    return nieuw.length;
  },
};
