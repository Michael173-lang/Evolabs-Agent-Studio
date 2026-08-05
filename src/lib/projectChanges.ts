import type { AgentChangeProposal, AgentChangeOperation, EvolabsProject, ProductionBible, Scene } from '../types';

const characterFields = new Set([
  'age',
  'role',
  'appearance',
  'wardrobe',
  'identityAnchor',
  'appearancePrompt',
  'negativePrompt',
  'expressionGuide',
  'voiceDirection',
] as const);

const appearanceAffectingCharacterFields = new Set<string>([
  'age',
  'appearance',
  'wardrobe',
  'identityAnchor',
  'appearancePrompt',
] as const);

const sceneFields = new Set([
  'title',
  'visual',
  'dialogue',
  'shot',
  'composition',
  'action',
  'emotion',
  'startFramePrompt',
  'endFramePrompt',
  'motionPrompt',
  'negativePrompt',
  'transition',
  'continuityIn',
  'continuityOut',
] as const);

const unsafeWardrobe = /(?:裸體|全裸|赤裸|裸身|無衣|沒穿衣|未穿衣|不穿衣|透明衣|透明服|透視裝|nude|naked|topless|bottomless|see[- ]?through|transparent clothing)/iu;
const clothingIndicator = /(?:衣|服|褲|裙|外套|襯衫|制服|西裝|毛衣|鞋|襪|shirt|jacket|coat|pants|trousers|skirt|dress|uniform|sweater|hoodie|shoe)/iu;

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === 'object' && value !== null && !Array.isArray(value);

function boundedText(value: unknown, label: string, maximum: number): string {
  if (typeof value !== 'string' || !value.trim()) throw new Error(`${label} 缺少有效文字。`);
  const text = value.trim();
  if ([...text].length > maximum) throw new Error(`${label} 超過 ${maximum.toLocaleString()} 個字元。`);
  if (/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/u.test(text)) throw new Error(`${label} 含有不允許的控制字元。`);
  return text;
}

function explicitAge(value: unknown, label: string): string {
  const text = boundedText(value, label, 120);
  const match = text.match(/(?:^|[^0-9])(\d{1,3})(?:\s*(?:歲|years?\s*old|year[- ]old|y\/?o))?/iu);
  if (!match) throw new Error(`${label} 必須包含明確數字年齡，例如「17 歲」。`);
  const age = Number(match[1]);
  if (!Number.isInteger(age) || age < 1 || age > 120) throw new Error(`${label} 必須介於 1 到 120 歲。`);
  return text;
}

function safeWardrobe(value: unknown, label: string): string {
  const text = boundedText(value, label, 1_000);
  if (unsafeWardrobe.test(text)) throw new Error(`${label} 包含裸露、透明或未穿衣等不安全描述。`);
  if (!clothingIndicator.test(text)) throw new Error(`${label} 必須明確列出完整服裝。`);
  return text;
}

function resetScene(scene: Scene): Scene {
  return {
    ...scene,
    status: 'ready',
    progress: 0,
    previewPath: undefined,
    visualSource: undefined,
    generationAttempt: 0,
    reviewState: 'pending',
    reviewFeedback: undefined,
    qualityChecks: [],
    videoPrompt: undefined,
  };
}

function updateBibleCharacterLock(
  bible: ProductionBible | undefined,
  characterName: string,
  field: string,
  value: string,
): ProductionBible | undefined {
  if (!bible?.script || !['age', 'role', 'wardrobe'].includes(field)) return bible;
  let found = false;
  const characterSeeds = bible.script.characterSeeds.map((seed) => {
    if (seed.name !== characterName) return seed;
    found = true;
    return { ...seed, [field]: value };
  });
  if (!found) throw new Error(`製作聖經找不到角色「${characterName}」，無法同步 AI 建議。`);
  return {
    ...bible,
    script: { ...bible.script, characterSeeds },
    directorReview: undefined,
  };
}

function validateOperation(operation: AgentChangeOperation, index: number): AgentChangeOperation {
  if (!isRecord(operation)) throw new Error(`第 ${index + 1} 個 AI 修改操作格式無效。`);
  const type = operation.type;
  if (type === 'append-director-instruction') {
    return { type, value: boundedText(operation.value, `第 ${index + 1} 個導演指示`, 2_000) };
  }
  if (type === 'set-character-field') {
    const characterName = boundedText(operation.characterName, `第 ${index + 1} 個角色名稱`, 100);
    if (!characterFields.has(operation.field)) throw new Error(`第 ${index + 1} 個 AI 修改操作包含不受支援的角色欄位。`);
    const value = operation.field === 'age'
      ? explicitAge(operation.value, `角色「${characterName}」年齡`)
      : operation.field === 'wardrobe'
        ? safeWardrobe(operation.value, `角色「${characterName}」固定服裝`)
        : boundedText(operation.value, `角色「${characterName}」${operation.field}`, 4_000);
    return { type, characterName, field: operation.field, value };
  }
  if (type === 'set-scene-field') {
    if (!sceneFields.has(operation.field)) throw new Error(`第 ${index + 1} 個 AI 修改操作包含不受支援的鏡頭欄位。`);
    const sceneId = typeof operation.sceneId === 'string' && operation.sceneId.trim()
      ? boundedText(operation.sceneId, `第 ${index + 1} 個鏡頭 ID`, 160)
      : undefined;
    const sceneTitle = typeof operation.sceneTitle === 'string' && operation.sceneTitle.trim()
      ? boundedText(operation.sceneTitle, `第 ${index + 1} 個鏡頭標題`, 180)
      : undefined;
    if (Boolean(sceneId) === Boolean(sceneTitle)) {
      throw new Error(`第 ${index + 1} 個鏡頭修改必須且只能使用 sceneId 或 sceneTitle 其中一種定位方式。`);
    }
    return {
      type,
      ...(sceneId ? { sceneId } : { sceneTitle }),
      field: operation.field,
      value: boundedText(operation.value, `第 ${index + 1} 個鏡頭修改內容`, 6_000),
    };
  }
  throw new Error(`第 ${index + 1} 個 AI 修改操作種類不受支援。`);
}

export function validateAgentProposal(proposal: AgentChangeProposal): AgentChangeProposal {
  if (!isRecord(proposal)) throw new Error('AI 修改提案格式無效。');
  const operations = Array.isArray(proposal.operations) ? proposal.operations : [];
  if (!operations.length || operations.length > 24) throw new Error('AI 修改提案必須包含 1 到 24 個操作。');
  return {
    ...proposal,
    title: boundedText(proposal.title, 'AI 修改提案標題', 200),
    summary: boundedText(proposal.summary, 'AI 修改提案摘要', 2_000),
    operations: operations.map((operation, index) => validateOperation(operation, index)),
  };
}

export function applyAgentProposal(project: EvolabsProject, rawProposal: AgentChangeProposal): EvolabsProject {
  const proposal = validateAgentProposal(rawProposal);
  let next = project;
  let bible = next.productionBible;
  for (const operation of proposal.operations) {
    if (operation.type === 'append-director-instruction') {
      const existing = next.directorInstructions ?? [];
      next = { ...next, directorInstructions: [...existing, operation.value].slice(-64) };
      continue;
    }
    if (operation.type === 'set-character-field') {
      let changedCharacterId: string | undefined;
      const characters = next.characters.map((character) => {
        if (character.name !== operation.characterName) return character;
        changedCharacterId = character.id;
        const changed = { ...character, [operation.field]: operation.value, locked: true };
        return appearanceAffectingCharacterFields.has(operation.field)
          ? {
            ...changed,
            referenceImagePath: undefined,
            referenceImageDataUrl: undefined,
            referenceImageName: undefined,
          }
          : changed;
      });
      if (!changedCharacterId) throw new Error(`找不到角色「${operation.characterName}」，無法套用 AI 建議。`);
      bible = updateBibleCharacterLock(bible, operation.characterName, operation.field, operation.value);
      bible = bible ? { ...bible, sound: undefined, directorReview: undefined } : bible;
      const scenes = next.scenes.map((scene) => scene.characterIds.includes(changedCharacterId as string) ? resetScene(scene) : scene);
      next = { ...next, characters, scenes };
      continue;
    }
    if (operation.type === 'set-scene-field') {
      let changed = false;
      const scenes = next.scenes.map((scene) => {
        const matched = operation.sceneId ? scene.id === operation.sceneId : scene.title === operation.sceneTitle;
        if (!matched) return scene;
        changed = true;
        return resetScene({ ...scene, [operation.field]: operation.value });
      });
      if (!changed) throw new Error('找不到 AI 建議指定的鏡頭，無法套用修改。');
      bible = bible ? { ...bible, sound: undefined, directorReview: undefined } : bible;
      next = { ...next, scenes };
    }
  }
  const updatedBible = bible?.directorReview ? { ...bible, directorReview: undefined } : bible;
  return {
    ...next,
    plannedStoryFingerprint: undefined,
    productionBible: updatedBible,
    agentWorkspace: next.agentWorkspace ? { ...next.agentWorkspace, artifacts: updatedBible } : next.agentWorkspace,
    updatedAt: new Date().toISOString(),
  };
}
