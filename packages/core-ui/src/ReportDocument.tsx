import {ReportSpecView} from '../../display-renderer/src';
/** A saved result, not a source fetch, schedule or permission to run agent work. */
export type SavedDisplayReport={id:string;title:string;capturedAt:string;sourceLabel:string;document:unknown};
export function ReportDocument({report}:{report:SavedDisplayReport}){
 return <ReportSpecView document={report.document} title={report.title} capturedAt={report.capturedAt} sourceLabel={report.sourceLabel}/>;
}
