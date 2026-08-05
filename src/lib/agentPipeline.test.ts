import { describe, expect, it } from 'vitest';
import { agentRoster, applyArtifactToWorkspace, createAgentWorkspace, nodesForProduction, setAgentPhase } from './agentPipeline';
import { createBlankProject } from '../state/defaultProject';
import type { ProductionBible } from '../types';

const bible: ProductionBible = {
  script: {
    title: '鐘樓倒數',
    logline: '一名學生發現校園鐘樓正在倒轉時間。',
    genre: '校園科幻',
    tone: '緊張',
    theme: '選擇的代價',
    targetAudience: '青少年',
    summary: '學生必須在倒數結束前阻止時間重置。',
    beats: [],
    characterSeeds: [],
    locationSeeds: [],
  },
};

describe('auditable agent workspace', () => {
  it('starts without fabricated agent dialogue', () => {
    const project = createBlankProject();
    const workspace = createAgentWorkspace(project);
    expect(agentRoster).toHaveLength(8);
    expect(workspace.messages).toEqual([]);
    expect(workspace.activities).toEqual([]);
    expect(workspace.tasks.every((task) => task.state === 'queued')).toBe(true);
  });

  it('records real task state separately from dialogue', () => {
    const project = createBlankProject();
    const workspace = setAgentPhase(createAgentWorkspace(project), 'screenwriter', 'working', 15, '等待模型回覆');
    expect(workspace.messages).toHaveLength(0);
    expect(workspace.tasks.find((task) => task.agentId === 'screenwriter')?.state).toBe('working');
  });

  it('creates canvas nodes only from verified project artifacts', () => {
    const project = createBlankProject();
    project.story = '測試劇本';
    project.productionBible = bible;
    const nodes = nodesForProduction(project, bible);
    expect(nodes.some((item) => item.kind === 'script-analysis')).toBe(true);
    expect(nodes.some((item) => item.kind === 'director-review')).toBe(false);
  });

  it('does not invent an assistant message when a handoff is applied', () => {
    const project = createBlankProject();
    project.productionBible = bible;
    const workspace = applyArtifactToWorkspace(createAgentWorkspace(project), project, 'screenwriter', bible);
    expect(workspace.messages).toHaveLength(0);
    expect(workspace.agents.find((agent) => agent.id === 'screenwriter')?.status).toBe('done');
  });
});
