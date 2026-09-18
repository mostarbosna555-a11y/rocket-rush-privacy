# Klinik Yönetim

Veteriner kliniği için müşteri/hasta kartı, aşı takvimi, randevu ve **otomatik SMS
hatırlatma** sistemi. E-vet Smart Plus'ın aylık abonelik ödenen hatırlatma/toplu SMS
işlevlerinin kendi sunucunuzda çalışan karşılığı.

SMS gönderimi **Organik Haberleşme** API'si üzerinden yapılır; SMS kredisini doğrudan
sağlayıcıdan alırsınız, aradaki yazılım aboneliği ortadan kalkar.

## Ne yapar

| Ekran | İş |
|---|---|
| **Panel** | Bugünkü/yaklaşan/gecikmiş aşı, randevu, doğum günü ve gönderilen SMS sayıları |
| **Hasta Kabul** | Müşteri kartı (protokol no, GSM, kimlik, adres, KVKK izinleri) ve bağlı hastalar |
| **Hasta Kartı** | Tür, ırk, cinsiyet, doğum tarihi, otomatik yaş, ağırlık, çip no + **aşı kartı** |
| **Hatırlatma** | Tarih aralığında vadesi gelen aşılar; seç → şablon → toplu SMS |
| **Doğum Günü** | O gün doğum günü olan hastaların sahiplerine kutlama SMS'i |
| **Randevular** | Randevu ekleme, "geldi" işaretleme |
| **Toplu SMS** | Tüm müşteriler / bakiyesi olanlar / türe göre / uzun süredir gelmeyenler / manuel liste |
| **SMS Geçmişi** | Gönderim kaydı, başarılı-hatalı-kredi özeti |
| **Şablonlar** | Yer tutuculu mesaj şablonları (`{musteri}`, `{hasta}`, `{asi}`, `{tarih}` …) |
| **Kara Liste** | Bu numaralara hiçbir koşulda SMS gitmez |

## Kurulum

Node.js 20 veya üzeri gerekir.

```bash
cd klinik
npm install
cp .env.example .env     # ADMIN_PASSWORD'ü değiştirin
npm start                # http://localhost:3000
```

İlk açılışta `admin` kullanıcısı oluşturulur. `.env` içinde `ADMIN_PASSWORD`
tanımlamazsanız şifre `admin123` olur ve konsola uyarı basılır — ilk girişten sonra
**Ayarlar > Şifre Değiştir**'den değiştirin.

Ekranların dolu görünmesi için deneme verisi:

```bash
npm run seed:demo
```

Uçtan uca testler:

```bash
node scripts/smoke.js
```

## SMS'i açmak

Sistem **test modunda** başlar: gönderimler yalnızca kayda geçer, operatöre gitmez.
Gerçek gönderime geçmek için:

1. [organikhaberlesme.com](https://www.organikhaberlesme.com) hesabınızda
   **Kullanıcı Paneli > API Kontrol** menüsünden bir API anahtarı oluşturun.
2. **Ayarlar > SMS Sağlayıcı**'da sağlayıcıyı "Organik Haberleşme" yapın, anahtarı yapıştırın.
3. **Bağlantıyı Test Et**'e basın — bakiyeniz ve onaylı SMS başlıklarınız gelir.
4. Başlığı seçip kaydedin.

API anahtarı veritabanında tutulur ve arayüze **asla tam hâliyle** gönderilmez
(`••••1234` şeklinde maskelenir).

### Kullanılan uç noktalar

Şema: <https://apidocs.organikhaberlesme.com/> (OpenAPI: `/api.json`).
Kimlik doğrulama `X-Organik-API` başlığı ile yapılır.

| Uç nokta | Kullanım |
|---|---|
| `GET /me` | Anahtar doğrulama |
| `GET /user/payment/balance` | Kenar çubuğundaki bakiye |
| `GET /sms/headers/get` | Onaylı gönderici başlıkları |
| `POST /sms/send` | Gönderim |
| `POST /sms/report/detail` | Teslimat durumu |

Farklı bir sağlayıcıya geçerseniz `src/sms/organik.js` yerine aynı arayüze sahip yeni
bir istemci yazıp `src/sms/index.js` içinde devreye alın; uygulamanın geri kalanı değişmez.

## Gönderim güvenlikleri

Yanlışlıkla toplu SMS atıp kredi yakmamak için:

- **Önizle** düğmesi gerçek gönderim yapmadan kaç alıcı ve kaç kredi olduğunu söyler.
- Gönderimden önce onay kutusu çıkar.
- Aynı metni paylaşan alıcılar **tek API çağrısında** gruplanır.
- Aynı aşı için aynı gün ikinci kez hatırlatma gitmez (`reminder_sent` tablosu).
- Kara listedeki numara, SMS izni kapalı müşteri ve geçersiz numara otomatik elenir;
  neden elendiği gönderim sonunda raporlanır.
- Türkçe karakter mesajı unicode yapar (160 değil 70 karakter). Sayaç bunu canlı gösterir.

### KVKK / İYS notu

Aşı ve randevu hatırlatmaları **hizmet/bilgilendirme** mesajıdır, ticari ileti değildir;
sistem bunları `commercial: false` ile gönderir. Toplu SMS ekranındaki **"Ticari
(pazarlama) gönderim"** kutusu işaretlenirse ileti İYS kapsamına girer ve alıcı onayı
gerekir. Kampanya/indirim duyurusu gönderecekseniz İYS izinlerinizin güncel olduğundan
emin olun.

Müşteri kartındaki "SMS gönderilebilir" kutusu izin kaydıdır; kapalıysa o müşteriye
hiçbir toplu gönderimde SMS gitmez.

## Veri

Tek dosyalık SQLite: varsayılan `klinik/data/klinik.db` (`DB_PATH` ile değiştirilebilir).
Yedek almak için sunucu kapalıyken bu dosyayı kopyalamak yeterlidir.

Müşteri/hasta silme **yumuşak silmedir** — kayıt `deleted_at` ile gizlenir, aşı geçmişi
ve SMS logu korunur.

## Yapı

```
klinik/
├── server.js              Express uygulaması, oturum ve ayar uçları
├── src/
│   ├── db.js              SQLite şeması, varsayılan aşı tipleri ve şablonlar
│   ├── auth.js            Oturum, bcrypt, yetki kontrolü
│   ├── util.js            GSM normalizasyonu, SMS kredi hesabı, tarih/yaş
│   ├── reminders.js       Vadesi gelen aşı/randevu/doğum günü sorguları
│   ├── sms/organik.js     Organik Haberleşme API istemcisi
│   ├── sms/index.js       Gönderim katmanı: eleme, gruplama, loglama
│   └── routes/
│       ├── records.js     Müşteri, hasta, aşı, randevu, muayene
│       └── messaging.js   Hatırlatma, toplu SMS, şablon, kara liste, geçmiş
├── public/                Tek sayfa arayüz (bağımlılıksız JS)
└── scripts/
    ├── smoke.js           Uçtan uca testler
    └── seed-demo.js       Deneme verisi
```

## Henüz yok

Laboratuvar/PACS entegrasyonu, stok ve fatura (e-Fatura/e-SMM), hospitalizasyon,
hayvan sahibi mobil uygulaması, çoklu şube. Şu anki sürüm hatırlatma ve toplu SMS
akışına odaklanır.
