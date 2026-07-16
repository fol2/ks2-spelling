import {
  createB3InitialCaptureStartAuthority,
  publicB3CaptureStartAuthority,
} from './b3-capture-start-authority.mjs';
import { openB3CaptureStateDatabase } from './b3-capture-state-database.mjs';
import { takeB3CaptureStateSession } from './b3-capture-state-internal.mjs';

function repositoryError(message) {
  return Object.assign(new Error(message), { code: 'b3_capture_state_invalid' });
}

export async function openB3CaptureStateRepository(options) {
  const foundation = await openB3CaptureStateDatabase(options);
  const session = takeB3CaptureStateSession(foundation);
  if (!session) {
    await foundation.close();
    throw repositoryError('B3 capture-state internal session authority is absent');
  }

  async function reserveInitialCaptureStart(reservationOptions) {
    if (session.isClosed()) {
      throw repositoryError('B3 capture-state repository is already closed');
    }
    const reservationKeys = reservationOptions && typeof reservationOptions === 'object'
      ? Object.keys(reservationOptions)
      : [];
    if (reservationKeys.length !== 1 || reservationKeys[0] !== 'command') {
      throw repositoryError('B3 capture-state initial reservation authority is invalid');
    }
    const rawCommand = reservationOptions.command;
    const buildAuthority = await session.readBuildAuthorityFresh();
    const proposal = createB3InitialCaptureStartAuthority({
      platform: session.platform,
      command: rawCommand,
      buildAuthority,
    });

    session.database.exec('BEGIN IMMEDIATE');
    try {
      let state = session.validate(buildAuthority);
      if (state.kind === 'empty') {
        const inserted = session.database.prepare(`
          INSERT INTO b3_capture_start_intents (
            start_intent_sha256, intent_kind, recovered_command_sha256,
            terminal_claim_sha256, capture_id, first_command_sha256,
            first_command_json, first_prepared_record_json,
            first_prepared_record_sha256, intent_state, row_version
          ) VALUES (?, 'initial', NULL, NULL, ?, ?, ?, ?, ?, 'pending', 1)
        `).run(
          proposal.startIntentSha256,
          proposal.captureId,
          proposal.firstCommandSha256,
          proposal.commandBytes,
          proposal.preparedRecordBytes,
          proposal.firstPreparedRecordSha256,
        );
        const reserved = session.database.prepare(`
          UPDATE b3_authority_state
          SET reserved_start_command_sha256 = ?, row_version = row_version + 1
          WHERE singleton = 1 AND next_allocation_sequence = 1
            AND active_command_sha256 IS NULL
            AND reserved_start_command_sha256 IS NULL AND row_version = 1
        `).run(proposal.firstCommandSha256);
        if (inserted.changes !== 1 || reserved.changes !== 1) {
          throw repositoryError('B3 capture-state initial reservation write lost authority');
        }
        state = session.validate(buildAuthority);
      }
      if (state.kind !== 'pending-initial') {
        throw repositoryError('B3 capture-state initial reservation cannot proceed');
      }
      session.database.exec('COMMIT');
      return publicB3CaptureStartAuthority(state.startIntent);
    } catch (error) {
      if (session.database.isTransaction) session.database.exec('ROLLBACK');
      throw error;
    }
  }

  return Object.freeze({
    reserveInitialCaptureStart,
    close: () => foundation.close(),
  });
}
