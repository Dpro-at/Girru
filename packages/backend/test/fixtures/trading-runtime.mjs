// Explicit isolated-test app root; normal production has no bundled fallback.
import {fileURLToPath} from 'node:url';
process.env.GIRRU_TRADING_APP_DIR=fileURLToPath(new URL('./store-apps/trading/',import.meta.url));
