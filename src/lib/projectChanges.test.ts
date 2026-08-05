import { describe, expect, it } from 'vitest';
import { applyAgentProposal, validateAgentProposal } from './projectChanges';
import { createBlankProject } from '../state/defaultProject';
import type { AgentChangeProposal, Character, Scene, ScriptAnalysisArtifact, SoundPlanArtifact } from '../types';

function proposal(operations: AgentChangeProposal['operations']): AgentChangeProposal {
  return {
    id: 'proposal_1',
    agentId: 'character-designer',
    title: '更新角色設定',
    summary: '依使用者要求更新並鎖定角色資料。',
    operations,
    status: 'pending',
    createdAt: '2026-08-05T00:00:00.000Z',
  };
}

function preparedProject() {
  const project = createBlankProject();
  const character: Character = {
    id: 'hero',
    name: '小安',
    role: '主角',
    age: '17 歲',
    appearance: '短黑髮、棕色眼睛',
    voice: '青年・自然',
    locked: true,
    accent: '#aaa',
    consistencyStrength: .95,
    identityAnchor: '短黑髮、棕色眼睛、左眉小痣',
    appearancePrompt: '17-year-old student',
    negativePrompt: 'age drift',
    wardrobe: '完整白襯衫、深藍制服外套與長褲',
    expressionGuide: '緊張時抿嘴',
    voiceDirection: '自然、略急促',
    referenceImagePath: 'C:/references/hero.png',
    referenceImageName: 'hero.png',
  };
  const scene: Scene = {
    id: 'shot_1',
    order: 1,
    title: '鐘樓前',
    visual: '小安抬頭看鐘面',
    dialogue: '時間又倒退了。',
    characterIds: ['hero'],
    duration: 5,
    shot: '中景',
    status: 'done',
    progress: 100,
    previewPath: 'C:/old/shot.mp4',
    visualSource: 'video',
    reviewState: 'approved',
    qualityChecks: [{ id: 'human-review', label: '人工驗收', state: 'passed', detail: '已核准' }],
    videoPrompt: 'old locked prompt',
  };
  const script: ScriptAnalysisArtifact = {
    title: '倒轉鐘聲',
    logline: '小安發現時間倒流。',
    genre: '科幻',
    tone: '緊張',
    theme: '選擇',
    targetAudience: '青少年',
    summary: '小安試圖阻止記憶消失。',
    beats: [{ id: 'beat_1', title: '發現', summary: '發現鐘樓異常', tension: 60, characterNames: ['小安'] }],
    characterSeeds: [{
      name: '小安',
      role: '主角',
      goal: '阻止記憶消失',
      conflict: '倒轉時間會失去回憶',
      traits: ['敏銳'],
      age: '17 歲',
      wardrobe: '完整白襯衫、深藍制服外套與長褲',
    }],
    locationSeeds: [{ name: '鐘樓', purpose: '高潮' }],
  };
  const sound: SoundPlanArtifact = {
    musicDirection: '懸疑電子樂',
    mixDirection: '對白清楚',
    cues: [{ sceneId: 'shot_1', musicCue: '脈衝', ambience: '風聲', soundEffects: ['鐘聲'], dialoguePacing: '急促' }],
  };
  project.characters = [character];
  project.scenes = [scene];
  project.productionBible = { script, sound, directorReview: { approved: true, score: 95, summary: '核准', issues: [], finalInstructions: ['生成'] } };
  if (project.agentWorkspace) project.agentWorkspace.artifacts = project.productionBible;
  return project;
}

describe('AI change proposals', () => {
  it('rejects unsafe or ambiguous operations before touching the project', () => {
    expect(() => validateAgentProposal(proposal([{
      type: 'set-character-field',
      characterName: '小安',
      field: 'age',
      value: '未知年齡',
    }]))).toThrow(/數字年齡/);

    expect(() => validateAgentProposal(proposal([{
      type: 'set-character-field',
      characterName: '小安',
      field: 'wardrobe',
      value: '未穿衣服',
    }]))).toThrow(/不安全/);

    expect(() => validateAgentProposal(proposal([{
      type: 'set-scene-field',
      sceneId: 'shot_1',
      sceneTitle: '鐘樓前',
      field: 'action',
      value: '小安轉身奔跑',
    }]))).toThrow(/只能使用/);
  });

  it('synchronizes character locks and invalidates rendered shots after applying a proposal', () => {
    const project = preparedProject();
    const updated = applyAgentProposal(project, proposal([{
      type: 'set-character-field',
      characterName: '小安',
      field: 'wardrobe',
      value: '完整灰色連帽外套、黑色長褲與運動鞋',
    }]));
    expect(updated.characters[0].wardrobe).toContain('灰色連帽外套');
    expect(updated.productionBible?.script?.characterSeeds[0].wardrobe).toContain('灰色連帽外套');
    expect(updated.scenes[0].previewPath).toBe(undefined);
    expect(updated.scenes[0].reviewState).toBe('pending');
    expect(updated.scenes[0].videoPrompt).toBe(undefined);
    expect(updated.characters[0].referenceImagePath).toBe(undefined);
    expect(updated.characters[0].referenceImageName).toBe(undefined);
    expect(updated.productionBible?.sound).toBe(undefined);
    expect(updated.agentWorkspace?.artifacts?.script?.characterSeeds[0].wardrobe).toContain('灰色連帽外套');
    expect(updated.productionBible?.directorReview).toBe(undefined);
  });

  it('invalidates sound and previous video approval when a shot changes', () => {
    const updated = applyAgentProposal(preparedProject(), proposal([{
      type: 'set-scene-field',
      sceneId: 'shot_1',
      field: 'dialogue',
      value: '小安：我不能再敲這座鐘。',
    }]));
    expect(updated.scenes[0].dialogue).toContain('不能再敲');
    expect(updated.scenes[0].status).toBe('ready');
    expect(updated.scenes[0].previewPath).toBe(undefined);
    expect(updated.scenes[0].videoPrompt).toBe(undefined);
    expect(updated.productionBible?.sound).toBe(undefined);
    expect(updated.agentWorkspace?.artifacts?.sound).toBe(undefined);
  });

  it('preserves the identity reference when only a non-visual character field changes', () => {
    const updated = applyAgentProposal(preparedProject(), proposal([{
      type: 'set-character-field',
      characterName: '小安',
      field: 'voiceDirection',
      value: '語速稍慢，情緒保持克制',
    }]));
    expect(updated.characters[0].referenceImagePath).toBe('C:/references/hero.png');
    expect(updated.characters[0].referenceImageName).toBe('hero.png');
    expect(updated.productionBible?.sound).toBe(undefined);
    expect(updated.scenes[0].videoPrompt).toBe(undefined);
  });

});
