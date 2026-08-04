import { describe, expect, it } from 'vitest';
import { planningFingerprint } from '../lib/planner';
import { createBlankProject } from './defaultProject';
import { normalizeProject } from './projectMigration';

describe('project migration', () => {
  it('rejects unrecognized data instead of overwriting it with a blank project', () => {
    expect(normalizeProject([])).toBeNull();
    expect(normalizeProject({})).toBeNull();
    expect(normalizeProject('broken')).toBeNull();
    expect(normalizeProject({ schemaVersion: 2, id: 'future', story: 'future', settings: {} })).toBeNull();
  });

  it('migrates an older valid project and restores its workflow', () => {
    const migrated = normalizeProject({
      id: 'old_project',
      title: '舊專案',
      story: '故事',
      settings: { mode: 'anime', format: '9:16', targetSeconds: 60, quality: 'balanced', renderMode: 'comic', captions: true },
      characters: [{ id: 'c1', name: '主角' }],
      scenes: [{ id: 's1', title: '第一鏡', duration: 5 }],
    });
    expect(migrated?.schemaVersion).toBe(1);
    expect(migrated?.workflowStep).toBe(3);
    expect(migrated?.maxUnlockedStep).toBe(3);
    expect(migrated?.scenes).toHaveLength(1);
    expect(migrated?.settings.visualMode).toBe('ai-images');
    expect(migrated?.settings.autopilot).toBe(true);
    expect(migrated?.settings.keepCharacterIdentity).toBe(true);
    expect(migrated?.characters[0].consistencyStrength).toBe(.85);
  });

  it('normalizes unsupported legacy voice labels to the neutral profile', () => {
    const migrated = normalizeProject({
      id: 'voice_project',
      story: '故事',
      settings: { mode: 'anime', format: '9:16', targetSeconds: 30, quality: 'balanced', renderMode: 'comic', captions: true },
      characters: [{ id: 'c1', name: '主角', voice: 'old-custom-voice' }],
      scenes: [],
    });
    expect(migrated?.characters[0].voice).toBe('中性・自然');
  });

  it('preserves safe character references and clamps consistency strength', () => {
    const migrated = normalizeProject({
      id: 'reference_project',
      story: '故事',
      settings: { mode: 'anime', format: '9:16', targetSeconds: 30, quality: 'speed', visualMode: 'ai-images' },
      characters: [{
        id: 'c1', name: '主角', consistencyStrength: 2,
        referenceImageName: 'hero.png', referenceImageDataUrl: 'data:image/png;base64,AAAA',
      }],
      scenes: [],
    });
    expect(migrated?.settings.visualMode).toBe('ai-images');
    expect(migrated?.characters[0]).toMatchObject({
      consistencyStrength: 1,
      referenceImageName: 'hero.png',
      referenceImageDataUrl: 'data:image/png;base64,AAAA',
    });
  });

  it('invalidates the plan when story settings change', () => {
    const project = createBlankProject();
    project.story = '一個故事';
    const before = planningFingerprint(project);
    project.settings.targetSeconds = 90;
    expect(planningFingerprint(project)).not.toBe(before);
  });

  it('does not rebuild characters for output-only changes', () => {
    const project = createBlankProject();
    project.story = '一個故事';
    const before = planningFingerprint(project);
    project.settings.quality = 'cinema';
    project.settings.format = '16:9';
    expect(planningFingerprint(project)).toBe(before);
  });
  it('preserves the shared production bible used by the agent canvas and renderer', () => {
    const migrated = normalizeProject({
      id: 'agent_project',
      story: '一個劇本',
      settings: { mode: 'anime', format: '9:16', targetSeconds: 60, quality: 'balanced', renderMode: 'film' },
      characters: [{ id: 'c1', name: 'Evo', identityAnchor: '短黑髮與左眉小疤', wardrobe: '銀色外套' }],
      scenes: [{ id: 's1', title: '第一鏡', duration: 6, locationId: 'l1', startFramePrompt: '雨夜門口', endFramePrompt: '手碰到門把' }],
      productionBible: {
        artDirection: { styleName: '電影動畫', visualBible: '一致視覺', colorPalette: ['黑', '粉'], lighting: '左側主光', cameraLanguage: '穩定推進', texture: '細緻', globalPrompt: 'cinematic anime', globalNegativePrompt: 'style drift' },
        locations: [{ id: 'l1', name: '鐘樓', purpose: '高潮', environmentAnchor: '紅磚與單一拱門', timeOfDay: '午夜', weather: '雨', lighting: '暖鐘面', keyProps: ['紅色腳踏車'], prompt: 'clock tower', negativePrompt: 'modern building' }],
      },
      directorInstructions: ['整片保持低飽和'],
    });
    expect(migrated?.productionBible?.artDirection?.globalPrompt).toBe('cinematic anime');
    expect(migrated?.productionBible?.locations?.[0].id).toBe('l1');
    expect(migrated?.scenes[0].locationId).toBe('l1');
    expect(migrated?.directorInstructions).toEqual(['整片保持低飽和']);
    expect(migrated?.agentWorkspace?.nodes.some((node) => node.kind === 'location')).toBe(true);
  });

});
