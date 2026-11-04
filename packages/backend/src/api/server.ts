// CRITICAL: must stay the first import. Loads .env, then the generated
// secrets from .data/secrets.env (INST-02), before any other module runs.
import '../config/load-env.js';

// Everything else loads only after load-env has finished. load-env waits for a
// pending restore (BACKUP-01, FD4a "Restore and open") with a top-level await;
// a static import here would be evaluated meanwhile, open the database first
// and keep using the replaced file. So the server itself is a dynamic import.
await import('./server-main.js');
