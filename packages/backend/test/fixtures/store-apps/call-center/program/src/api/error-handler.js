import {corePort} from "../../../host.js";
const port=corePort("src/api/error-handler.js");
export const handleError=port.handleError;
