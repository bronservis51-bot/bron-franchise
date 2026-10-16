-- Демо-данные v4 (13.10.2026): франчайзи по именам владельца — Виктор (Волгоград), Марсель (Караганда), Махмут (Стамбул).
-- Только переименование и перенос городов демо-точек; коды партнёров и точек не меняются. Идемпотентно.

insert into public.city_geo(country, city, lat, lng) values ('RU', 'Волжский', 48.7858, 44.7797) on conflict do nothing;

update public.partner p set name = v.name, contact_name = v.contact from (values
  ('ALPHA', 'Франчайзи Виктор (демо)', 'Виктор'), ('BETA', 'Франчайзи Марсель (демо)', 'Марсель'), ('GAMMA', 'Franchise Mahmut (demo)', 'Mahmut')
) v(code, name, contact) where p.code = v.code and p.name <> v.name;

update public.location l set name = v.name, city = v.city, address = v.address, timezone = v.tz, lat = null, lng = null from (values
  ('ALPHA-1', 'Волгоград Европа (демо)', 'Волгоград', 'ТРЦ «Европа Сити Молл», островок 3', 'Europe/Volgograd'),
  ('ALPHA-2', 'Волгоград Ворошиловский (демо)', 'Волгоград', 'ТРЦ «Ворошиловский», 1 этаж', 'Europe/Volgograd'),
  ('ALPHA-3', 'Волжский (демо, открытие)', 'Волжский', null, 'Europe/Volgograd'),
  ('BETA-1', 'Караганда Сити Молл (демо)', 'Караганда', 'ТРЦ «City Mall», 2 этаж', 'Asia/Almaty'),
  ('BETA-2', 'Астана (демо, открытие)', 'Астана', null, 'Asia/Almaty'),
  ('GAMMA-1', 'İstanbul Kadıköy AVM (demo)', 'İstanbul', 'Kadıköy AVM, Kat 1', 'Europe/Istanbul')
) v(code, name, city, address, tz) where l.code = v.code and l.name <> v.name;

update public.app_user u set full_name = v.name from (values
  ('alpha.owner@demo.example.com', 'Виктор Демо'), ('beta.owner@demo.example.com', 'Марсель Демо'), ('gamma.owner@demo.example.com', 'Mahmut Demo')
) v(email, name) where u.email = v.email and u.full_name <> v.name;
