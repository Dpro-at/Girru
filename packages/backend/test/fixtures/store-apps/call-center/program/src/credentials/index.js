import {corePort} from "../../../host.js";
const port=corePort("src/credentials/index.js");
export const getCredentialManager=port.getCredentialManager;
export const getCredentialStorage=port.getCredentialStorage;
