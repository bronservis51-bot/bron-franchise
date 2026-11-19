# Кнопка выпуска кабинета на Timeweb

Workflow [«Выпуск Timeweb»](../../.github/workflows/production-release.yml) собирает кабинет по проверенному коммиту, прогоняет тесты и передаёт пакет закрытой серверной команде. Лендинг и GitHub Pages выпускаются по своим процедурам.

## Первичная настройка

1. Настройте защиту `main` и `release/production`. В `main` хранится проверенный workflow. В `release/production` допускаются проверенные коммиты кабинета, чья история включает рабочую версию. Ограничьте обновление веток и запуск выпусков уполномоченными участниками. Не допускайте прямых правок workflow без проверки.
2. Создайте GitHub Actions Environment `production`. Разрешите запуск из `main` и включите обязательное подтверждение уполномоченным человеком. Проверьте, что выбранный план GitHub поддерживает это правило для репозитория. Пока требуемая защита не включена, не добавляйте доступы в окружение и используйте `verify_only`.
3. Изолированная сборка использует публичный ключ для `https://api.bronservis.ru` из [`availability-public.json`](../../deploy/timeweb/availability-public.json). При ротации укажите актуальный публичный `anon` или `sb_publishable_…` в **Variables** репозитория под именем `PRODUCTION_SUPABASE_PUBLISHABLE_KEY`. Если настроен Google Drive, добавьте публичный `PRODUCTION_GOOGLE_DRIVE_CLIENT_ID`. Пароль БД, сервисный ключ Supabase, токены МойСклад и S3 остаются на сервере.
4. Создайте в Tailscale федеративную identity с issuer `https://token.actions.githubusercontent.com`, разрешением `auth_keys` и только тегом `tag:bron-deploy`. Скопируйте точный audience (`api.tailscale.com/<client-id>`). Ограничьте доверие точным субъектом `repo:bronservis51-bot@341494654/bron-franchise@1422714079:environment:production` и claims из таблицы. Проверьте выбранные значения claims при первичной проверке, без записи исходного JWT в лог.
5. В политиках Tailscale разрешите тегу `tag:bron-deploy` обращаться только к адресу рабочего сервера по TCP 22. На этом маршруте должен отвечать обычный OpenSSH с серверной принудительной командой. Не включайте перехват этого маршрута через Tailscale SSH. Сверьте с серверным администратором адрес и открытый ключ хоста по доверенному каналу, прежде чем записывать закреплённый `known_hosts`.
6. Установите проверенный серверный приёмник и отдельный логин `bron-deploy` по его процедуре. Команда `bron-release-v1` должна приводить только к установленному приёмнику. Закройте интерактивный вход, выделение терминала и перенаправления. Создайте для GitHub отдельную пару ключей этого логина. Рабочий административный `BRON_CLOUD_SSH_KEY` в GitHub не передаётся.

| Claim Tailscale | Разрешённое значение |
|---|---|
| `repository_id` | `1422714079` |
| `ref` | `refs/heads/main` |
| `workflow_ref` | `bronservis51-bot/bron-franchise/.github/workflows/production-release.yml@refs/heads/main` |
| `event_name` | `workflow_dispatch` |
| `runner_environment` | `github-hosted` |

| В окружении `production` | Значение |
|---|---|
| Variable `TS_OAUTH_CLIENT_ID` | ID федеративной identity Tailscale |
| Variable `TS_AUDIENCE` | Audience из настроек identity |
| Variable `PRODUCTION_TAILSCALE_HOST` | Закреплённый IPv4 рабочего сервера в диапазоне Tailscale `100.64.0.0/10` |
| Variable `PRODUCTION_SSH_KNOWN_HOSTS` | Одна строка `<Tailscale-IP> ssh-ed25519 <проверенный открытый keyblob>` без комментария |
| Secret `PRODUCTION_DEPLOY_SSH_KEY` | Закрытый ключ отдельного логина `bron-deploy` |

## Приёмник на VPS

Администратор устанавливает файлы в `/usr/local/sbin` с владельцем `root:root`
и правами `0755`. Серверная команда читает tar из stdin.

```sh
install -o root -g root -m 0755 scripts/production-release.py /usr/local/sbin/bron-production-release
install -o root -g root -m 0755 scripts/production-release-ssh.sh /usr/local/sbin/bron-release-ssh
install -d -o root -g root -m 0700 /etc/bron-release /root/bron-secrets/production-release
```

В `/etc/bron-release/config.json` с владельцем `root:root` и правами `0600`
задаются следующие поля.

| Поле | Значение |
|---|---|
| `site_root` | Проверенный каталог `/opt/bron/supabase/docker/bron/site`, который обслуживает Caddy |
| `state_dir` | Закрытый каталог `/root/bron-secrets/production-release` для квитанций |
| `backup_program` | Установленный `/opt/bron/backup/target-backup.py` |
| `public_probe_key` | Публичный `anon` или `sb_publishable_…` ключ действующего API для проверки входа, RPC и анкеты |
| `restore_receipt` | Абсолютный путь к закрытой квитанции успешного пробного восстановления текущего механизма копирования |
| `restore_receipt_sha256` | SHA-256 подтверждённой квитанции |
| `target_db_id` | Полный ID проверенного рабочего контейнера `supabase-db` |
| `target_db_image` | Идентификатор образа этого контейнера в формате `sha256:…` |

Для учётной записи `bron-deploy` отключите вход по паролю и оставьте один ключ
из окружения GitHub `production`. Для этого ключа в `authorized_keys`
используются опции
`from="100.64.0.0/10",restrict,command="/usr/local/sbin/bron-release-ssh"`.
Доступ ограничивают политика Tailscale и отдельный ключ GitHub. Правило в
`visudo` даёт логину право только на одну серверную команду.

```sudoers
bron-deploy ALL=(root) NOPASSWD: /usr/local/sbin/bron-production-release ""
```

Перед первым запуском администратор выполняет
`/usr/local/sbin/bron-production-release --check` и подтверждает `READY`
с актуальным рабочим SHA. Квитанция выпуска хранится в `latest.json`, а
результат миграций — в `migration.json` закрытого каталога состояния.

## Выпуск

1. Проверьте текущий `sourceCommit` по адресу `https://app.bronservis.ru/release-manifest.json`. Используйте полный SHA из рабочей версии в `expected_live_source_sha` и полный SHA проверенного коммита в `source_sha`.
2. В GitHub Actions запустите «Выпуск Timeweb» из `main`. Для репетиции включите `verify_only`. Такая попытка собирает и проверяет пакет без доступа к рабочему серверу.
3. Перед подтверждением сверьте SHA в форме запуска, результаты тестов и целевое окружение `production`. Задание выпуска скачивает артефакт этой сборки по ID, сверяет SHA-256 и передаёт tar через stdin единственной серверной команде. Пакет содержит сайт с публичным манифестом, полную историю миграций и контрольные суммы. Сервер сверяет рабочую версию и уже применённые SQL, проверяет резервную копию и переключает кабинет по своему регламенту.
4. Дождитесь окончания задания и пяти публичных проверок с GitHub. Они охватывают кабинет, вход, данные, анкету лендинга и состояние резервирования. GitHub также сверит рабочий `sourceCommit` с запрошенным SHA. Проверьте затронутые пользовательские сценарии в приложении. Если сервер сообщил об изменении рабочей версии, проверьте причину и заново согласуйте следующий SHA. Не перезапускайте устаревшую попытку с прежней рабочей версией. Процедура возвращения к предыдущей версии описывается серверным регламентом.

Сервер проверяет эти же маршруты до подтверждения переключения клиента.
При сбое он возвращает предыдущую сборку и сохраняет хешированные ресурсы,
которые успели получить браузеры. Квитанция отдельно фиксирует результат
локального возврата и публичной проверки. Применённые миграции остаются
в журнале, откуда следующая попытка прочитает их контрольные суммы.
Проверка резервной копии использует действующий порог до 70 минут для последней
успешной копии с проверенным чтением из S3.

Проверка формата пакета локально выполняется командой `node --test tests/ops/release-bundle.test.mjs`. Тест использует временные файлы и не соединяется с рабочим сервером.

[Tailscale GitHub Action](https://tailscale.com/docs/integrations/github/github-action) · [GitHub OIDC claims](https://docs.github.com/en/actions/reference/security/oidc) · [GitHub Environments](https://docs.github.com/en/actions/how-tos/deploy/configure-and-manage-deployments/manage-environments)
