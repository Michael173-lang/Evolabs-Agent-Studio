import { describe, expect, it } from 'vitest';
import {
  agentRoster,
  applyArtifactToWorkspace,
  createAgentWorkspace,
  createFallbackProduction,
  nodesForProduction,
  normalizeCharacters,
  normalizeDirectorReview,
  normalizeStoryboard,
} from './agentPipeline';
import { createBlankProject } from '../state/defaultProject';

describe('multi-agent production pipeline', () => {
  it('creates a complete seven-specialist production bible from one script', () => {
    const project = createBlankProject();
    project.story = '阿澤：別開那扇門。小雨抬頭看見鐘樓指針倒轉，雨水突然停在半空。';
    const fallback = createFallbackProduction(project);

    expect(agentRoster).toHaveLength(8); // Evo Director plus seven specialist agents.
    expect(fallback.bible.script.beats.length).toBeGreaterThanOrEqual(4);
    expect(fallback.characters.length).toBeGreaterThanOrEqual(2);
    expect(fallback.bible.locations.length).toBeGreaterThanOrEqual(1);
    expect(fallback.scenes.length).toBeGreaterThanOrEqual(4);
    expect(fallback.bible.sound.cues).toHaveLength(fallback.scenes.length);
    expect(fallback.bible.directorReview.approved).toBe(true);
    expect(fallback.scenes.every((scene) => Boolean(scene.startFramePrompt && scene.endFramePrompt))).toBe(true);
  });

  it('normalizes unsafe or incomplete specialist output without inventing unknown cast ids', () => {
    const project = createBlankProject();
    project.story = '阿澤：我回來了。小雨：你不該回來。';
    const fallback = createFallbackProduction(project);
    const characters = normalizeCharacters({
      characters: [
        { name: '阿澤', role: '主角', identityAnchor: '短黑髮、左眉小疤', voice: '青年・自然' },
        { name: '小雨', role: '對手', identityAnchor: '長髮、銀色髮夾', voice: '少女・清冷' },
      ],
    }, project, fallback.bible.script);
    const scenes = normalizeStoryboard({
      shots: [{
        title: '門口重逢',
        visual: '阿澤站在門外，小雨隔著玻璃看向他',
        characterNames: ['阿澤', '不存在的人'],
        locationName: fallback.bible.locations[0].name,
        duration: 7,
        shot: '中景・緩慢推進',
      }],
    }, project, fallback.bible.script, fallback.bible.artDirection, characters, fallback.bible.locations);

    const knownIds = new Set(characters.map((character) => character.id));
    expect(scenes.every((scene) => scene.characterIds.every((id) => knownIds.has(id)))).toBe(true);
    expect(scenes.every((scene) => scene.duration >= 2 && scene.duration <= 20)).toBe(true);
  });

  it('builds an OiiOii-style linked canvas of shared assets and shots', () => {
    const project = createBlankProject();
    project.story = '一名學生在雨夜鐘樓前發現時間倒流。';
    const fallback = createFallbackProduction(project);
    project.title = fallback.title;
    project.characters = fallback.characters;
    project.scenes = fallback.scenes;
    project.productionBible = fallback.bible;

    const nodes = nodesForProduction(project, fallback.bible);
    const kinds = new Set(nodes.map((node) => node.kind));
    expect(kinds.has('script-analysis')).toBe(true);
    expect(kinds.has('art-direction')).toBe(true);
    expect(kinds.has('ip-bible')).toBe(true);
    expect(kinds.has('character')).toBe(true);
    expect(kinds.has('location')).toBe(true);
    expect(kinds.has('shot')).toBe(true);
    expect(kinds.has('sound')).toBe(true);
    expect(kinds.has('director-review')).toBe(true);
    expect(kinds.has('render')).toBe(true);
  });

  it('records each specialist handoff progressively instead of waiting for one giant plan', () => {
    const project = createBlankProject();
    project.story = '一名學生在鐘樓前按下倒轉時間的按鈕。';
    const fallback = createFallbackProduction(project);
    const workspace = createAgentWorkspace(project);
    project.productionBible = { script: fallback.bible.script };

    const next = applyArtifactToWorkspace(
      workspace,
      project,
      'screenwriter',
      project.productionBible,
      '劇本拆解已完成。',
    );
    expect(next.agents.find((agent) => agent.id === 'screenwriter')?.status).toBe('done');
    expect(next.nodes.some((node) => node.kind === 'script-analysis')).toBe(true);
    expect(next.messages.at(-1)?.sender).toBe('編劇師');
  });

  it('keeps director review issue references bounded to real shots', () => {
    const project = createBlankProject();
    project.story = '測試故事';
    const fallback = createFallbackProduction(project);
    const review = normalizeDirectorReview({
      approved: false,
      score: 60,
      issues: [
        { severity: 'critical', sceneId: fallback.scenes[0].id, message: '光線方向不一致', fix: '統一為左側主光' },
        { severity: 'critical', sceneId: '../../bad', message: '無效鏡頭', fix: '不應套用' },
      ],
    }, fallback.scenes);
    expect(review.issues[0].sceneId).toBe(fallback.scenes[0].id);
    expect(review.issues[1].sceneId).toBeUndefined();
  });
});
