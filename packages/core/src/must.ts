/** Narrows a nullable value in a test, throwing when it is absent. */
export function must<T>(value: T | null | undefined): T {
  if (value == null) throw new Error('expected a value');
  return value;
}
