import { createId } from './id';
import { createFastPlan } from './planner';
import type {
  AgentCanvasNode,
  AgentId,
  AgentMember,
  AgentMessage,
  AgentStage,
  AgentTask,
  AgentTaskState,
  AgentWorkspace,
  ArtDirectionArtifact,
  Character,
  DirectorReviewArtifact,
  EvolabsProject,
  IpBibleArtifact,
  LocationAsset,
  ProductionBible,
  RenderJobSnapshot,
  Scene,
  ScriptAnalysisArtifact,
  SoundPlanArtifact,
  StoryBeat,
  StoryPlan,
  VoiceProfile,
} from '../types';

const voices: VoiceProfile[] = ['青年・自然', '少女・清冷', '中性・自然', '成熟・沉穩'];
const accents = ['#ff74bd', '#79a9ff', '#65d9aa', '#f2bd64', '#a88bff', '#ff8d78', '#62cad8', '#d3db6e'];

export const agentRoster: Array<Pick<AgentMember, 'id' | 'name' | 'title' | 'symbol'>> = [
  { id: 'director', name: 'Evo 導演', title: '總導演／流程統籌', symbol: 'E' },
  { id: 'screenwriter', name: '編劇師', title: '劇本分析與節奏', symbol: '劇' },
  { id: 'art-director', name: '美術總監', title: '風格與視覺聖經', symbol: '藝' },
  { id: 'ip-designer', name: 'IP 設計師', title: '世界觀與一致性規則', symbol: 'IP' },
  { id: 'character-designer', name: '角色設計師', title: '人物外觀與身份錨點', symbol: '角' },
  { id: 'scene-designer', name: '場景設計師', title: '場景資產、光線與世界', symbol: '景' },
  { id: 'storyboard-artist', name: '分鏡師', title: '鏡頭、運鏡與剪輯', symbol: '鏡' },
  { id: 'sound-director', name: '聲音導演', title: '配音、音效與配樂', symbol: '聲' },
];

const initialTasks: Array<Omit<AgentTask, 'id'>> = [
  { agentId: 'screenwriter', title: '理解劇本', detail: '辨識角色、衝突、節奏與故事節點', state: 'queued', progress: 0 },
  { agentId: 'art-director', title: '建立視覺聖經', detail: '確立整片風格、色彩、材質與攝影語言', state: 'queued', progress: 0 },
  { agentId: 'ip-designer', title: '建立 IP 聖經', detail: '鎖定世界規則、重複意象與不可漂移項目', state: 'queued', progress: 0 },
  { agentId: 'character-designer', title: '設計角色資產', detail: '建立身份錨點、服裝、聲線與一致性提示', state: 'queued', progress: 0 },
  { agentId: 'scene-designer', title: '設計場景資產', detail: '抽取地點、時間、天氣、光線與關鍵道具', state: 'queued', progress: 0 },
  { agentId: 'storyboard-artist', title: '製作分鏡', detail: '拆鏡、構圖、首尾幀、運鏡與鏡頭時長', state: 'queued', progress: 0 },
  { agentId: 'sound-director', title: '安排聲音', detail: '分配角色配音、環境音、音效與配樂方向', state: 'queued', progress: 0 },
  { agentId: 'director', title: '總導演驗收並輸出', detail: '檢查連戲、節奏與可生成性後自動排程成片', state: 'queued', progress: 0 },
];

export const stageAgent: Record<AgentStage, AgentId> = {
  screenwriter: 'screenwriter',
  'art-director': 'art-director',
  'ip-designer': 'ip-designer',
  'character-designer': 'character-designer',
  'scene-designer': 'scene-designer',
  'storyboard-artist': 'storyboard-artist',
  'sound-director': 'sound-director',
  'director-review': 'director',
};

function now() {
  return new Date().toISOString();
}

function message(sender: string, text: string, agentId?: AgentId, kind: AgentMessage['kind'] = 'agent'): AgentMessage {
  return { id: createId('message'), sender, text, agentId, kind, createdAt: now() };
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);
const asText = (value: unknown, fallback: string, maximum = 2400) => typeof value === 'string' && value.trim()
  ? value.trim().slice(0, maximum)
  : fallback;
const asTextArray = (value: unknown, fallback: string[] = [], maximumItems = 20, maximumText = 240) => Array.isArray(value)
  ? value.filter((item): item is string => typeof item === 'string' && Boolean(item.trim())).slice(0, maximumItems).map((item) => item.trim().slice(0, maximumText))
  : fallback;
const clamp = (value: unknown, fallback: number, minimum: number, maximum: number) => {
  const number = typeof value === 'number' && Number.isFinite(value) ? value : fallback;
  return Math.max(minimum, Math.min(maximum, number));
};

function normalizeVoice(value: unknown, index: number): VoiceProfile {
  return typeof value === 'string' && voices.includes(value as VoiceProfile)
    ? value as VoiceProfile
    : voices[index % voices.length];
}

function baseScriptNode(project: EvolabsProject): AgentCanvasNode {
  const trimmed = project.story.trim();
  return {
    id: 'node_script',
    kind: 'script',
    title: project.title || '我的劇本',
    subtitle: trimmed ? `${trimmed.length.toLocaleString()} 字劇本` : '等待你貼上劇本',
    status: trimmed ? 'done' : 'idle',
    progress: trimmed ? 100 : 0,
    x: 90,
    y: 190,
    width: 350,
    height: 290,
    agentId: 'screenwriter',
    detail: trimmed,
    badges: ['唯一輸入'],
  };
}

export function createAgentWorkspace(project: EvolabsProject): AgentWorkspace {
  return {
    state: 'idle',
    autopilot: true,
    zoom: .82,
    agents: agentRoster.map((agent) => ({ ...agent, status: 'idle', progress: 0, currentTask: '等待劇本' })),
    tasks: initialTasks.map((task) => ({ ...task, id: createId('task') })),
    messages: [
      message('Evo 導演', '貼上完整劇本後按「交給團隊」。角色、場景、分鏡、聲音、模型排程與成片會由 Evo 導演與七位專業 Agent 自動接手。', 'director'),
    ],
    nodes: [baseScriptNode(project)],
    artifacts: {},
  };
}

export function refreshScriptNode(workspace: AgentWorkspace, project: EvolabsProject): AgentWorkspace {
  const next = baseScriptNode(project);
  const nodes = workspace.nodes.some((node) => node.id === next.id)
    ? workspace.nodes.map((node) => node.id === next.id ? next : node)
    : [next, ...workspace.nodes];
  return { ...workspace, nodes };
}

function artDirectionFallback(project: EvolabsProject): ArtDirectionArtifact {
  if (project.settings.mode === 'realistic') {
    return {
      styleName: '自然電影感寫實短劇',
      visualBible: '自然電影感寫實攝影；人物膚色、骨相、髮型與服裝跨鏡頭一致。光線有明確方向，場景保留真實材質與空氣透視，避免塑膠皮膚、過度銳化與不合理景深。',
      colorPalette: ['炭黑', '暖灰', '低飽和琥珀', '冷青陰影', '自然膚色'],
      lighting: '以場景內合理光源為主，主光方向在連續鏡頭間保持一致，夜景保留可讀的人臉層次。',
      cameraLanguage: '敘事鏡頭以穩定中景建立空間，情緒轉折用近景，關鍵揭示使用緩慢推進；避免無目的快速運鏡。',
      texture: '真實皮膚、布料、玻璃、金屬與空氣顆粒；控制數位銳化。',
      globalPrompt: 'cinematic live-action short drama, consistent cast identity, realistic skin and fabric, motivated lighting, controlled depth of field, coherent production design',
      globalNegativePrompt: 'identity drift, face change, different wardrobe, extra fingers, duplicate people, plastic skin, oversharpen, random text, watermark, deformed anatomy',
    };
  }
  return {
    styleName: '精緻日系動畫短劇',
    visualBible: '精緻動畫短劇；角色臉型、髮型、髮色、瞳色、服裝與配件在所有鏡頭保持一致。背景具有清楚景深與材質層次，情緒表演自然，避免每鏡換畫風。',
    colorPalette: ['深墨黑', '櫻桃粉', '靛藍', '柔紫', '暖金高光'],
    lighting: '電影式主光與輪廓光；同一場景的色溫、光源位置與時間狀態保持一致。',
    cameraLanguage: '以動畫電影分鏡處理景別、視線與動作軸；重要情緒使用近景，轉場前保留可接續的動作。',
    texture: '乾淨線條、細緻上色、可控顆粒與柔和高光，背景不空洞。',
    globalPrompt: 'high-end cinematic anime short film, consistent character design, clean line art, detailed background, expressive acting, coherent lighting, professional storyboard composition',
    globalNegativePrompt: 'character redesign, different hairstyle, different outfit, low detail, flat background, extra limbs, bad hands, duplicate person, random text, watermark, style drift',
  };
}

function fallbackScriptAnalysis(project: EvolabsProject, fastPlan: StoryPlan): ScriptAnalysisArtifact {
  const sentences = project.story.split(/(?<=[。！？!?\n])/u).map((item) => item.trim()).filter(Boolean);
  const beats: StoryBeat[] = fastPlan.scenes.map((scene, index) => ({
    id: `beat_${index + 1}`,
    title: scene.title,
    summary: sentences[index % Math.max(1, sentences.length)] || scene.visual,
    tension: Math.round(20 + (index / Math.max(1, fastPlan.scenes.length - 1)) * 70),
    characterNames: scene.characterIds.map((id) => fastPlan.characters.find((character) => character.id === id)?.name).filter((name): name is string => Boolean(name)),
    locationHint: index === 0 ? '故事主要場景' : undefined,
  }));
  const firstSentence = sentences[0] || project.story.trim();
  return {
    title: fastPlan.title,
    logline: firstSentence.length > 120 ? `${firstSentence.slice(0, 117)}…` : firstSentence,
    genre: project.settings.mode === 'anime' ? '動畫敘事短劇' : '寫實敘事短劇',
    tone: '情緒清楚、節奏緊湊、適合短影音觀看',
    theme: '角色必須為自己的選擇承擔後果',
    targetAudience: '短劇與故事型短影音觀眾',
    summary: project.story.trim().slice(0, 900),
    beats,
    characterSeeds: fastPlan.characters.map((character, index) => ({
      name: character.name,
      role: character.role,
      goal: index === 0 ? '完成故事中的核心目標' : '推動或阻礙主角的選擇',
      conflict: index === 0 ? '外在事件與內在代價同時逼近' : '與主角的需求或立場產生衝突',
      traits: index === 0 ? ['主動', '敏感', '有明確缺口'] : ['可辨識', '有動機'],
    })),
    locationSeeds: [{ name: '主要場景', purpose: '承載故事核心行動與情緒轉折', timeHint: '依劇本內容' }],
  };
}

function fallbackIpBible(project: EvolabsProject, script: ScriptAnalysisArtifact): IpBibleArtifact {
  return {
    title: `${script.title}・IP 聖經`,
    premise: script.logline,
    worldRules: [
      '故事中的因果規則不可因鏡頭切換而改變。',
      '同一地點的空間方向、時間狀態與主要道具保持連續。',
      project.settings.mode === 'anime' ? '動畫角色造型比例與線條語言全片一致。' : '人物生理特徵與寫實材質全片一致。',
    ],
    continuityRules: [
      '角色臉型、髮型、瞳色、服裝、配件與年齡不得漂移。',
      '上一鏡的動作、視線、手持物與情緒必須能接到下一鏡。',
      '同一場景的光源方向、色溫、天氣與時間保持一致。',
      '關鍵道具的外觀、數量與所在位置保持一致。',
    ],
    recurringMotifs: ['故事核心道具', '主角的視線與選擇', '能代表主題的光影變化'],
    prohibitedChanges: ['隨機更換服裝', '角色年齡或臉型改變', '無原因換場或換天氣', '鏡頭軸線突然反轉', '加入劇本不存在的文字或 Logo'],
  };
}

function enrichCharacter(character: Character, index: number, mode: EvolabsProject['settings']['mode']): Character {
  const identity = `${character.name}｜${character.role}｜固定臉型、髮型、髮色、瞳色、服裝與配件；所有鏡頭必須視為同一個人`;
  const medium = mode === 'anime' ? 'cinematic anime character sheet' : 'cinematic live-action casting sheet';
  return {
    ...character,
    locked: true,
    accent: character.accent || accents[index % accents.length],
    consistencyStrength: Math.max(.86, character.consistencyStrength || .86),
    identityAnchor: character.identityAnchor || identity,
    appearancePrompt: character.appearancePrompt || `${medium}, ${character.appearance}, front three-quarter view, neutral full-body reference, consistent proportions and wardrobe`,
    negativePrompt: character.negativePrompt || 'different face, different hairstyle, different wardrobe, age change, body shape drift, duplicate character, extra limbs, text, watermark',
    wardrobe: character.wardrobe || '依劇本建立一套主服裝；除非劇本明確換裝，所有鏡頭保持同一套服裝與配件。',
    expressionGuide: character.expressionGuide || '至少維持中性、緊張、驚訝、悲傷與堅定五種表情，但身份特徵不變。',
    voiceDirection: character.voiceDirection || `${character.voice}；語速自然，情緒跟隨故事節點，不使用誇張播音腔。`,
  };
}

function fallbackLocations(project: EvolabsProject, script: ScriptAnalysisArtifact, art: ArtDirectionArtifact): LocationAsset[] {
  const seeds = script.locationSeeds.length ? script.locationSeeds : [{ name: '主要場景', purpose: '故事主要事件發生地', timeHint: '依劇本' }];
  return seeds.slice(0, 8).map((seed, index) => ({
    id: createId('location'),
    name: seed.name || `場景 ${index + 1}`,
    purpose: seed.purpose || '承載故事行動',
    environmentAnchor: `${seed.name}；空間格局、主要材質、出入口、背景地標與關鍵道具固定，後續鏡頭不得重設空間。`,
    timeOfDay: seed.timeHint || (index % 2 ? '夜晚' : '傍晚'),
    weather: '依劇本；同一段落保持一致',
    lighting: art.lighting,
    keyProps: ['故事關鍵道具', '可建立空間方向的固定地標'],
    prompt: `${art.globalPrompt}, ${seed.name}, ${seed.purpose}, coherent environment layout, reusable location asset, no characters, ${art.lighting}`,
    negativePrompt: `${art.globalNegativePrompt}, inconsistent architecture, random furniture relocation, impossible perspective`,
  }));
}

function enrichScenes(project: EvolabsProject, scenes: Scene[], characters: Character[], locations: LocationAsset[], art: ArtDirectionArtifact, script: ScriptAnalysisArtifact): Scene[] {
  const characterById = new Map(characters.map((character) => [character.id, character]));
  return scenes.map((scene, index) => {
    const location = locations[index % Math.max(1, locations.length)];
    const names = scene.characterIds.map((id) => characterById.get(id)?.name).filter((name): name is string => Boolean(name));
    const beat = script.beats[index % Math.max(1, script.beats.length)];
    const identity = scene.characterIds.map((id) => characterById.get(id)?.identityAnchor).filter(Boolean).join('；');
    const startFrame = `${art.globalPrompt}; ${location?.environmentAnchor || ''}; ${scene.visual}; cast: ${identity}; composition: ${scene.shot}; single decisive moment; ${project.settings.format}`;
    return {
      ...scene,
      order: index + 1,
      locationId: location?.id,
      storyBeatId: beat?.id,
      composition: scene.composition || scene.shot,
      action: scene.action || scene.visual,
      emotion: scene.emotion || (index === scenes.length - 1 ? '情緒收束並留下餘韻' : '依劇本節點清楚表演'),
      startFramePrompt: scene.startFramePrompt || startFrame,
      endFramePrompt: scene.endFramePrompt || `${startFrame}; continue the same identity, environment and lighting; complete the described action without changing wardrobe or camera axis`,
      motionPrompt: scene.motionPrompt || `${scene.shot}; restrained character motion; preserve face and costume; smooth cinematic motion; no sudden morphing`,
      negativePrompt: scene.negativePrompt || `${art.globalNegativePrompt}; identity drift; location drift; wrong cast count; names: ${names.join(', ')}`,
      transition: scene.transition || (index === scenes.length - 1 ? '淡出' : '動作或視線匹配剪接'),
      continuityIn: scene.continuityIn || (index === 0 ? '故事起始狀態' : `承接第 ${index} 鏡的動作、視線、道具與光線`),
      continuityOut: scene.continuityOut || (index === scenes.length - 1 ? '完成故事情緒收束' : `保留可接到第 ${index + 2} 鏡的動作終點`),
      status: 'ready',
      progress: 0,
      seed: scene.seed ?? Math.abs(hashString(`${project.id}:${index}:${scene.title}`)) % 0x7fffffff,
    };
  });
}

function fallbackSound(scenes: Scene[], characters: Character[]): SoundPlanArtifact {
  return {
    musicDirection: '以一條可持續發展的主題音樂貫穿全片；前段留白，中段隨衝突增加層次，結尾在角色選擇後收束，不蓋過對白。',
    mixDirection: '對白居中清楚，環境音建立空間，音效只強調關鍵動作；避免每鏡重新開始音樂造成斷裂。',
    narratorVoice: characters[0]?.voice || '中性・自然',
    cues: scenes.map((scene) => ({
      sceneId: scene.id,
      musicCue: scene.order === 1 ? '主題動機首次出現，音量低' : scene.order === scenes.length ? '主題動機收束並留尾韻' : '延續前鏡並依張力逐步增加',
      ambience: '依場景空間建立連續環境底噪，不在剪接點突然中斷',
      soundEffects: ['角色關鍵動作', '故事關鍵道具'],
      dialoguePacing: scene.dialogue ? '依鏡頭時長自然分句，保留情緒停頓' : '無對白時以環境與音樂承擔節奏',
    })),
  };
}

function fallbackReview(scenes: Scene[]): DirectorReviewArtifact {
  return {
    approved: true,
    score: 86,
    summary: `已完成 ${scenes.length} 鏡的可生成性、角色一致性、場景連續、節奏與聲音檢查，可進入自動生成。`,
    issues: [],
    finalInstructions: [
      '任何角色或場景生成失敗時只重做該資產與受影響鏡頭，不重置整個專案。',
      '禁止在 AI 畫面模式下靜默改用文字卡片；模型未就緒時必須先完成模型準備。',
      '每鏡輸出完成後立即保存預覽與狀態，成片合成失敗時保留已完成素材。',
    ],
  };
}

function hashString(value: string): number {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash | 0;
}

export interface FallbackProduction {
  title: string;
  characters: Character[];
  scenes: Scene[];
  bible: Required<ProductionBible>;
}

export function createFallbackProduction(project: EvolabsProject): FallbackProduction {
  const fastPlan = createFastPlan(project);
  const script = fallbackScriptAnalysis(project, fastPlan);
  const artDirection = artDirectionFallback(project);
  const ipBible = fallbackIpBible(project, script);
  const characters = fastPlan.characters.map((character, index) => enrichCharacter(character, index, project.settings.mode));
  const locations = fallbackLocations(project, script, artDirection);
  const scenes = enrichScenes(project, fastPlan.scenes, characters, locations, artDirection, script);
  const sound = fallbackSound(scenes, characters);
  const directorReview = fallbackReview(scenes);
  return { title: script.title, characters, scenes, bible: { script, artDirection, ipBible, locations, sound, directorReview } };
}

export function createFallbackAgentPlan(project: EvolabsProject): StoryPlan {
  const fallback = createFallbackProduction(project);
  return {
    title: fallback.title,
    characters: fallback.characters,
    scenes: fallback.scenes,
    source: 'fast-planner',
    artDirection: fallback.bible.artDirection.visualBible,
    productionBible: fallback.bible,
  };
}

export function normalizeScriptAnalysis(value: unknown, project: EvolabsProject): ScriptAnalysisArtifact {
  const fallback = createFallbackProduction(project).bible.script;
  if (!isRecord(value)) return fallback;
  const rawBeats = Array.isArray(value.beats) ? value.beats : [];
  const beats = rawBeats.slice(0, 24).flatMap((entry, index): StoryBeat[] => {
    if (!isRecord(entry)) return [];
    return [{
      id: asText(entry.id, `beat_${index + 1}`, 64),
      title: asText(entry.title, `節點 ${index + 1}`, 80),
      summary: asText(entry.summary, fallback.beats[index % fallback.beats.length]?.summary || '推進故事', 900),
      tension: Math.round(clamp(entry.tension, 30 + index * 8, 0, 100)),
      characterNames: asTextArray(entry.characterNames, [], 12, 40),
      locationHint: asText(entry.locationHint, '', 120) || undefined,
    }];
  });
  const rawCharacterSeeds = Array.isArray(value.characterSeeds) ? value.characterSeeds : [];
  const characterSeeds = rawCharacterSeeds.slice(0, 12).flatMap((entry, index) => {
    if (!isRecord(entry)) return [];
    const name = asText(entry.name, '', 40);
    if (!name) return [];
    return [{
      name,
      role: asText(entry.role, index === 0 ? '主角' : '配角', 80),
      goal: asText(entry.goal, '完成故事中的核心目標', 320),
      conflict: asText(entry.conflict, '面對外在阻礙與內在代價', 320),
      traits: asTextArray(entry.traits, ['可辨識'], 8, 60),
    }];
  });
  const rawLocationSeeds = Array.isArray(value.locationSeeds) ? value.locationSeeds : [];
  const locationSeeds = rawLocationSeeds.slice(0, 12).flatMap((entry, index) => {
    if (!isRecord(entry)) return [];
    const name = asText(entry.name, '', 80);
    if (!name) return [];
    return [{ name, purpose: asText(entry.purpose, `故事場景 ${index + 1}`, 320), timeHint: asText(entry.timeHint, '', 80) || undefined }];
  });
  return {
    title: asText(value.title, fallback.title, 100),
    logline: asText(value.logline, fallback.logline, 500),
    genre: asText(value.genre, fallback.genre, 120),
    tone: asText(value.tone, fallback.tone, 240),
    theme: asText(value.theme, fallback.theme, 300),
    targetAudience: asText(value.targetAudience, fallback.targetAudience, 160),
    summary: asText(value.summary, fallback.summary, 1800),
    beats: beats.length >= 3 ? beats : fallback.beats,
    characterSeeds: characterSeeds.length ? characterSeeds : fallback.characterSeeds,
    locationSeeds: locationSeeds.length ? locationSeeds : fallback.locationSeeds,
  };
}

export function normalizeArtDirection(value: unknown, project: EvolabsProject): ArtDirectionArtifact {
  const fallback = artDirectionFallback(project);
  if (!isRecord(value)) return fallback;
  return {
    styleName: asText(value.styleName, fallback.styleName, 120),
    visualBible: asText(value.visualBible, fallback.visualBible, 2400),
    colorPalette: asTextArray(value.colorPalette, fallback.colorPalette, 10, 80),
    lighting: asText(value.lighting, fallback.lighting, 800),
    cameraLanguage: asText(value.cameraLanguage, fallback.cameraLanguage, 900),
    texture: asText(value.texture, fallback.texture, 500),
    globalPrompt: asText(value.globalPrompt, fallback.globalPrompt, 1800),
    globalNegativePrompt: asText(value.globalNegativePrompt, fallback.globalNegativePrompt, 1200),
  };
}

export function normalizeIpBible(value: unknown, project: EvolabsProject, script: ScriptAnalysisArtifact): IpBibleArtifact {
  const fallback = fallbackIpBible(project, script);
  if (!isRecord(value)) return fallback;
  return {
    title: asText(value.title, fallback.title, 120),
    premise: asText(value.premise, fallback.premise, 800),
    worldRules: asTextArray(value.worldRules, fallback.worldRules, 16, 500),
    continuityRules: asTextArray(value.continuityRules, fallback.continuityRules, 20, 500),
    recurringMotifs: asTextArray(value.recurringMotifs, fallback.recurringMotifs, 12, 240),
    prohibitedChanges: asTextArray(value.prohibitedChanges, fallback.prohibitedChanges, 16, 320),
  };
}

export function normalizeCharacters(value: unknown, project: EvolabsProject, script: ScriptAnalysisArtifact): Character[] {
  const fallback = createFallbackProduction(project).characters;
  const raw = isRecord(value) && Array.isArray(value.characters) ? value.characters : Array.isArray(value) ? value : [];
  const characters = raw.slice(0, 12).flatMap((entry, index): Character[] => {
    if (!isRecord(entry)) return [];
    const name = asText(entry.name, script.characterSeeds[index]?.name || '', 40);
    if (!name) return [];
    const role = asText(entry.role, script.characterSeeds[index]?.role || (index === 0 ? '主角' : '配角'), 80);
    const base: Character = {
      id: createId('character'),
      name,
      role,
      appearance: asText(entry.appearance, `${name}，${role}；建立可跨鏡頭保持一致的外觀`, 1600),
      voice: normalizeVoice(entry.voice, index),
      locked: true,
      accent: accents[index % accents.length],
      consistencyStrength: clamp(entry.consistencyStrength, .9, .5, 1),
      identityAnchor: asText(entry.identityAnchor, `${name}｜${role}｜固定臉型、髮型、髮色、瞳色、服裝與配件`, 1200),
      appearancePrompt: asText(entry.appearancePrompt, '', 1800) || undefined,
      negativePrompt: asText(entry.negativePrompt, '', 1000) || undefined,
      wardrobe: asText(entry.wardrobe, '', 800) || undefined,
      expressionGuide: asText(entry.expressionGuide, '', 800) || undefined,
      voiceDirection: asText(entry.voiceDirection, '', 600) || undefined,
    };
    return [enrichCharacter(base, index, project.settings.mode)];
  });
  return characters.length ? characters : fallback;
}

export function normalizeLocations(value: unknown, project: EvolabsProject, script: ScriptAnalysisArtifact, art: ArtDirectionArtifact): LocationAsset[] {
  const fallback = fallbackLocations(project, script, art);
  const raw = isRecord(value) && Array.isArray(value.locations) ? value.locations : Array.isArray(value) ? value : [];
  const locations = raw.slice(0, 12).flatMap((entry, index): LocationAsset[] => {
    if (!isRecord(entry)) return [];
    const name = asText(entry.name, script.locationSeeds[index]?.name || '', 100);
    if (!name) return [];
    return [{
      id: createId('location'),
      name,
      purpose: asText(entry.purpose, script.locationSeeds[index]?.purpose || '承載故事行動', 500),
      environmentAnchor: asText(entry.environmentAnchor, `${name}；固定空間格局、材質、入口、地標與道具位置`, 1500),
      timeOfDay: asText(entry.timeOfDay, script.locationSeeds[index]?.timeHint || '依劇本', 100),
      weather: asText(entry.weather, '依劇本；同一段落保持一致', 160),
      lighting: asText(entry.lighting, art.lighting, 700),
      keyProps: asTextArray(entry.keyProps, ['故事關鍵道具'], 16, 120),
      prompt: asText(entry.prompt, `${art.globalPrompt}, ${name}, reusable location asset, no characters`, 1800),
      negativePrompt: asText(entry.negativePrompt, `${art.globalNegativePrompt}, inconsistent architecture`, 1000),
    }];
  });
  return locations.length ? locations : fallback;
}

export function normalizeStoryboard(
  value: unknown,
  project: EvolabsProject,
  script: ScriptAnalysisArtifact,
  art: ArtDirectionArtifact,
  characters: Character[],
  locations: LocationAsset[],
): Scene[] {
  const fastPlan = createFastPlan(project);
  const actualCharacterIdByName = new Map(characters.map((character) => [character.name, character.id]));
  const fastCharacterNameById = new Map(fastPlan.characters.map((character) => [character.id, character.name]));
  const fallbackScenes = fastPlan.scenes.map((scene) => ({
    ...scene,
    characterIds: scene.characterIds
      .map((id) => fastCharacterNameById.get(id))
      .map((name) => name ? actualCharacterIdByName.get(name) : undefined)
      .filter((id): id is string => Boolean(id)),
  }));
  const fallback = enrichScenes(project, fallbackScenes, characters, locations, art, script);
  const raw = isRecord(value) && Array.isArray(value.shots) ? value.shots : isRecord(value) && Array.isArray(value.scenes) ? value.scenes : Array.isArray(value) ? value : [];
  const characterByName = new Map(characters.map((character) => [character.name, character.id]));
  const locationByName = new Map(locations.map((location) => [location.name, location.id]));
  const shots = raw.slice(0, 24).flatMap((entry, index): Scene[] => {
    if (!isRecord(entry)) return [];
    const rawCharacterNames = asTextArray(entry.characterNames, [], 12, 40);
    const rawCharacterIds = asTextArray(entry.characterIds, [], 12, 100);
    const characterIds = [...rawCharacterIds.filter((id) => characters.some((character) => character.id === id)), ...rawCharacterNames.map((name) => characterByName.get(name)).filter((id): id is string => Boolean(id))]
      .filter((id, position, all) => all.indexOf(id) === position);
    if (!characterIds.length && characters[0]) characterIds.push(characters[0].id);
    const locationName = asText(entry.locationName, '', 100);
    const locationId = asText(entry.locationId, '', 100) || locationByName.get(locationName) || locations[index % Math.max(1, locations.length)]?.id;
    const visual = asText(entry.visual, asText(entry.action, `第 ${index + 1} 鏡的可生成畫面`, 1800), 1800);
    return [{
      id: createId('scene'),
      order: index + 1,
      title: asText(entry.title, `第 ${index + 1} 鏡`, 100),
      visual,
      dialogue: asText(entry.dialogue, '', 1600),
      characterIds,
      duration: Math.round(clamp(entry.duration, 6, 2, 20)),
      shot: asText(entry.shot, '中景・緩慢推進', 160),
      status: 'ready',
      progress: 0,
      seed: Math.round(clamp(entry.seed, Math.abs(hashString(`${project.id}:${index}:${visual}`)), 0, 0x7fffffff)),
      locationId,
      storyBeatId: asText(entry.storyBeatId, script.beats[index % script.beats.length]?.id || '', 100) || undefined,
      composition: asText(entry.composition, asText(entry.shot, '主體清楚、視線方向一致', 500), 500),
      action: asText(entry.action, visual, 1200),
      emotion: asText(entry.emotion, '依故事節點清楚表演', 500),
      startFramePrompt: asText(entry.startFramePrompt, '', 2400) || undefined,
      endFramePrompt: asText(entry.endFramePrompt, '', 2400) || undefined,
      motionPrompt: asText(entry.motionPrompt, '', 1600) || undefined,
      negativePrompt: asText(entry.negativePrompt, '', 1200) || undefined,
      transition: asText(entry.transition, index === raw.length - 1 ? '淡出' : '動作或視線匹配剪接', 240),
      continuityIn: asText(entry.continuityIn, index === 0 ? '故事起始狀態' : `承接第 ${index} 鏡`, 600),
      continuityOut: asText(entry.continuityOut, index === raw.length - 1 ? '故事情緒收束' : `保留可接到第 ${index + 2} 鏡的動作終點`, 600),
    }];
  });
  const desired = Math.max(4, Math.min(20, Math.round(project.settings.targetSeconds / 6)));
  const safe = shots.length >= 3 ? shots : fallback;
  const trimmed = safe.slice(0, Math.max(desired + 4, 6));
  const durationTotal = trimmed.reduce((sum, scene) => sum + scene.duration, 0);
  if (durationTotal > 0 && Math.abs(durationTotal - project.settings.targetSeconds) > 8) {
    const scale = project.settings.targetSeconds / durationTotal;
    return enrichScenes(project, trimmed.map((scene) => ({ ...scene, duration: Math.max(2, Math.min(20, Math.round(scene.duration * scale))) })), characters, locations, art, script);
  }
  return enrichScenes(project, trimmed, characters, locations, art, script);
}

export function normalizeSound(value: unknown, scenes: Scene[], characters: Character[]): SoundPlanArtifact {
  const fallback = fallbackSound(scenes, characters);
  if (!isRecord(value)) return fallback;
  const rawCues = Array.isArray(value.cues) ? value.cues : [];
  const sceneIds = new Set(scenes.map((scene) => scene.id));
  const cues = rawCues.slice(0, scenes.length + 4).flatMap((entry, index) => {
    if (!isRecord(entry)) return [];
    const sceneId = asText(entry.sceneId, scenes[index]?.id || '', 100);
    if (!sceneIds.has(sceneId)) return [];
    return [{
      sceneId,
      musicCue: asText(entry.musicCue, '延續前鏡音樂並依張力調整', 500),
      ambience: asText(entry.ambience, '建立連續空間環境音', 500),
      soundEffects: asTextArray(entry.soundEffects, [], 12, 160),
      dialoguePacing: asText(entry.dialoguePacing, '語速自然，保留情緒停頓', 400),
    }];
  });
  const byScene = new Map(cues.map((cue) => [cue.sceneId, cue]));
  return {
    musicDirection: asText(value.musicDirection, fallback.musicDirection, 1200),
    mixDirection: asText(value.mixDirection, fallback.mixDirection, 1000),
    narratorVoice: normalizeVoice(value.narratorVoice, 2),
    cues: scenes.map((scene) => byScene.get(scene.id) || fallback.cues.find((cue) => cue.sceneId === scene.id) || {
      sceneId: scene.id,
      musicCue: '延續前鏡音樂',
      ambience: '依場景建立環境音',
      soundEffects: [],
      dialoguePacing: '語速自然',
    }),
  };
}

export function normalizeDirectorReview(value: unknown, scenes: Scene[]): DirectorReviewArtifact {
  const fallback = fallbackReview(scenes);
  if (!isRecord(value)) return fallback;
  const rawIssues = Array.isArray(value.issues) ? value.issues : [];
  const sceneIds = new Set(scenes.map((scene) => scene.id));
  const issues = rawIssues.slice(0, 20).flatMap((entry) => {
    if (!isRecord(entry)) return [];
    const severity: 'info' | 'warning' | 'critical' = entry.severity === 'critical' || entry.severity === 'warning' || entry.severity === 'info' ? entry.severity : 'warning';
    const sceneId = asText(entry.sceneId, '', 100);
    return [{
      severity,
      sceneId: sceneIds.has(sceneId) ? sceneId : undefined,
      message: asText(entry.message, '需要確認連續性', 700),
      fix: asText(entry.fix, '在生成前自動修正提示與銜接', 700),
    }];
  });
  return {
    approved: typeof value.approved === 'boolean' ? value.approved : !issues.some((issue) => issue.severity === 'critical'),
    score: Math.round(clamp(value.score, fallback.score, 0, 100)),
    summary: asText(value.summary, fallback.summary, 1200),
    issues,
    finalInstructions: asTextArray(value.finalInstructions, fallback.finalInstructions, 20, 500),
  };
}

export function productionPlan(project: EvolabsProject, bible: ProductionBible, characters: Character[], scenes: Scene[], source: StoryPlan['source'] = 'multi-agent'): StoryPlan {
  return {
    title: bible.script?.title || project.title || '未命名短劇',
    characters,
    scenes,
    source,
    artDirection: bible.artDirection?.visualBible,
    productionBible: bible,
  };
}

function characterNode(character: Character, index: number): AgentCanvasNode {
  const column = index % 2;
  const row = Math.floor(index / 2);
  return {
    id: `node_character_${character.id}`,
    kind: 'character',
    title: character.name,
    subtitle: character.role,
    status: 'done',
    progress: 100,
    x: 1080 + column * 278,
    y: 150 + row * 242,
    width: 248,
    height: 216,
    agentId: 'character-designer',
    characterId: character.id,
    previewPath: character.referenceImagePath,
    previewDataUrl: character.referenceImageDataUrl,
    detail: [character.appearance, character.identityAnchor, character.wardrobe].filter(Boolean).join('\n\n'),
    badges: ['身份鎖定', character.voice],
  };
}

function locationNode(location: LocationAsset, index: number, yStart: number): AgentCanvasNode {
  const column = index % 2;
  const row = Math.floor(index / 2);
  return {
    id: `node_location_${location.id}`,
    kind: 'location',
    title: location.name,
    subtitle: `${location.timeOfDay} · ${location.weather}`,
    status: 'done',
    progress: 100,
    x: 1080 + column * 278,
    y: yStart + row * 226,
    width: 248,
    height: 198,
    agentId: 'scene-designer',
    locationId: location.id,
    previewPath: location.referenceImagePath,
    previewDataUrl: location.referenceImageDataUrl,
    detail: `${location.environmentAnchor}\n\n${location.lighting}`,
    badges: ['場景資產', ...location.keyProps.slice(0, 1)],
  };
}

function shotNode(scene: Scene, index: number): AgentCanvasNode {
  const column = index % 2;
  const row = Math.floor(index / 2);
  const state: AgentTaskState = scene.status === 'failed'
    ? 'failed'
    : scene.status === 'working' || scene.status === 'queued'
      ? 'working'
      : scene.status === 'done'
        ? 'done'
        : 'queued';
  return {
    id: `node_scene_${scene.id}`,
    kind: 'shot',
    title: `${String(scene.order).padStart(2, '0')} · ${scene.title}`,
    subtitle: `${scene.shot} · ${scene.duration} 秒`,
    status: state,
    progress: scene.progress,
    x: 1770 + column * 326,
    y: 130 + row * 246,
    width: 294,
    height: 218,
    agentId: 'storyboard-artist',
    sceneId: scene.id,
    previewPath: scene.previewPath,
    detail: `${scene.visual}\n\n${scene.dialogue}`,
    badges: [scene.transition || '剪接', scene.musicCue || '聲音待配'],
  };
}

export function nodesForPlan(project: EvolabsProject, artDirection?: string): AgentCanvasNode[] {
  const artifacts: ProductionBible = project.productionBible || project.agentWorkspace?.artifacts || {
    artDirection: artDirection ? { ...artDirectionFallback(project), visualBible: artDirection } : artDirectionFallback(project),
  };
  return nodesForProduction(project, artifacts);
}

export function nodesForProduction(project: EvolabsProject, artifacts: ProductionBible = {}): AgentCanvasNode[] {
  const nodes: AgentCanvasNode[] = [baseScriptNode(project)];
  const script = artifacts.script;
  const art = artifacts.artDirection;
  const ip = artifacts.ipBible;
  const locations = artifacts.locations || [];
  const sound = artifacts.sound;
  const review = artifacts.directorReview;

  if (script) nodes.push({
    id: 'node_script_analysis', kind: 'script-analysis', title: '劇本拆解', subtitle: `${script.beats.length} 個故事節點 · ${script.genre}`, status: 'done', progress: 100,
    x: 520, y: 70, width: 390, height: 220, agentId: 'screenwriter', detail: `${script.logline}\n\n主題：${script.theme}\n調性：${script.tone}`,
    badges: ['劇情結構', `${script.beats.length} beats`],
  });
  if (art) nodes.push({
    id: 'node_art_direction', kind: 'art-direction', title: '視覺聖經', subtitle: art.styleName, status: 'done', progress: 100,
    x: 520, y: 330, width: 390, height: 220, agentId: 'art-director', detail: `${art.visualBible}\n\n攝影：${art.cameraLanguage}\n光線：${art.lighting}`,
    badges: art.colorPalette.slice(0, 3),
  });
  if (ip) nodes.push({
    id: 'node_ip_bible', kind: 'ip-bible', title: 'IP／連戲聖經', subtitle: `${ip.worldRules.length} 條世界規則 · ${ip.continuityRules.length} 條連戲規則`, status: 'done', progress: 100,
    x: 520, y: 590, width: 390, height: 230, agentId: 'ip-designer', detail: `${ip.premise}\n\n${ip.continuityRules.map((rule) => `• ${rule}`).join('\n')}`,
    badges: ['世界觀', '連戲鎖'],
  });

  if (project.characters.length) {
    const characterRows = Math.ceil(project.characters.length / 2);
    nodes.push({
      id: 'node_characters', kind: 'characters', title: `角色資產 · ${project.characters.length}`, subtitle: '身份錨點、服裝與聲線', status: 'done', progress: 100,
      x: 990, y: 80, width: 64, height: Math.max(240, characterRows * 242), agentId: 'character-designer', badges: ['linked assets'],
    });
    nodes.push(...project.characters.map(characterNode));
  }

  const locationY = 170 + Math.ceil(Math.max(1, project.characters.length) / 2) * 242;
  if (locations.length) {
    nodes.push({
      id: 'node_locations', kind: 'locations', title: `場景資產 · ${locations.length}`, subtitle: '可重複使用的環境錨點', status: 'done', progress: 100,
      x: 990, y: locationY - 70, width: 64, height: Math.max(220, Math.ceil(locations.length / 2) * 226), agentId: 'scene-designer', badges: ['reusable'],
    });
    nodes.push(...locations.map((location, index) => locationNode(location, index, locationY)));
  }

  if (project.scenes.length) {
    nodes.push({
      id: 'node_storyboard', kind: 'storyboard', title: `分鏡序列 · ${project.scenes.length}`, subtitle: '首尾幀、運鏡、台詞與銜接', status: project.scenes.every((scene) => scene.status === 'done') ? 'done' : 'working', progress: Math.round(project.scenes.reduce((sum, scene) => sum + scene.progress, 0) / project.scenes.length),
      x: 1680, y: 60, width: 64, height: Math.max(260, Math.ceil(project.scenes.length / 2) * 246), agentId: 'storyboard-artist', badges: ['linked editing'],
    });
    nodes.push(...project.scenes.map(shotNode));
  }

  const rightY = 140;
  if (sound) nodes.push({
    id: 'node_sound', kind: 'sound', title: '聲音設計', subtitle: `${sound.cues.length} 鏡聲音 cue · 自動字幕`, status: 'done', progress: 100,
    x: 2510, y: rightY, width: 390, height: 220, agentId: 'sound-director', detail: `${sound.musicDirection}\n\n${sound.mixDirection}`,
    badges: ['配音', '環境音', '音樂'],
  });
  if (review) nodes.push({
    id: 'node_director_review', kind: 'director-review', title: '總導演驗收', subtitle: `${review.score}/100 · ${review.approved ? '可進入生成' : '已自動修正後再檢查'}`, status: review.approved ? 'done' : 'blocked', progress: review.approved ? 100 : 78,
    x: 2510, y: rightY + 270, width: 390, height: 220, agentId: 'director', detail: `${review.summary}\n\n${review.finalInstructions.map((item) => `• ${item}`).join('\n')}`,
    badges: review.issues.length ? [`${review.issues.length} 項修正`] : ['continuity passed'],
  });
  if (project.scenes.length) nodes.push({
    id: 'node_render', kind: 'render', title: '最終成片', subtitle: '等待 Evo 導演調度模型與合成', status: 'queued', progress: 0,
    x: 3090, y: 300, width: 390, height: 270, agentId: 'director', detail: '角色／場景資產 → 分鏡首幀 → 鏡頭運動 → 配音／字幕／音效 → 最終合成', badges: ['AUTO'],
  });
  return nodes;
}

export function applyArtifactToWorkspace(
  workspace: AgentWorkspace,
  project: EvolabsProject,
  stage: AgentStage,
  artifacts: ProductionBible,
  optionalMessage?: string,
): AgentWorkspace {
  const agentId = stageAgent[stage];
  const agentName = agentRoster.find((agent) => agent.id === agentId)?.name || 'Agent';
  const tasks = workspace.tasks.map((task) => task.agentId === agentId
    ? { ...task, state: 'done' as const, progress: 100, detail: '已交付並加入製作畫布' }
    : task);
  const agents = workspace.agents.map((agent) => agent.id === agentId
    ? { ...agent, status: 'done' as const, progress: 100, currentTask: '已交付', lastMessage: optionalMessage || agent.lastMessage }
    : agent);
  return {
    ...workspace,
    artifacts,
    agents,
    tasks,
    activeAgentId: agentId,
    nodes: nodesForProduction(project, artifacts),
    messages: optionalMessage ? [...workspace.messages, message(agentName, optionalMessage, agentId)] : workspace.messages,
  };
}

export function applyPlanToWorkspace(workspace: AgentWorkspace, project: EvolabsProject, plan: StoryPlan, provider?: string, providerModel?: string): AgentWorkspace {
  const artifacts = plan.productionBible || project.productionBible || workspace.artifacts || {};
  const agents = workspace.agents.map((agent) => ({
    ...agent,
    status: 'done' as const,
    progress: 100,
    currentTask: agent.id === 'director' ? '等待模型與生成排程' : '已交付',
  }));
  const tasks = workspace.tasks.map((task) => ({ ...task, state: 'done' as const, progress: 100 }));
  return {
    ...workspace,
    state: 'preparing-models',
    activeAgentId: 'director',
    provider,
    providerModel,
    artifacts,
    agents,
    tasks,
    nodes: nodesForProduction(project, artifacts),
    messages: [
      ...workspace.messages,
      message('Evo 導演', provider === 'lm-studio'
        ? `Evo 導演與七位專業 Agent 已使用本機模型 ${providerModel || ''} 完成製作藍圖。接著自動準備畫面模型、逐鏡生成並合成成片。`
        : provider === 'hybrid'
          ? `Evo 導演已整合本機模型與內建專家完成製作藍圖${providerModel ? `（本機模型：${providerModel}）` : ''}。接著自動準備畫面模型、逐鏡生成並合成成片。`
          : 'Evo 導演與七位專業 Agent 已用 Evolabs 內建代理完成製作藍圖。接著自動準備畫面模型、逐鏡生成並合成成片。', 'director'),
    ],
  };
}

export function setAgentPhase(
  workspace: AgentWorkspace,
  agentId: AgentId,
  state: AgentTaskState,
  progress: number,
  currentTask: string,
  optionalMessage?: string,
): AgentWorkspace {
  const agents = workspace.agents.map((agent) => agent.id === agentId
    ? { ...agent, status: state, progress, currentTask, lastMessage: optionalMessage ?? agent.lastMessage }
    : agent);
  const tasks = workspace.tasks.map((task) => task.agentId === agentId
    ? { ...task, state, progress, detail: currentTask }
    : task);
  return {
    ...workspace,
    activeAgentId: agentId,
    agents,
    tasks,
    messages: optionalMessage
      ? [...workspace.messages, message(agentRoster.find((agent) => agent.id === agentId)?.name ?? 'Agent', optionalMessage, agentId)]
      : workspace.messages,
  };
}

export function syncWorkspaceWithRender(workspace: AgentWorkspace, project: EvolabsProject, render: RenderJobSnapshot): AgentWorkspace {
  const nodes = nodesForProduction(project, workspace.artifacts || project.productionBible || {}).map((node) => {
    if (node.kind === 'render') {
      const failed = render.state === 'failed' || render.state === 'canceled';
      const done = render.state === 'completed';
      return {
        ...node,
        status: failed ? 'failed' as const : done ? 'done' as const : 'working' as const,
        progress: render.overallProgress,
        subtitle: done ? '成片已完成' : failed ? '生成停止' : render.message || '正在生成成片',
        detail: render.outputPath || render.error?.message || render.message || node.detail,
      };
    }
    if (node.characterId) {
      const asset = render.characterAssets?.find((candidate) => candidate.characterId === node.characterId);
      if (!asset) return node;
      return {
        ...node,
        status: asset.state === 'done' ? 'done' as const : asset.state === 'failed' ? 'failed' as const : asset.state === 'queued' ? 'queued' as const : 'working' as const,
        progress: asset.progress,
        previewPath: asset.previewPath ?? node.previewPath,
        subtitle: asset.state === 'done' ? `${node.subtitle} · 身份參考已建立` : asset.state === 'working' ? `${node.subtitle} · 正在生成身份參考` : node.subtitle,
      };
    }
    if (node.sceneId) {
      const scene = project.scenes.find((candidate) => candidate.id === node.sceneId);
      if (!scene) return node;
      return {
        ...node,
        status: scene.status === 'done' ? 'done' as const : scene.status === 'failed' ? 'failed' as const : scene.status === 'ready' ? 'queued' as const : 'working' as const,
        progress: scene.progress,
        previewPath: scene.previewPath,
      };
    }
    return node;
  });
  const finished = render.state === 'completed';
  const failed = render.state === 'failed' || render.state === 'canceled';
  const wasTerminal = workspace.state === 'completed' || workspace.state === 'failed';
  return {
    ...workspace,
    state: finished ? 'completed' : failed ? 'failed' : render.state === 'paused' ? 'paused' : 'rendering',
    activeAgentId: 'director',
    failure: failed ? render.error?.message || render.message || '生成工作已停止。' : undefined,
    finishedAt: finished || failed ? now() : undefined,
    nodes,
    agents: workspace.agents.map((agent) => agent.id === 'director'
      ? {
          ...agent,
          status: failed ? 'failed' as const : finished ? 'done' as const : 'working' as const,
          progress: render.overallProgress,
          currentTask: finished ? '成片已交付' : failed ? '需要處理錯誤' : render.message || '正在統整成片',
        }
      : agent),
    messages: finished && !wasTerminal
      ? [...workspace.messages, message('Evo 導演', '成片已完成。你只需要打開輸出；角色、場景、分鏡、聲音與合成都已由團隊處理。', 'director')]
      : failed && !wasTerminal
        ? [...workspace.messages, message('Evo 導演', render.error?.message || render.message || '生成工作已停止。', 'director')]
        : workspace.messages,
  };
}

export function workspaceOverallProgress(workspace: AgentWorkspace): number {
  if (workspace.state === 'completed') return 100;
  if (workspace.state === 'idle') return 0;
  const active = workspace.tasks.length ? workspace.tasks.reduce((sum, task) => sum + task.progress, 0) / workspace.tasks.length : 0;
  return Math.max(1, Math.min(99, Math.round(active)));
}
