const CONNECTION_QUEUES = new WeakMap();

function transactionError(code, message = code, options) {
  const error = new Error(message, options);
  error.code = code;
  return error;
}

function diagnosticError(value, code, message) {
  if (value instanceof Error) return value;
  return transactionError(code, message, { cause: value });
}

function attachCause(original, cause) {
  if (!cause) return original;
  const error = original instanceof Error ? original : new Error(String(original));
  const descriptor = Object.getOwnPropertyDescriptor(error, 'cause');
  const existing = descriptor && Object.hasOwn(descriptor, 'value')
    ? descriptor.value
    : undefined;
  const combined = existing === undefined
    ? cause
    : new AggregateError([existing, cause], 'Original and SQLite transaction causes.');
  try {
    Object.defineProperty(error, 'cause', { configurable: true, value: combined });
    return error;
  } catch {
    const wrapped = new Error(error.message, { cause: combined });
    wrapped.name = error.name;
    if (error.code !== undefined) wrapped.code = error.code;
    return wrapped;
  }
}

async function probeTransactionState(connection, code, message) {
  let state;
  try {
    state = await connection.isTransactionActive();
  } catch (error) {
    throw transactionError(code, message, {
      cause: diagnosticError(
        error,
        'sqlite_transaction_state_check_failed',
        'SQLite transaction state check failed.',
      ),
    });
  }
  if (state !== true && state !== false) {
    throw transactionError(code, message, {
      cause: transactionError(
        'sqlite_transaction_state_invalid',
        'SQLite transaction state was not exactly boolean.',
      ),
    });
  }
  return state;
}

async function rollbackOwnedTransaction(connection) {
  const issues = [];
  try {
    await connection.rollback();
  } catch (error) {
    issues.push(
      diagnosticError(
        error,
        'sqlite_transaction_rollback_failed',
        'SQLite transaction rollback failed.',
      ),
    );
  }
  try {
    const state = await connection.isTransactionActive();
    if (state !== false) {
      issues.push(
        transactionError(
          state === true
            ? 'sqlite_transaction_still_active'
            : 'sqlite_transaction_state_invalid',
          state === true
            ? 'SQLite transaction remained active after rollback.'
            : 'SQLite transaction state was not exactly boolean.',
        ),
      );
    }
  } catch (error) {
    issues.push(
      diagnosticError(
        error,
        'sqlite_transaction_state_check_failed',
        'SQLite transaction state check failed after rollback.',
      ),
    );
  }
  if (issues.length === 0) return null;
  return transactionError(
    'sqlite_transaction_rollback_incomplete',
    'SQLite transaction inactivity could not be proven after rollback.',
    { cause: new AggregateError(issues, 'SQLite rollback recovery failed.') },
  );
}

export function runExclusive(connection, operation) {
  const prior = CONNECTION_QUEUES.get(connection) ?? Promise.resolve();
  const result = prior.then(operation, operation);
  const tail = result.then(
    () => undefined,
    () => undefined,
  );
  CONNECTION_QUEUES.set(connection, tail);
  void tail.finally(() => {
    if (CONNECTION_QUEUES.get(connection) === tail) {
      CONNECTION_QUEUES.delete(connection);
    }
  });
  return result;
}

export async function assertTransactionInactive(connection) {
  const active = await probeTransactionState(
    connection,
    'sqlite_transaction_state_invalid',
    'SQLite transaction state could not be established before begin.',
  );
  if (active) {
    throw transactionError(
      'sqlite_transaction_foreign_active',
      'SQLite connection already has a transaction owned by another operation.',
    );
  }
}

export function runOwnedTransaction(connection, operation) {
  return runExclusive(connection, async () => {
    await assertTransactionInactive(connection);

    try {
      await connection.begin();
    } catch (error) {
      let state;
      try {
        state = await connection.isTransactionActive();
      } catch (probeError) {
        const cleanup = await rollbackOwnedTransaction(connection);
        throw attachCause(
          error,
          cleanup ?? diagnosticError(
            probeError,
            'sqlite_transaction_state_check_failed',
            'SQLite begin failure state check failed.',
          ),
        );
      }
      if (state === true) {
        throw attachCause(error, await rollbackOwnedTransaction(connection));
      }
      if (state !== false) {
        const cleanup = await rollbackOwnedTransaction(connection);
        throw attachCause(
          error,
          cleanup ?? transactionError('sqlite_transaction_state_invalid'),
        );
      }
      throw error;
    }

    let active;
    try {
      active = await probeTransactionState(
        connection,
        'sqlite_transaction_state_invalid',
        'SQLite begin was not acknowledged by an active native transaction.',
      );
    } catch (error) {
      throw attachCause(error, await rollbackOwnedTransaction(connection));
    }
    if (!active) {
      throw transactionError('sqlite_transaction_state_invalid');
    }

    let value;
    try {
      value = await operation();
    } catch (error) {
      throw attachCause(error, await rollbackOwnedTransaction(connection));
    }

    try {
      await connection.commit();
    } catch (error) {
      let state;
      try {
        state = await connection.isTransactionActive();
      } catch (probeError) {
        const cleanup = await rollbackOwnedTransaction(connection);
        throw attachCause(
          error,
          cleanup ?? diagnosticError(
            probeError,
            'sqlite_transaction_state_check_failed',
            'SQLite commit failure state check failed.',
          ),
        );
      }
      if (state === true) {
        throw attachCause(error, await rollbackOwnedTransaction(connection));
      }
      if (state !== false) {
        throw attachCause(
          error,
          await rollbackOwnedTransaction(connection) ??
            transactionError('sqlite_transaction_state_invalid'),
        );
      }
      throw error;
    }

    let finalState;
    try {
      finalState = await probeTransactionState(
        connection,
        'sqlite_transaction_state_invalid',
        'SQLite commit did not leave the connection inactive.',
      );
    } catch (error) {
      throw attachCause(error, await rollbackOwnedTransaction(connection));
    }
    if (finalState) {
      throw attachCause(
        transactionError(
          'sqlite_transaction_state_invalid',
          'SQLite commit did not leave the connection inactive.',
        ),
        await rollbackOwnedTransaction(connection),
      );
    }
    return value;
  });
}
