import { describe, expect, it } from 'vitest';
import { buildAgentConversationHistory, hasVerifiedAgentEvidence, isVerifiedAssistantMessage, isVisibleDialogueMessage } from './agentConversation';
import type { AgentMessage, AgentRunEvidence } from '../types';

const evidence: AgentRunEvidence = {
  requestId: 'chat_real_1',
  modelId: 'evolabs-agent',
  provider: 'lm-studio',
  latencyMs: 1200,
  schemaValid: true,
  acknowledgement: {
    understoodTask: true,
    objective: '回覆使用者',
    inputsReceived: ['專案內容'],
    constraints: ['不得猜測'],
    missingInformation: [],
  },
};

function message(overrides: Partial<AgentMessage>): AgentMessage {
  return {
    id: 'message_1',
    sender: '你',
    text: '內容',
    createdAt: '2026-08-05T00:00:00.000Z',
    kind: 'user',
    ...overrides,
  };
}

describe('Agent conversation history', () => {
  it('keeps only the selected conversation and labels every speaker', () => {
    const history = buildAgentConversationHistory([
      message({ id: 'writer_user', agentId: 'screenwriter', conversationTarget: 'screenwriter', text: '主角要幾歲？' }),
      message({
        id: 'writer_ai',
        agentId: 'screenwriter',
        conversationTarget: 'screenwriter',
        sender: '編劇師',
        kind: 'assistant',
        text: '劇本尚未提供年齡。',
        evidence,
      }),
      message({ id: 'director_user', agentId: 'director', conversationTarget: 'director', text: '節奏加快。' }),
    ], 'screenwriter');

    expect(history).toEqual([
      { role: 'user', content: '使用者：主角要幾歲？' },
      { role: 'assistant', content: '編劇師：劇本尚未提供年齡。' },
    ]);
  });

  it('drops unverifiable assistant text and supports a real production meeting', () => {
    const history = buildAgentConversationHistory([
      message({ id: 'meeting_user', conversationTarget: 'production-meeting', text: '一起調整第三幕。' }),
      message({
        id: 'fake_ai',
        agentId: 'director',
        conversationTarget: 'production-meeting',
        sender: 'Evo 導演',
        kind: 'assistant',
        text: '這是沒有模型證據的預寫文字。',
      }),
      message({
        id: 'real_ai',
        agentId: 'director',
        conversationTarget: 'production-meeting',
        sender: 'Evo 導演',
        kind: 'assistant',
        text: '我建議先縮短第三幕的建立鏡頭。',
        evidence,
      }),
    ], 'production-meeting');

    expect(history).toHaveLength(2);
    expect(history[1].content).toContain('Evo 導演');
    expect(history.some((entry) => entry.content.includes('預寫文字'))).toBe(false);
  });

  it('requires complete request evidence before assistant text can enter dialogue', () => {
    const real = message({
      id: 'real',
      kind: 'assistant',
      sender: '編劇師',
      text: '這是模型真正回傳的答案。',
      evidence,
    });
    expect(hasVerifiedAgentEvidence(evidence)).toBe(true);
    expect(isVerifiedAssistantMessage(real)).toBe(true);
    expect(isVisibleDialogueMessage(real)).toBe(true);

    const missingProvider = { ...evidence, provider: '' };
    const missingAcknowledgement = { ...evidence, acknowledgement: undefined };
    const invalidLatency = { ...evidence, latencyMs: -1 };
    const unsupportedClaim = {
      ...evidence,
      acknowledgement: {
        ...evidence.acknowledgement!,
        understoodTask: false,
        missingInformation: [],
      },
    };

    for (const invalidEvidence of [missingProvider, missingAcknowledgement, invalidLatency, unsupportedClaim]) {
      const fake = message({ id: `fake_${Math.random()}`, kind: 'assistant', text: '不可顯示', evidence: invalidEvidence as AgentRunEvidence });
      expect(isVerifiedAssistantMessage(fake)).toBe(false);
      expect(isVisibleDialogueMessage(fake)).toBe(false);
    }
  });

});
