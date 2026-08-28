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

export async function rejectsCode(
  fn: () => Promise<unknown>,
  code: string,
  message?: string,
): Promise<{ code?: string; message?: string }> {
  try {
    await fn();
  } catch (error) {
    const actual = (error as { code?: string }).code;
    assert.equal(actual, code, message ?? `expected error code ${code}, received ${actual ?? '(none)'}`);
    // Returned like `throwsCode`, so a test can go on to assert what the
    // refusal actually said. A code proves the right rule fired; the sentence
    // is what the person on the other end of it reads.
    return error as { code?: string; message?: string };
  }
  assert.fail(message ?? `expected the call to reject with ${code}, but it resolved`);
}
