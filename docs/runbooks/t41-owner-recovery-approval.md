# T41: разрешённое исключение для независимого восстановления ключа

14.11.2026 владелец явно разрешил только метод из
[owner-key-recovery-proposal.md](owner-key-recovery-proposal.md).
Одобренные bytes этого предложения не изменяются: SHA-256
`dc714a9f88a5c2b453a73ce1474d13a39be13872f7251fa06f99223d90e962d8`.
Историческое `NOT AUTHORIZED` в самом предложении описывает момент его подготовки;
актуальное решение владельца записано здесь.

Точная формулировка решения:

> OWNER_APPROVAL T41 KEY-RECOVERY EXCEPTION: Owner approves only the scoped method in owner-key-recovery-proposal.md. Keep the existing plaintext AGE identity on the VPS; encrypt it with a new owner-held passphrase entered only in hidden phone TTY; send only the scrypt-encrypted ciphertext directly VPS→existing private Timeweb S3 at a unique migration/owner-key-escrow path with no-overwrite PUT and bounded GET/readback; verify the downloaded ciphertext decrypts the pinned backup. No plaintext key, passphrase, or backup through Mac or logs; do not open the DMG or use the T30 raw-identity verifier. This approval does not authorize execution before a new pinned task and a working owner phone root console.

Это узкое исключение к запрету identity в backup bucket: разрешена только копия,
дополнительно зашифрованная новой личной фразой, в отдельном уникальном
`migration/owner-key-escrow-<UUID>/identity.age`. Raw AGE identity остаётся на VPS.
Другие credentials, policies, lifecycle, общий uploader allowlist и его команды
не меняются. Одна conditional PUT, затем один ограниченный GET; сбой или
неопределённый ответ не разрешает повторную загрузку.

Разрешение не является фактическим proof. Новый task T41 сначала требует
личную root-консоль с телефона; затем helper выполняет crypto/readback proof,
а владелец отдельно подтверждает независимую копию фразы, вход в AdminVPS и
Timeweb с телефона. T30 raw-identity verifier не вызывается, T30 PASS не создаётся.
Только после проверки этих новых файлов координатором разрешены следующие
условные фазы T41. Приложение и API до release gates остаются в maintenance.
