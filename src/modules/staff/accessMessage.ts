import { localized, type Language } from '../../platform/locale';

export function accessMessage(site: string, password: string, language: Language = 'ru') {
  return `${site}\n${localized(language, 'Твой логин — твой номер телефона', 'Giriş numaran telefon numaran.')}\n${password}`;
}

export function accessMessengerLinks(phone: string) {
  return [
    { name: 'WhatsApp', href: `https://wa.me/${phone}` },
    { name: 'MAX', href: 'https://web.max.ru/' },
    { name: 'Telegram', href: `https://t.me/+${phone}` },
  ];
}
