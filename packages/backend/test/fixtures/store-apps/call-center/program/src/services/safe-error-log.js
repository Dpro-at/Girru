import {corePort} from "../../../host.js";
const port=corePort("src/services/safe-error-log.js");
export const safeConsole=port.safeConsole;
