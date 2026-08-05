import { createId } from './id';
import type {
  ArtDirectionArtifact,
  Character,
  DirectorReviewArtifact,
  EvolabsProject,
  IpBibleArtifact,
  LocationAsset,
  Scene,
  ScriptAnalysisArtifact,
  SoundPlanArtifact,
  StoryBeat,
  VoiceProfile,
} from '../types';

const voices: VoiceProfile[] = ['青年・自然', '少女・清冷', '中性・自然', '成熟・沉穩'];
const accents = ['#b9c4d0', '#d2c1b8', '#b8cdbf', '#c8c0d8', '#d4c79d'];
const humanSafety = [
  'one anatomically normal human per described person',
  'exactly one head and two natural eyes per person',
  'normal hands and limbs',
  'fully clothed according to the locked wardrobe',
  'age exactly matches the character bible',
  'no nudity, no exposed intimate areas, no transparent clothing',
  'no duplicate face, no extra eyes, no extra limbs, no fused body parts',
].join(', ');

const unsafeWardrobe = /(?:裸體|全裸|赤裸|裸身|無衣|沒穿衣|未穿衣|不穿衣|透明衣|透明服|透視裝|nude|naked|topless|bottomless|see[- ]?through|transparent clothing)/iu;
const clothingIndicator = /(?:衣|服|褲|裙|外套|襯衫|制服|西裝|毛衣|鞋|襪|shirt|jacket|coat|pants|trousers|skirt|dress|uniform|sweater|hoodie|shoe)/iu;
const fauxVideoLanguage = /(?:ken\s*burns|still[- ]?image|static[- ]?image|slideshow|photo\s*montage|motion\s*comic|圖片運鏡|靜態圖片|定格圖片|相片平移|卡片模式|動態漫畫)/iu;

function explicitAge(value: unknown, label: string): string {
  const text = requiredText(value, label, 120);
  const match = text.match(/(?:^|[^0-9])(\d{1,3})(?:\s*(?:歲|years?\s*old|year[- ]old|y\/?o))?/iu);
  if (!match) throw new Error(`${label} 必須包含明確數字年齡，例如「17 歲」。`);
  const age = Number(match[1]);
  if (!Number.isInteger(age) || age < 1 || age > 120) throw new Error(`${label} 必須介於 1 到 120 歲。`);
  if (/(?:老人|老年|高齡|elderly|senior)/iu.test(text) && age < 60) {
    throw new Error(`${label} 的文字描述與數字年齡互相矛盾。`);
  }
  return text;
}

function ageNumber(value: string): number {
  const match = value.match(/\d{1,3}/u);
  if (!match) throw new Error('角色年齡缺少數字。');
  return Number(match[0]);
}

function safeWardrobe(value: unknown, label: string): string {
  const text = requiredText(value, label, 1_000);
  if (unsafeWardrobe.test(text)) throw new Error(`${label} 包含裸露、透明或未穿衣等不安全描述。`);
  if (!clothingIndicator.test(text)) throw new Error(`${label} 必須明確列出完整服裝。`);
  return text;
}

function normalizedLockText(value: string): string {
  return value.toLocaleLowerCase('zh-Hant')
    .replace(/[\s\p{P}\p{S}]/gu, '')
    .replace(/色/gu, '');
}

function uniqueNames(values: string[], label: string): string[] {
  const seen = new Set<string>();
  for (const value of values) {
    if (seen.has(value)) throw new Error(`${label} 重複引用「${value}」。`);
    seen.add(value);
  }
  return values;
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

function requiredText(value: unknown, label: string, maximum = 8_000): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} 缺少有效文字。`);
  return value.trim().slice(0, maximum);
}

function optionalText(value: unknown, maximum = 8_000): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim().slice(0, maximum) : undefined;
}

function requiredArray(value: unknown, label: string, maximumItems = 32): unknown[] {
  if (!Array.isArray(value) || !value.length) throw new Error(`${label} 必須是非空陣列。`);
  return value.slice(0, maximumItems);
}

function textArray(value: unknown, label: string, minimum = 1, maximumItems = 32, maximumText = 1_000): string[] {
  if (!Array.isArray(value)) throw new Error(`${label} 必須是陣列。`);
  const items = value
    .filter((item): item is string => typeof item === 'string' && Boolean(item.trim()))
    .slice(0, maximumItems)
    .map((item) => item.trim().slice(0, maximumText));
  if (items.length < minimum) throw new Error(`${label} 至少需要 ${minimum} 項。`);
  return items;
}

function finiteNumber(value: unknown, label: string, minimum: number, maximum: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`${label} 必須是數字。`);
  return Math.max(minimum, Math.min(maximum, value));
}

function voice(value: unknown, index: number): VoiceProfile {
  return typeof value === 'string' && voices.includes(value as VoiceProfile) ? value as VoiceProfile : voices[index % voices.length];
}

function stableSeed(...parts: string[]): number {
  let hash = 0x811c9dc5;
  for (const character of parts.join('|')) {
    hash ^= character.charCodeAt(0);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 1;
}

export function strictScriptAnalysis(value: unknown): ScriptAnalysisArtifact {
  if (!isRecord(value)) throw new Error('編劇交付不是 JSON 物件。');
  const beats = requiredArray(value.beats, '故事節點', 24).map((entry, index): StoryBeat => {
    if (!isRecord(entry)) throw new Error(`第 ${index + 1} 個故事節點格式不正確。`);
    return {
      id: optionalText(entry.id, 80) || `beat_${index + 1}`,
      title: requiredText(entry.title, `第 ${index + 1} 個故事節點標題`, 160),
      summary: requiredText(entry.summary, `第 ${index + 1} 個故事節點摘要`, 1_800),
      tension: Math.round(finiteNumber(entry.tension, `第 ${index + 1} 個故事節點張力`, 0, 100)),
      characterNames: textArray(entry.characterNames, `第 ${index + 1} 個故事節點角色`, 0, 16, 120),
      locationHint: optionalText(entry.locationHint, 240),
    };
  });
  const characterSeeds = requiredArray(value.characterSeeds, '角色種子', 16).map((entry, index) => {
    if (!isRecord(entry)) throw new Error(`第 ${index + 1} 個角色種子格式不正確。`);
    return {
      name: requiredText(entry.name, `第 ${index + 1} 個角色名稱`, 100),
      role: requiredText(entry.role, `第 ${index + 1} 個角色功能`, 160),
      goal: requiredText(entry.goal, `第 ${index + 1} 個角色目標`, 1_000),
      conflict: requiredText(entry.conflict, `第 ${index + 1} 個角色衝突`, 1_000),
      traits: textArray(entry.traits, `第 ${index + 1} 個角色特質`, 1, 12, 160),
      age: explicitAge(entry.age, `第 ${index + 1} 個角色年齡`),
      wardrobe: safeWardrobe(entry.wardrobe, `第 ${index + 1} 個角色固定服裝`),
    };
  });
  const locationSeeds = requiredArray(value.locationSeeds, '場景需求', 16).map((entry, index) => {
    if (!isRecord(entry)) throw new Error(`第 ${index + 1} 個場景需求格式不正確。`);
    return {
      name: requiredText(entry.name, `第 ${index + 1} 個場景名稱`, 160),
      purpose: requiredText(entry.purpose, `第 ${index + 1} 個場景用途`, 1_000),
      timeHint: optionalText(entry.timeHint, 240),
    };
  });
  uniqueNames(characterSeeds.map((seed) => seed.name), '角色種子');
  uniqueNames(locationSeeds.map((seed) => seed.name), '場景需求');
  const knownCharacters = new Set(characterSeeds.map((seed) => seed.name));
  beats.forEach((beat) => beat.characterNames.forEach((name) => {
    if (!knownCharacters.has(name)) throw new Error(`故事節點「${beat.title}」引用了未定義角色「${name}」。`);
  }));
  return {
    title: requiredText(value.title, '作品標題', 200),
    logline: requiredText(value.logline, '一句話故事', 900),
    genre: requiredText(value.genre, '作品類型', 200),
    tone: requiredText(value.tone, '作品調性', 600),
    theme: requiredText(value.theme, '作品主題', 800),
    targetAudience: requiredText(value.targetAudience, '目標觀眾', 400),
    summary: requiredText(value.summary, '故事摘要', 4_000),
    beats,
    characterSeeds,
    locationSeeds,
  };
}

export function strictArtDirection(value: unknown): ArtDirectionArtifact {
  if (!isRecord(value)) throw new Error('美術交付不是 JSON 物件。');
  return {
    styleName: requiredText(value.styleName, '視覺風格名稱', 200),
    visualBible: requiredText(value.visualBible, '視覺聖經', 5_000),
    colorPalette: textArray(value.colorPalette, '色彩規劃', 3, 16, 120),
    lighting: requiredText(value.lighting, '燈光規則', 2_000),
    cameraLanguage: requiredText(value.cameraLanguage, '攝影語言', 2_400),
    texture: requiredText(value.texture, '材質規則', 1_400),
    globalPrompt: requiredText(value.globalPrompt, '全片正向提示', 4_000),
    globalNegativePrompt: `${requiredText(value.globalNegativePrompt, '全片負向提示', 3_000)}, ${humanSafety}`,
  };
}

export function strictIpBible(value: unknown): IpBibleArtifact {
  if (!isRecord(value)) throw new Error('IP／連戲交付不是 JSON 物件。');
  return {
    title: requiredText(value.title, 'IP／連戲聖經標題', 200),
    premise: requiredText(value.premise, '世界觀前提', 2_000),
    worldRules: textArray(value.worldRules, '世界規則', 2, 32, 1_000),
    continuityRules: textArray(value.continuityRules, '連戲規則', 3, 40, 1_000),
    recurringMotifs: textArray(value.recurringMotifs, '重複意象', 1, 24, 500),
    prohibitedChanges: textArray(value.prohibitedChanges, '禁止變更項目', 3, 32, 800),
  };
}

export function strictCharacters(value: unknown, script: ScriptAnalysisArtifact, mode: EvolabsProject['settings']['mode']): Character[] {
  const raw = isRecord(value) ? requiredArray(value.characters, '角色資產', 16) : requiredArray(value, '角色資產', 16);
  if (raw.length !== script.characterSeeds.length) {
    throw new Error(`角色設計必須完整交付 ${script.characterSeeds.length} 名已確認角色，不得增減角色。`);
  }
  const seedByName = new Map(script.characterSeeds.map((seed) => [seed.name, seed]));
  const seen = new Set<string>();
  const characters = raw.map((entry, index): Character => {
    if (!isRecord(entry)) throw new Error(`第 ${index + 1} 個角色資產格式不正確。`);
    const name = requiredText(entry.name, `第 ${index + 1} 個角色名稱`, 100);
    if (seen.has(name)) throw new Error(`角色設計重複交付角色「${name}」。`);
    seen.add(name);
    const seed = seedByName.get(name);
    if (!seed) throw new Error(`角色設計新增了劇本中未確認的角色「${name}」。請先與編劇確認。`);
    const generatedAge = explicitAge(entry.age, `角色「${name}」年齡`);
    const generatedWardrobe = safeWardrobe(entry.wardrobe, `角色「${name}」固定服裝`);
    const lockedAge = explicitAge(seed.age, `角色種子「${name}」年齡`);
    const lockedWardrobe = safeWardrobe(seed.wardrobe, `角色種子「${name}」固定服裝`);
    if (ageNumber(generatedAge) !== ageNumber(lockedAge)) {
      throw new Error(`角色「${name}」年齡從 ${lockedAge} 漂移為 ${generatedAge}。`);
    }
    const generatedWardrobeLock = normalizedLockText(generatedWardrobe);
    const lockedWardrobeLock = normalizedLockText(lockedWardrobe);
    if (!generatedWardrobeLock.includes(lockedWardrobeLock) && !lockedWardrobeLock.includes(generatedWardrobeLock)) {
      throw new Error(`角色「${name}」服裝與編劇鎖定設定不一致。`);
    }
    const appearance = requiredText(entry.appearance, `角色「${name}」外觀`, 2_400);
    const negative = requiredText(entry.negativePrompt, `角色「${name}」負向提示`, 2_400);
    return {
      id: createId('character'),
      name,
      role: requiredText(entry.role, `角色「${name}」功能`, 160),
      age: lockedAge,
      appearance: `${lockedAge}；${appearance}；固定服裝：${lockedWardrobe}；${mode === 'anime' ? '動畫造型比例固定' : '真人骨相與膚色固定'}`,
      voice: voice(entry.voice, index),
      locked: true,
      accent: accents[index % accents.length],
      consistencyStrength: finiteNumber(entry.consistencyStrength ?? .95, `角色「${name}」一致性強度`, .85, 1),
      identityAnchor: requiredText(entry.identityAnchor, `角色「${name}」身份錨點`, 2_000),
      appearancePrompt: `${requiredText(entry.appearancePrompt, `角色「${name}」外觀提示`, 3_000)}, ${lockedAge}, ${lockedWardrobe}, fully clothed, opaque clothing, anatomically normal`,
      negativePrompt: `${negative}, nude, naked, exposed body, transparent clothing, old person unless explicitly required, age drift, extra eyes, multiple pupils, duplicate face, extra limbs, malformed hands`,
      wardrobe: lockedWardrobe,
      expressionGuide: requiredText(entry.expressionGuide, `角色「${name}」表情規則`, 1_200),
      voiceDirection: requiredText(entry.voiceDirection, `角色「${name}」聲音規則`, 1_000),
    };
  });
  const missing = script.characterSeeds.filter((seed) => !seen.has(seed.name));
  if (missing.length) throw new Error(`角色設計缺少：${missing.map((seed) => seed.name).join('、')}。`);
  return characters;
}

export function strictLocations(value: unknown, script: ScriptAnalysisArtifact): LocationAsset[] {
  const raw = isRecord(value) ? requiredArray(value.locations, '場景資產', 20) : requiredArray(value, '場景資產', 20);
  if (raw.length !== script.locationSeeds.length) {
    throw new Error(`場景設計必須完整交付 ${script.locationSeeds.length} 個已確認場景，不得增減或合併場景。`);
  }
  const seedByName = new Map(script.locationSeeds.map((seed) => [seed.name, seed]));
  const parsedByName = new Map<string, LocationAsset>();
  raw.forEach((entry, index) => {
    if (!isRecord(entry)) throw new Error(`第 ${index + 1} 個場景資產格式不正確。`);
    const name = requiredText(entry.name, `第 ${index + 1} 個場景名稱`, 160);
    if (parsedByName.has(name)) throw new Error(`場景設計重複交付場景「${name}」。`);
    const seed = seedByName.get(name);
    if (!seed) throw new Error(`場景設計新增或重新命名了編劇尚未確認的場景「${name}」。請先與編劇確認。`);
    parsedByName.set(name, {
      id: createId('location'),
      name,
      purpose: requiredText(entry.purpose, `場景「${name}」用途`, 1_000),
      environmentAnchor: requiredText(entry.environmentAnchor, `場景「${name}」空間錨點`, 2_400),
      timeOfDay: requiredText(entry.timeOfDay, `場景「${name}」時間`, 240),
      weather: requiredText(entry.weather, `場景「${name}」天氣`, 240),
      lighting: requiredText(entry.lighting, `場景「${name}」燈光`, 1_400),
      keyProps: textArray(entry.keyProps, `場景「${name}」道具`, 1, 24, 240),
      prompt: requiredText(entry.prompt, `場景「${name}」提示`, 3_000),
      negativePrompt: requiredText(entry.negativePrompt, `場景「${name}」負向提示`, 2_000),
    });
  });
  const missing = script.locationSeeds.filter((seed) => !parsedByName.has(seed.name));
  if (missing.length) throw new Error(`場景設計缺少：${missing.map((seed) => seed.name).join('、')}。`);
  return script.locationSeeds.map((seed) => parsedByName.get(seed.name) as LocationAsset);
}

export function strictStoryboard(
  value: unknown,
  project: EvolabsProject,
  characters: Character[],
  locations: LocationAsset[],
): Scene[] {
  const raw = isRecord(value) && Array.isArray(value.shots)
    ? requiredArray(value.shots, '影片分鏡', 40)
    : isRecord(value) && Array.isArray(value.scenes)
      ? requiredArray(value.scenes, '影片分鏡', 40)
      : requiredArray(value, '影片分鏡', 40);
  const characterByName = new Map(characters.map((character) => [character.name, character]));
  const locationByName = new Map(locations.map((location) => [location.name, location]));
  return raw.map((entry, index): Scene => {
    if (!isRecord(entry)) throw new Error(`第 ${index + 1} 個影片鏡頭格式不正確。`);
    const characterNames = uniqueNames(textArray(entry.characterNames, `第 ${index + 1} 鏡角色`, 0, 16, 120), `第 ${index + 1} 鏡角色`);
    const selectedCharacters = characterNames.map((name) => {
      const character = characterByName.get(name);
      if (!character) throw new Error(`第 ${index + 1} 鏡引用了不存在的角色「${name}」。`);
      return character;
    });
    const locationName = requiredText(entry.locationName, `第 ${index + 1} 鏡場景`, 160);
    const location = locationByName.get(locationName);
    if (!location) throw new Error(`第 ${index + 1} 鏡引用了不存在的場景「${locationName}」。`);
    const duration = Math.round(finiteNumber(entry.duration, `第 ${index + 1} 鏡秒數`, 2, 10));
    const action = requiredText(entry.action, `第 ${index + 1} 鏡動作`, 2_400);
    const motion = requiredText(entry.motionPrompt, `第 ${index + 1} 鏡影片動作提示`, 2_400);
    const visual = requiredText(entry.visual, `第 ${index + 1} 鏡畫面`, 3_000);
    if ((project.settings.visualMode ?? 'ai-video') === 'ai-video' && fauxVideoLanguage.test(`${visual} ${action} ${motion}`)) {
      throw new Error(`第 ${index + 1} 鏡使用靜態圖片運鏡或動態漫畫語言，不能作為 AI 影片鏡頭。`);
    }
    const subjectLocks = selectedCharacters.map((character) => `${character.name}: ${character.age}, ${character.identityAnchor}, wardrobe ${character.wardrobe}`).join('; ');
    const videoPrompt = [
      action,
      visual,
      subjectLocks,
      `Location: ${location.environmentAnchor}`,
      `Camera: ${requiredText(entry.shot, `第 ${index + 1} 鏡景別`, 400)}; ${requiredText(entry.composition, `第 ${index + 1} 鏡構圖`, 1_000)}; ${motion}`,
      `Lighting: ${location.lighting}`,
      'chronological continuous motion, physically plausible movement, stable face and wardrobe across every frame',
      humanSafety,
    ].filter(Boolean).join('. ');
    return {
      id: createId('scene'),
      order: index + 1,
      title: requiredText(entry.title, `第 ${index + 1} 鏡標題`, 180),
      visual,
      dialogue: optionalText(entry.dialogue, 2_000) || '',
      characterIds: selectedCharacters.map((character) => character.id),
      duration,
      shot: requiredText(entry.shot, `第 ${index + 1} 鏡景別`, 400),
      status: 'ready',
      progress: 0,
      seed: typeof entry.seed === 'number' && Number.isInteger(entry.seed)
        ? Math.max(0, Math.min(0x7fffffff, entry.seed))
        : stableSeed(project.id, requiredText(entry.title, `第 ${index + 1} 鏡標題`, 180), String(index + 1)),
      locationId: location.id,
      storyBeatId: optionalText(entry.storyBeatId, 120),
      composition: requiredText(entry.composition, `第 ${index + 1} 鏡構圖`, 1_000),
      action,
      emotion: requiredText(entry.emotion, `第 ${index + 1} 鏡情緒`, 800),
      startFramePrompt: optionalText(entry.startFramePrompt, 4_000),
      endFramePrompt: optionalText(entry.endFramePrompt, 4_000),
      motionPrompt: motion,
      videoPrompt,
      negativePrompt: `${requiredText(entry.negativePrompt, `第 ${index + 1} 鏡負向提示`, 2_400)}, nude, naked, exposed intimate areas, age drift, elderly person unless specified, extra eyes, multiple pupils, duplicate face, deformed anatomy, extra limbs, fused body, wardrobe change, identity drift`,
      transition: requiredText(entry.transition, `第 ${index + 1} 鏡轉場`, 500),
      continuityIn: requiredText(entry.continuityIn, `第 ${index + 1} 鏡前段連戲`, 1_200),
      continuityOut: requiredText(entry.continuityOut, `第 ${index + 1} 鏡後段連戲`, 1_200),
      generationAttempt: 0,
      reviewState: 'pending',
      qualityChecks: [],
    };
  });
}

export function strictSound(value: unknown, scenes: Scene[]): SoundPlanArtifact {
  if (!isRecord(value)) throw new Error('聲音交付不是 JSON 物件。');
  const rawCues = requiredArray(value.cues, '聲音 Cue', scenes.length + 8);
  if (rawCues.length !== scenes.length) {
    throw new Error(`聲音設計必須為每個鏡頭提供且只提供一個 Cue；預期 ${scenes.length} 個，實際 ${rawCues.length} 個。`);
  }
  const sceneIds = new Set(scenes.map((scene) => scene.id));
  const seen = new Set<string>();
  const cues = rawCues.map((entry, index) => {
    if (!isRecord(entry)) throw new Error(`第 ${index + 1} 個聲音 Cue 格式不正確。`);
    const sceneId = requiredText(entry.sceneId, `第 ${index + 1} 個聲音 Cue 鏡頭 ID`, 160);
    if (!sceneIds.has(sceneId)) throw new Error(`聲音 Cue 引用了不存在的鏡頭「${sceneId}」。`);
    if (seen.has(sceneId)) throw new Error(`鏡頭「${sceneId}」出現重複的聲音 Cue。`);
    seen.add(sceneId);
    return {
      sceneId,
      musicCue: requiredText(entry.musicCue, `鏡頭「${sceneId}」音樂`, 1_000),
      ambience: requiredText(entry.ambience, `鏡頭「${sceneId}」環境音`, 1_000),
      soundEffects: textArray(entry.soundEffects, `鏡頭「${sceneId}」音效`, 0, 24, 300),
      dialoguePacing: requiredText(entry.dialoguePacing, `鏡頭「${sceneId}」對白節奏`, 800),
    };
  });
  const missing = scenes.filter((scene) => !seen.has(scene.id));
  if (missing.length) throw new Error(`聲音設計缺少鏡頭：${missing.map((scene) => scene.title).join('、')}。`);
  return {
    musicDirection: requiredText(value.musicDirection, '全片音樂方向', 2_000),
    mixDirection: requiredText(value.mixDirection, '全片混音方向', 1_600),
    narratorVoice: voice(value.narratorVoice, 2),
    cues,
  };
}

export function strictDirectorReview(value: unknown, scenes: Scene[]): DirectorReviewArtifact {
  if (!isRecord(value)) throw new Error('導演驗收不是 JSON 物件。');
  if (typeof value.approved !== 'boolean') throw new Error('導演驗收缺少 approved。');
  const sceneIds = new Set(scenes.map((scene) => scene.id));
  const allowedReturnAgents = ['screenwriter', 'art-director', 'ip-designer', 'character-designer', 'scene-designer', 'storyboard-artist', 'sound-director'] as const;
  const issues: DirectorReviewArtifact['issues'] = Array.isArray(value.issues) ? value.issues.slice(0, 40).map((entry, index) => {
    if (!isRecord(entry)) throw new Error(`第 ${index + 1} 個導演問題格式不正確。`);
    const severity = entry.severity === 'critical' || entry.severity === 'warning' || entry.severity === 'info' ? entry.severity : 'warning';
    const sceneId = optionalText(entry.sceneId, 160);
    if (sceneId && !sceneIds.has(sceneId)) throw new Error(`第 ${index + 1} 個導演問題引用了不存在的鏡頭。`);
    const rawReturnTo = optionalText(entry.returnToAgent, 80);
    const returnToAgent = rawReturnTo && allowedReturnAgents.includes(rawReturnTo as typeof allowedReturnAgents[number])
      ? rawReturnTo as typeof allowedReturnAgents[number]
      : undefined;
    if (severity !== 'info' && !returnToAgent) {
      throw new Error(`第 ${index + 1} 個阻斷問題必須指定可執行修正的 returnToAgent。`);
    }
    return {
      severity,
      sceneId,
      message: requiredText(entry.message, `第 ${index + 1} 個導演問題`, 1_200),
      fix: requiredText(entry.fix, `第 ${index + 1} 個導演修正`, 1_200),
      returnToAgent,
    };
  }) : [];
  const blockingIssues = issues.filter((issue) => issue.severity === 'critical' || issue.severity === 'warning');
  if (value.approved && blockingIssues.length) {
    throw new Error('導演驗收標示為核准，但仍包含警告或重大問題。');
  }
  if (!value.approved && !blockingIssues.length) {
    throw new Error('導演未核准交付，但沒有提供可退回修正的阻斷問題。');
  }
  return {
    approved: value.approved,
    score: Math.round(finiteNumber(value.score, '導演評分', 0, 100)),
    summary: requiredText(value.summary, '導演驗收摘要', 2_000),
    issues,
    finalInstructions: textArray(value.finalInstructions, '最終生成指令', 1, 32, 1_000),
  };
}
