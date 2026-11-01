import { departmentIcon, departmentName } from './agent-look';
import { UiIcon } from './ui-icons';

/** One department identity across chat, calls and paged participant lists. */
export function DepartmentBadge({ department, compact = false }: { department?: string | null; compact?: boolean }) {
 const name = department === undefined ? 'Department unavailable' : departmentName(department);
 return <span className="department-badge" data-compact={compact || undefined} title={name} aria-label={`Department: ${name}`}><UiIcon name={departmentIcon(department)} size={12}/><span>{name}</span></span>;
}
