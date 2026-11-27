export interface MarketingSite { id:string;domain:string;niche:string;country:string }
export interface MarketingStat { date:string;clicks:number;impressions:number;position:number }
export interface MarketingRow { label:string;clicks:number;impressions:number;position:number;ctr:number|null }
export interface MarketingInsight { stats:MarketingStat[];keywords:MarketingRow[];pages:MarketingRow[];countries:MarketingRow[] }
export function dataOf(result:unknown):unknown;
export function sitesOf(result:unknown):MarketingSite[];
export function insightOf(result:unknown):MarketingInsight;
export function totalsOf(stats:MarketingStat[]):{clicks:number|null;impressions:number|null;ctr:number|null;position:number|null};
