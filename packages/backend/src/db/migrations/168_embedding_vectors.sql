-- STORE-MAP-01 P3 step 5 (expand): memory vectors as packed Float32 instead of
-- JSON text. Smaller to keep and faster to read for every recall.
--
-- embedding_vec holds the same numbers as `embedding` (little-endian Float32,
-- `embedding_dims` long). A background job fills it while GIRRU_STORE_P3 is on
-- (resumable, never blocking start); recall reads it when present and the JSON
-- text otherwise. The JSON column stays until every reader uses the vector
-- (a later contract step drops it).

ALTER TABLE memories ADD COLUMN embedding_vec BLOB;
