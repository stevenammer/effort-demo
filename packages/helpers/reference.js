import { helperPrompt, validateHelperResult } from './contract.js';
import { exactKeys, safePart, same } from '../core/sealed.js';

/** A protocol exerciser. It performs no inference, network access or external work. */
export async function referenceReply(packet, hash) {
  if (!exactKeys(packet, ['protocol','requestId','requestHash','approvalHash','attemptId','role','recipient','question','requestedResult','context']) ||
      packet.protocol !== 'effort-thread/1' || !safePart(packet.requestId) || !safePart(packet.attemptId) ||
      !exactKeys(packet.recipient, ['id','kind']) || packet.recipient.kind !== 'reference') throw Error('Invalid reference request.');
  const review = { question: packet.question, requestedResult: packet.requestedResult, context: packet.context.map(source=>({...source,origin:source.origin?{kind:source.origin.kind,recordId:source.origin.recordId,recordHash:source.origin.recordHash,metadataHash:source.origin.metadataHash}:null})), invited: [packet.role] };
  const prompt = helperPrompt(review, packet.role);
  const result = { type: 'NO_ACTION', text: 'This deterministic protocol check made no model call and performed no external work.',
    facts: [], assumptions: [], uncertainties: ['No inference or independent fact checking was performed.'], recommendation: '', proposals: [], confidence: 'unknown' };
  validateHelperResult(result, review, { sourceIdAllowed: safePart });
  return { protocol: 'effort-thread/1', requestId: packet.requestId, attemptId: packet.attemptId,
    requestHash: packet.requestHash, approvalHash: packet.approvalHash, packetHash: await hash(packet),
    result, rawResponse: JSON.stringify(result), rawModelResponse: null,
    receipt: { kind: 'deterministic-reference', model: null, recipientId: packet.recipient.id, role: packet.role,
      prompt, promptHash: await hash(prompt), tools: [], externalWork: false } };
}

export async function verifyReferenceReply(envelope, packet, hash) {
  if (!same(envelope, await referenceReply(packet, hash))) throw Error('The reference result differs from its exact approved attempt.');
  return envelope;
}
