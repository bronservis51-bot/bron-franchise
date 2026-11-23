import { afterEach, expect, it, vi } from 'vitest';
import { saveFinancialOperation } from '../../src/modules/finance/financeOperations';
import { captureSession, command } from '../../src/platform/backend';
import { operationKey } from '../../src/platform/operation';

vi.mock('../../src/platform/backend', () => ({ captureSession: vi.fn(), command: vi.fn() }));
vi.mock('../../src/platform/operation', () => ({ operationKey: vi.fn() }));

afterEach(() => vi.resetAllMocks());

it('не отправляет финансовую запись после переключения с исходной учётной записи', async () => {
  const complete = vi.fn();
  vi.mocked(operationKey).mockResolvedValue({ id: 'receipt', complete });
  vi.mocked(captureSession).mockRejectedValue(new Error('Войдите в исходную учётную запись'));

  await expect(saveFinancialOperation('original-user', 'expense_save_with_recurring', { p_amount: '1200', p_location: null }))
    .rejects.toThrow('исходную учётную запись');
  expect(captureSession).toHaveBeenCalledWith('original-user');
  expect(command).not.toHaveBeenCalled();
  expect(complete).not.toHaveBeenCalled();
});
