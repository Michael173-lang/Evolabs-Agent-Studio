import type { EvolabsProject, VideoProviderStatus } from '../types';

function hasReference(character: EvolabsProject['characters'][number]): boolean {
  return Boolean(character.referenceImagePath?.trim() || character.referenceImageDataUrl?.startsWith('data:image/'));
}

export function getVideoPreflightIssue(project: EvolabsProject, provider: VideoProviderStatus): string | undefined {
  if (project.settings.visualMode !== 'ai-video') return undefined;
  if (!provider.available) return provider.error ?? provider.message;
  if (!provider.capabilities.outputVideo) return '目前工作流尚未通過影片輸出能力驗證。';
  if (!provider.capabilities.outputPrefixBinding) return '目前工作流缺少輸出名稱綁定，無法隔離每個鏡頭與重試產物。';
  if (!provider.capabilities.textToVideo && !provider.capabilities.imageToVideo) {
    return '目前工作流沒有可用的文字轉影片或參考圖轉影片能力。';
  }
  if (!provider.capabilities.inputImageBinding) return undefined;

  const characterById = new Map(project.characters.map((character) => [character.id, character]));
  for (const scene of project.scenes) {
    if (scene.characterIds.length === 0) {
      return `第 ${scene.order} 鏡「${scene.title}」沒有角色，但目前的參考圖轉影片工作流必須收到一張角色參考圖。請改用文字轉影片工作流，或重新設計此鏡頭。`;
    }
    if (scene.characterIds.length > 1) {
      return `第 ${scene.order} 鏡「${scene.title}」包含 ${scene.characterIds.length} 名角色；目前的參考圖轉影片工作流只支援一名角色的一張身份參考圖。請拆分鏡頭或改用支援多人參考的工作流。`;
    }
    const character = characterById.get(scene.characterIds[0]);
    if (!character) return `第 ${scene.order} 鏡「${scene.title}」引用了不存在的角色。`;
    if (!hasReference(character)) {
      return `角色「${character.name}」尚未匯入身份參考圖，因此第 ${scene.order} 鏡「${scene.title}」無法使用目前的參考圖轉影片工作流。`;
    }
  }
  return undefined;
}
