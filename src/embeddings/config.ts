export const ACTIVE_EMBEDDING_MODEL = 'openai/text-embedding-3-small@2024-01';
export const EMBEDDING_DIMENSIONS = 1536;
export const OPENAI_MODEL_NAME = 'text-embedding-3-small';

// Batch size for OpenAI embeddings API (max is 2048, but keep headroom)
export const EMBEDDING_BATCH_SIZE = 1000;

// Similarity thresholds — starting values, tunable per consumer
export const DEFAULT_SIMILARITY_THRESHOLD = 0.75;
