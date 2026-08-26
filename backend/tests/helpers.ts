import assert from 'node:assert/strict';

/**
 * Assert that a call fails with a specific domain error code.
 *
 * The platform separates the machine-readable `code` from the human-readable
 * message, so matching on the message alone would let a renamed error pass
 * silently. This checks the code, which is what clients actually branch on.
 *
 * Returns the refusal it caught, so a test that cares about the sentence a
 * person reads — not only the code a machine matches — can assert on that too.
 */
export function throwsCode(fn: () => unknown, code: string, message?: string): { code?: string; message?: string } {
  try {
    fn();
  } catch (error) {
    const actual = (error as { code?: string }).code;
    assert.equal(actual, code, message ?? `expected error code ${code}, received ${actual ?? '(none)'}`);
    return error as { code?: string; message?: string };
  }
  assert.fail(message ?? `expected the call to throw ${code}, but it returned normally`);
}

export async function rejectsCode(fn: () => Promise<unknown>, code: string, message?: string): Promise<void> {
  try {
    await fn();
  } catch (error) {
    const actual = (error as { code?: string }).code;
    assert.equal(actual, code, message ?? `expected error code ${code}, received ${actual ?? '(none)'}`);
    return;
  }
  assert.fail(message ?? `expected the call to reject with ${code}, but it resolved`);
}
