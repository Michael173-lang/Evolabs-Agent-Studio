import { describe, expect, it } from 'vitest';
import { createBlankProject } from '../state/defaultProject';
import type { Character, Scene, VideoProviderStatus } from '../types';
import { getVideoPreflightIssue } from './videoPreflight';

function provider(inputImageBinding: boolean): VideoProviderStatus {
  return {
    configured: true,
    available: true,
    workflowValid: true,
    nodeCount: 2,
    capabilities: {
      textToVideo: !inputImageBinding,
      imageToVideo: inputImageBinding,
      outputVideo: true,
      promptBinding: true,
      negativePromptBinding: true,
      seedBinding: true,
      dimensionsBinding: true,
      frameBinding: true,
      fpsBinding: true,
      inputImageBinding,
      outputPrefixBinding: true,
    },
    detectedModels: [],
    compatibility: 'experimental',
    message: '已連線',
  };
}

const character: Character = {
  id: 'hero',
  name: '小安',
  role: '主角',
  age: '17 歲',
  appearance: '短黑髮',
  voice: '青年・自然',
  locked: true,
  accent: '#aaa',
  consistencyStrength: .95,
  wardrobe: '完整校服與長褲',
};

const scene: Scene = {
  id: 'shot-1',
  order: 1,
  title: '鐘樓前',
  visual: '小安抬頭',
  dialogue: '',
  characterIds: ['hero'],
  duration: 5,
  shot: '中景',
  status: 'ready',
  progress: 0,
};

describe('AI video preflight', () => {
  it('allows text-to-video without a character reference image', () => {
    const project = createBlankProject();
    project.characters = [character];
    project.scenes = [scene];
    expect(getVideoPreflightIssue(project, provider(false))).toBe(undefined);
  });

  it('requires exactly one referenced character for the current image-to-video contract', () => {
    const project = createBlankProject();
    project.characters = [character];
    project.scenes = [scene];
    expect(getVideoPreflightIssue(project, provider(true))).toContain('尚未匯入身份參考圖');

    project.characters = [{ ...character, referenceImagePath: 'C:/refs/hero.png' }];
    expect(getVideoPreflightIssue(project, provider(true))).toBe(undefined);

    project.scenes = [{ ...scene, characterIds: ['hero', 'support'] }];
    expect(getVideoPreflightIssue(project, provider(true))).toContain('只支援一名角色');
  });

  it('rejects a workflow that cannot isolate output names', () => {
    const project = createBlankProject();
    const invalid = provider(false);
    invalid.capabilities.outputPrefixBinding = false;
    expect(getVideoPreflightIssue(project, invalid)).toContain('輸出名稱綁定');
  });
});
