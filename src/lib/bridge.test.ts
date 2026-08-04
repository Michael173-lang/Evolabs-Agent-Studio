import { describe, expect, it } from 'vitest';
import { createFastPlan } from './planner';
import {
  controlRenderJob,
  getRenderJob,
  isDemoBridge,
  normalizeHardwareProfile,
  normalizeModelInstallSnapshot,
  normalizeRenderJobSnapshot,
  revealRenderOutput,
  startRenderJob,
} from './bridge';
import { createBlankProject } from '../state/defaultProject';

function projectWithScenes() {
  const project = createBlankProject();
  project.story = '一名轉學生在鐘樓裡發現能讓時間倒流的機關。';
  const plan = createFastPlan(project);
  project.characters = plan.characters;
  project.scenes = plan.scenes;
  return project;
}

describe('browser render bridge', () => {
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
      modelPacks: [{ id: 'anime-core', name: '動漫核心', status: 'ready', version: '1.0' }],
    });
    expect(ai.capabilities).toMatchObject({ animeImage: true, characterConsistency: true, imageToVideo: false });
    expect(ai.modelPacks?.[0]).toMatchObject({ id: 'anime-core', status: 'ready' });
  });

  it('normalizes model install progress and structured errors', () => {
    expect(normalizeModelInstallSnapshot({
      installId: 'install_1',
      packId: 'anime-core',
      packName: '動漫核心',
      state: 'running',
      progress: 132,
      downloadedBytes: 1024,
      totalBytes: 2048,
      fileName: 'model.safetensors',
    })).toMatchObject({ installId: 'install_1', packId: 'anime-core', packName: '動漫核心', state: 'running', progress: 100, downloadedBytes: 1024 });
    expect(normalizeModelInstallSnapshot({
      installId: 'install_2', state: 'failed', error: { message: '雜湊驗證失敗' },
    }).error).toBe('雜湊驗證失敗');
  });

  it('normalizes functional-core status files at the bridge boundary', () => {
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
      { sceneId: 'scene_a', state: 'done', progress: 100, previewPath: 'C:\\Evolabs\\preview.png', visualSource: 'card', voiceProfile: '少女・清冷' },
      { sceneId: 'scene_b', state: 'working', progress: 48, previewPath: undefined, visualSource: undefined, voiceProfile: undefined },
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

  it('keeps demo simulation behind the render-job contract and preserves scene ids', async () => {
    expect(isDemoBridge()).toBe(true);
    const project = projectWithScenes();
    const created = await startRenderJob(project, true);
    const snapshot = await getRenderJob(created.jobId);

    expect(snapshot.jobId).toBe(created.jobId);
    expect(snapshot.projectId).toBe(project.id);
    expect(snapshot.scope).toBe('sample');
    expect(snapshot.state).toBe('running');
    expect(snapshot.scenes.map((scene) => scene.sceneId)).toEqual(project.scenes.slice(0, 3).map((scene) => scene.id));
    expect(snapshot.activeSceneId).toBe(project.scenes[0].id);
  });

  it('supports pause, resume, and cancel through bridge controls', async () => {
    const project = projectWithScenes();
    const { jobId } = await startRenderJob(project, false);
    await getRenderJob(jobId);

    expect(await controlRenderJob(jobId, 'pause')).toEqual({ ok: true });
    expect((await getRenderJob(jobId)).state).toBe('paused');
    expect(await controlRenderJob(jobId, 'resume')).toEqual({ ok: true });
    expect((await getRenderJob(jobId)).state).toBe('running');
    expect(await controlRenderJob(jobId, 'cancel')).toEqual({ ok: true });
    expect((await getRenderJob(jobId)).state).toBe('canceled');
    expect(await revealRenderOutput(jobId)).toEqual({ ok: false });
  });

  it('reports completion and labels the browser output as non-materialized demo data', async () => {
    const project = projectWithScenes();
    const { jobId } = await startRenderJob(project, false);
    let snapshot = await getRenderJob(jobId);
    for (let index = 0; index < 20 && snapshot.state !== 'completed'; index += 1) {
      snapshot = await getRenderJob(jobId);
    }

    expect(snapshot.state).toBe('completed');
    expect(snapshot.stage).toBe('complete');
    expect(snapshot.scenes.every((scene) => scene.state === 'done' && scene.progress === 100)).toBe(true);
    expect(snapshot.outputPath).toContain('未產生實體 MP4');
  });

  it('rejects a render with no scenes', async () => {
    await expect(startRenderJob(createBlankProject(), false)).rejects.toThrow('至少需要一個分鏡');
  });
});
