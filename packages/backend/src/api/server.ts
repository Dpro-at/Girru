// The private native ownership plan precedes configuration and every database initializer.
import {receiveNativeStartupPlan} from '../memory/encryption/native-startup-handshake.js';
import {reserveNativeStartupExclusions} from '../memory/encryption/native-startup-exclusion.js';
import {bindNativeProcessStartup} from '../memory/encryption/native-process-startup.js';
const plan=await receiveNativeStartupPlan();
const exclusion=plan?.control?reserveNativeStartupExclusions(plan.control):null;
// Pending restore and generated secrets finish before any application store opens.
await import('../config/load-env.js');
if(plan?.control){const {createNormalNativeBootstrap}=await import('../memory/encryption/normal-native-bootstrap.js');bindNativeProcessStartup(await createNormalNativeBootstrap(plan));}
else bindNativeProcessStartup(null);
exclusion?.release();
await import('./server-main.js');
