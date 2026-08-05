import type { AgentMessage, AgentRunEvidence, ConversationTarget } from '../types';

export interface AgentConversationHistoryItem {
  role: 'user' | 'assistant';
  content: string;
}


/**
 * Returns true only when an assistant message can be tied to one completed,
 * structurally validated model request. This is intentionally stricter than
 * checking `kind === 'assistant'`: imported, legacy, or manually injected UI
 * text must never be allowed to masquerade as an AI reply.
 */
export function hasVerifiedAgentEvidence(evidence: AgentRunEvidence | undefined): evidence is AgentRunEvidence {
  if (!evidence || evidence.schemaValid !== true) return false;
  if (!evidence.requestId.trim() || !evidence.modelId.trim() || !evidence.provider.trim()) return false;
  if (!Number.isFinite(evidence.latencyMs) || evidence.latencyMs < 0 || evidence.latencyMs > 24 * 60 * 60 * 1_000) return false;
  const acknowledgement = evidence.acknowledgement;
  if (!acknowledgement || !acknowledgement.objective.trim()) return false;
  if (!acknowledgement.understoodTask && acknowledgement.missingInformation.filter(Boolean).length === 0) return false;
  return true;
}

export function isVerifiedAssistantMessage(message: AgentMessage): boolean {
  return message.kind === 'assistant' && Boolean(message.text.trim()) && hasVerifiedAgentEvidence(message.evidence);
}

export function isVisibleDialogueMessage(message: AgentMessage): boolean {
  return message.kind === 'user' ? Boolean(message.text.trim()) : isVerifiedAssistantMessage(message);
}

/**
 * Builds the bounded history sent to one direct Agent chat or production meeting.
 * Assistant entries without verifiable model evidence are never sent back as AI dialogue.
 */
export function buildAgentConversationHistory(
  messages: AgentMessage[],
  target: ConversationTarget,
  currentMessageId?: string,
  maximumItems = 32,
): AgentConversationHistoryItem[] {
  const limit = Math.max(1, Math.min(48, Math.trunc(maximumItems) || 32));
  return messages
    .filter((entry) => {
      if (entry.id === currentMessageId || entry.conversationTarget !== target) return false;
      if (entry.kind === 'user') return Boolean(entry.text.trim());
      return isVerifiedAssistantMessage(entry);
    })
    .slice(-limit)
    .map((entry) => ({
      role: entry.kind === 'user' ? 'user' as const : 'assistant' as const,
      content: `${entry.kind === 'user' ? '使用者' : entry.sender}：${entry.text.trim()}`.slice(0, 12_000),
    }));
}
