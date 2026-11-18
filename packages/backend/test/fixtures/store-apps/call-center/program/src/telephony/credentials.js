import {corePort} from "../../../host.js";
const port=corePort("src/telephony/credentials.js");
export const TELEPHONY_KEYS=port.TELEPHONY_KEYS;
export const getTelephonySecret=port.getTelephonySecret;
export const setTelephonySecret=port.setTelephonySecret;
