# Локальная проверка доступа к VPS и Supabase

12.11.2026, MSK (UTC+03:00). Статус этапа: заблокирован.

- **SSH.** Сетевой ключ ED25519 и ключ в доверенной VNC-консоли AdminVPS
  совпали: `SHA256:8KA0F5NRZo8hIn84yT/pSclefFxk8zRg9JzuPuilYh0`.
  В закреплённой инструкции отпечаток записан с ошибкой. В `known_hosts`
  добавлен сверенный ключ. Проба с `BatchMode=yes` вернула
  `Permission denied (publickey,password)`. Подготовлен скрытый вход владельца
  для регистрации отдельного ключа. Второй вход ключом пока не подтверждён.
- **Маршрут.** В [списке AdminVPS](https://my.adminvps.ru/knowledgebase/561/zablokirovannye-porty-na-usluge-vps.html)
  TCP/5432 указан среди глобально заблокированных портов. В VNC виден
  предыдущий прямой результат `STOP: TimeoutError: timed out` до TLS.
  Новая проверка с VPS ждёт входа владельца и установки helper. Запрос на
  разрешение прямого маршрута, по инструкции, уже отправлен. Reverse SSH
  и `caffeinate` не запускались. Listener `127.0.0.1:15432` не создавался.
- **Helper, TLS и SQL.** Закреплённый файл совпал в Git и по URL загрузки.
  SHA-256: `6b51705679976b6f2c4f1b0412ec9bd3973889e3232e726286553bc0f23b7f23`.
  Установка на VPS, проверка CA, TLS, hostname и read-only SQL ещё не выполнены.
  Версия PostgreSQL и счётчики в этом сеансе не подтверждены.
- **Файлы доступа.** Ожидаемые пути на VPS:
  `/root/bron-secrets/source.pg_service.conf` и
  `/root/bron-secrets/source.pgpass`, права файлов 0600 и каталога 0700.
  Наличие и права не подтверждены. Ввод пароля БД не начинался.

После подтверждения входа, установки helper и разрешения маршрута проверка
без пароля запускается на VPS от root командой
`python3 /opt/bron/source-db-access.py --check`. После первичного скрытого
ввода и создания файлов `python3 /opt/bron/source-db-access.py --connect`
повторяет TLS и проверяет read-only SQL с уже сохранёнными credentials.

Дампы и миграция в рамках этого этапа не выполнялись.
