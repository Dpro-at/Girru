import {corePort} from "../../../host.js";
const port=corePort("src/credentials/secret-mask.js");
export const maskSecret=port.maskSecret;
export const isMaskedSecret=port.isMaskedSecret;
