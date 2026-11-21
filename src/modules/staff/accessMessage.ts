export function accessMessage(site: string, password: string) {
  return `${site}\nТвой логин — твой номер телефона\n${password}`;
}

export function accessMessengerLinks(phone: string) {
  return [
    { name: 'WhatsApp', href: `https://wa.me/${phone}` },
    { name: 'MAX', href: 'https://web.max.ru/' },
    { name: 'Telegram', href: `https://t.me/+${phone}` },
  ];
}
