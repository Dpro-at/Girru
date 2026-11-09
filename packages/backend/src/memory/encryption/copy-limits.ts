/** Shared bounded declared-surface copy limits. These do not certify whole-profile coverage. */
export const MEMORY_COPY_MAX_ROWS = 5000;
export const MEMORY_COPY_READ_LIMIT = MEMORY_COPY_MAX_ROWS + 1;
export const MEMORY_COPY_MAX_SOURCE_BYTES = 8 * 1024 * 1024;
export const MEMORY_COPY_MAX_SET_SOURCE_BYTES = 32 * 1024 * 1024;
export const MEMORY_COPY_MAX_ENCODED_BYTES = 32 * 1024 * 1024;
export const MEMORY_COPY_MAX_SET_ENCODED_BYTES = 64 * 1024 * 1024;
