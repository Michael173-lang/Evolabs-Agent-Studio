import { describe, expect, it } from 'vitest';
import { createFastPlan, estimateRange, totalDuration } from './planner';
import { createBlankProject } from '../state/defaultProject';

describe('fast planner', () => {
  it('creates an editable plan from one sentence', () => {
    const project = createBlankProject();
    project.story = '一名轉學生發現校園鐘樓能讓時間倒流。';
    const plan = createFastPlan(project);
    expect(plan.characters.length).toBeGreaterThanOrEqual(1);
    expect(plan.scenes.length).toBeGreaterThanOrEqual(4);
    expect(totalDuration(plan.scenes)).toBeGreaterThanOrEqual(40);
    expect(plan.characters.some((character) => ['林澈', '予棠'].includes(character.name))).toBe(false);
    expect(plan.scenes[0].visual).toContain('校園鐘樓');
    expect(plan.scenes[0].dialogue).toContain('旁白：');
  });

  it('extracts explicit speakers instead of inventing a fixed cast', () => {
    const project = createBlankProject();
    project.story = '阿澤：門後有人。小雨：先別開門！兩人一起退到走廊盡頭。';
    const plan = createFastPlan(project);
    expect(plan.characters.map((character) => character.name)).toEqual(expect.arrayContaining(['阿澤', '小雨']));
    expect(plan.scenes.some((scene) => scene.dialogue.includes('阿澤：門後有人'))).toBe(true);
    expect(plan.scenes.some((scene) => scene.dialogue.includes('小雨：先別開門'))).toBe(true);
    expect(plan.characters.every((character) => character.locked === false)).toBe(true);
  });

  it('keeps the functional-core estimate short and makes cinema encoding slower', () => {
    const project = createBlankProject();
    project.story = '測試';
    project.scenes = createFastPlan(project).scenes;
    project.settings.visualMode = 'cards';
    const comic = estimateRange(project, 4096);
    expect(comic[0]).toBeLessThan(10);
    project.settings.quality = 'cinema';
    const cinema = estimateRange(project, 4096);
    expect(cinema[0]).toBeGreaterThan(comic[0]);
  });
});
