/** Captures begin outside this state machine. CANDIDATE and REVIEW are not commitments. */
export const STATES = Object.freeze(['CANDIDATE', 'REVIEW', 'COMMITTED', 'ACTIVE', 'COMPLETE', 'DROPPED']);
export const COMMITMENT_STATES = Object.freeze(['COMMITTED', 'ACTIVE', 'COMPLETE', 'DROPPED']);
