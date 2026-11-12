// Karar modeli (plancı): bir isteği ücretsiz bir modele alt görevlere böldürür ve her görev için agent seçtirir.
// Bu dosya saf mantıktır (dosya / süreç yok): istem, cevaptan JSON çıkarma ve planı doğrulama. Sunucu: server.js.
// Test: node --test planlayici.test.js

const MAX_GOREV = 6;
const MAX_DOSYA_LISTESI = 200;

/** Her agent'ın ne işe yaradığı (karar modeline gösterilir). Yeni agent eklenirse buraya da yazılmalı. */
const AJAN_GUCLERI = {
  antigravity: 'En güçlü ücretsiz kodlayıcı. Birden çok dosyaya dokunan kod işleri, yeni özellik, hata ayıklama.',
  'opencode-glm': 'Orta seviye kodlayıcı. Tek dosyalık kod işleri, birim testleri, küçük düzeltmeler.',
  'opencode-deepseek': 'Orta seviye kodlayıcı. Tek dosyalık kod işleri, birim testleri, küçük düzeltmeler.',
  ollama: 'Yerel, sınırsız ama zayıf ve DOSYA YAZAMAZ: yalnızca düz metin üretir (açıklama, liste, ürün metni). Kod işi verilmez.',
};

/** Karar modeline giden istem. `ajanlar`: [{ id, ad, model, metinSadece }], yalnızca şu an kullanılabilenler. */
function planIstemi({ istek, dosyalar = [], ajanlar = [] }) {
  const ajanSatirlari = ajanlar
    .map((a) => `- ${a.id} (${a.ad} · ${a.model}): ${AJAN_GUCLERI[a.id] || (a.metinSadece ? 'Yalnızca düz metin üretir, dosya yazamaz.' : 'Kodlayıcı.')}`)
    .join('\n');
  const liste = dosyalar.slice(0, MAX_DOSYA_LISTESI);
  const dosyaBolumu = liste.length
    ? `Çalışma klasöründeki dosyalar (ilk ${liste.length}):\n${liste.join('\n')}`
    : 'Çalışma klasörü boş ya da dosya listesi alınamadı.';
  return [
    'Sen bir iş planlayıcısısın. Görevin: aşağıdaki isteği, ücretsiz kodlama agent\'larına dağıtılacak alt görevlere bölmek ve her alt görev için en uygun agent\'ı seçmek. İşin kendisini YAPMA, yalnızca plan yaz.',
    '',
    '# Kullanılabilir agent\'lar',
    ajanSatirlari || '- (yok)',
    '',
    '# Kurallar',
    `- En fazla ${MAX_GOREV} alt görev. Gereğinden fazla bölme: küçük bir iş tek görev olmalı.`,
    '- Alt görevler AYNI ANDA ve AYNI KLASÖRDE çalışır. İki görev aynı dosyayı değiştirmemeli. Her görevin "dosyalar" listesine dokunacağı dosyaları yaz.',
    '- Bir görevin sonucuna başka bir görev ihtiyaç duyuyorsa ikisini tek görevde birleştir.',
    '- "pref" alanına yukarıdaki agent id\'lerinden birini yaz. Emin değilsen "otomatik" yaz.',
    '- Dosyaya kod yazmayan, yalnızca düz metin isteyen görevlerde "metinIsi": true ve "metinDosyasi": "ad.md" yaz.',
    '- "text": agent\'a gidecek, tek başına anlaşılır, ayrıntılı talimat. Hangi dosyalar, ne yapılacak, iş ne zaman bitmiş sayılır yaz.',
    '- Kod, sır, şifre ya da anahtar uydurma. İstekte olmayan iş ekleme.',
    '',
    '# Çıktı biçimi',
    'YALNIZCA şu JSON\'u yaz, başka hiçbir şey yazma:',
    '{"baslik": "kısa iş adı", "gorevler": [{"baslik": "kısa görev adı", "pref": "agent id", "dosyalar": ["yol/dosya.js"], "metinIsi": false, "text": "ayrıntılı talimat"}]}',
    '',
    dosyaBolumu,
    '',
    '# İstek',
    istek,
  ].join('\n');
}

/** Model cevabından ilk geçerli JSON nesnesini çıkarır (```json blokları, önündeki/arkasındaki yazılar). Yoksa null. */
function jsonCikar(metin) {
  if (typeof metin !== 'string') return null;
  const adaylar = [];
  for (const m of metin.matchAll(/```(?:json)?\s*([\s\S]*?)```/gi)) adaylar.push(m[1]);
  adaylar.push(metin);
  for (const aday of adaylar) {
    for (let bas = aday.indexOf('{'); bas !== -1; bas = aday.indexOf('{', bas + 1)) {
      let derinlik = 0;
      let tirnak = false;
      let kacis = false;
      for (let i = bas; i < aday.length; i++) {
        const c = aday[i];
        if (tirnak) {
          if (kacis) kacis = false;
          else if (c === '\\') kacis = true;
          else if (c === '"') tirnak = false;
          continue;
        }
        if (c === '"') tirnak = true;
        else if (c === '{') derinlik++;
        else if (c === '}' && --derinlik === 0) {
          try {
            const obj = JSON.parse(aday.slice(bas, i + 1));
            if (obj && typeof obj === 'object' && !Array.isArray(obj)) return obj;
          } catch {}
          break;
        }
      }
    }
  }
  return null;
}

const temizYol = (s) => String(s).trim().replace(/\\/g, '/').replace(/^\.\//, '');

/**
 * Model planını kurallara uydurur. `ajanlar`: kullanılabilen agent'lar [{ id, metinSadece }].
 * Dönüş: { ok: true, plan, uyarilar } ya da { ok: false, hata }.
 */
function planDogrula(ham, ajanlar = []) {
  if (!ham || typeof ham !== 'object' || !Array.isArray(ham.gorevler)) return { ok: false, hata: 'Planda "gorevler" listesi yok.' };
  const uyarilar = [];
  const idler = new Map(ajanlar.map((a) => [a.id, a]));
  let liste = ham.gorevler.filter((g) => g && typeof g === 'object' && typeof g.text === 'string' && g.text.trim().length >= 10);
  if (!liste.length) return { ok: false, hata: 'Planda geçerli görev yok.' };
  if (liste.length > MAX_GOREV) {
    uyarilar.push(`Karar modeli ${liste.length} görev önerdi; ilk ${MAX_GOREV} tanesi alındı.`);
    liste = liste.slice(0, MAX_GOREV);
  }
  const gorevler = liste.map((g, i) => {
    const text = g.text.trim().slice(0, 6000);
    const baslik = (typeof g.baslik === 'string' && g.baslik.trim() ? g.baslik.trim() : text.split('\n')[0]).slice(0, 80);
    let pref = typeof g.pref === 'string' ? g.pref.trim() : 'otomatik';
    const metinIsi = g.metinIsi === true;
    if (pref !== 'otomatik' && !idler.has(pref)) {
      uyarilar.push(`"${baslik}": bilinmeyen ya da şu an kullanılamayan agent (${pref}), otomatik seçime bırakıldı.`);
      pref = 'otomatik';
    }
    if (pref !== 'otomatik' && idler.get(pref).metinSadece && !metinIsi) {
      uyarilar.push(`"${baslik}": ${pref} dosya yazamaz, bu görev otomatik seçime bırakıldı.`);
      pref = 'otomatik';
    }
    const dosyalar = Array.isArray(g.dosyalar)
      ? [...new Set(g.dosyalar.filter((d) => typeof d === 'string' && d.trim()).map(temizYol))].slice(0, 30)
      : [];
    const gorev = { baslik, text, pref, dosyalar };
    if (metinIsi) {
      gorev.metinIsi = true;
      const ad = typeof g.metinDosyasi === 'string' ? g.metinDosyasi.trim() : '';
      gorev.metinDosyasi = /^[\w.-]+\.(md|txt)$/i.test(ad) ? ad : `metin-${i + 1}.md`;
    }
    return gorev;
  });
  // Aynı anda çalışan iki görev aynı dosyaya dokunmamalı.
  const sahip = new Map();
  for (const g of gorevler) {
    for (const d of g.dosyalar) {
      const k = d.toLowerCase();
      if (sahip.has(k) && sahip.get(k) !== g.baslik) uyarilar.push(`"${sahip.get(k)}" ve "${g.baslik}" aynı dosyaya dokunuyor: ${d}. Aynı anda çalışırlarsa birbirinin işini bozabilir.`);
      else sahip.set(k, g.baslik);
    }
  }
  const baslik = (typeof ham.baslik === 'string' && ham.baslik.trim() ? ham.baslik.trim() : gorevler[0].baslik).slice(0, 80);
  return { ok: true, plan: { baslik, gorevler }, uyarilar };
}

/** Hiçbir karar modeli plan çıkaramazsa: istek tek görev olarak otomatik agent'a. */
function tekGorevPlan(istek) {
  const text = String(istek || '').trim().slice(0, 6000);
  return { baslik: text.split('\n')[0].slice(0, 80) || 'İş', gorevler: [{ baslik: text.split('\n')[0].slice(0, 80) || 'İş', text, pref: 'otomatik', dosyalar: [] }] };
}

module.exports = { MAX_GOREV, MAX_DOSYA_LISTESI, AJAN_GUCLERI, planIstemi, jsonCikar, planDogrula, tekGorevPlan };
