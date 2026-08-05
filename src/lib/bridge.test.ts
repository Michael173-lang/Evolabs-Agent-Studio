import { describe, expect, it } from 'vitest';
import {
  controlRenderJob,
  getRenderJob,
  isDemoBridge,
  normalizeHardwareProfile,
  normalizeModelInstallSnapshot,
  normalizeRenderJobSnapshot,
  revealRenderOutput,
  reviewRenderScene,
  startRenderJob,
} from './bridge';
import { createBlankProject } from '../state/defaultProject';

describe('desktop bridge boundaries', () => {
  it('normalizes optional AI capabilities without treating a healthy core as AI-ready', () => {
    const legacy = normalizeHardwareProfile({
      gpu: 'RTX 3050', vramMb: 4096, ramGb: 12, cpu: 'CPU', profile: 'rtx3050-4gb', runtimeReady: true,
    });
    expect(legacy.capabilities).toMatchObject({ comicCore: true, animeImage: false, realisticImage: false });
    expect(legacy.aiReady).toBe(false);

    const ai = normalizeHardwareProfile({
      gpu: 'RTX 3050', vramMb: 4096, ramGb: 12, cpu: 'CPU', profile: 'rtx3050-4gb', runtimeReady: true,
      aiReady: true,
      aiProvider: 'Evolabs Local AI',
      capabilities: { comicCore: true, animeImage: true, realisticImage: false, characterConsistency: true, zhVoice: true },
      modelPacks: [{ id: 'anime-core', name: '動態漫畫圖片模型', status: 'ready', version: '1.0' }],
    });
    expect(ai.capabilities).toMatchObject({ animeImage: true, characterConsistency: true, imageToVideo: false });
    expect(ai.modelPacks?.[0]).toMatchObject({ id: 'anime-core', status: 'ready' });
  });

  it('normalizes model install progress and structured errors', () => {
    expect(normalizeModelInstallSnapshot({
      installId: 'install_1',
      packId: 'anime-core',
      packName: '動態漫畫圖片模型',
      state: 'running',
      progress: 132,
      downloadedBytes: 1024,
      totalBytes: 2048,
      fileName: 'model.safetensors',
    })).toMatchObject({ installId: 'install_1', packId: 'anime-core', state: 'running', progress: 100, downloadedBytes: 1024 });
    expect(normalizeModelInstallSnapshot({
      installId: 'install_2', state: 'failed', error: { message: '雜湊驗證失敗' },
    }).error).toBe('雜湊驗證失敗');
  });

  it('normalizes legacy engine states while clearly labeling static motion as motion comic', () => {
    const snapshot = normalizeRenderJobSnapshot({
      jobId: 'job_00000000-0000-0000-0000-000000000000',
      projectId: 'project_test',
      scope: 'sample',
      state: 'running',
      stage: 'background',
      progress: 37,
      sceneIndex: 1,
      scenes: [
        { id: 'scene_a', state: 'completed', progress: 100, previewPath: 'C:\\Evolabs\\preview.png', visualSource: 'card', voiceProfile: '少女・清冷' },
        { id: 'scene_b', state: 'running', progress: 48, voiceProfile: 'legacy-voice' },
      ],
    });

    expect(snapshot).toMatchObject({
      state: 'running',
      stage: 'visual',
      overallProgress: 37,
      sceneProgress: 48,
      activeSceneId: 'scene_b',
    });
    expect(snapshot.scenes).toEqual([
      { sceneId: 'scene_a', state: 'done', progress: 100, previewPath: 'C:\\Evolabs\\preview.png', visualSource: 'motion-comic', voiceProfile: '少女・清冷', generationAttempt: undefined, reviewState: undefined, reviewFeedback: undefined, qualityChecks: undefined, providerId: undefined, modelName: undefined },
      { sceneId: 'scene_b', state: 'working', progress: 48, previewPath: undefined, visualSource: undefined, voiceProfile: undefined, generationAttempt: undefined, reviewState: undefined, reviewFeedback: undefined, qualityChecks: undefined, providerId: undefined, modelName: undefined },
    ]);
  });

  it('normalizes legacy terminal-state spellings without inventing a failure', () => {
    const completed = normalizeRenderJobSnapshot({
      jobId: 'job_00000000-0000-0000-0000-000000000010',
      projectId: 'project_test',
      scope: 'scene',
      state: 'succeeded',
      stage: 'completed',
      scenes: [],
      progress: 100,
    });
    const canceled = normalizeRenderJobSnapshot({
      jobId: 'job_00000000-0000-0000-0000-000000000011',
      projectId: 'project_test',
      state: 'cancelled',
      stage: 'idle',
      scenes: [],
    });
    expect(completed.state).toBe('completed');
    expect(completed.scope).toBe('scene');
    expect(completed.stage).toBe('complete');
    expect(canceled.state).toBe('canceled');
  });

  it('never simulates video generation in a browser preview', async () => {
    expect(isDemoBridge()).toBe(true);
    await expect(startRenderJob(createBlankProject(), false)).rejects.toThrow('瀏覽器預覽不會模擬影片生成');
    await expect(getRenderJob('job_test')).rejects.toThrow('瀏覽器預覽沒有影片生成工作');
    await expect(reviewRenderScene('job_test', 'scene_test', true)).rejects.toThrow('瀏覽器預覽不能審核本機影片鏡頭');
    expect(await controlRenderJob('job_test', 'pause')).toEqual({ ok: false });
    expect(await revealRenderOutput('job_test')).toEqual({ ok: false });
  });
});
