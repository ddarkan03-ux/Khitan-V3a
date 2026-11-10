/* Penghubung ke Firebase (Firestore + Authentication) lewat REST. */
(function () {
  var D = window.DATA || {};
  var cfg = D.firebase || {};
  var kode = String(D.kode || '').toLowerCase();
  var aktif = !!(cfg.apiKey && cfg.projectId && kode);
  var BASE = 'https://firestore.googleapis.com/v1/projects/' + cfg.projectId + '/databases/(default)/documents';
  var ROOT = 'undangan/' + kode;
  var KEY = '?key=' + encodeURIComponent(cfg.apiKey || '');
  var SES = 'fb_admin_' + kode;

  function enc(v) {
    if (v === null || v === undefined) return { nullValue: null };
    if (typeof v === 'boolean') return { booleanValue: v };
    if (typeof v === 'number') return Number.isInteger(v) ? { integerValue: String(v) } : { doubleValue: v };
    if (v instanceof Date) return { timestampValue: v.toISOString() };
    return { stringValue: String(v) };
  }
  function dec(f) {
    if ('stringValue' in f) return f.stringValue;
    if ('booleanValue' in f) return f.booleanValue;
    if ('integerValue' in f) return Number(f.integerValue);
    if ('doubleValue' in f) return f.doubleValue;
    if ('timestampValue' in f) return new Date(f.timestampValue);
    return null;
  }
  function toDoc(o) { var f = {}; Object.keys(o).forEach(function (k) { f[k] = enc(o[k]); }); return { fields: f }; }
  function fromDoc(d) {
    var o = { id: d.name.split('/').pop() };
    var f = d.fields || {};
    Object.keys(f).forEach(function (k) { o[k] = dec(f[k]); });
    return o;
  }

  async function req(method, url, body, token) {
    var h = { 'Content-Type': 'application/json' };
    if (token) h.Authorization = 'Bearer ' + token;
    var r = await fetch(url, { method: method, headers: h, cache: 'no-store', body: body ? JSON.stringify(body) : undefined });
    var j = null;
    try { j = await r.json(); } catch (e) {}
    if (!r.ok) {
      var er = new Error((j && j.error && j.error.message) || r.statusText || 'Gagal');
      er.status = r.status;
      er.code = j && j.error && j.error.status;
      throw er;
    }
    return j;
  }

  /* ---------- sesi admin ---------- */
  function simpanSesi(j) {
    var s = { idToken: j.idToken || j.id_token, refreshToken: j.refreshToken || j.refresh_token, exp: Date.now() + (Number(j.expiresIn || j.expires_in) - 60) * 1000 };
    try { sessionStorage.setItem(SES, JSON.stringify(s)); } catch (e) {}
    return s;
  }
  function bacaSesi() { try { return JSON.parse(sessionStorage.getItem(SES) || 'null'); } catch (e) { return null; } }
  async function token() {
    var s = bacaSesi();
    if (!s) throw Object.assign(new Error('Belum masuk'), { status: 401 });
    if (Date.now() < s.exp) return s.idToken;
    var r = await fetch('https://securetoken.googleapis.com/v1/token' + KEY, {
      method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: 'grant_type=refresh_token&refresh_token=' + encodeURIComponent(s.refreshToken)
    });
    if (!r.ok) { try { sessionStorage.removeItem(SES); } catch (e) {} throw Object.assign(new Error('Sesi habis'), { status: 401 }); }
    return simpanSesi(await r.json()).idToken;
  }

  var FB = {
    aktif: aktif,
    kode: kode,

    /* ----- tamu (publik) ----- */
    kirimUcapan: function (u) {
      return req('POST', BASE + '/' + ROOT + '/ucapan' + KEY, toDoc({ nama: u.nama, isi: u.isi, hadir: u.hadir, waktu: new Date() }));
    },
    daftarUcapan: async function (admin) {
      var t = admin ? await token() : null;
      var j = await req('POST', BASE + '/' + ROOT + ':runQuery' + KEY, {
        structuredQuery: { from: [{ collectionId: 'ucapan' }], orderBy: [{ field: { fieldPath: 'waktu' }, direction: 'DESCENDING' }], limit: 300 }
      }, t);
      return (j || []).filter(function (x) { return x.document; }).map(function (x) { return fromDoc(x.document); });
    },
    kirimRSVP: function (u) {
      return req('POST', BASE + '/' + ROOT + '/rsvp' + KEY, toDoc({
        nama: u.nama, isi: u.isi || '', hadir: u.hadir, jumlah: Number(u.jumlah || 1), waktu: new Date()
      }));
    },
    daftarRSVP: async function (admin) {
      var t = admin ? await token() : null;
      var j = await req('POST', BASE + '/' + ROOT + ':runQuery' + KEY, {
        structuredQuery: { from: [{ collectionId: 'rsvp' }], orderBy: [{ field: { fieldPath: 'waktu' }, direction: 'DESCENDING' }], limit: 500 }
      }, t);
      return (j || []).filter(function (x) { return x.document; }).map(function (x) { return fromDoc(x.document); });
    },
    pengaturan: async function () {
      try { return fromDoc(await req('GET', BASE + '/' + ROOT + '/pengaturan/utama' + KEY + '&_=' + Date.now())); }
      catch (e) { if (e.status === 404) return null; throw e; }
    },

    /* ----- admin ----- */
    sudahLogin: function () { return !!bacaSesi(); },
    login: async function (sandi) {
      var j;
      try {
        j = await req('POST', 'https://identitytoolkit.googleapis.com/v1/accounts:signInWithPassword' + KEY,
          { email: kode + '@admin.undangan', password: sandi, returnSecureToken: true });
      } catch (e) {
        var m = String(e.message || '');
        if (/OPERATION_NOT_ALLOWED/.test(m)) e.pesan = 'Login Email/Password belum diaktifkan di Firebase.';
        else if (/TOO_MANY/.test(m)) e.pesan = 'Terlalu banyak percobaan. Coba lagi nanti.';
        else if (/INVALID|EMAIL_NOT_FOUND|PASSWORD/.test(m)) e.pesan = 'Kata sandi salah.';
        else e.pesan = 'Tidak dapat masuk: ' + m;
        throw e;
      }
      simpanSesi(j);
    },
    logout: function () { try { sessionStorage.removeItem(SES); } catch (e) {} },

    ucapanHapus: async function (id) { return req('DELETE', BASE + '/' + ROOT + '/ucapan/' + id + KEY, null, await token()); },
    rsvpHapus: async function (id) { return req('DELETE', BASE + '/' + ROOT + '/rsvp/' + id + KEY, null, await token()); },

    tamuDaftar: async function () {
      var t = await token(), out = [], pg = '';
      do {
        var j = await req('GET', BASE + '/' + ROOT + '/tamu' + KEY + '&pageSize=300' + (pg ? '&pageToken=' + encodeURIComponent(pg) : ''), null, t);
        (j.documents || []).forEach(function (d) { out.push(fromDoc(d)); });
        pg = j.nextPageToken || '';
      } while (pg);
      out.sort(function (a, b) { return (a.dibuat || 0) - (b.dibuat || 0); });
      return out;
    },
    tamuTambah: async function (t) {
      var tk = await token();
      var j = await req('POST', BASE + '/' + ROOT + '/tamu' + KEY, toDoc({ nama: t.nama, wa: t.wa || '', terkirim: false, dibuat: new Date() }), tk);
      return fromDoc(j);
    },
    tamuUbah: async function (id, o) {
      var q = Object.keys(o).map(function (k) { return 'updateMask.fieldPaths=' + k; }).join('&');
      return req('PATCH', BASE + '/' + ROOT + '/tamu/' + id + KEY + '&' + q, toDoc(o), await token());
    },
    tamuHapus: async function (id) { return req('DELETE', BASE + '/' + ROOT + '/tamu/' + id + KEY, null, await token()); },

    simpanPengaturan: async function (o) {
      var q = Object.keys(o).map(function (k) { return 'updateMask.fieldPaths=' + k; }).join('&');
      return req('PATCH', BASE + '/' + ROOT + '/pengaturan/utama' + KEY + '&' + q, toDoc(o), await token());
    }
  };
  window.FB = FB;
})();
