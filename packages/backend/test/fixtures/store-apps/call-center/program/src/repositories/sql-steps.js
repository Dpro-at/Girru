import {corePort} from "../../../host.js";
const port=corePort("src/repositories/sql-steps.js");
export const q=port.q;
export const one=port.one;
export const run=port.run;
export const sql=port.sql;
export const dialect=port.dialect;
