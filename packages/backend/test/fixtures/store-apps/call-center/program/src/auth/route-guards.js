import {corePort} from "../../../host.js";
const port=corePort("src/auth/route-guards.js");
export const authorizeActiveRole=port.authorizeActiveRole;
export const OWNER_OR_ADMIN=port.OWNER_OR_ADMIN;
