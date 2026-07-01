import path from "node:path";

import { readJsonFile, writeJsonFile } from "../shared/fs.js";
import type {
  BatchHistoryState,
  ProjectPaths,
  PushHistoryState,
  StateBundle,
  TranslationCacheState
} from "../shared/types.js";

const DEFAULT_TRANSLATION_CACHE: TranslationCacheState = {
  version: 1,
  entries: {}
};

const DEFAULT_PUSH_HISTORY: PushHistoryState = {
  version: 1,
  entries: []
};

const DEFAULT_BATCH_HISTORY: BatchHistoryState = {
  version: 1,
  latestBatchId: null,
  entries: []
};

export async function loadStateBundle(paths: ProjectPaths): Promise<StateBundle> {
  const [translationCache, pushHistory, batches] = await Promise.all([
    readJsonFile(path.join(paths.stateDir, "translation-cache.json"), DEFAULT_TRANSLATION_CACHE),
    readJsonFile(path.join(paths.stateDir, "push-history.json"), DEFAULT_PUSH_HISTORY),
    readJsonFile(path.join(paths.stateDir, "batches.json"), DEFAULT_BATCH_HISTORY)
  ]);

  return { translationCache, pushHistory, batches };
}

export async function saveStateBundle(paths: ProjectPaths, state: StateBundle): Promise<void> {
  await Promise.all([
    writeJsonFile(path.join(paths.stateDir, "translation-cache.json"), state.translationCache),
    writeJsonFile(path.join(paths.stateDir, "push-history.json"), state.pushHistory),
    writeJsonFile(path.join(paths.stateDir, "batches.json"), state.batches)
  ]);
}
