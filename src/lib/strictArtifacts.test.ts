import { describe, expect, it } from 'vitest';
import { strictCharacters, strictDirectorReview, strictLocations, strictScriptAnalysis, strictSound, strictStoryboard } from './strictArtifacts';
import { createBlankProject } from '../state/defaultProject';
import type { Character, LocationAsset } from '../types';

const characters: Character[] = [{
  id: 'hero',
  name: '小安',
  role: '主角',
  age: '17 歲',
  appearance: '短黑髮',
  voice: '青年・自然',
  locked: true,
  accent: '#aaa',
  consistencyStrength: .95,
  identityAnchor: '短黑髮、棕色眼睛、左眉小痣',
  appearancePrompt: '17-year-old student with short black hair',
  negativePrompt: 'age drift',
  wardrobe: '完整白襯衫、深藍制服外套與長褲',
  expressionGuide: '緊張時抿嘴',
  voiceDirection: '自然、略急促',
}];

const locations: LocationAsset[] = [{
  id: 'clock',
  name: '校園鐘樓',
  purpose: '故事高潮',
  environmentAnchor: '紅磚鐘樓與單一拱門',
  timeOfDay: '黃昏',
  weather: '晴朗',
  lighting: '右側暖光',
  keyProps: ['銅鐘'],
  prompt: 'red brick school clock tower',
  negativePrompt: 'modern office',
}];


function scriptArtifact() {
  return {
    title: '倒轉鐘聲',
    logline: '17 歲學生小安發現校園鐘樓能讓時間倒流。',
    genre: '校園科幻短劇',
    tone: '緊張而克制',
    theme: '記憶與選擇的代價',
    targetAudience: '青少年與科幻觀眾',
    summary: '小安必須在修正錯誤與保留重要記憶之間選擇。',
    beats: [{
      id: 'beat_1',
      title: '鐘聲異常',
      summary: '小安發現鐘聲會讓時間倒退。',
      tension: 65,
      characterNames: ['小安'],
      locationHint: '校園鐘樓',
    }],
    characterSeeds: [{
      name: '小安',
      role: '主角',
      goal: '阻止記憶繼續消失',
      conflict: '每次倒轉時間都要失去一段回憶',
      traits: ['敏銳', '克制'],
      age: '17 歲',
      wardrobe: '完整白襯衫、深藍制服外套與長褲',
    }],
    locationSeeds: [{ name: '校園鐘樓', purpose: '故事高潮', timeHint: '黃昏' }],
  };
}

function characterArtifact(overrides: Record<string, unknown> = {}) {
  return {
    characters: [{
      name: '小安',
      role: '主角',
      age: '17 歲',
      appearance: '短黑髮、棕色眼睛、左眉小痣',
      voice: '青年・自然',
      consistencyStrength: .95,
      identityAnchor: '短黑髮、棕色眼睛、左眉小痣',
      appearancePrompt: '17-year-old student with short black hair',
      negativePrompt: 'age drift, nudity, extra eyes, extra limbs',
      wardrobe: '完整白襯衫、深藍制服外套與長褲',
      expressionGuide: '緊張時抿嘴',
      voiceDirection: '自然、略急促',
      ...overrides,
    }],
  };
}

function shot() {
  return {
    title: '鐘聲響起',
    visual: '小安站在鐘樓前抬頭看鐘面',
    dialogue: '小安：時間又倒退了。',
    characterNames: ['小安'],
    locationName: '校園鐘樓',
    duration: 5,
    shot: '中景緩慢推進',
    composition: '人物位於左側三分線',
    action: '小安抬頭並後退一步',
    emotion: '驚訝而警覺',
    motionPrompt: 'continuous dolly-in with natural hair and clothing motion',
    negativePrompt: 'bad anatomy',
    transition: '動作切接',
    continuityIn: '承接上一鏡的右腳落地',
    continuityOut: '停在小安望向鐘面的視線',
  };
}

describe('strict production artifacts', () => {
  it('builds deterministic, fully clothed true-video prompts', () => {
    const project = createBlankProject();
    project.id = 'project-fixed';
    const first = strictStoryboard({ shots: [shot()] }, project, characters, locations)[0];
    const second = strictStoryboard({ shots: [shot()] }, project, characters, locations)[0];
    expect(first.seed).toBe(second.seed);
    expect(first.videoPrompt).toContain('17 歲');
    expect(first.videoPrompt).toContain('完整白襯衫');
    expect(first.videoPrompt).toContain('continuous motion');
    expect(first.negativePrompt).toContain('extra eyes');
    expect(first.negativePrompt).toContain('naked');
  });

  it('rejects an approved director review that still contains blocking issues', () => {
    expect(() => strictDirectorReview({
      approved: true,
      score: 86,
      summary: '仍有問題',
      issues: [{ severity: 'warning', message: '服裝漂移', fix: '重做角色', returnToAgent: 'character-designer' }],
      finalInstructions: ['保持角色一致'],
    }, [])).toThrow(/核准/);
  });

  it('requires rejected work to route a blocking issue to a specialist', () => {
    expect(() => strictDirectorReview({
      approved: false,
      score: 60,
      summary: '需要修正',
      issues: [{ severity: 'critical', message: '鏡頭不可生成', fix: '簡化動作' }],
      finalInstructions: ['簡化鏡頭'],
    }, [])).toThrow(/returnToAgent/);
  });

  it('requires explicit age and complete clothing in the screenplay contract', () => {
    const missingAge = scriptArtifact();
    delete (missingAge.characterSeeds[0] as { age?: string }).age;
    expect(() => strictScriptAnalysis(missingAge)).toThrow(/年齡/);

    const unsafeClothing = scriptArtifact();
    unsafeClothing.characterSeeds[0].wardrobe = '未穿衣服';
    expect(() => strictScriptAnalysis(unsafeClothing)).toThrow(/不安全/);
  });

  it('rejects character age, wardrobe, count and identity drift', () => {
    const script = strictScriptAnalysis(scriptArtifact());
    expect(() => strictCharacters(characterArtifact({ age: '70 歲' }), script, 'anime')).toThrow(/年齡.*漂移/);
    expect(() => strictCharacters(characterArtifact({ wardrobe: '紅色晚禮服' }), script, 'anime')).toThrow(/服裝.*不一致/);
    expect(() => strictCharacters({ characters: [] }, script, 'anime')).toThrow(/非空陣列|完整交付/);
    const extra = characterArtifact();
    extra.characters.push({ ...extra.characters[0], name: '陌生人' });
    expect(() => strictCharacters(extra, script, 'anime')).toThrow(/不得增減角色/);
  });


  it('requires the scene designer to preserve every screenplay location by name', () => {
    const script = strictScriptAnalysis(scriptArtifact());
    const valid = strictLocations({ locations: [{
      name: '校園鐘樓',
      purpose: '故事高潮與時間倒流的核心空間',
      environmentAnchor: '紅磚鐘樓、單一拱門與懸掛銅鐘',
      timeOfDay: '黃昏',
      weather: '晴朗',
      lighting: '右側暖色夕陽與冷色陰影',
      keyProps: ['銅鐘', '老舊指針'],
      prompt: 'red brick school clock tower at sunset',
      negativePrompt: 'modern office, different architecture',
    }] }, script);
    expect(valid).toHaveLength(1);
    expect(valid[0].name).toBe('校園鐘樓');

    expect(() => strictLocations({ locations: [{
      name: '陌生車站',
      purpose: '任意新增',
      environmentAnchor: '車站',
      timeOfDay: '白天',
      weather: '晴朗',
      lighting: '自然光',
      keyProps: ['月台'],
      prompt: 'station',
      negativePrompt: 'clock tower',
    }] }, script)).toThrow(/新增或重新命名/);
  });

  it('rejects static-image language in AI-video shots but permits the explicit motion-comic mode', () => {
    const aiProject = createBlankProject();
    expect(() => strictStoryboard({ shots: [{ ...shot(), motionPrompt: 'Ken Burns pan over a still image' }] }, aiProject, characters, locations)).toThrow(/不能作為 AI 影片/);

    const comicProject = createBlankProject();
    comicProject.settings.visualMode = 'motion-comic';
    expect(strictStoryboard({ shots: [{ ...shot(), motionPrompt: 'Ken Burns pan over a still image' }] }, comicProject, characters, locations)).toHaveLength(1);
  });

  it('requires exactly one sound cue for every generated shot', () => {
    const project = createBlankProject();
    const scenes = strictStoryboard({ shots: [shot()] }, project, characters, locations);
    const cue = {
      sceneId: scenes[0].id,
      musicCue: '低頻脈衝逐漸增強',
      ambience: '黃昏校園與遠處風聲',
      soundEffects: ['鐘聲'],
      dialoguePacing: '台詞前留半秒停頓',
    };
    const valid = strictSound({
      musicDirection: '克制的懸疑電子配樂',
      mixDirection: '對白置中，鐘聲保留動態',
      narratorVoice: '中性・自然',
      cues: [cue],
    }, scenes);
    expect(valid.cues).toHaveLength(1);
    expect(() => strictSound({
      musicDirection: '懸疑配樂',
      mixDirection: '清楚混音',
      cues: [cue, cue],
    }, scenes)).toThrow(/只提供一個 Cue|實際 2 個/);
  });

});
