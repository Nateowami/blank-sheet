// Minimal test assertion utilities wrapping node:assert

import nodeAssert from "node:assert";

export function assertEquals<T>(actual: T, expected: T, msg?: string): void {
  nodeAssert.deepStrictEqual(actual, expected, msg);
}

export function assertNotEquals<T>(actual: T, expected: T, msg?: string): void {
  nodeAssert.notDeepStrictEqual(actual, expected, msg);
}

export function assertStringIncludes(actual: string, expected: string, msg?: string): void {
  if (!actual.includes(expected)) {
    nodeAssert.fail(
      msg ?? `Expected string to include "${expected}" but got:\n${actual}`,
    );
  }
}

export function assertThrows(
  fn: () => void,
  // deno-lint-ignore no-explicit-any
  ErrorClass?: new (...args: any[]) => Error,
  msgIncludes?: string,
): void {
  let threw = false;
  let err: unknown;
  try {
    fn();
  } catch (e) {
    threw = true;
    err = e;
  }
  if (!threw) {
    nodeAssert.fail("Expected function to throw but it did not.");
  }
  if (ErrorClass && !(err instanceof ErrorClass)) {
    nodeAssert.fail(
      `Expected error to be instance of ${ErrorClass.name}, got ${(err as Error)?.constructor?.name}`,
    );
  }
  if (msgIncludes && err instanceof Error && !err.message.includes(msgIncludes)) {
    nodeAssert.fail(
      `Expected error message to include "${msgIncludes}", got: "${err.message}"`,
    );
  }
}

export async function assertRejects(
  fn: () => Promise<void>,
  // deno-lint-ignore no-explicit-any
  ErrorClass?: new (...args: any[]) => Error,
  msgIncludes?: string,
): Promise<void> {
  let threw = false;
  let err: unknown;
  try {
    await fn();
  } catch (e) {
    threw = true;
    err = e;
  }
  if (!threw) {
    nodeAssert.fail("Expected async function to throw but it did not.");
  }
  if (ErrorClass && !(err instanceof ErrorClass)) {
    nodeAssert.fail(
      `Expected error to be instance of ${ErrorClass.name}, got ${(err as Error)?.constructor?.name}`,
    );
  }
  if (msgIncludes && err instanceof Error && !err.message.includes(msgIncludes)) {
    nodeAssert.fail(
      `Expected error message to include "${msgIncludes}", got: "${err.message}"`,
    );
  }
}
