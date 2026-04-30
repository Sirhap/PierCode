export const DEFAULT_AUTO_EXECUTE = false;

export function resolveAutoExecute(value: unknown): boolean {
  return typeof value === 'boolean' ? value : DEFAULT_AUTO_EXECUTE;
}
