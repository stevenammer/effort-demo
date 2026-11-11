import { same } from '../core/sealed.js';
/** Host-local authority, deliberately separate from portable workspace exports.
 * Production hosts must persist these receipts in their own private trust store.
 * An imported request or pairing record never calls either authorizing method.
 */
export function createMemoryTrust(initial = { recipients: [], approvals: [] }) {
  const receipts = structuredClone(initial);
  if (!Array.isArray(receipts.recipients) || !Array.isArray(receipts.approvals)) throw Error('Invalid local trust receipts.');
  return {
    async trustRecipient(recipient, { authority } = {}) {
      if (authority !== 'human') throw Error('A person must explicitly trust the recipient.');
      if (!receipts.recipients.some(row => same(row, recipient))) receipts.recipients.push(structuredClone(recipient));
    },
    async trustApproval(approval, { authority } = {}) {
      if (authority !== 'human') throw Error('A person must explicitly approve the selected context.');
      if (!receipts.approvals.some(row => same(row, approval))) receipts.approvals.push(structuredClone(approval));
    },
    async allowRecipient(recipient) { return receipts.recipients.some(row => same(row, recipient)); },
    async allowApproval(approval) { return receipts.approvals.some(row => same(row, approval)); },
    snapshot: () => structuredClone(receipts),
  };
}
