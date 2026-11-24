import { localized, type Language } from '../../platform/locale';

export function accessMessage(site: string, password: string, language: Language = 'ru') {
  return `${site}\n${localized(language, 'Твой логин — твой номер телефона', 'Giriş numaran telefon numaran.')}\n${password}`;
}

const appDraftTargets = {
  WhatsApp: 'whatsapp://send',
  Telegram: 'tg://resolve',
} as const;

export const accessDraftApps = ['WhatsApp', 'Telegram'] as const;

export function accessMessengerDraft(name: (typeof accessDraftApps)[number], phone: string, message: string) {
  return `${appDraftTargets[name]}?phone=${encodeURIComponent(phone)}&text=${encodeURIComponent(message)}`;
}

export function accessMessengerLinks(phone: string) {
  return [
    { name: 'WhatsApp', href: `https://wa.me/${phone}` },
    { name: 'MAX', href: 'https://web.max.ru/' },
    { name: 'Telegram', href: `https://t.me/+${phone}` },
  ];
}
