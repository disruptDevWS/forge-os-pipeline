export { ACTIVE_EMBEDDING_MODEL, EMBEDDING_DIMENSIONS, DEFAULT_SIMILARITY_THRESHOLD } from './config.js';
export { contentHash } from './hash.js';
export {
  embed,
  embedBatch,
  findSimilar,
  similarityBatch,
  _resetOpenAI,
} from './service.js';
export type { ContentType, EmbeddingResult, SimilarityMatch } from './service.js';
