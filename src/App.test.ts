import { describe, expect, it } from 'vitest';
import { aiImagesReady, mergeRenderSceneState, renderErrorGuidance, renderReadiness, runtimeCapabilities } from './App';
import { createFastPlan } from './lib/planner';
import { createBlankProject } from './state/defaultProject';

describe('render scene reconciliation', () => {
  it('maps progress by stable scene id rather than queue index', () => {
    const project = createBlankProject();
    project.story = '測試故事';
    const scenes = createFastPlan(project).scenes.slice(0, 2);
    const merged = mergeRenderSceneState(scenes, [
      { sceneId: scenes[1].id, state: 'done', progress: 100 },
      { sceneId: scenes[0].id, state: 'working', progress: 42 },
    ]);

    expect(merged[0]).toMatchObject({ id: scenes[0].id, status: 'working', progress: 42 });
    expect(merged[1]).toMatchObject({ id: scenes[1].id, status: 'done', progress: 100 });
  });

  it('preserves scenes that are outside a sample job', () => {
    const project = createBlankProject();
    project.story = '測試故事';
    const scenes = createFastPlan(project).scenes.slice(0, 2);
    const merged = mergeRenderSceneState(scenes, [
      { sceneId: scenes[0].id, state: 'working', progress: 25 },
    ]);

    expect(merged[1]).toBe(scenes[1]);
    expect(merged[1].status).toBe('ready');
  });
});

describe('AI workflow gating', () => {
  it('keeps legacy runtimes on the honest storyboard-card path', () => {
    const project = createBlankProject();
    project.settings.visualMode = 'cards';
    const hardware = {
      gpu: 'RTX 3050', vramMb: 4096, ramGb: 12, cpu: 'CPU', profile: 'rtx3050-4gb' as const, runtimeReady: true,
    };
    expect(runtimeCapabilities(hardware)).toMatchObject({ comicCore: true, animeImage: false });
    expect(renderReadiness(project, hardware)).toEqual({ ready: true });
    project.settings.visualMode = 'ai-images';
    expect(aiImagesReady(project, hardware)).toBe(false);
    expect(renderReadiness(project, hardware)).toMatchObject({ ready: false });
  });

  it('allows AI images only for the selected style capability', () => {
    const project = createBlankProject();
    project.settings.visualMode = 'ai-images';
    const hardware = {
      gpu: 'RTX', vramMb: 8192, ramGb: 16, cpu: 'CPU', profile: 'balanced' as const, runtimeReady: true,
      capabilities: {
        comicCore: true, animeImage: true, realisticImage: false, characterConsistency: true,
        animeReference: true, realisticReference: false, multiCharacterReference: false,
        zhVoice: true, lipSync: false, imageToVideo: false,
      },
    };
    expect(renderReadiness(project, hardware)).toEqual({ ready: true });
    project.settings.mode = 'realistic';
    expect(renderReadiness(project, hardware)).toMatchObject({ ready: false, reason: '寫實 AI 畫面模型尚未就緒。' });
  });

  it('turns common engine failures into actionable Chinese guidance', () => {
    expect(renderErrorGuidance('CUDA_OUT_OF_MEMORY')?.title).toBe('顯示記憶體不足');
    expect(renderErrorGuidance('AI_IMAGE_UNAVAILABLE')?.title).toBe('AI 模型尚未就緒');
    expect(renderErrorGuidance('UNKNOWN')).toBeNull();
  });

  it('enables single-person lip sync only after the real local provider is ready', () => {
    const project = createBlankProject();
    project.settings.visualMode = 'ai-images';
    project.settings.lipSync = true;
    const baseCapabilities = {
      comicCore: true, animeImage: true, realisticImage: false, characterConsistency: true,
      animeReference: true, realisticReference: false, multiCharacterReference: false,
      zhVoice: true, lipSync: false, imageToVideo: false,
    };
    const hardware = {
      gpu: 'RTX 3050', vramMb: 4096, ramGb: 16, cpu: 'CPU', profile: 'rtx3050-4gb' as const,
      runtimeReady: true, capabilities: baseCapabilities,
    };
    expect(renderReadiness(project, hardware)).toMatchObject({ ready: false, reason: '本機單人對嘴執行器尚未就緒。' });
    expect(renderReadiness(project, { ...hardware, capabilities: { ...baseCapabilities, lipSync: true } })).toEqual({ ready: true });
  });
});
