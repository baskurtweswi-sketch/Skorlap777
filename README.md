# SkorLab — Günlük Futbol Bülteni + Olasılık Analizi

Günün maçlarını gerçek kaynaktan çekip analiz eden tek dosyalık web uygulaması
ve Android APK'sı. Maçlara tıklanınca soccerstats Stats menüsündeki istatistik
setleri (form, gol/İY/zamanlama/ilk gol, ev-deplasman, korner, gol aralıkları,
tahmini puanlar) aynı düzende gösterilir.

## Yayınlama (GitHub Pages)

1. Bu repoyu GitHub'da açın (public repo önerilir).
2. **Settings → Pages → Source: Deploy from a branch → Branch: main, /(root)** seçin.
3. Adresiniz kalıcı olur: `https://<kullaniciadi>.github.io/<repo>/`

## Günlük otomatik güncelleme

`.github/workflows/gunluk-guncelleme.yml` her gün **06:00 ve 18:00 (İstanbul)**
saatlerinde çalışır: veriyi kaynaktan yeniden çeker, `index.html` +
`version.json` dosyalarını günceller ve yayına alır. Ek kurulum gerekmez;
harici npm paketi kullanılmaz (yalnız Node.js 20).

Elle tetiklemek için: **Actions → Günlük bülten güncellemesi → Run workflow**.

## Android uygulaması

`SkorLab-2.9.apk` — telefona kurun. Uygulama gömülü paketle çalışır; sunucuya
ulaşabilirse güncel içeriği indirir (boyut + SHA-256 doğrulamalı).

## Yerel derleme

```bash
node tools/build-static.js            # index.html + version.json üretir
node tools/build-static.js out.html out.json   # özel çıktı yolları
```

## Dosyalar

| Dosya | Açıklama |
|---|---|
| `index.html` | Tek dosyalık uygulama (günlük yenilenir) |
| `version.json` | Bütünlük bilgisi (tarih, boyut, sha256) |
| `SkorLab-2.9.apk` | Android uygulaması |
| `tools/build-static.js` | Sunucusuz derleme betiği |
| `src/fixtures.js` | 365scores fikstür + sezon sonuçları çekimi |
| `src/analyze.js` | Olasılık analizi (Poisson modeli) |
| `public/index.html` | Arayüz şablonu (veri gömülerek derlenir) |
