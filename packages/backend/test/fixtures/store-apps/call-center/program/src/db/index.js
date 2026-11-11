import {corePort} from "../../../host.js";
const port=corePort("src/db/index.js");
export const getDatabase=port.getDatabase;

export const telephonyNames=port.telephonyNames;
