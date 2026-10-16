// Генерирует src/platform/contract.generated.ts из SQL-команд (ARCH-09: клиент проверяется по контракту).
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createDb, readContract, root } from './db-lib.mjs';

const db = await createDb({ seed: false });
const contract = await readContract(db);
const body = contract.map((c) => `  ${c.name}: { args: [${c.args.map((a) => `'${a.replace(/^p_/, '')}'`).join(', ')}], returns: '${c.returns}' },`).join('\n');
const out = `// СГЕНЕРИРОВАНО scripts/gen-contract.mjs из supabase/migrations — не редактировать вручную.
// Команды backend, доступные клиенту: аргументы (без префикса p_) и форма результата.
export const CONTRACT = {
${body}
} as const satisfies Record<string, { args: readonly string[]; returns: 'single' | 'set' | 'scalar' | 'void' }>;

export type CommandName = keyof typeof CONTRACT;
`;
writeFileSync(join(root, 'src/platform/contract.generated.ts'), out);
console.log(`Контракт: ${contract.length} команд`);
await db.close();
