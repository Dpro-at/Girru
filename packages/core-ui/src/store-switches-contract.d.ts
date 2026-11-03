export declare const STORE_SWITCHES_PATH: '/api/store-switches';
export declare function storeSwitchesRoute(path: string): boolean;
export declare function allowedStoreSwitches(method: string, path: string, body?: unknown): boolean;
export declare function storeSwitchesResponse(status: number, body: unknown): { p2: boolean; p3: boolean; p4: boolean; p6?: true; p8?: true } | { code: 'forbidden' | 'unavailable' };
