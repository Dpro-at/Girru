import {corePort} from "../../../host.js";
const port=corePort("extensions/shared/webhook-verify.js");
export const registerRawBodyParsers=port.registerRawBodyParsers;
export const verifyTwilioRequest=port.verifyTwilioRequest;
export const publicRequestUrl=port.publicRequestUrl;
