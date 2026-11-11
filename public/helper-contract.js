// Compatibility entry. Generated contract code comes only from packages/helpers.
export * from './helpers/contract.js';
import { validateHelperEnvelope as validate } from './helpers/contract.js';
import { sha256 } from './primitives.js';
export const validateHelperEnvelope = (envelope, review=null, role=null) => validate(envelope, review, role, {hash:sha256});
