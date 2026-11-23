import { AppError, captureSession, command } from '../../platform/backend';
import { operationKey } from '../../platform/operation';

type CheckedOperation = 'royalty_payment_reviewed' | 'royalty_set_accrual_only' | 'expense_save_with_recurring' | 'expense_repeat_checked';

export async function saveFinancialOperation<T>(userId: string | undefined, name: CheckedOperation, args: Record<string, unknown>) {
  if (!userId) throw new AppError('unauthenticated', 'Войдите в исходную учётную запись и повторите действие.', '', '');
  const receipt = await operationKey(userId, name, args);
  const actor = await captureSession(userId);
  const result = await command<T>('financial_operation', { command: name, args, operation: receipt.id },
    { accessToken: actor.access_token });
  receipt.complete();
  return result;
}
