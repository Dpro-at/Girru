import {corePort} from "../../../../host.js";
const port=corePort("src/db/pg/dialect.js");
export const nowText=port.nowText;
export const secondsSinceText=port.secondsSinceText;
