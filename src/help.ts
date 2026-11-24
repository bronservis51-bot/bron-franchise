import '@fontsource-variable/montserrat';
import { config } from './platform/config';
import { checkConnection, connectionSummary, diagnosticText, type Connection } from './platform/connection';

const el = (id: string) => document.getElementById(id)!;
const turkish = location.hash === '#tr' || new URLSearchParams(location.search).get('lang') === 'tr';
const t = (ru: string, tr: string) => turkish ? tr : ru;

if (turkish) {
  document.documentElement.lang = 'tr';
  document.title = 'Bağlantı yardımı — Bron Servis';
  const labels = {
    'help-title': 'Bağlantı yardımı',
    'help-intro': 'Bu sayfa giriş yapmadan bağlantıyı kontrol etmenizi ve hata kodunu kaydetmenizi sağlar.',
    'local-heading': 'Cihazınızdan bağlantı',
    local: '«Bağlantıyı kontrol et» düğmesine tıklayın.',
    check: 'Bağlantıyı kontrol et',
    copy: 'Tanılama bilgilerini kopyala',
    'external-heading': 'Harici hizmet kontrolü',
    external: 'Kontrol sonucu henüz yüklenmedi.',
    'external-check': 'Sonucu göster',
    'external-note': 'Otomatik kontrol yaklaşık beş dakikada bir çalışır ve gecikebilir. Sunucuyu başka bir ağdan kontrol eder. Telefonunuzdan erişimi bu sayfadaki bağlantı kontrolüyle sınayın.',
    'login-help-heading': 'Giriş yapamıyorum',
    'login-help-check': '«Bağlantıyı kontrol et» düğmesine tıklayın. Kullanıcı adı veya parola hatalıysa klavye dilini ve kişisel kullanıcı adınızı kontrol edin.',
    'login-help-network': 'Sunucu yanıt vermiyorsa Wi-Fi yerine mobil bağlantıyı, mobil bağlantı yerine Wi-Fi’yi deneyin.',
    'login-help-contact': 'Sorun sürüyorsa tanılama bilgilerini yöneticinize veya teknik uzmana gönderin. Hatayı aldığınız saati ve yaptığınız işlemi yazın. Parolanızı paylaşmayın.',
    'work-heading': 'Diğer durumlar',
    'leads-heading': 'Başvurular yüklenmedi',
    'leads-note': '«Yenile» düğmesine bir kez tıklayın. Sorun sürüyorsa tanılama bilgilerini gönderin ve daha önce gönderdiğiniz başvuruları yeniden oluşturmayın.',
    'queue-heading': 'Tutar veya vardiya gönderilmeyi bekliyor',
    'queue-note': 'Bekleyen kaydın kopyasını kuyruktan alın, bağlantıyı geri yükleyin ve aynı kuyruktan yeniden gönderin. Tarayıcı verilerini silmeyin ve uygulamayı kaldırmayın. Çakışma olursa yöneticinizle tutarları karşılaştırın.',
    'permissions-heading': 'Yetki yetersiz veya oturumun süresi doldu',
    'permissions-note': 'Oturumun süresi dolduysa tekrar giriş yapın. Yetki için erişimi veren kişiye başvurun. Çalışanlar kendi yöneticisine, franchise işletmecileri franchise yöneticisine başvurabilir.',
    'trash-heading': 'Başvuruyu yanlışlıkla sildim',
    'trash-note': '«Başvurular» → «Çöp kutusu» → «Geri yükle» yolunu izleyin. Başvuru eski sütununa döner ve mevcut durumunu korur.',
    'update-heading': 'Güncellemeden sonra hata oluştu',
    'update-note': 'Bekleyen kayıtların kopyasını alın. Giriş sayfasında «Uygulamayı güncelle» düğmesi görünüyorsa tıklayın. Sorun sürerse tanılama bilgilerini teknik uzmana gönderin. Tarayıcı verilerini silmeyin.',
    'login-back': 'Girişe dön',
  };
  for (const [id, label] of Object.entries(labels)) el(id).textContent = label;
}

const locale = turkish ? 'tr-TR' : 'ru-RU';
const version = import.meta.env.VITE_BUILD_TIME ?? t('неизвестна', 'bilinmiyor');
let last: Connection | null = null;
el('version').textContent = t(`Сборка: ${version}`, `Sürüm ${version}`);

el('check').onclick = async () => {
  const button = el('check') as HTMLButtonElement;
  button.disabled = true;
  el('local').textContent = t('Проверяем сервер входа и базу данных…', 'Giriş sunucusu ve veri tabanı kontrol ediliyor…');
  try {
    last = await checkConnection(config.supabaseUrl, config.supabaseKey);
    el('local').textContent = connectionSummary(last, t);
    el('diagnostic').textContent = diagnosticText(last, navigator.onLine, version);
  } finally { button.disabled = false; }
};

el('copy').onclick = async () => {
  const value = diagnosticText(last, navigator.onLine, version);
  el('diagnostic').textContent = value;
  try {
    await navigator.clipboard.writeText(value);
    el('copy-state').textContent = t('Диагностика скопирована. В ней нет пароля и данных заявок.', 'Tanılama bilgileri kopyalandı. Bu bilgiler parola veya başvuru verisi içermez.');
  } catch {
    el('copy-state').textContent = t('Копирование недоступно. Выделите и скопируйте текст диагностики ниже.', 'Kopyalanamadı. Aşağıdaki tanılama metnini seçip kopyalayın.');
  }
};

el('external-check').onclick = async () => {
  const button = el('external-check') as HTMLButtonElement;
  button.disabled = true;
  try {
    const r = await fetch('https://api.github.com/repos/bronservis51-bot/bron-franchise/actions/workflows/availability.yml/runs?status=completed&per_page=1', {
      cache: 'no-store', credentials: 'omit', signal: AbortSignal.timeout(12_000),
    });
    if (!r.ok) throw Error();
    const response = await r.json();
    const run = response.workflow_runs?.[0];
    const at = Date.parse(run?.updated_at);
    const age = Date.now() - at;
    if (!Number.isFinite(at) || age > 30 * 60_000 || age < -60_000) {
      el('external').textContent = t('Свежего результата нет. Проверяйте соединение с этого устройства и передайте диагностику.',
        'Güncel sonuç yok. Bu cihazdan bağlantıyı kontrol edin ve tanılama bilgilerini paylaşın.');
      return;
    }
    const result = run.conclusion === 'success' ? t('Серверные проверки прошли.', 'Sunucu kontrolleri başarılı.')
      : t('Внешняя проверка не завершилась успешно. Нужна проверка техническим специалистом.', 'Harici kontrol başarısız oldu. Teknik uzmana başvurun.');
    const date = new Date(at).toLocaleString(locale);
    el('external').textContent = `${result} ${t(`Запуск завершён ${date}.`, `Kontrol ${date} tarihinde tamamlandı.`)}`;
  } catch {
    el('external').textContent = t('Результат внешней проверки недоступен. Это не доказывает сбой базы. Используйте проверку с этого устройства.',
      'Harici kontrolün sonucu alınamadı. Bağlantıyı bu cihazdan kontrol edin.');
  } finally { button.disabled = false; }
};
