# Локальная проверка доступа к VPS и Supabase

12.11.2026, MSK (UTC+03:00).

- **SSH.** Сетевой ключ ED25519 совпал с ключом из доверенной VNC AdminVPS
  и исправленным отпечатком инструкции
  `SHA256:8KA0F5NRZo8hIn84yT/pSclefFxk8zRg9JzuPuilYh0`. Запись
  сверена в `known_hosts`. После личного скрытого ввода существующего
  пароля VPS установлен только публичный ключ владельца. Подтверждён отдельный
  вход под root с `BatchMode=yes` и строгой проверкой host key. Закрытый ключ
  остался на Mac с правами 0600.
- **VPS и helper.** Подтверждены адрес целевого VPS, отсутствие
  `/opt/bron/production-enabled` и контейнеров. Закреплённый
  `/opt/bron/source-db-access.py` установлен с владельцем `root:root` и
  правами 0600. SHA-256
  `6b51705679976b6f2c4f1b0412ec9bd3973889e3232e726286553bc0f23b7f23`.
  SHA-256 исходного CA
  `700723581420dd1ac98fd7e9ac529f0ef210eadcaf87fc868a3ad7d114c2f3b7`.
  Bundle совпал с системным CA bundle и закреплённым CA Supabase.
- **Маршрут.** Прямая проверка с VPS завершилась до TLS с
  `STOP: TimeoutError: Source network check exceeded 30 seconds`.
  [AdminVPS перечисляет TCP/5432](https://my.adminvps.ru/knowledgebase/561/zablokirovannye-porty-na-usluge-vps.html)
  среди глобально заблокированных портов. Работает временный reverse SSH с Mac.
  Эффективное `GatewayPorts no` проверено. VPS слушает только
  `127.0.0.1:15432`. Закреплённый helper подтвердил TLS 1.3, сертификат и
  каноническое имя `aws-1-us-west-2.pooler.supabase.com`.
- **SQL.** Ожидается скрытый ввод владельца в TTY VPS. Проверен каталог
  `/root/bron-secrets`, владелец `root:root`, права 0700. Файлы
  `source.pg_service.conf` и `source.pgpass` пока отсутствуют. Версия
  PostgreSQL, счётчики и read-only SQL в этом сеансе ещё не подтверждены.
- **Канал на Mac.** SSH работает отдельным заданием пользовательского
  `launchd` с `caffeinate -i`. SSH и блокировка сна подтверждены повторно.
  В Terminal на Mac: остановка — `~/.ssh/bron-source-tunnel stop`,
  запуск — `~/.ssh/bron-source-tunnel start`, статус —
  `~/.ssh/bron-source-tunnel status`. Если после перезапуска Mac ключ
  отсутствует в SSH-агенте, сначала выполните
  `ssh-add ~/.ssh/bron_adminvps_ed25519` и введите фразу ключа в Terminal.
  Mac оставить с открытой крышкой, питанием и интернетом.

Последняя проверка 12.11.2026 в 14:23 MSK. SSH, единственный loopback listener
и TLS работают. Точка передачи этапа после read-only SQL ещё не достигнута.

После первичного скрытого ввода команда повторной проверки на VPS от root:

```sh
test -f /root/bron-secrets/source.pg_service.conf &&
  test -f /root/bron-secrets/source.pgpass &&
  BRON_SOURCE_TUNNEL_PORT=15432 python3 /opt/bron/source-db-access.py --connect
```

Команда проверяет TLS и выполняет только запрос метаданных с read-only режимом.
Дампы и миграция в рамках этого этапа не выполнялись.
