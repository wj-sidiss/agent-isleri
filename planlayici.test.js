// node --test planlayici.test.js
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { MAX_GOREV, planIstemi, jsonCikar, planDogrula, tekGorevPlan } = require('./planlayici');

const AJANLAR = [
  { id: 'antigravity', ad: 'Antigravity CLI', model: 'Antigravity' },
  { id: 'opencode-glm', ad: 'OpenCode', model: 'GLM' },
  { id: 'ollama', ad: 'Ollama', model: 'Qwen', metinSadece: true },
];

test('istem: istek, yalnızca verilen agentlar, kurallar ve dosya listesi', () => {
  const s = planIstemi({ istek: 'Fiyat hesaplayıcı ekle', dosyalar: ['src/a.ts', 'src/b.ts'], ajanlar: AJANLAR });
  assert.match(s, /Fiyat hesaplayıcı ekle/);
  assert.match(s, /- antigravity \(Antigravity CLI · Antigravity\)/);
  assert.match(s, /- ollama .*DOSYA YAZAMAZ/);
  assert.doesNotMatch(s, /opencode-deepseek/);
  assert.match(s, new RegExp(`En fazla ${MAX_GOREV} alt görev`));
  assert.match(s, /src\/a\.ts\nsrc\/b\.ts/);
});

test('istem: dosya listesi 200 ile sınırlı, boşsa söylenir', () => {
  const cok = Array.from({ length: 450 }, (_, i) => `f${i}.js`);
  const s = planIstemi({ istek: 'x', dosyalar: cok, ajanlar: AJANLAR });
  assert.match(s, /\(ilk 200\)/);
  assert.doesNotMatch(s, /f200\.js/);
  assert.match(planIstemi({ istek: 'x', ajanlar: AJANLAR }), /dosya listesi alınamadı/);
});

test('jsonCikar: düz JSON, ```json bloğu, önünde arkasında yazı ve parantezli metin', () => {
  assert.deepEqual(jsonCikar('{"a":1}'), { a: 1 });
  assert.deepEqual(jsonCikar('İşte plan:\n```json\n{"gorevler": []}\n```\nBitti.'), { gorevler: [] });
  assert.deepEqual(jsonCikar('> build · glm\nPlan {"baslik": "x {y}", "gorevler": [{"text": "a } b"}]} son'), { baslik: 'x {y}', gorevler: [{ text: 'a } b' }] });
  assert.deepEqual(jsonCikar('önce {bozuk} sonra {"ok": true}'), { ok: true });
  assert.equal(jsonCikar('hiç json yok'), null);
  assert.equal(jsonCikar('[1,2,3]'), null);
  assert.equal(jsonCikar(undefined), null);
});

test('planDogrula: geçerli plan aynen geçer, yollar temizlenir', () => {
  const r = planDogrula({ baslik: 'Hesaplayıcı', gorevler: [
    { baslik: 'Mantık', pref: 'antigravity', dosyalar: ['.\\src\\calc.ts', 'src/calc.ts'], text: 'src/calc.ts içine hesaplama fonksiyonu yaz.' },
    { baslik: 'Test', pref: 'opencode-glm', dosyalar: ['src/calc.test.ts'], text: 'src/calc.test.ts içine testleri yaz.' },
  ] }, AJANLAR);
  assert.equal(r.ok, true);
  assert.equal(r.plan.baslik, 'Hesaplayıcı');
  assert.deepEqual(r.plan.gorevler.map((g) => g.pref), ['antigravity', 'opencode-glm']);
  assert.deepEqual(r.plan.gorevler[0].dosyalar, ['src/calc.ts']);
  assert.deepEqual(r.uyarilar, []);
});

test('planDogrula: bilinmeyen agent ve dosya yazamayan agenta kod işi otomatiğe döner', () => {
  const r = planDogrula({ gorevler: [
    { baslik: 'A', pref: 'gpt-9', text: 'Bir şey yap, uzun talimat.' },
    { baslik: 'B', pref: 'ollama', text: 'src/x.ts dosyasını düzelt lütfen.' },
    { baslik: 'C', pref: 'ollama', metinIsi: true, metinDosyasi: '../kotu.sh', text: 'Ürün açıklaması yaz, kısa.' },
  ] }, AJANLAR);
  assert.equal(r.ok, true);
  assert.deepEqual(r.plan.gorevler.map((g) => g.pref), ['otomatik', 'otomatik', 'ollama']);
  assert.equal(r.plan.gorevler[2].metinDosyasi, 'metin-3.md');
  assert.equal(r.uyarilar.length, 2);
});

test('planDogrula: aynı dosyaya dokunan iki görev için uyarı', () => {
  const r = planDogrula({ gorevler: [
    { baslik: 'A', pref: 'antigravity', dosyalar: ['src/x.ts'], text: 'src/x.ts dosyasına özellik ekle.' },
    { baslik: 'B', pref: 'opencode-glm', dosyalar: ['SRC/X.ts'], text: 'src/x.ts dosyasında hatayı düzelt.' },
  ] }, AJANLAR);
  assert.equal(r.ok, true);
  assert.equal(r.uyarilar.length, 1);
  assert.match(r.uyarilar[0], /"A" ve "B" aynı dosyaya dokunuyor/);
});

test('planDogrula: fazla görev kesilir, boş/kısa görevler atılır, başlık eksikse metinden', () => {
  const gorevler = Array.from({ length: 9 }, (_, i) => ({ text: `Görev numarası ${i} için ayrıntılı talimat`, pref: 'antigravity' }));
  gorevler.push({ text: 'kısa' }, null, { baslik: 'metinsiz' });
  const r = planDogrula({ gorevler }, AJANLAR);
  assert.equal(r.ok, true);
  assert.equal(r.plan.gorevler.length, MAX_GOREV);
  assert.equal(r.plan.gorevler[0].baslik, 'Görev numarası 0 için ayrıntılı talimat');
  assert.match(r.uyarilar[0], /9 görev önerdi/);
});

test('planDogrula: gorevler yoksa ya da hepsi geçersizse hata', () => {
  assert.equal(planDogrula(null, AJANLAR).ok, false);
  assert.equal(planDogrula({ plan: [] }, AJANLAR).ok, false);
  assert.equal(planDogrula({ gorevler: [{ text: 'x' }] }, AJANLAR).ok, false);
});

test('tekGorevPlan: istek tek görev, otomatik agent', () => {
  const p = tekGorevPlan('Başlık satırı\nayrıntı');
  assert.equal(p.gorevler.length, 1);
  assert.equal(p.gorevler[0].pref, 'otomatik');
  assert.equal(p.baslik, 'Başlık satırı');
  assert.equal(p.gorevler[0].text, 'Başlık satırı\nayrıntı');
});
