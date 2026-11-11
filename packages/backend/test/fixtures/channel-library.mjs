// Select the existing development dependency for channel tests, never an account or provider profile.
import {fileURLToPath} from 'node:url';
process.env.GIRRU_CHANNELS_RUNTIME_DIR=fileURLToPath(new URL('../../',import.meta.url));

const {loadChannelLibrary}=await import('../../src/services/channel-runtime.ts');
await loadChannelLibrary();
