# Ajan Odası

Kodlama işlerini **ücretsiz yapay zekâ ajanlarına** yaptıran, bilgisayarında çalışan küçük bir panel.
Bir iş yazarsın; ücretsiz bir karar modeli işi parçalara böler ve her parçaya bir ajan seçer.
Sen planı onaylarsın, ajanlar aynı anda çalışır, sonra Codex denetler, en sonda da Claude kontrol eder.

```
İstek → Karar modeli (böler, ajan seçer) → Sen onaylarsın → Ücretsiz ajanlar → Codex denetim → Claude son kontrol
```

- Bir ajanın kotası biterse iş otomatik olarak sıradakine geçer.
- Ek paket yok, yalnızca Node.js ile çalışır. Her şey senin bilgisayarında kalır (`127.0.0.1`).
- Yalnızca **Windows** üzerinde denendi.

## Gerekenler

| Araç | Ne için | Ücret |
|---|---|---|
| [Node.js](https://nodejs.org) 20+ | Paneli çalıştırır | Ücretsiz |
| [Antigravity CLI](https://antigravity.google) (`agy`) | En güçlü ücretsiz kodlayıcı | Google hesabıyla ücretsiz plan |
| [OpenCode](https://opencode.ai) (`npm i -g opencode-ai`) | GLM ve DeepSeek ücretsiz modelleri, karar modeli | Ücretsiz modeller |
| [Ollama](https://ollama.com) + `ollama pull qwen2.5-coder:7b` | Yerel, sınırsız; yalnızca metin üretir | Ücretsiz |
| Codex (ChatGPT masaüstü uygulaması) | Denetim aşaması | ChatGPT aboneliği |
| [Claude Code](https://claude.com/claude-code) (`npm i -g @anthropic-ai/claude-code`) | Son kontrol | Claude aboneliği |

Hepsi zorunlu değil. Kurulu olmayan ajan panelde "kurulu değil" görünür ve atlanır.
Her aracı bir kez kendi komut satırında açıp giriş yapman gerekir.

## Kurulum ve çalıştırma

```bash
git clone https://github.com/wj-sidiss/agent-isleri.git
cd agent-isleri
node server.js
```

Ya da `baslat.bat` dosyasına çift tıkla. Sonra tarayıcıda aç:

- **http://127.0.0.1:4545/oda** — Ajan Odası: yeni iş, plan onayı, iş akışı, ajanların canlı kaydı
- **http://127.0.0.1:4545** — Tek görev paneli

## Komut satırından

```powershell
# Karar modeline planlat (plan onay bekler, ajanlar başlamaz)
.\gorev-gonder.ps1 -Planla "Fiyat hesaplayıcıya indirim ekle ve testlerini yaz" -Klasor C:\projem

# Planı onayla ve başlat
.\gorev-gonder.ps1 -Onayla <planId>

# Tek görev gönder, bitmesini 5 dk bekle
.\gorev-gonder.ps1 -Gorev "README'deki yazım hatalarını düzelt" -Klasor C:\projem -Bekle 300

# Görevleri listele / bir görevin durumuna bak
.\gorev-gonder.ps1 -Liste
.\gorev-gonder.ps1 -Durum <gorevId>
```

## Dikkat

- Ajanlar çalışma klasöründe **onay sormadan dosya yazar**. Önemli projelerde işe başlamadan önce git ile commit al.
- Görev kayıtları ve sonuçlar (`gorevler.json`, `isler.json`, `planlar.json`, `sonuclar/`, `calisma/`) yerelde kalır ve repoya girmez.
- Ücretsiz planların koşulları değişebilir. Bir aracın ücretli olup olmadığını kendin kontrol et.

## Test

```bash
node --test planlayici.test.js
```

## Lisans

[MIT](LICENSE)
