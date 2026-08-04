import type { Character, EvolabsProject, Scene, StoryPlan } from '../types';
import { createId } from './id';

const splitSentences = (text: string) =>
  text
    .split(/(?<=[。！？!?\n])/u)
    .map((part) => part.trim())
    .filter(Boolean);

const normalizeName = (value: string) => value
  .replace(/[「」『』“”"'（）()\[\]]/gu, '')
  .replace(/^(?:而|但|接著|然後|這時|突然|一名|一位|那名|那位)/u, '')
  .trim();

const invalidNames = new Set([
  '旁白', '畫外音', '內心', '故事', '主角', '角色', '鏡頭', '他', '她', '它', '我', '你', '我們', '他們', '她們',
  '時間', '事情', '答案', '世界', '城市', '校園', '如果', '因為', '但是', '然後', '突然',
]);

function plausibleName(value: string): string | null {
  const clean = normalizeName(value);
  if (!clean || clean.length > 12 || invalidNames.has(clean) || /[，。！？!?：:\s]/u.test(clean)) return null;
  if (!/[\p{Script=Han}A-Za-z]/u.test(clean)) return null;
  return clean;
}

interface DialogueBeat {
  speaker: string;
  text: string;
  source: string;
}

function extractDialogue(story: string): DialogueBeat[] {
  const beats: DialogueBeat[] = [];
  for (const source of splitSentences(story)) {
    const match = source.match(/(?:^|[「『“"\s])([\p{Script=Han}A-Za-z][\p{Script=Han}A-Za-z0-9·]{0,11})\s*[：:]\s*([^\n]+)/u);
    if (!match) continue;
    const speaker = plausibleName(match[1]);
    const text = match[2].replace(/[」』”"]+$/u, '').trim();
    if (speaker && text) beats.push({ speaker, text, source });
  }
  return beats;
}

function extractNarrativeNames(story: string): string[] {
  const candidates: string[] = [];
  const patterns = [
    /(?:名叫|叫做|叫|人物是|主角是)\s*([\p{Script=Han}A-Za-z][\p{Script=Han}A-Za-z0-9·]{0,11})/gu,
    /([\p{Script=Han}]{2,4})\s*(?:和|與|跟)\s*([\p{Script=Han}]{2,4})/gu,
    /([A-Z][A-Za-z]{1,11})\s*(?:and|with|&|和|與)\s*([A-Z][A-Za-z]{1,11})/gu,
  ];
  for (const pattern of patterns) {
    for (const match of story.matchAll(pattern)) {
      for (const raw of match.slice(1)) {
        const name = plausibleName(raw);
        if (name) candidates.push(name);
      }
    }
  }
  return candidates;
}

function characterAppearance(name: string, role: string, anime: boolean): string {
  const medium = anime ? '日系精緻動畫造型' : '自然寫實人物造型';
  return `${name}，${role}；外觀請依故事內容建立，服裝與辨識特徵在所有鏡頭保持一致，${medium}`;
}

function buildCharacters(project: EvolabsProject, dialogue: DialogueBeat[]): Character[] {
  const orderedNames = [...dialogue.map((beat) => beat.speaker), ...extractNarrativeNames(project.story)]
    .filter((name, index, all) => all.indexOf(name) === index)
    .slice(0, 8);
  if (!orderedNames.length) orderedNames.push('主角');

  return orderedNames.map((name, index) => {
    const role = index === 0 ? '主角' : index === 1 ? '關鍵角色' : '配角';
    return {
      id: createId('character'),
      name,
      role,
      appearance: characterAppearance(name, role, project.settings.mode === 'anime'),
      voice: index % 2 === 0 ? '青年・自然' : '中性・自然',
      locked: false,
      accent: ['#c7cad1', '#9298a6', '#7f8796', '#aab4d6'][index % 4],
      consistencyStrength: .85,
    };
  });
}

function sceneTitle(fragment: string, index: number, total: number): string {
  const clean = fragment.replace(/[「」『』“”"'\n\r]/gu, '').split(/[，。！？!?：:；;]/u)[0]?.trim();
  if (clean && clean.length <= 14) return clean;
  if (index === 0) return '故事開始';
  if (index === total - 1) return '最後選擇';
  return `情節 ${index + 1}`;
}

export function planningFingerprint(project: EvolabsProject): string {
  const source = JSON.stringify({
    story: project.story.trim(),
    mode: project.settings.mode,
    targetSeconds: project.settings.targetSeconds,
  });
  let hash = 0x811c9dc5;
  for (let index = 0; index < source.length; index += 1) {
    hash ^= source.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return `plan1_${(hash >>> 0).toString(16).padStart(8, '0')}`;
}

function chooseTitle(story: string): string {
  const clean = story.replace(/[\n\r]+/g, ' ').trim();
  if (!clean) return '未命名短劇';
  const first = clean.split(/[，。！？!?]/u)[0]?.trim() || clean;
  return first.length > 16 ? `${first.slice(0, 16)}…` : first;
}

export function createFastPlan(project: EvolabsProject): StoryPlan {
  const pieces = splitSentences(project.story);
  const sceneCount = Math.max(4, Math.min(10, Math.round(project.settings.targetSeconds / 7)));
  const duration = Math.max(3, Math.round(project.settings.targetSeconds / sceneCount));
  const dialogue = extractDialogue(project.story);
  const characters = buildCharacters(project, dialogue);
  const characterByName = new Map(characters.map((character) => [character.name, character]));

  const scenes: Scene[] = Array.from({ length: sceneCount }, (_, index) => {
    const fragment = pieces[index % Math.max(1, pieces.length)] || project.story || '主角踏入故事發生的場景。';
    const sourceDialogue = dialogue.find((beat) => beat.source === fragment) ?? dialogue[index % Math.max(1, dialogue.length)];
    const mentioned = characters.filter((character) => fragment.includes(character.name));
    const speakerCharacter = sourceDialogue ? characterByName.get(sourceDialogue.speaker) : undefined;
    const activeCharacters = [...mentioned, ...(speakerCharacter ? [speakerCharacter] : [])]
      .filter((character, position, all) => all.findIndex((candidate) => candidate.id === character.id) === position);
    if (!activeCharacters.length && characters[0]) activeCharacters.push(characters[0]);
    return {
      id: createId('scene'),
      order: index + 1,
      title: sceneTitle(fragment, index, sceneCount),
      visual: `${fragment}；以可拍攝的單一時刻呈現，構圖清楚、光線自然，角色外觀保持一致`,
      dialogue: sourceDialogue ? `${sourceDialogue.speaker}：${sourceDialogue.text}` : `旁白：${fragment}`,
      characterIds: activeCharacters.map((character) => character.id),
      duration,
      shot: index % 3 === 0 ? '中景・緩慢推進' : index % 3 === 1 ? '近景・固定鏡頭' : '廣角・平移',
      status: 'ready',
      progress: 0,
    };
  });

  return {
    title: chooseTitle(project.story),
    characters,
    scenes,
    source: 'fast-planner',
  };
}

export function totalDuration(scenes: Scene[]): number {
  return scenes.reduce((sum, scene) => sum + scene.duration, 0);
}

export function estimateRange(project: EvolabsProject, vramMb: number): [number, number] {
  const duration = Math.max(10, totalDuration(project.scenes));
  const qualityFactor = project.settings.quality === 'speed' ? 0.65 : project.settings.quality === 'cinema' ? 2.2 : 1;
  if (project.settings.visualMode === 'ai-images') {
    const lowVramFactor = vramMb < 6144 ? 1.75 : vramMb < 8192 ? 1.25 : 1;
    const imageMinutes = Math.max(1, project.scenes.length) * 1.15 * qualityFactor * lowVramFactor;
    const lower = Math.max(3, Math.round(imageMinutes));
    return [lower, Math.max(lower + 3, Math.round(lower * 2.1))];
  }
  // The storyboard-card path is CPU/FFmpeg bound, so VRAM does not inflate it.
  const sceneOverhead = project.scenes.length * 0.12;
  const lower = Math.max(1, Math.round(((duration / 60) * 2 + sceneOverhead) * qualityFactor));
  return [lower, Math.max(lower + 1, Math.round(lower * 1.8))];
}
