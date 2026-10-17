// ⚙️ Единственный файл, который нужно отредактировать после установки.
window.APP_CONFIG = {
  // Адрес веб-приложения Apps Script (Развернуть → Управление развёртываниями → URL, заканчивается на /exec)
  API_URL: 'https://script.google.com/macros/s/AKfycbyKsOhn3ngKovtiQubXQIFQ6jD0gcgd4Z-tqXzHGQ9sEiVTb84CPtRAZK8-nRGJuEWs/exec',

  // Через сколько минут бездействия выходить из аккаунта
  IDLE_LOGOUT_MIN: { seller: 30, manager: 10, admin: 10 },

  // Как часто пытаться отправить неотправленные продажи (секунды)
  SYNC_INTERVAL_SEC: 30,

  // Как часто обновлять справочник товаров из таблицы (минуты)
  CATALOG_REFRESH_MIN: 5,

  // Сжатие фото при загрузке: максимальная сторона в пикселях и качество JPEG
  PHOTO_MAX_PX: 600,
  PHOTO_QUALITY: 0.8,
};
