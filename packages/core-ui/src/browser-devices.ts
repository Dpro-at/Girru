export type DevicePreset={id:string;name:string;group:string;kind:'phone'|'foldable'|'tablet'|'laptop'|'desktop'|'tv';width:number;height:number;mobile:boolean};
export type BrowserViewport={width:number;height:number;mobile:boolean};
export function orientedViewport(value:BrowserViewport,portrait:boolean):BrowserViewport{
 const short=Math.min(value.width,value.height),long=Math.max(value.width,value.height);
 return {width:portrait?short:long,height:portrait?long:short,mobile:value.mobile};
}
export function validViewport(width:number,height:number){return Number.isInteger(width)&&Number.isInteger(height)&&width>=240&&height>=240&&width<=8192&&height<=8192;}
