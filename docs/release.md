# Выпуск easyPTO для Windows

## Сборка установщика

Локальная команда создаёт NSIS-установщик для текущей версии:

```powershell
npm ci
npm run tauri build -- --target x86_64-pc-windows-msvc --bundles nsis
```

Установщик устанавливается для текущего пользователя. Результат находится в `src-tauri/target/x86_64-pc-windows-msvc/release/bundle/nsis`.

GitHub Actions собирает этот установщик для проверки изменений. Релизная сборка запускается только при отправке тега `vX.Y.Z`; тег должен совпасть с версиями в `package.json`, `src-tauri/tauri.conf.json` и `src-tauri/Cargo.toml`.

## Подпись обновлений и релиз

В приложении настроено получение `latest.json` из GitHub Releases. Для подписи пакетов обновления добавьте в **Settings → Secrets and variables → Actions**:

- `TAURI_SIGNING_PRIVATE_KEY` — содержимое файла updater `.key`;
- `TAURI_SIGNING_PRIVATE_KEY_PASSWORD` — пароль этого ключа.

Updater подписывает пакет закрытым ключом Tauri; приложение проверяет подпись встроенным публичным ключом. Ключ `.key` нельзя коммитить или отправлять в чат, а его резервную копию нужно хранить отдельно и надёжно: без него нельзя выпускать совместимые обновления.

Платный сертификат Windows не требуется. NSIS EXE при этом останется без Authenticode-подписи и Windows может показывать предупреждение SmartScreen. Это не отключает криптографическую проверку пакетов автообновления Tauri: механизмы подписывают разные вещи.

Перед тегом обновите версию одновременно в `package.json`, `src-tauri/tauri.conf.json` и `src-tauri/Cargo.toml`, затем зафиксируйте и отправьте изменения в `main`. После этого отправьте тег, совпадающий с версией, например `v0.2.0`. Workflow соберёт NSIS-пакет с подписью updater, сформирует checksum и `latest.json`, затем опубликует их как GitHub Release. Приложение проверяет обновление при запуске и предлагает установить его; установка закрывает и перезапускает приложение.

## Выпуск новой версии из Windows

В корне репозитория есть `release-easypto.cmd`. Его можно запустить двойным щелчком или указать полный путь из любой текущей папки. Он попросит выбрать patch/minor/major, обновит версию приложения и Cargo lock, выполнит локальные сборки, покажет список файлов и запросит подтверждение перед публикацией.

```cmd
"C:\путь\к\easyPTO\release-easypto.cmd"
```

После подтверждения сценарий создаст коммит в `main`, отправит его на GitHub и дождётся успешного workflow `Windows build`. Если `main` на GitHub ушла вперёд, сценарий сам выполнит безопасный `git pull --ff-only`; если локальная ветка содержит неотправленные коммиты, он остановится, чтобы не переписывать историю. Только после успешной сборки он отправит тег `vX.Y.Z`, дождётся `Windows release` и покажет ссылку на опубликованный релиз. Нужны установленные Git, Node.js/npm, Rust/Cargo, GitHub CLI (`gh`) с выполненным `gh auth login`, а также настроенные GitHub Actions secrets для подписи updater.

Для ручного выпуска выполните те же этапы по порядку, заменив `0.1.3` на новую версию:

```powershell
# 1. Убедиться, что рабочая ветка main синхронизирована с GitHub
git switch main
git pull --ff-only origin main

# 2. Обновить package.json и package-lock.json без автоматического git-тега
npm version 0.1.3 --no-git-tag-version

# 3. Установить эту же версию в src-tauri/tauri.conf.json и src-tauri/Cargo.toml,
#    затем пересчитать Cargo.lock и проверить обе части приложения
npm run build
cargo check --manifest-path src-tauri/Cargo.toml

# 4. Посмотреть изменения, зафиксировать и отправить коммит в main
git add -A -- . ':(exclude)src-tauri/icon-output-temp'
git diff --cached --check
git diff --cached --stat
git commit -m "Release easyPTO v0.1.3"
git push origin main

# 5. Дождаться успешной сборки Windows в GitHub Actions, затем создать тег
git tag -a v0.1.3 -m "easyPTO v0.1.3"
git push origin v0.1.3

# 6. Следить за релизной сборкой и проверить опубликованный релиз
gh run list --workflow "Windows release" --limit 5
gh release view v0.1.3
```

Для ручного выпуска версия в трёх файлах (`package.json`, `src-tauri/tauri.conf.json`, `src-tauri/Cargo.toml`) и теге должна совпадать. Не отправляйте тег, пока workflow `Windows build` для коммита не завершился успешно.

## Порядок первого релиза

Репозиторий должен быть публичным, так как клиент скачивает ленту и пакет без GitHub-токена. После отправки исходников и настроек Actions Secrets создайте первый тег выше текущей версии установленного приложения, например `v0.1.1`, если приложение собрано с версией `0.1.0`. Тег `v0.1.0` не будет предлагаться приложению с такой же версией.
