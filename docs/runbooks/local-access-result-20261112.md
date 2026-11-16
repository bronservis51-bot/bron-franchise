# Локальная проверка доступа к VPS и Supabase

12.11.2026, MSK (UTC+03:00).

- **SSH.** Сетевой ключ ED25519 совпал с ключом из доверенной VNC AdminVPS
  и исправленным отпечатком инструкции
  `SHA256:8KA0F5NRZo8hIn84yT/pSclefFxk8zRg9JzuPuilYh0`. Запись
  сверена в `known_hosts`. После личного скрытого ввода существующего
  пароля VPS установлен только публичный ключ владельца. Подтверждён отдельный
  вход под root с `BatchMode=yes` и строгой проверкой host key. Закрытый ключ
  остался на Mac с правами 0600.
- **VPS и helper.** Локальный исполнитель подтвердил адрес целевого VPS, отсутствие
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
- **SQL — завершено в прежнем чате 12.11.** После личного ввода пароля запрос
  выполнился, но предыдущий helper ошибочно потребовал session default read-only.
  Исправленный helper из `84bfe538d5754b2a25e765d0b0ce68b428ac40dd` загружен как
  `/root/e`; SHA-256 `05b381f28f69377f87a980b7444190fa00047544d81b6b0f9d65ad1d8a68817e`
  совпал. `python3 /root/e --tunnel --connect` подтвердил TLS 1.3,
  PostgreSQL 17.11 (`170011`), actual `read_only=on`, default `off`,
  16 Auth users / 16 identities / 1 bucket / 0 objects. Existing credential
  files прошли защитную проверку root/0600/точного service и были переиспользованы
  без запроса пароля. Затем `install -m600 /root/e /opt/bron/source-db-access.py`
  завершился без ошибки. Каталог `/root/bron-secrets` — root/0700.
- **Канал на Mac.** SSH работает отдельным заданием пользовательского
  `launchd` с `caffeinate -i`. SSH и блокировка сна подтверждены повторно.
  В Terminal на Mac: остановка — `~/.ssh/bron-source-tunnel stop`,
  запуск — `~/.ssh/bron-source-tunnel start`, статус —
  `~/.ssh/bron-source-tunnel status`. Если после перезапуска Mac ключ
  отсутствует в SSH-агенте, сначала выполните
  `ssh-add ~/.ssh/bron_adminvps_ed25519` и введите фразу ключа в Terminal.
  Mac оставить с открытой крышкой, питанием и интернетом.

Локальная проверка SSH/канала — 12.11.2026 в 14:23 MSK; SQL и установленный fix
проверены позднее в прежнем чате. Этап доступа завершён; миграция продолжается
здесь. Полной копии и восстановления пока нет.

После первичного скрытого ввода команда повторной проверки на VPS от root:

```sh
python3 /opt/bron/source-db-access.py --tunnel --connect
```

Команда проверяет TLS и выполняет только запрос метаданных с read-only режимом.
Дампы и миграция в рамках этого этапа не выполнялись.
