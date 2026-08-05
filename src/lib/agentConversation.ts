import type { AgentMessage, AgentRunEvidence, ConversationTarget } from '../types';

export interface AgentConversationHistoryItem {
  role: 'user' | 'assistant';
  content: string;
}

const maximumHistoryItemCharacters = 4_000;
const maximumHistoryCharacters = 24_000;

/**
 * Returns true only when an assistant message can be tied to one completed,
 * structurally validated model request. Imported, legacy, or manually injected
 * UI text must never be allowed to masquerade as an AI reply.
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

function boundedHistory(items: AgentConversationHistoryItem[], maximumItems: number): AgentConversationHistoryItem[] {
  const selected: AgentConversationHistoryItem[] = [];
  let usedCharacters = 0;
  for (let index = items.length - 1; index >= 0 && selected.length < maximumItems; index -= 1) {
    const item = items[index];
    const content = item.content.slice(0, maximumHistoryItemCharacters);
    const remaining = maximumHistoryCharacters - usedCharacters;
    if (remaining <= 0) break;
    const bounded = content.length > remaining ? content.slice(0, remaining) : content;
    selected.push({ ...item, content: bounded });
    usedCharacters += bounded.length;
  }
  return selected.reverse();
}

/**
 * Builds the bounded history sent to one direct Agent chat or production meeting.
 * Assistant entries without verifiable model evidence are never sent back as AI dialogue.
 * The total history is deliberately bounded so small local models do not fail with HTTP 400
 * simply because a long meeting transcript exhausted their context window.
 */
export function buildAgentConversationHistory(
  messages: AgentMessage[],
  target: ConversationTarget,
  currentMessageId?: string,
  maximumItems = 16,
): AgentConversationHistoryItem[] {
  const limit = Math.max(1, Math.min(24, Math.trunc(maximumItems) || 16));
  const candidates = messages
    .filter((entry) => {
      if (entry.id === currentMessageId || entry.conversationTarget !== target) return false;
      if (entry.kind === 'user') return Boolean(entry.text.trim());
      return isVerifiedAssistantMessage(entry);
    })
    .map((entry) => ({
      role: entry.kind === 'user' ? 'user' as const : 'assistant' as const,
      content: `${entry.kind === 'user' ? '使用者' : entry.sender}：${entry.text.trim()}`,
    }));
  return boundedHistory(candidates, limit);
}
