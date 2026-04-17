export { ACTIVE_EMBEDDING_MODEL, EMBEDDING_DIMENSIONS, DEFAULT_SIMILARITY_THRESHOLD } from './config.js';
export { contentHash } from './hash.js';
export {
  embed,
  embedBatch,
  getEmbedding,
  getEmbeddingsBatch,
  findSimilar,
  similarityBatch,
  cosineSimilarity,
  _resetOpenAI,
} from './service.js';
export type { ContentType, EmbeddingResult, SimilarityMatch, FindSimilarOptions } from './service.js';
